# 表单草稿保存器（Form Draft Saver）

无后端的 Chrome Manifest V3 扩展：用户**主动选择**当前页面表单中的普通文本字段，
草稿保存在浏览器本地 IndexedDB，可随时预览、确认后恢复。
不采集完整 DOM，不上传任何内容（扩展无任何网络请求）。

## 安全与隐私模型

- **权限最小化**：仅 `activeTab` + `scripting` + `alarms`，不申请任何通配站点权限（无 `host_permissions`）。
- **按需注入**：只有用户点击工具栏图标（activeTab 授权）后，才向当前标签页的**顶层文档**注入内容脚本；不读取 iframe（内容脚本内还有 `window.top === window` 双保险）。
- **字段规则**：
  - 表单必须带文档内唯一 `id`；
  - 字段必须是该表单内具有唯一 `id` 或 `name` 的普通文本字段
    （`input[type=text/email/url/tel/search/number]` 或 `textarea`），每个表单**最多 20 项**；
  - 始终排除：`password` / `file` / `hidden` / 按钮类等非文本控件、
    `autocomplete="one-time-code"`（一次性验证码）、`autocomplete="cc-*"`（支付自动填充）、
    `current-password` / `new-password`，以及 `disabled` / `readonly` 控件。
- **草稿隔离**：草稿键 = `origin :: 完整路由(path+query+hash) :: 表单id`。
- **文档令牌**：每次授权产生新令牌，令牌与浏览器提供的 `sender.documentId` 绑定；
  后台逐条校验消息（会话存在、active、令牌一致）。每个草稿键记录当前写入者（令牌 + documentId），
  重新授权/重新绑定会取代旧写入者——**旧页面的迟到保存无法覆盖新页面的草稿**。
- **可重启的后台**：全部持久状态在 IndexedDB 事务中维护（sessions / writers / drafts），
  不依赖进程内变量；service worker 被终止再唤醒后可继续工作。
- **过期清理**：草稿保留 7 天、会话 24 小时，由 `chrome.alarms` 定期清理（闹钟跨 SW 重启存活）。
- **修订与清理**：草稿按字段维护修订号（rev）。用户确认"已提交"后，清理只删除
  `rev <= 确认时修订号` 的内容；确认期间产生的新输入（更大 rev）保留。
- **暂停与拒绝**：SPA 换路由或表单被替换后暂停绑定，要求重新选择；
  恢复时字段身份（id/name）或类型变化即拒绝该字段，不猜测相近输入框。

## 安装

1. 打开 `chrome://extensions`，开启**开发者模式**。
2. 点击**加载已解压的扩展程序**，选择本目录（`form-draft-saver/`）。
3. 需要 Chrome ≥ 106（依赖 `sender.documentId`）。

## 启动本地测试页

```bash
cd form-draft-saver
python3 -m http.server 8765
# 浏览器打开 http://localhost:8765/test/test-form.html
```

## 自动化测试

```bash
npm install   # 安装 fake-indexeddb 与 jsdom（仅测试用）
npm test      # 后台逻辑 22 项 + 内容脚本 19 项
```

- `test/bg.test.cjs`：令牌签发/吊销、writer 取代（旧页迟到保存拒绝）、修订清理保留新输入、
  路由隔离、过期 GC、撤销授权。
- `test/content.test.cjs`：jsdom 加载真实测试页，验证字段筛选与排除、20 项上限、
  绑定/防抖保存、表单替换与路由变化暂停、恢复时身份/类型校验拒绝。

## 验证清单

### 1. 授权与注入
- 未点击图标前：页面上没有面板，扩展对页面零接触（可查看 `chrome://extensions` 中本扩展无站点权限）。
- 点击工具栏图标后面板出现，状态显示"已授权"。
- 在 `chrome://extensions` 等浏览器内部页面点击图标无反应（无法注入，属预期）。

### 2. 字段规则
- 面板只列出 `profile_form` / `order_form` / `many_form`；无 id 表单被忽略。
- `profile_form` 中只出现 5 个合规字段（f-name / email / f-tel / f-bio / q）；
  密码、文件、hidden、验证码、卡号、新密码、无 id/name、重复 name、只读、日期均被排除，
  卡片底部显示"已排除 N 个不符合条件的控件"。
- `many_form` 只列出 20 个字段，并提示"已达 20 项上限，忽略 5 个字段"。

### 3. 保存草稿
- 勾选字段 → "绑定选中" → 在页面输入内容 → 约 1 秒后"本地草稿"出现对应草稿（字段值、修订号、更新时间）。

### 4. 恢复（需再次确认）
- 清空页面字段 → 草稿卡片点"预览恢复" → 出现逐字段预览 → "确认恢复" → 值写回并触发 `input/change` 事件。
- 点"把 email 改成 text 类型"后再恢复：email 字段被拒绝（类型已变化），其余正常恢复。
- 点"追加第二个 name=email 字段"后再恢复：email 被拒绝（字段不再唯一）。

### 5. 授权撤回
- 面板底部"撤销授权" → 状态变"未授权"，绑定全部暂停，继续输入不会产生新草稿。
- 再次点击工具栏图标 → 重新授权（新文档令牌），按提示重新选择并绑定后可继续保存。

### 6. 导航（SPA 换路由）
- 绑定后点"pushState → /route-a?x=1"或"随机改 hash" → 面板提示路由变化、绑定暂停。
- 重新扫描并绑定后保存：草稿按新路由单独隔离（草稿列表中可见两条不同路由的草稿，
  且"预览恢复/清理"只在对应路由下可用）。

### 7. 表单替换
- 绑定后点"替换 profile_form（同 id 新元素）" → 约 1 秒内绑定暂停并提示重新扫描。

### 8. 旧页迟到保存不覆盖新页草稿
- 标签页 A、标签页 B 打开同一 URL，A 先绑定，B 再绑定（B 取代写入者）。
- 回到 A 继续输入 → A 的保存被拒绝（提示"绑定已被其它页面取代"），B 的草稿不被 A 覆盖。

### 9. 后台（service worker）重启
- 打开 `chrome://serviceworker-internals`，找到本扩展点 **stop**。
- 回到测试页继续在已绑定字段输入 → 草稿仍然更新（SW 被消息唤醒，状态全部来自 IndexedDB）。

### 10. 清理只删确认过的修订
- 绑定两个字段并各输入内容，等草稿保存（如修订 2）。
- 点"我已提交，清理"出现确认框（显示"截至修订 2"），**先不点确认**。
- 在其中一个字段追加输入，等其保存（修订 3）。
- 回到面板点"确认清理" → 提示保留 1 项新输入；草稿中仅保留刚追加的字段，另一字段已删除。

### 11. 过期清理
- 临时把 `background.js` 顶部 `DRAFT_TTL_MS` 改为 `60000`，在 `chrome://extensions` 重载扩展；
  等 1 分钟后点面板"运行过期清理" → 过期草稿被删除（面板同时显示删除统计）。
- 正式使用时由 `chrome.alarms` 每 6 小时自动清理（7 天过期），SW 重启不影响闹钟。

### 12. 隐私
- DevTools → Network：操作扩展全程无任何网络请求。
- 扩展仅保存勾选字段的值，扫描阶段只读取控件属性，不采集完整 DOM。

## 文件结构

```
form-draft-saver/
├── manifest.json        # MV3 清单（activeTab + scripting + alarms，无站点权限）
├── background.js        # service worker：IndexedDB 事务、令牌/修订、过期清理
├── content.js           # 按需注入：扫描、绑定、防抖保存、面板（Shadow DOM）、恢复/清理
├── package.json         # 仅测试依赖（fake-indexeddb / jsdom）
├── test/
│   ├── test-form.html   # 本地测试表单（合规/排除/上限/SPA/替换/类型变化）
│   ├── bg.test.cjs      # 后台逻辑测试
│   └── content.test.cjs # 内容脚本测试
└── README.md
```
