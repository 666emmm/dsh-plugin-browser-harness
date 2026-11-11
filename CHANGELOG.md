# Changelog

## v0.4.0 — 2026-11-11

元素批注（annotation）系统。人在页面上圈一个元素、写一句话，这条批注**变成一条用户消息投递回发起它的会话**。

### 新增

- **`browser_annotate` / `browser_annotation_stop` / `browser_annotation_list`** 三个工具。会话 ID 自动从 `exec.agent.id` 取，不需要指定。
- **`src/daemon-ipc.js`** —— 直连 daemon 的 TCP 通道，不 spawn 子进程。实测往返 **0.96–6.82 ms**。
- **`src/picker.js`** —— 页面内浮层拾取器。浮层、高亮框、元素描述（标签/选择器/文本/属性/位置/字号/颜色）。
- **`src/annotation-store.js`** —— 批注队列（按会话分桶）+ 浏览器所有权 + 消息格式化。
- **`src/annotation-watcher.js`** —— 每秒轮询 daemon 事件，1.2 秒 debounce 合并，走 `sessionController.prompt({ mode: 'queue' })` 投递。
- **5 个 HTTP 路由**：`/annotation-{start,status,flush,list,stop}`。
- **Shadow DOM 穿透** —— 用 `composedPath()` 和 `shadowRoot.elementFromPoint()` 代替 `elementFromPoint()`。B站评论区那种 4 层嵌套 shadow 也能精确选中内部按钮（实测 `bili-icon` 点赞图标）。
- **关闭即释放** —— 点面板「关闭」发 `picker_closed` 事件，watcher 收到就 flush 剩余队列、释放所有权、停止轮询。
- **切标签页自动重注入** —— 每 5 秒检测 `currentTab()`，变了就补回拾取器；每 15 秒兜底应对 SPA 跳转。

### 修复

- **会话 ID 缺 `session-` 前缀导致投递失败** —— `prompt` 报 `session "xxx" not found`，看着像会话丢了。新增 `normalizeSessionId()`，队列键和 prompt 目标统一归一化。
- **工具拿不到会话 ID** —— `exec.sessionId` 不存在（`ToolRunContext` 没有这个字段），会话在 `exec.agent.id`。新增 `sessionIdOf()` 按优先级探测。
- **`viaBinding` 永远是 false** —— 赋值写在 binding 调用之后，序列化时还没设上。改成调用前赋值。
- **已投递的批注被重放** —— localStorage 镜像里留着已投递记录，下次注入又「恢复」一遍。改成 binding 成功后从镜像里删掉该 id。
- **watcher 从不认领所有权** —— 第一次 `pollOnce` 看到 `owner === null` 就把自己停掉了。改成 `startLoop()` 之前先 `claimOwnership()`。
- **消息里没说明元素在 Shadow DOM 内** —— 模型拿 `#count` 去主文档查，得到 0，于是回答「这个元素不存在」。现在会输出：⚠ 警告 + 穿透路径 + 宿主标签 + **可直接执行的取元素代码**。
- **`matchCount` 在 shadow 内恒为 0** —— 改成在元素所属的 shadow root 内统计。
- **面板只显示树内选择器** —— shadow 内的元素现在显示完整穿透路径（`a >>> b >>> c`），鼠标悬停看全文。

### 内部

- 工具数：builtin 8 → 12；MCP 模式下插件自带的工具 2 → 5（新增的 3 个批注工具 MCP 不提供）。
- `package.json` 描述修复乱码，补 `annotation` / `shadow-dom` / `element-picker` 关键词。

### 已知限制

- closed shadow root 穿不过（浏览器限制），只能按坐标定位。
- `chrome://` 等拒绝执行 JS 的页面无法注入拾取器。
- 同一时刻只有一个会话能持有批注（后发起的顶掉前一个）。
- 批注草稿不持久化，面板重注入时未发送的文本会丢。

---

## v0.3.2 — 2026-11-08

- 新增 `browser_click_selector`，按 CSS 选择器一步点击（MCP 只有坐标点击）。
- 修复 `browser_doctor` 报「无法解析输出」（漏了 `jsonSnippet` 的 print）。
- 修复自愈投递永远 failed（`prompt` 漏传必需的 `AbortSignal`）。
- 修复模型列表冒出「浏览器连接」条目（误用 `registerConfigurableProviders`）。
- 修复 `spawn browser-harness ENOENT`（PATH 快照比安装旧 + 裸名优先是死代码）。

## v0.3.1

- `prompt` 必须传 `AbortSignal`。

## v0.3.0

- 自愈会话：检测出异常后把结论递进专用会话。

## v0.2.x

- 能力层双层架构（MCP / builtin）、设置页诊断界面、更新检测。
