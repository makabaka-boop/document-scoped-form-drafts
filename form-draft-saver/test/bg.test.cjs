/* 后台逻辑功能测试：用 fake-indexeddb + chrome API 桩模拟真实消息流。
 * 运行：node test/bg.test.cjs
 */
'use strict';

const { indexedDB } = require('fake-indexeddb');

// ---- chrome API 桩 ----
const listeners = {};
global.chrome = {
  runtime: {
    onMessage: { addListener: (fn) => { listeners.message = fn; } },
    onInstalled: { addListener: (fn) => { listeners.installed = fn; } },
    onStartup: { addListener: (fn) => { listeners.startup = fn; } },
  },
  action: { onClicked: { addListener: (fn) => { listeners.clicked = fn; } } },
  alarms: {
    create: () => {},
    get: async () => null,
    onAlarm: { addListener: (fn) => { listeners.alarm = fn; } },
  },
  scripting: { executeScript: async () => {} },
};
global.indexedDB = indexedDB;

require('../background.js'); // 注册监听器

// ---- 消息发送辅助 ----
function sendMessage(msg, sender) {
  return new Promise((resolve, reject) => {
    const keepAlive = listeners.message(msg, sender, (resp) => resolve(resp));
    if (keepAlive !== true) reject(new Error('handler did not return true for ' + msg.type));
  });
}
const senderOf = (tabId, documentId, origin) => ({
  tab: { id: tabId }, documentId, origin,
});

// ---- 断言辅助 ----
let passed = 0;
let failed = 0;
function check(name, cond, extra) {
  if (cond) { passed += 1; console.log('  ✓', name); }
  else { failed += 1; console.log('  ✗', name, extra == null ? '' : JSON.stringify(extra)); }
}

(async () => {
  const ORIGIN = 'http://localhost:8765';
  const ROUTE = '/test/test-form.html';
  const KEY = `${ORIGIN}::${ROUTE}::profile_form`;

  console.log('== 1. 授权 / 绑定 / 保存 ==');
  const tabA = senderOf(1, 'doc-A1', ORIGIN);
  const authA = await sendMessage({ type: 'authorize', origin: ORIGIN, route: ROUTE }, tabA);
  check('授权返回令牌', authA.ok && typeof authA.token === 'string');
  const fields = [
    { key: 'f-name', keyType: 'id', type: 'text' },
    { key: 'email', keyType: 'name', type: 'email' },
  ];
  const bindA = await sendMessage({ type: 'bind', token: authA.token, formId: 'profile_form', fields }, tabA);
  check('绑定成功', bindA.ok && bindA.key === KEY, bindA);
  const save1 = await sendMessage({ type: 'save', token: authA.token, formId: 'profile_form', fields: { 'f-name': '张三', email: 'a@b.c' } }, tabA);
  check('保存成功 rev=2', save1.ok && save1.rev === 2, save1);
  const saveNoChange = await sendMessage({ type: 'save', token: authA.token, formId: 'profile_form', fields: { 'f-name': '张三' } }, tabA);
  check('值未变化不产生新修订', saveNoChange.ok && saveNoChange.rev === 2, saveNoChange);
  const saveUnbound = await sendMessage({ type: 'save', token: authA.token, formId: 'profile_form', fields: { hacker: 'x' } }, tabA);
  check('未绑定字段被忽略', saveUnbound.ok && saveUnbound.rev === 2, saveUnbound);

  console.log('== 2. 重新授权产生新令牌，旧令牌失效 ==');
  const tabA2 = senderOf(1, 'doc-A2', ORIGIN); // 同标签页新文档
  const authA2 = await sendMessage({ type: 'authorize', origin: ORIGIN, route: ROUTE }, tabA2);
  check('新令牌与旧令牌不同', authA2.ok && authA2.token !== authA.token);
  const saveOldToken = await sendMessage({ type: 'save', token: authA.token, formId: 'profile_form', fields: { 'f-name': '迟到覆盖' } }, tabA);
  check('旧文档迟到保存被拒绝', !saveOldToken.ok && saveOldToken.error === 'revoked', saveOldToken);
  const listAfterOld = await sendMessage({ type: 'list-drafts', token: authA2.token }, tabA2);
  check('旧页未覆盖草稿', listAfterOld.ok && listAfterOld.drafts[0].fields['f-name'].value === '张三',
    listAfterOld.drafts && listAfterOld.drafts[0]);

  console.log('== 3. 跨标签页 writer 取代 ==');
  const tabB = senderOf(2, 'doc-B1', ORIGIN);
  const authB = await sendMessage({ type: 'authorize', origin: ORIGIN, route: ROUTE }, tabB);
  const bindB = await sendMessage({ type: 'bind', token: authB.token, formId: 'profile_form', fields }, tabB);
  check('标签页 B 绑定成功', bindB.ok);
  const saveA2 = await sendMessage({ type: 'save', token: authA2.token, formId: 'profile_form', fields: { 'f-name': 'A2写入' } }, tabA2);
  check('被取代的写入者保存被拒绝(writer-mismatch)', !saveA2.ok && saveA2.error === 'writer-mismatch', saveA2);
  const saveB = await sendMessage({ type: 'save', token: authB.token, formId: 'profile_form', fields: { 'f-name': 'B写入' } }, tabB);
  check('当前写入者保存成功', saveB.ok && saveB.rev === 3, saveB);

  console.log('== 4. 清理只删确认过的修订 ==');
  // 当前 rev=3（f-name=B写入@rev3, email@rev2）。确认到 rev2，再新增输入到 rev4。
  const saveB2 = await sendMessage({ type: 'save', token: authB.token, formId: 'profile_form', fields: { 'f-name': 'B追加' } }, tabB);
  check('确认期间新输入 rev=4', saveB2.ok && saveB2.rev === 4, saveB2);
  const clean = await sendMessage({ type: 'cleanup', token: authB.token, key: KEY, upToRev: 2 }, tabB);
  check('清理删除 1 项保留 1 项', clean.ok && clean.deleted === 1 && clean.remaining === 1, clean);
  const listAfterClean = await sendMessage({ type: 'list-drafts', token: authB.token }, tabB);
  const remain = listAfterClean.drafts[0];
  check('新输入被保留', remain && remain.fields['f-name'] && remain.fields['f-name'].value === 'B追加', remain);
  check('已确认修订被删除', remain && !remain.fields.email, remain);
  const cleanAll = await sendMessage({ type: 'cleanup', token: authB.token, key: KEY, upToRev: 99 }, tabB);
  check('清理全部修订', cleanAll.ok && cleanAll.remaining === 0, cleanAll);
  const listEmpty = await sendMessage({ type: 'list-drafts', token: authB.token }, tabB);
  check('草稿记录已删除', listEmpty.ok && listEmpty.drafts.length === 0, listEmpty);

  console.log('== 5. 撤销授权 ==');
  const revoke = await sendMessage({ type: 'revoke', token: authB.token }, tabB);
  check('撤销成功', revoke.ok);
  const saveAfterRevoke = await sendMessage({ type: 'save', token: authB.token, formId: 'profile_form', fields: { 'f-name': 'x' } }, tabB);
  check('撤销后保存被拒绝', !saveAfterRevoke.ok && saveAfterRevoke.error === 'revoked', saveAfterRevoke);

  console.log('== 6. 过期清理（GC）==');
  const authC = await sendMessage({ type: 'authorize', origin: ORIGIN, route: ROUTE }, senderOf(3, 'doc-C1', ORIGIN));
  await sendMessage({ type: 'bind', token: authC.token, formId: 'profile_form', fields }, senderOf(3, 'doc-C1', ORIGIN));
  await sendMessage({ type: 'save', token: authC.token, formId: 'profile_form', fields: { 'f-name': '过期数据' } }, senderOf(3, 'doc-C1', ORIGIN));
  // 直接把草稿 updatedAt 改到 8 天前
  const db = await new Promise((res) => { const r = indexedDB.open('form-draft-saver', 1); r.onsuccess = () => res(r.result); });
  await new Promise((res, rej) => {
    const tx = db.transaction('drafts', 'readwrite');
    const getReq = tx.objectStore('drafts').get(KEY);
    getReq.onsuccess = () => {
      const d = getReq.result;
      d.updatedAt = Date.now() - 8 * 24 * 3600 * 1000;
      const putReq = tx.objectStore('drafts').put(d);
      putReq.onsuccess = () => res();
      putReq.onerror = () => rej(putReq.error);
    };
  });
  db.close();
  const gc = await sendMessage({ type: 'run-gc-now', token: authC.token }, senderOf(3, 'doc-C1', ORIGIN));
  check('GC 删除过期草稿', gc.ok && gc.draftsDeleted === 1, gc);
  const listAfterGC = await sendMessage({ type: 'list-drafts', token: authC.token }, senderOf(3, 'doc-C1', ORIGIN));
  check('过期草稿不再出现', listAfterGC.ok && listAfterGC.drafts.length === 0, listAfterGC);

  console.log('== 7. 路由隔离 ==');
  const authD = await sendMessage({ type: 'authorize', origin: ORIGIN, route: '/route-a?x=1' }, senderOf(4, 'doc-D1', ORIGIN));
  await sendMessage({ type: 'bind', token: authD.token, formId: 'profile_form', fields }, senderOf(4, 'doc-D1', ORIGIN));
  await sendMessage({ type: 'save', token: authD.token, formId: 'profile_form', fields: { 'f-name': '路由A' } }, senderOf(4, 'doc-D1', ORIGIN));
  const authE = await sendMessage({ type: 'authorize', origin: ORIGIN, route: ROUTE }, senderOf(5, 'doc-E1', ORIGIN));
  await sendMessage({ type: 'bind', token: authE.token, formId: 'profile_form', fields }, senderOf(5, 'doc-E1', ORIGIN));
  await sendMessage({ type: 'save', token: authE.token, formId: 'profile_form', fields: { 'f-name': '主路由' } }, senderOf(5, 'doc-E1', ORIGIN));
  const listIso = await sendMessage({ type: 'list-drafts', token: authE.token }, senderOf(5, 'doc-E1', ORIGIN));
  const routes = listIso.drafts.map((d) => `${d.route}=${d.fields['f-name'].value}`).sort();
  check('同表单不同路由草稿互相隔离', routes.length === 2
    && routes[0] === '/route-a?x=1=路由A' && routes[1] === '/test/test-form.html=主路由', routes);

  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('测试异常：', e); process.exit(1); });
