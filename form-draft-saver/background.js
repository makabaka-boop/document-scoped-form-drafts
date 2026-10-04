/* 表单草稿保存器 · 后台 service worker
 *
 * 设计要点：
 * - 所有持久状态只存 IndexedDB（sessions / writers / drafts 三个对象仓库），
 *   不依赖任何进程内变量，service worker 被终止再唤醒后可直接继续工作。
 * - 每次授权产生新的文档令牌（token），令牌与浏览器提供的 sender.documentId 绑定；
 *   所有写操作都要求：sender.documentId 对应的会话存在、处于 active、且令牌一致。
 * - 每个草稿键（origin :: 完整路由 :: 表单id）记录当前写入者（令牌 + documentId），
 *   重新授权/重新绑定会取代旧写入者，旧页面的迟到保存因此无法覆盖新页面的草稿。
 * - 草稿按字段维护修订号（rev），清理只删除用户确认过的修订（rev <= upToRev），
 *   确认期间产生的新输入（更大 rev）保留。
 */
'use strict';

const DB_NAME = 'form-draft-saver';
const DB_VERSION = 1;
const STORE_SESSIONS = 'sessions'; // documentId -> { token, tabId, origin, route, active, createdAt, ... }
const STORE_WRITERS = 'writers';   // draftKey  -> { token, documentId, tabId, formId, fields, updatedAt }
const STORE_DRAFTS = 'drafts';     // draftKey  -> { origin, route, formId, rev, fields: {k: {value, rev, keyType, type, updatedAt}}, ... }

const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 草稿保留 7 天
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;   // 授权会话保留 24 小时
const WRITER_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const GC_ALARM = 'fds-gc';
const GC_PERIOD_MIN = 6 * 60; // 每 6 小时做一次过期清理
const MAX_FIELDS_PER_FORM = 20;
const MAX_VALUE_LEN = 5000;

/* ---------------- IndexedDB 基础 ---------------- */

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_SESSIONS)) {
        db.createObjectStore(STORE_SESSIONS, { keyPath: 'documentId' });
      }
      if (!db.objectStoreNames.contains(STORE_WRITERS)) {
        db.createObjectStore(STORE_WRITERS, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(STORE_DRAFTS)) {
        db.createObjectStore(STORE_DRAFTS, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function reqp(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/* 在一个事务里执行 fn；fn 内部只允许 await 该事务上的 IDB 请求，
 * 这样事务在 fn 完成前保持存活，fn 完成后随事务一起提交。 */
async function withTx(storeNames, mode, fn) {
  const db = await openDB();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(storeNames, mode);
      const stores = {};
      for (const n of storeNames) stores[n] = tx.objectStore(n);
      let result;
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error || new Error('tx-error'));
      tx.onabort = () => reject(tx.error || new Error('tx-aborted'));
      Promise.resolve()
        .then(() => fn(stores))
        .then((r) => { result = r; })
        .catch((e) => {
          try { tx.abort(); } catch (_) { /* 已结束则忽略 */ }
          reject(e);
        });
    });
  } finally {
    db.close();
  }
}

/* ---------------- 工具 ---------------- */

function draftKey(origin, route, formId) {
  return origin + '::' + route + '::' + formId;
}

function s300(v) {
  return typeof v === 'string' && v.length > 0 && v.length <= 300;
}

/* 校验消息来源：sender.documentId 必须对应一个 active 会话，且令牌一致 */
async function getValidSession(stores, sender, token) {
  if (!sender || !sender.documentId) throw new Error('missing-document-id');
  const sess = await reqp(stores[STORE_SESSIONS].get(sender.documentId));
  if (!sess || !sess.active) throw new Error('revoked');
  if (sess.token !== token) throw new Error('token-mismatch');
  return sess;
}

/* ---------------- 消息处理 ---------------- */

/* 授权：同一标签页的旧会话全部作废，签发新令牌（重新授权必产生新令牌） */
async function handleAuthorize(msg, sender) {
  const documentId = sender.documentId;
  const tabId = sender.tab && sender.tab.id;
  if (!documentId || tabId == null) throw new Error('missing-sender-info');
  const origin = sender.origin || (s300(msg.origin) ? msg.origin : '');
  if (!origin) throw new Error('missing-origin');
  const route = s300(msg.route) ? msg.route : '/';
  const token = crypto.randomUUID();
  const now = Date.now();
  await withTx([STORE_SESSIONS], 'readwrite', async (s) => {
    const all = await reqp(s[STORE_SESSIONS].getAll());
    for (const sess of all) {
      if (sess.tabId === tabId && sess.active) {
        sess.active = false;
        sess.revokedAt = now;
        sess.revokedReason = 'superseded';
        await reqp(s[STORE_SESSIONS].put(sess));
      }
    }
    await reqp(s[STORE_SESSIONS].put({
      documentId, tabId, token, origin, route, createdAt: now, active: true,
    }));
  });
  return { ok: true, token };
}

/* 令牌是否仍然有效（内容脚本在重复注入时先探活，避免无谓换令牌） */
async function handlePing(msg, sender) {
  try {
    await withTx([STORE_SESSIONS], 'readonly', async (s) => {
      await getValidSession(s, sender, msg.token);
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/* 绑定：把当前文档登记为该草稿键的写入者（取代旧写入者） */
async function handleBind(msg, sender) {
  if (!s300(msg.formId)) throw new Error('bad-form-id');
  const rawFields = Array.isArray(msg.fields) ? msg.fields.slice(0, MAX_FIELDS_PER_FORM) : [];
  const fields = [];
  for (const f of rawFields) {
    if (!f || typeof f !== 'object') continue;
    if (!s300(f.key)) continue;
    if (f.keyType !== 'id' && f.keyType !== 'name') continue;
    if (typeof f.type !== 'string' || !f.type || f.type.length > 40) continue;
    fields.push({ key: f.key, keyType: f.keyType, type: f.type });
  }
  if (!fields.length) throw new Error('no-fields');
  return withTx([STORE_SESSIONS, STORE_WRITERS, STORE_DRAFTS], 'readwrite', async (s) => {
    const sess = await getValidSession(s, sender, msg.token);
    const key = draftKey(sess.origin, sess.route, msg.formId);
    await reqp(s[STORE_WRITERS].put({
      key,
      token: sess.token,
      documentId: sender.documentId,
      tabId: sess.tabId,
      formId: msg.formId,
      fields,
      updatedAt: Date.now(),
    }));
    const draft = await reqp(s[STORE_DRAFTS].get(key));
    return { ok: true, key, rev: draft ? draft.rev : 0 };
  });
}

/* 保存：校验会话 + 写入者身份，逐字段递增修订号；值未变化不产生新修订 */
async function handleSave(msg, sender) {
  if (!s300(msg.formId)) throw new Error('bad-form-id');
  const input = msg.fields && typeof msg.fields === 'object' ? msg.fields : {};
  const entries = Object.entries(input).slice(0, MAX_FIELDS_PER_FORM * 3);
  return withTx([STORE_SESSIONS, STORE_WRITERS, STORE_DRAFTS], 'readwrite', async (s) => {
    const sess = await getValidSession(s, sender, msg.token);
    const key = draftKey(sess.origin, sess.route, msg.formId);
    const writer = await reqp(s[STORE_WRITERS].get(key));
    if (!writer || writer.token !== sess.token || writer.documentId !== sender.documentId) {
      throw new Error('writer-mismatch'); // 旧页面/旧令牌的迟到保存在此被拒绝
    }
    const meta = new Map(writer.fields.map((f) => [f.key, f]));
    const now = Date.now();
    let draft = await reqp(s[STORE_DRAFTS].get(key));
    if (!draft) {
      draft = {
        key, origin: sess.origin, route: sess.route, formId: msg.formId,
        rev: 0, fields: {}, createdAt: now, updatedAt: now,
      };
    }
    let changed = 0;
    for (const [fk, fv] of entries) {
      const fm = meta.get(fk);
      if (!fm || typeof fv !== 'string') continue; // 只接受绑定时登记过的字段
      const value = fv.slice(0, MAX_VALUE_LEN);
      const existing = draft.fields[fk];
      if (existing && existing.value === value) continue;
      draft.rev += 1;
      draft.fields[fk] = { value, rev: draft.rev, keyType: fm.keyType, type: fm.type, updatedAt: now };
      changed += 1;
    }
    if (changed) {
      draft.updatedAt = now;
      await reqp(s[STORE_DRAFTS].put(draft));
    }
    return { ok: true, rev: draft.rev };
  });
}

/* 列出当前 origin 下的全部草稿（含各路由） */
async function handleListDrafts(msg, sender) {
  return withTx([STORE_SESSIONS, STORE_DRAFTS], 'readonly', async (s) => {
    const sess = await getValidSession(s, sender, msg.token);
    const all = await reqp(s[STORE_DRAFTS].getAll());
    const drafts = all
      .filter((d) => d.origin === sess.origin)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return { ok: true, drafts };
  });
}

/* 读取单个草稿（用于恢复预览） */
async function handleGetDraft(msg, sender) {
  return withTx([STORE_SESSIONS, STORE_DRAFTS], 'readonly', async (s) => {
    const sess = await getValidSession(s, sender, msg.token);
    const key = String(msg.key || '');
    if (!key.startsWith(sess.origin + '::')) throw new Error('origin-mismatch');
    const draft = await reqp(s[STORE_DRAFTS].get(key));
    return { ok: true, draft: draft || null };
  });
}

/* 清理：只删除 rev <= upToRev 的修订；确认期间产生的新输入（更大 rev）保留 */
async function handleCleanup(msg, sender) {
  const upToRev = Number.isFinite(msg.upToRev) ? Math.max(0, Math.floor(msg.upToRev)) : 0;
  return withTx([STORE_SESSIONS, STORE_WRITERS, STORE_DRAFTS], 'readwrite', async (s) => {
    const sess = await getValidSession(s, sender, msg.token);
    const key = String(msg.key || '');
    if (!key.startsWith(sess.origin + '::')) throw new Error('origin-mismatch');
    const writer = await reqp(s[STORE_WRITERS].get(key));
    if (!writer || writer.token !== sess.token || writer.documentId !== sender.documentId) {
      throw new Error('writer-mismatch');
    }
    const draft = await reqp(s[STORE_DRAFTS].get(key));
    if (!draft) return { ok: true, deleted: 0, remaining: 0 };
    let deleted = 0;
    for (const [fk, f] of Object.entries(draft.fields)) {
      if (f && typeof f.rev === 'number' && f.rev <= upToRev) {
        delete draft.fields[fk];
        deleted += 1;
      }
    }
    const remaining = Object.keys(draft.fields).length;
    if (remaining === 0) await reqp(s[STORE_DRAFTS].delete(key));
    else await reqp(s[STORE_DRAFTS].put(draft));
    return { ok: true, deleted, remaining };
  });
}

/* 撤销授权：仅吊销 sender.documentId 自己的会话 */
async function handleRevoke(msg, sender) {
  return withTx([STORE_SESSIONS], 'readwrite', async (s) => {
    const sess = await reqp(s[STORE_SESSIONS].get(sender.documentId));
    if (sess && sess.active) {
      sess.active = false;
      sess.revokedAt = Date.now();
      sess.revokedReason = 'user';
      await reqp(s[STORE_SESSIONS].put(sess));
    }
    return { ok: true };
  });
}

/* ---------------- 过期清理 ---------------- */

async function runGC() {
  const now = Date.now();
  return withTx([STORE_SESSIONS, STORE_WRITERS, STORE_DRAFTS], 'readwrite', async (s) => {
    let draftsDeleted = 0;
    let sessionsDeleted = 0;
    let writersDeleted = 0;
    const drafts = await reqp(s[STORE_DRAFTS].getAll());
    for (const d of drafts) {
      if (!d.updatedAt || now - d.updatedAt > DRAFT_TTL_MS) {
        await reqp(s[STORE_DRAFTS].delete(d.key));
        draftsDeleted += 1;
      }
    }
    const sessions = await reqp(s[STORE_SESSIONS].getAll());
    for (const x of sessions) {
      if (now - x.createdAt > SESSION_TTL_MS) {
        await reqp(s[STORE_SESSIONS].delete(x.documentId));
        sessionsDeleted += 1;
      }
    }
    const writers = await reqp(s[STORE_WRITERS].getAll());
    for (const w of writers) {
      if (now - w.updatedAt > WRITER_TTL_MS) {
        await reqp(s[STORE_WRITERS].delete(w.key));
        writersDeleted += 1;
      }
    }
    return { draftsDeleted, sessionsDeleted, writersDeleted };
  });
}

async function handleRunGCNow(msg, sender) {
  await withTx([STORE_SESSIONS], 'readonly', async (s) => {
    await getValidSession(s, sender, msg.token);
  });
  const summary = await runGC();
  return { ok: true, ...summary };
}

/* ---------------- 路由与生命周期 ---------------- */

const HANDLERS = {
  authorize: handleAuthorize,
  ping: handlePing,
  bind: handleBind,
  save: handleSave,
  'list-drafts': handleListDrafts,
  'get-draft': handleGetDraft,
  cleanup: handleCleanup,
  revoke: handleRevoke,
  'run-gc-now': handleRunGCNow,
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return false;
  const handler = HANDLERS[msg.type];
  if (!handler) return false;
  handler(msg, sender).then(
    (resp) => sendResponse(resp),
    (e) => sendResponse({ ok: false, error: String((e && e.message) || e) }),
  );
  return true; // 异步 sendResponse
});

/* 仅在用户点击扩展图标（activeTab 授权）后注入顶层文档；不注入 iframe */
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || tab.id == null) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id }, // 默认 allFrames:false，仅顶层框架
      files: ['content.js'],
    });
  } catch (e) {
    // chrome:// 页面、Web Store 等无法注入的页面直接忽略
    console.warn('inject failed:', e && e.message);
  }
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(GC_ALARM, { periodInMinutes: GC_PERIOD_MIN });
});

chrome.runtime.onStartup.addListener(() => {
  runGC().catch(() => {});
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm && alarm.name === GC_ALARM) runGC().catch(() => {});
});

/* service worker 被唤醒时确保清理闹钟存在（闹钟本身可跨重启存活） */
chrome.alarms.get(GC_ALARM).then((alarm) => {
  if (!alarm) chrome.alarms.create(GC_ALARM, { periodInMinutes: GC_PERIOD_MIN });
});
