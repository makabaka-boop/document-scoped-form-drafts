/* 内容脚本功能测试：jsdom 加载真实测试页 + 桩 chrome API，验证扫描规则、
 * 绑定/保存、表单替换与路由变化暂停、恢复时身份/类型校验。
 * 运行：node test/content.test.cjs
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const html = fs.readFileSync(path.join(__dirname, 'test-form.html'), 'utf8');
const contentJs = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');

const dom = new JSDOM(html, {
  url: 'http://localhost:8765/test/test-form.html',
  runScripts: 'dangerously', // 执行测试页自己的脚本（生成 25 字段等）
  pretendToBeVisual: true,
});
const { window } = dom;

if (!window.CSS || !window.CSS.escape) {
  window.CSS = window.CSS || {};
  window.CSS.escape = (s) => String(s).replace(/[^\w-]/g, '\\$&');
}

// ---- chrome API 桩 ----
let revCounter = 0;
const cannedDraft = {
  key: 'http://localhost:8765::/test/test-form.html::profile_form',
  origin: 'http://localhost:8765',
  route: '/test/test-form.html',
  formId: 'profile_form',
  rev: 2,
  updatedAt: Date.now(),
  fields: {
    'f-name': { value: '张三', rev: 1, keyType: 'id', type: 'text', updatedAt: Date.now() },
    email: { value: 'a@b.c', rev: 2, keyType: 'name', type: 'email', updatedAt: Date.now() },
  },
};
function handler(msg) {
  switch (msg.type) {
    case 'authorize': return { ok: true, token: 'tok-' + Math.random().toString(36).slice(2) };
    case 'ping': return { ok: true };
    case 'bind': return { ok: true, key: cannedDraft.key, rev: 0 };
    case 'save': return { ok: true, rev: ++revCounter };
    case 'list-drafts': return { ok: true, drafts: [] };
    case 'get-draft': return { ok: true, draft: cannedDraft };
    case 'cleanup': return { ok: true, deleted: 0, remaining: 0 };
    case 'revoke': return { ok: true };
    case 'run-gc-now': return { ok: true, draftsDeleted: 0, sessionsDeleted: 0, writersDeleted: 0 };
    default: return { ok: false, error: 'unknown:' + msg.type };
  }
}
window.chrome = {
  runtime: {
    lastError: null,
    sendMessage(msg, cb) {
      setTimeout(() => { window.chrome.runtime.lastError = null; cb(handler(msg)); }, 0);
    },
  },
};

// ---- 断言辅助 ----
let passed = 0;
let failed = 0;
function check(name, cond, extra) {
  if (cond) { passed += 1; console.log('  ✓', name); }
  else { failed += 1; console.log('  ✗', name, extra == null ? '' : JSON.stringify(extra)); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  window.eval(contentJs); // 模拟 executeScript 注入
  await sleep(80);        // 等待 authorize + 首轮渲染

  const app = window.__formDraftSaverInstance__;
  console.log('== 1. 注入与扫描 ==');
  check('实例已创建并完成授权', !!app && app.authOk === true);
  const formIds = app.scanned.map((s) => s.formId).sort();
  check('只列出带唯一 id 的表单', JSON.stringify(formIds) === JSON.stringify(['many_form', 'order_form', 'profile_form']), formIds);
  const profile = app.scanned.find((s) => s.formId === 'profile_form');
  const keys = profile.fields.map((f) => f.key);
  check('合规字段齐全且顺序正确', JSON.stringify(keys) === JSON.stringify(['f-name', 'email', 'f-tel', 'f-bio', 'q']), keys);
  check('email 字段识别为 name 身份', profile.fields.find((f) => f.key === 'email').keyType === 'name');
  check('排除项数量正确（12 个）', profile.excluded === 12, profile.excluded);
  const many = app.scanned.find((s) => s.formId === 'many_form');
  check('many_form 截断到 20 项', many.fields.length === 20, many.fields.length);
  check('many_form 溢出 5 项', many.overflow === 5, many.overflow);

  console.log('== 2. 绑定与防抖保存 ==');
  app.selected.set('profile_form', new Set(['f-name', 'email']));
  await app.bindForm('profile_form');
  const binding = app.bindings.get('profile_form');
  check('绑定成功', binding && binding.status === 'bound');
  const nameInput = window.document.getElementById('f-name');
  nameInput.value = '李四';
  nameInput.dispatchEvent(new window.Event('input', { bubbles: true }));
  await sleep(800); // 超过 600ms 防抖
  check('输入触发自动保存', revCounter >= 1, revCounter);

  console.log('== 3. 表单替换 → 暂停绑定 ==');
  window.document.getElementById('btn-replace-form').click();
  app.tick();
  check('替换后绑定被暂停', app.bindings.get('profile_form').status === 'paused');

  console.log('== 4. SPA 路由变化 → 暂停 + 换发令牌 ==');
  app.rescan();
  app.selected.set('profile_form', new Set(['f-name', 'email']));
  await app.bindForm('profile_form');
  check('重新绑定成功', app.bindings.get('profile_form').status === 'bound');
  const oldToken = app.token;
  window.history.pushState({}, '', '/route-a?x=1');
  app.tick();
  await sleep(20);
  check('路由变化后绑定暂停', app.bindings.get('profile_form').status === 'paused');
  check('路由变化后换发新令牌', app.token && app.token !== oldToken);

  console.log('== 5. 恢复校验：类型变化即拒绝 ==');
  window.document.getElementById('btn-morph-type').click(); // email: email → text
  await app.previewRestore(cannedDraft.key);
  const rows = app.restorePreview.rows;
  const nameRow = rows.find((r) => r.meta.key === 'f-name');
  const emailRow = rows.find((r) => r.meta.key === 'email');
  check('f-name 可恢复', nameRow.ok === true, nameRow);
  check('email 类型变化被拒绝', emailRow.ok === false && /类型已变化/.test(emailRow.error), emailRow);
  app.confirmRestore();
  check('确认恢复只写入通过校验的字段', window.document.getElementById('f-name').value === '张三');
  const emailEl = window.document.querySelector('#profile_form input[name="email"]');
  check('被拒绝字段不被写入', emailEl.value === '', emailEl.value);

  console.log('== 6. 恢复校验：name 不再唯一即拒绝 ==');
  window.document.getElementById('btn-dup-email').click();
  app.rescan();
  const profile2 = app.scanned.find((s) => s.formId === 'profile_form');
  check('重复 name 的字段从可选列表消失', !profile2.fields.some((f) => f.key === 'email'));
  await app.previewRestore(cannedDraft.key);
  const emailRow2 = app.restorePreview.rows.find((r) => r.meta.key === 'email');
  check('恢复时报告字段不再唯一', emailRow2.ok === false && /不再唯一/.test(emailRow2.error), emailRow2);

  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('测试异常：', e); process.exit(1); });
