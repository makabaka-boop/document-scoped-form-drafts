/* 表单草稿保存器 · 内容脚本
 *
 * 仅在用户点击扩展图标（activeTab 授权）后由后台注入顶层文档，不进入 iframe。
 * 只读取用户勾选字段的值，不采集完整 DOM，不进行任何网络上传。
 */
'use strict';
(function () {
  if (window.top !== window) return; // 双保险：即使被注入子框架也直接退出

  const INSTANCE_KEY = '__formDraftSaverInstance__';
  if (window[INSTANCE_KEY]) {
    // 同一文档重复注入：先探活，令牌失效才重新授权
    window[INSTANCE_KEY].wake();
    return;
  }

  /* ================= 常量 ================= */

  const MAX_FIELDS = 20;               // 每个表单最多可保存的字段数
  const SAVE_DEBOUNCE_MS = 600;        // 输入防抖
  const WATCH_MS = 800;                // 路由/表单存活轮询
  const ALLOWED_TYPES = new Set(['text', 'email', 'url', 'tel', 'search', 'number']);
  const BLOCKED_AC_TOKENS = new Set(['one-time-code', 'current-password', 'new-password']);

  /* ================= 工具 ================= */

  const routeOf = () => location.pathname + location.search + location.hash;
  const originOf = () => location.origin;

  function send(msg) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (v) => { if (!settled) { settled = true; resolve(v); } };
      try {
        chrome.runtime.sendMessage(msg, (resp) => {
          const err = chrome.runtime.lastError;
          if (err) done({ ok: false, error: err.message || 'runtime-error' });
          else done(resp || { ok: false, error: 'empty-response' });
        });
      } catch (e) {
        done({ ok: false, error: String((e && e.message) || e) });
      }
    });
  }

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
  const trunc = (s, n) => {
    const v = String(s);
    return v.length > n ? v.slice(0, n) + '…' : v;
  };
  const fmtTime = (ts) => {
    try { return new Date(ts).toLocaleString(); } catch (_) { return String(ts); }
  };
  const fieldTypeOf = (el) => (el.tagName === 'TEXTAREA' ? 'textarea' : el.type);

  /* ================= 字段规则 ================= */

  /* 普通文本字段 + 表单内唯一身份（id 优先，其次 name）；否则返回 null */
  function eligibleField(el, form) {
    const tag = el.tagName;
    let type;
    if (tag === 'TEXTAREA') {
      type = 'textarea';
    } else if (tag === 'INPUT') {
      if (!ALLOWED_TYPES.has(el.type)) return null; // password/file/hidden/按钮等一律排除
      type = el.type;
    } else {
      return null;
    }
    if (el.disabled || el.readOnly) return null;
    const ac = (el.getAttribute('autocomplete') || '').trim().toLowerCase();
    if (ac) {
      const tokens = ac.split(/\s+/);
      // 一次性验证码、支付自动填充（cc-*）、密码类自动填充始终排除
      if (tokens.some((t) => BLOCKED_AC_TOKENS.has(t) || t.startsWith('cc-'))) return null;
    }
    let key = null;
    let keyType = null;
    if (el.id) {
      try {
        if (form.querySelectorAll('#' + CSS.escape(el.id)).length === 1) {
          key = el.id;
          keyType = 'id';
        }
      } catch (_) { /* 非法选择器则放弃 id */ }
    }
    if (!key && el.name) {
      let count = 0;
      for (const e of form.elements) if (e.name && e.name === el.name) count += 1;
      if (count === 1) {
        key = el.name;
        keyType = 'name';
      }
    }
    if (!key) return null;
    let label = '';
    try {
      if (el.labels && el.labels[0]) label = el.labels[0].textContent.trim();
    } catch (_) { /* 忽略 */ }
    if (!label) label = el.getAttribute('placeholder') || '';
    return { key, keyType, type, label: trunc(label, 24) };
  }

  /* 按记录的身份在当前表单中定位字段；身份或类型不符即拒绝，绝不猜测相近输入框 */
  function findField(formEl, meta) {
    if (!formEl || !formEl.isConnected) return { error: '表单不在文档中' };
    let el = null;
    if (meta.keyType === 'id') {
      const found = document.getElementById(meta.key);
      if (!found || !formEl.contains(found)) return { error: '字段不存在' };
      el = found;
    } else {
      const matches = [];
      for (const e of formEl.elements) if (e.name === meta.key) matches.push(e);
      if (matches.length === 0) return { error: '字段不存在' };
      if (matches.length > 1) return { error: '字段不再唯一' };
      el = matches[0];
    }
    const nowType = fieldTypeOf(el);
    if (nowType !== meta.type) return { error: `类型已变化（${meta.type} → ${nowType}）` };
    if (el.disabled || el.readOnly) return { error: '字段不可编辑' };
    return { el };
  }

  /* 扫描文档中带唯一 id 的表单 */
  function scanForms() {
    const out = [];
    for (const form of document.querySelectorAll('form[id]')) {
      const id = form.getAttribute('id') || '';
      if (!id) continue;
      let unique = false;
      try {
        unique = document.querySelectorAll('#' + CSS.escape(id)).length === 1
          && document.getElementById(id) === form;
      } catch (_) { unique = false; }
      if (!unique) continue;
      const fields = [];
      let excluded = 0;
      let overflow = 0;
      for (const el of form.elements) {
        const meta = eligibleField(el, form);
        if (meta) {
          if (fields.length < MAX_FIELDS) fields.push(meta);
          else overflow += 1;
        } else {
          excluded += 1;
        }
      }
      out.push({ formEl: form, formId: id, fields, excluded, overflow });
    }
    return out;
  }

  /* ================= 面板样式 ================= */

  const CSS_TEXT = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .panel { position: fixed; top: 16px; right: 16px; width: 388px; max-height: 84vh;
      display: flex; flex-direction: column; background: #fff; color: #1f2328;
      border: 1px solid #d0d7de; border-radius: 10px; box-shadow: 0 10px 32px rgba(31,35,40,.22);
      font: 13px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
      "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
      z-index: 2147483647; overflow: hidden; }
    .hd { display: flex; align-items: center; gap: 8px; padding: 8px 10px;
      background: #f6f8fa; border-bottom: 1px solid #d0d7de; }
    .ttl { font-weight: 600; }
    .st { margin-left: auto; font-size: 12px; color: #57606a; }
    .st.ok { color: #1a7f37; } .st.bad { color: #cf222e; }
    .ic { border: none; background: transparent; cursor: pointer; font-size: 14px;
      color: #57606a; padding: 2px 6px; }
    .bd { padding: 10px; overflow-y: auto; }
    h3 { font-size: 12px; color: #57606a; margin: 12px 0 6px;
      border-bottom: 1px dashed #d0d7de; padding-bottom: 4px; font-weight: 600; }
    .card { border: 1px solid #d0d7de; border-radius: 8px; padding: 8px; margin: 6px 0; }
    .card-hd { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; flex-wrap: wrap; }
    code { background: #eff1f3; padding: 1px 5px; border-radius: 4px; font-size: 12px; }
    .tag { font-size: 11px; padding: 1px 6px; border-radius: 10px; background: #eff1f3; color: #57606a; }
    .tag.ok { background: #dafbe1; color: #1a7f37; }
    .tag.warn { background: #fff8c5; color: #9a6700; }
    .dim { color: #57606a; font-size: 12px; margin: 4px 0; }
    .fl { list-style: none; margin: 4px 0; padding: 0; max-height: 180px; overflow-y: auto; }
    .fl li { padding: 2px 0; }
    .fl label { display: flex; gap: 6px; align-items: baseline; cursor: pointer; }
    .fk { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
    .val { color: #0969da; word-break: break-all; }
    .pv { list-style: none; margin: 4px 0; padding: 0; font-size: 12px; }
    .row { display: flex; gap: 6px; margin-top: 6px; flex-wrap: wrap; }
    button { font: inherit; font-size: 12px; padding: 4px 10px; border: 1px solid #d0d7de;
      border-radius: 6px; background: #f6f8fa; cursor: pointer; color: #1f2328; }
    button:hover:not(:disabled) { background: #eaeef2; }
    button:disabled { opacity: .5; cursor: not-allowed; }
    button.danger { color: #cf222e; border-color: rgba(207,34,46,.4); }
    .notice { padding: 6px 8px; border-radius: 6px; margin-bottom: 8px; font-size: 12px; }
    .notice.info { background: #ddf4ff; color: #0969da; }
    .notice.ok { background: #dafbe1; color: #1a7f37; }
    .notice.warn { background: #fff8c5; color: #9a6700; }
    .notice.err { background: #ffebe9; color: #cf222e; }
    .ft { display: flex; gap: 6px; margin-top: 10px; padding-top: 8px;
      border-top: 1px solid #d0d7de; flex-wrap: wrap; }
    .fab { position: fixed; right: 16px; top: 16px; z-index: 2147483647; width: 40px; height: 40px;
      border-radius: 50%; border: 1px solid #d0d7de; background: #fff;
      box-shadow: 0 4px 14px rgba(31,35,40,.25); cursor: pointer; font-size: 18px; }
  `;

  /* ================= 应用 ================= */

  class App {
    constructor() {
      this.token = null;
      this.authOk = false;
      this.route = routeOf();
      this.scanned = [];               // 扫描到的表单
      this.selected = new Map();       // formId -> Set<fieldKey>
      this.bindings = new Map();       // formId -> { status, fields, formEl, lastAckedRev, ... }
      this.drafts = [];                // 本 origin 的草稿
      this.restorePreview = null;      // 恢复预览状态
      this.cleanupConfirm = null;      // 清理确认状态
      this.notice = null;
      this.min = false;
      this.suppress = false;           // 恢复写入时抑制自动保存
      this._tick = () => this.tick();
      this._draftsTimer = 0;
      this.buildPanel();
      this.start();
    }

    /* ---------- 面板骨架 ---------- */

    buildPanel() {
      const host = document.createElement('div');
      host.setAttribute('data-fds-host', '');
      this.shadow = host.attachShadow({ mode: 'open' });
      this.shadow.innerHTML = `
        <style>${CSS_TEXT}</style>
        <div class="panel">
          <div class="hd">
            <span class="ttl">表单草稿</span>
            <span class="st"></span>
            <button class="ic" data-action="toggle-min" title="收起/展开">▾</button>
            <button class="ic" data-action="hide" title="隐藏面板">×</button>
          </div>
          <div class="bd">
            <div class="notice" hidden></div>
            <div data-sec="restore"></div>
            <div data-sec="cleanup"></div>
            <div data-sec="forms"></div>
            <div data-sec="drafts"></div>
            <div class="ft">
              <button data-action="rescan">重新扫描</button>
              <button data-action="gc">运行过期清理</button>
              <button data-action="revoke" class="danger">撤销授权</button>
            </div>
          </div>
        </div>
        <button class="fab" data-action="show" hidden title="打开表单草稿面板">📝</button>
      `;
      document.documentElement.appendChild(host);
      this.$panel = this.shadow.querySelector('.panel');
      this.$bd = this.shadow.querySelector('.bd');
      this.$fab = this.shadow.querySelector('.fab');
      this.$st = this.shadow.querySelector('.st');
      this.$minBtn = this.shadow.querySelector('[data-action="toggle-min"]');
      this.$notice = this.shadow.querySelector('.notice');
      this.$forms = this.shadow.querySelector('[data-sec="forms"]');
      this.$drafts = this.shadow.querySelector('[data-sec="drafts"]');
      this.$restore = this.shadow.querySelector('[data-sec="restore"]');
      this.$cleanup = this.shadow.querySelector('[data-sec="cleanup"]');

      this.shadow.addEventListener('click', (e) => {
        const t = e.target.closest('[data-action]');
        if (t) this.onAction(t.dataset.action, t.dataset);
      });
      this.shadow.addEventListener('change', (e) => {
        const t = e.target;
        if (t.matches('input[type="checkbox"][data-form][data-key]')) {
          const set = this.selected.get(t.dataset.form) || new Set();
          if (t.checked) set.add(t.dataset.key);
          else set.delete(t.dataset.key);
          this.selected.set(t.dataset.form, set);
          this.renderForms();
        }
      });
    }

    async start() {
      const resp = await send({ type: 'authorize', origin: originOf(), route: this.route });
      if (resp.ok) {
        this.token = resp.token;
        this.authOk = true;
      } else {
        this.setNotice('授权失败：' + resp.error, 'err');
      }
      this.rescan();
      this.refreshDrafts();
      this.watch = setInterval(this._tick, WATCH_MS);
      window.addEventListener('popstate', this._tick);
      window.addEventListener('hashchange', this._tick);
      window.addEventListener('pagehide', () => this.flushAll());
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') this.flushAll();
      });
      this.render();
    }

    /* 重复注入时调用：令牌仍有效则只打开面板，否则重新授权（产生新令牌） */
    async wake() {
      const ping = await send({ type: 'ping', token: this.token });
      if (!ping.ok) {
        const resp = await send({ type: 'authorize', origin: originOf(), route: routeOf() });
        if (resp.ok) {
          this.token = resp.token;
          this.authOk = true;
          this.pauseAll('已重新授权，请重新绑定');
          this.setNotice('已重新授权（新文档令牌），原绑定已暂停，请重新选择字段', 'warn');
        } else {
          this.authOk = false;
          this.setNotice('重新授权失败：' + resp.error, 'err');
        }
      }
      this.route = routeOf();
      this.show();
      await this.refreshDrafts();
      this.render();
    }

    /* ---------- 动作分发 ---------- */

    onAction(action, ds) {
      switch (action) {
        case 'toggle-min':
          this.min = !this.min;
          this.$bd.hidden = this.min;
          this.$minBtn.textContent = this.min ? '▸' : '▾';
          break;
        case 'hide': this.hide(); break;
        case 'show': this.show(); break;
        case 'rescan': this.rescan(); this.setNotice('已重新扫描当前页面', 'info'); break;
        case 'bind': this.bindForm(ds.form); break;
        case 'unbind': this.unbindForm(ds.form); break;
        case 'preview-restore': this.previewRestore(ds.key); break;
        case 'confirm-restore': this.confirmRestore(); break;
        case 'cancel-restore': this.restorePreview = null; this.render(); break;
        case 'cleanup': this.requestCleanup(ds.key); break;
        case 'confirm-cleanup': this.confirmCleanup(); break;
        case 'cancel-cleanup': this.cleanupConfirm = null; this.render(); break;
        case 'revoke': this.revoke(); break;
        case 'gc': this.runGC(); break;
        default: break;
      }
    }

    show() { this.$panel.hidden = false; this.$fab.hidden = true; }
    hide() { this.$panel.hidden = true; this.$fab.hidden = false; }

    /* ---------- 授权 ---------- */

    async reauthorize() {
      const resp = await send({ type: 'authorize', origin: originOf(), route: this.route });
      if (resp.ok) {
        this.token = resp.token;
        this.authOk = true;
        this.refreshDrafts();
        this.render();
      } else {
        this.onAuthLost(resp.error);
      }
    }

    async revoke() {
      await send({ type: 'revoke', token: this.token });
      this.token = null;
      this.authOk = false;
      this.pauseAll('授权已撤销');
      this.setNotice('授权已撤销。再次点击工具栏扩展图标可重新授权。', 'warn');
      this.render();
    }

    onAuthLost(reason) {
      this.authOk = false;
      this.pauseAll('授权已失效（' + reason + '）');
      this.setNotice('授权已失效或被取代，请重新点击扩展图标重新授权', 'err');
      this.render();
    }

    /* ---------- 扫描与绑定 ---------- */

    rescan() {
      for (const [id, b] of this.bindings) {
        if (b.status === 'paused') this.bindings.delete(id); // 已暂停的绑定需重新选择
      }
      this.scanned = scanForms();
      const valid = new Map();
      for (const s of this.scanned) {
        const keys = new Set(s.fields.map((f) => f.key));
        const prev = this.selected.get(s.formId) || new Set();
        valid.set(s.formId, new Set([...prev].filter((k) => keys.has(k))));
      }
      this.selected = valid;
      this.render();
    }

    async bindForm(formId) {
      if (!this.authOk || !this.token) {
        this.setNotice('尚未授权，请点击工具栏扩展图标', 'err');
        return;
      }
      const scan = this.scanned.find((s) => s.formId === formId);
      const keys = this.selected.get(formId);
      if (!scan || !keys || keys.size === 0) {
        this.setNotice('请先勾选要保存的字段', 'warn');
        return;
      }
      const fields = scan.fields
        .filter((f) => keys.has(f.key))
        .slice(0, MAX_FIELDS)
        .map((f) => ({ key: f.key, keyType: f.keyType, type: f.type }));
      const resp = await send({ type: 'bind', token: this.token, formId, fields });
      if (!resp.ok) {
        if (resp.error === 'revoked' || resp.error === 'token-mismatch') this.onAuthLost(resp.error);
        else this.setNotice('绑定失败：' + resp.error, 'err');
        return;
      }
      const b = {
        formId,
        formEl: scan.formEl,
        fields,
        status: 'bound',
        reason: '',
        lastAckedRev: resp.rev || 0,
        timer: 0,
        listeners: [],
      };
      for (const f of fields) {
        const found = findField(scan.formEl, f);
        if (!found.el) continue;
        const fn = () => { if (!this.suppress) this.scheduleSave(formId); };
        found.el.addEventListener('input', fn);
        found.el.addEventListener('change', fn);
        b.listeners.push([found.el, fn]);
      }
      this.bindings.set(formId, b);
      this.setNotice(`已绑定表单 #${formId}（${fields.length} 个字段），输入将自动保存草稿`, 'ok');
      this.refreshDrafts();
      this.render();
    }

    unbindForm(formId) {
      const b = this.bindings.get(formId);
      if (b) this.detach(b);
      this.bindings.delete(formId);
      this.render();
    }

    detach(b) {
      clearTimeout(b.timer);
      for (const [el, fn] of b.listeners) {
        el.removeEventListener('input', fn);
        el.removeEventListener('change', fn);
      }
      b.listeners = [];
    }

    pauseBinding(formId, reason) {
      const b = this.bindings.get(formId);
      if (!b || b.status !== 'bound') return;
      this.detach(b);
      b.status = 'paused';
      b.reason = reason;
      this.render();
    }

    pauseAll(reason) {
      for (const [formId] of this.bindings) this.pauseBinding(formId, reason);
    }

    /* ---------- 保存 ---------- */

    scheduleSave(formId) {
      const b = this.bindings.get(formId);
      if (!b || b.status !== 'bound') return;
      clearTimeout(b.timer);
      b.timer = setTimeout(() => this.saveNow(formId), SAVE_DEBOUNCE_MS);
    }

    async saveNow(formId) {
      const b = this.bindings.get(formId);
      if (!b || b.status !== 'bound' || !this.token) return;
      const fields = {};
      for (const f of b.fields) {
        const found = findField(b.formEl, f);
        if (!found.el) {
          this.pauseBinding(formId, `字段 ${f.key} 身份变化：${found.error}`);
          return;
        }
        fields[f.key] = found.el.value;
      }
      const resp = await send({ type: 'save', token: this.token, formId, fields });
      if (!resp.ok) {
        if (resp.error === 'writer-mismatch') {
          this.pauseBinding(formId, '绑定已被其它页面取代，请重新绑定');
        } else if (resp.error === 'revoked' || resp.error === 'token-mismatch') {
          this.onAuthLost(resp.error);
        } else {
          this.setNotice('保存失败：' + resp.error, 'err');
        }
        return;
      }
      b.lastAckedRev = resp.rev;
      this.refreshDraftsSoon();
    }

    flushAll() {
      for (const [formId, b] of this.bindings) {
        if (b.status === 'bound' && b.timer) {
          clearTimeout(b.timer);
          b.timer = 0;
          this.saveNow(formId);
        }
      }
    }

    /* ---------- 草稿 ---------- */

    async refreshDrafts() {
      if (!this.token) return;
      const resp = await send({ type: 'list-drafts', token: this.token });
      if (resp.ok) {
        this.drafts = resp.drafts || [];
        this.renderDrafts();
      } else if (resp.error === 'revoked' || resp.error === 'token-mismatch') {
        this.onAuthLost(resp.error);
      }
    }

    refreshDraftsSoon() {
      clearTimeout(this._draftsTimer);
      this._draftsTimer = setTimeout(() => this.refreshDrafts(), 800);
    }

    /* ---------- 恢复 ---------- */

    async previewRestore(key) {
      const resp = await send({ type: 'get-draft', token: this.token, key });
      if (!resp.ok) {
        this.setNotice('读取草稿失败：' + resp.error, 'err');
        return;
      }
      const draft = resp.draft;
      if (!draft) {
        this.setNotice('草稿不存在（可能已被清理）', 'warn');
        this.refreshDrafts();
        return;
      }
      const formEl = document.getElementById(draft.formId);
      const formOk = formEl && formEl.tagName === 'FORM';
      const rows = [];
      for (const [fk, f] of Object.entries(draft.fields)) {
        const meta = { key: fk, keyType: f.keyType, type: f.type };
        if (!formOk) {
          rows.push({ meta, value: f.value, ok: false, error: '表单不存在' });
          continue;
        }
        const found = findField(formEl, meta);
        rows.push({ meta, value: f.value, ok: !!found.el, error: found.error || null });
      }
      this.restorePreview = { key, formId: draft.formId, rows };
      this.render();
    }

    confirmRestore() {
      const rp = this.restorePreview;
      if (!rp) return;
      const formEl = document.getElementById(rp.formId);
      let ok = 0;
      const refused = [];
      this.suppress = true;
      try {
        for (const row of rp.rows) {
          // 写入前再次校验：预览之后 DOM 可能又发生变化
          const found = formEl && formEl.tagName === 'FORM' ? findField(formEl, row.meta) : { error: '表单不存在' };
          if (!found.el) {
            refused.push(`${row.meta.key}（${found.error}）`);
            continue;
          }
          found.el.value = row.value;
          found.el.dispatchEvent(new Event('input', { bubbles: true }));
          found.el.dispatchEvent(new Event('change', { bubbles: true }));
          ok += 1;
        }
      } finally {
        this.suppress = false;
      }
      this.restorePreview = null;
      this.setNotice(
        refused.length
          ? `已恢复 ${ok} 项；拒绝 ${refused.length} 项：${refused.join('、')}`
          : `已恢复 ${ok} 项`,
        refused.length ? 'warn' : 'ok',
      );
      this.render();
    }

    /* ---------- 清理 ---------- */

    requestCleanup(key) {
      const d = this.drafts.find((x) => x.key === key);
      if (!d) return;
      const b = this.bindings.get(d.formId);
      if (!b || b.status !== 'bound') {
        this.setNotice('只有当前已绑定的表单才能清理其草稿', 'warn');
        return;
      }
      // 记录用户确认时已保存到的修订号；之后的新输入（更大修订号）会被保留
      this.cleanupConfirm = { key, formId: d.formId, upToRev: b.lastAckedRev };
      this.render();
    }

    async confirmCleanup() {
      const cc = this.cleanupConfirm;
      if (!cc) return;
      const resp = await send({ type: 'cleanup', token: this.token, key: cc.key, upToRev: cc.upToRev });
      this.cleanupConfirm = null;
      if (!resp.ok) {
        this.setNotice('清理失败：' + resp.error, 'err');
      } else {
        this.setNotice(
          resp.remaining
            ? `已清理 ${resp.deleted} 项修订；保留 ${resp.remaining} 项确认期间的新输入`
            : `已清理 ${resp.deleted} 项修订，草稿已删除`,
          'ok',
        );
      }
      await this.refreshDrafts();
      this.render();
    }

    async runGC() {
      const resp = await send({ type: 'run-gc-now', token: this.token });
      if (resp.ok) {
        this.setNotice(
          `过期清理完成：删除草稿 ${resp.draftsDeleted}、会话 ${resp.sessionsDeleted}、绑定 ${resp.writersDeleted}`,
          'ok',
        );
        this.refreshDrafts();
      } else {
        this.setNotice('清理失败：' + resp.error, 'err');
      }
    }

    /* ---------- 路由与表单存活监控 ---------- */

    tick() {
      const r = routeOf();
      let dirty = false;
      if (r !== this.route) {
        // SPA 换路由：暂停全部绑定并要求重新选择；同时换发新令牌（会话路由随之更新）
        this.route = r;
        this.pauseAll('页面路由已变化');
        this.setNotice('检测到路由变化，绑定已暂停，请重新选择字段', 'warn');
        this.reauthorize();
        dirty = true;
      }
      for (const [formId, b] of this.bindings) {
        if (b.status === 'bound' && !b.formEl.isConnected) {
          this.pauseBinding(formId, '表单已被替换或移除');
          this.setNotice(`表单 #${formId} 已不在文档中，绑定暂停，请重新扫描`, 'warn');
          dirty = true;
        }
      }
      if (dirty) this.render();
    }

    /* ---------- 渲染 ---------- */

    setNotice(text, kind) {
      this.notice = { text, kind: kind || 'info' };
      this.renderNotice();
    }

    renderNotice() {
      const n = this.$notice;
      if (!this.notice) { n.hidden = true; return; }
      n.hidden = false;
      n.className = 'notice ' + this.notice.kind;
      n.textContent = this.notice.text;
    }

    render() {
      this.renderStatus();
      this.renderNotice();
      this.renderRestore();
      this.renderCleanup();
      this.renderForms();
      this.renderDrafts();
    }

    renderStatus() {
      this.$st.textContent = this.authOk ? '已授权' : '未授权';
      this.$st.className = 'st ' + (this.authOk ? 'ok' : 'bad');
    }

    renderForms() {
      let html = '<h3>选择要保存的字段</h3>';
      if (!this.scanned.length) {
        html += '<p class="dim">未找到带唯一 id 的表单。</p>';
      }
      for (const s of this.scanned) {
        const b = this.bindings.get(s.formId);
        html += '<div class="card"><div class="card-hd"><code>#' + esc(s.formId) + '</code>';
        if (b && b.status === 'bound') {
          html += `<span class="tag ok">已绑定 · 修订 ${b.lastAckedRev}</span>`;
        } else if (b && b.status === 'paused') {
          html += '<span class="tag warn">已暂停</span>';
        }
        html += '</div>';
        if (b && b.status === 'paused') {
          html += `<p class="dim">原因：${esc(b.reason || '')}。请重新扫描并绑定。</p>`;
        }
        if (!s.fields.length) {
          html += '<p class="dim">表单内没有可保存的文本字段。</p>';
        } else {
          const sel = this.selected.get(s.formId) || new Set();
          const locked = b && b.status === 'bound';
          html += '<ul class="fl">';
          for (const f of s.fields) {
            const checked = locked ? b.fields.some((x) => x.key === f.key) : sel.has(f.key);
            html += `<li><label><input type="checkbox" data-form="${esc(s.formId)}" data-key="${esc(f.key)}"`
              + `${checked ? ' checked' : ''}${locked ? ' disabled' : ''}>`
              + `<span class="fk">${esc(f.key)}</span>`
              + `<span class="dim">${esc(f.keyType)} · ${esc(f.type)}${f.label ? ' · ' + esc(f.label) : ''}</span>`
              + '</label></li>';
          }
          html += '</ul>';
          if (s.overflow > 0) html += `<p class="dim">已达 ${MAX_FIELDS} 项上限，忽略 ${s.overflow} 个字段。</p>`;
          if (locked) {
            html += `<div class="row"><button data-action="unbind" data-form="${esc(s.formId)}">解绑</button></div>`;
          } else {
            html += `<div class="row"><button data-action="bind" data-form="${esc(s.formId)}"${sel.size ? '' : ' disabled'}>绑定选中（${sel.size}）</button></div>`;
          }
        }
        if (s.excluded > 0) html += `<p class="dim">已排除 ${s.excluded} 个不符合条件的控件。</p>`;
        html += '</div>';
      }
      this.$forms.innerHTML = html;
    }

    renderDrafts() {
      let html = `<h3>本地草稿（${esc(originOf())}）</h3>`;
      if (!this.drafts.length) html += '<p class="dim">暂无草稿。</p>';
      for (const d of this.drafts) {
        const keys = Object.keys(d.fields || {});
        const sameRoute = d.route === this.route;
        const formExists = !!document.getElementById(d.formId);
        const b = this.bindings.get(d.formId);
        const canCleanup = sameRoute && b && b.status === 'bound';
        html += '<div class="card">'
          + `<div class="card-hd"><code>#${esc(d.formId)}</code>`
          + `<span class="tag">${keys.length} 字段 · 修订 ${d.rev}</span></div>`
          + `<p class="dim">路由 ${esc(trunc(d.route, 60))} · 更新于 ${esc(fmtTime(d.updatedAt))}</p>`
          + '<ul class="pv">'
          + keys.slice(0, 3).map((k) => (
            `<li><span class="fk">${esc(k)}</span> = <span class="val">${esc(trunc(d.fields[k].value, 40))}</span></li>`
          )).join('')
          + (keys.length > 3 ? `<li class="dim">…共 ${keys.length} 项</li>` : '')
          + '</ul>'
          + '<div class="row">'
          + `<button data-action="preview-restore" data-key="${esc(d.key)}"${sameRoute && formExists ? '' : ' disabled'}>预览恢复</button>`
          + `<button data-action="cleanup" data-key="${esc(d.key)}"${canCleanup ? '' : ' disabled'}>我已提交，清理</button>`
          + '</div>'
          + (sameRoute ? '' : '<p class="dim">仅可在对应路由的页面恢复或清理。</p>')
          + '</div>';
      }
      this.$drafts.innerHTML = html;
    }

    renderRestore() {
      const rp = this.restorePreview;
      if (!rp) { this.$restore.innerHTML = ''; return; }
      const okCount = rp.rows.filter((r) => r.ok).length;
      let html = '<h3>恢复预览</h3><div class="card"><ul class="fl">';
      for (const r of rp.rows) {
        html += `<li>${r.ok ? '✅' : '⛔'} <span class="fk">${esc(r.meta.key)}</span>`
          + ` ← <span class="val">${esc(trunc(r.value, 50))}</span>`
          + (r.ok ? '' : ` <span class="dim">（${esc(r.error)}）</span>`)
          + '</li>';
      }
      html += '</ul>'
        + '<p class="dim">身份或类型不匹配的字段将被拒绝，不会尝试猜测相近输入框。</p>'
        + '<div class="row">'
        + `<button data-action="confirm-restore"${okCount ? '' : ' disabled'}>确认恢复（${okCount} 项）</button>`
        + '<button data-action="cancel-restore">取消</button>'
        + '</div></div>';
      this.$restore.innerHTML = html;
    }

    renderCleanup() {
      const cc = this.cleanupConfirm;
      if (!cc) { this.$cleanup.innerHTML = ''; return; }
      this.$cleanup.innerHTML = '<h3>确认清理</h3><div class="card">'
        + `<p>仅删除 <code>#${esc(cc.formId)}</code> 截至修订 <b>${cc.upToRev}</b> 的草稿内容；`
        + '确认期间产生的新输入会被保留。</p>'
        + '<div class="row">'
        + '<button data-action="confirm-cleanup" class="danger">确认清理</button>'
        + '<button data-action="cancel-cleanup">取消</button>'
        + '</div></div>';
    }
  }

  window[INSTANCE_KEY] = new App();
})();
