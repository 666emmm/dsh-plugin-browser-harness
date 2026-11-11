# dsh-plugin-browser-harness

让 DeepSeek Harness 的 Agent 直接控制你的本地 Chrome：点击、输入、导航、执行 JS、截图，全部通过 [browser-harness](https://github.com/browser-use/browser-harness) 的 CDP 连接完成。附带一个「设置 > 浏览器连接」诊断界面和「更新检测 + 确认更新」功能。

Agent-driven local Chrome control for DeepSeek Harness via [browser-harness](https://github.com/browser-use/browser-harness) (CDP), with a settings-page connection panel and update check.

> 上游项目：https://github.com/browser-use/browser-harness

---

## 快速开始 / Quick Start（三步，缺一不可）

> **重要**：本插件是 DeepSeek Harness 的插件，**只是 Node 壳**，真正的浏览器控制由独立的 Python CLI
> `browser-harness` 完成。CLI **不会**随插件自动安装，必须手动装一次。别人 clone 仓库后
> **只装插件不装 CLI 是跑不起来的**，这是最常见的原因。

```bash
# ① 安装 Python CLI（全局一次，uv 会装到 ~/.local/bin）
#    如果还没装 uv：winget install astral-sh.uv  或去 https://astral.sh/uv/
uv tool install --python 3.12 browser-harness

# ② 验证 CLI 就位
browser-harness --version        # 应输出 0.1.x
browser-harness --doctor         # 应输出 [ok] chrome running / [ok] daemon alive

# ③ 安装本插件（从 GitHub）
dsh plugin --profile web add github:666emmm/dsh-plugin-browser-harness
```

安装后**重启 dsh web** 生效。之后在设置页「浏览器连接」里看到状态为已连接，即可让 Agent 使用浏览器工具（`mcp` 模式：`mcp__bh__browser_*`；`builtin` 模式：`browser_*`）。

---

## 前置依赖 / Requirements

| 依赖 | 版本 | 用途 |
|---|---|---|
| DeepSeek Harness | ≥ v0.1.2-alpha.1 | 插件宿主 |
| Node.js | ≥ 18 | 插件运行时 |
| [uv](https://astral.sh/uv/) | 任意较新版本 | 安装 Python CLI |
| [browser-harness CLI](https://github.com/browser-use/browser-harness) | Python ≥3.11；`mcp` 模式需 **≥0.1.13 且带 `[mcp]` extra** | 真正的浏览器控制（CDP） |
| Chrome | 任意 | 被控制的浏览器 |

### Chrome 远程调试（很多人卡在这）

CLI 通过 CDP 连 Chrome，Chrome 必须开启远程调试：

1. 地址栏打开 `chrome://inspect/#remote-debugging`
2. 勾选 **"Allow remote debugging for this browser instance"**（允许此浏览器实例进行远程调试）
3. 保持该 Chrome 窗口开着（关掉 = 断开连接）

> 开启后页面右上角出现 🐴 标记即表示连接成功。

---

## 安装 / Install

```bash
# 推荐：装带 MCP 支持的 CLI（mcp 模式需要；builtin 模式 0.1.10 也能用）
uv tool install --python 3.12 "browser-harness[mcp]>=0.1.13"

# 从 GitHub 安装（推荐）
dsh plugin --profile web add github:666emmm/dsh-plugin-browser-harness

# 本地 tarball（开发）
npm pack
dsh plugin --profile web add ./dsh-plugin-browser-harness-0.3.0.tgz

# 本地目录（开发，注意：link 目录需放在 profile 内以便模块解析）
dsh plugin --profile web add link:./vendor/dsh-plugin-browser-harness
```

安装后重启 dsh web 生效。

### Windows 安装注意

`dsh plugin add <目录>` 在 Windows 上是 junction，Node 按 realpath 解析会跑出 profile、
找不到 `@deepseek-ai/*`。**必须打 tarball 或用 profile 内 `link:` 目录**。

---

## 报错排查 / Troubleshooting（调用 browser_* 工具报错时）

Agent 调用工具报错时，先跑一次 `browser_doctor`，然后对照下表：

| 报错内容 | 原因 | 解决 |
|---|---|---|
| `browser-harness CLI 未找到 / not found` | ① CLI 没装 | 执行 `uv tool install --python 3.12 browser-harness` |
| | ② CLI 装了但不在 PATH | 确认 `~/.local/bin` 在 PATH；或设置环境变量 `BROWSER_HARNESS_BIN` 指向 exe 绝对路径后重启 dsh |
| `[FAIL] chrome running` | Chrome 没开 | 打开 Chrome |
| `[FAIL] active browser connections — 0` | Chrome 没开远程调试 | `chrome://inspect/#remote-debugging` 勾选 "Allow remote debugging..." |
| `[FAIL] daemon alive` | browser-harness daemon 挂了 | 重跑任意 browser_* 工具会自动拉起；或重启 dsh web |
| `browser-harness timed out after 60000ms` | CLI 卡住（如浏览器弹窗/页面无响应） | 检查浏览器是否有未处理的弹窗；在设置页调大「调用超时」 |
| `Python: No module named 'browser_harness'` | CLI 安装环境损坏 | `uv tool uninstall browser-harness && uv tool install --python 3.12 browser-harness` 重装 |

### 三个自检命令（装完 CLI 后逐条跑）

```bash
browser-harness --version    # 1. 有输出 = CLI 装好了
browser-harness --doctor     # 2. 全部 [ok] = 连接就绪
```

如果第 2 条 `--doctor` 显示 `[FAIL] active browser connections — 0`，说明 Chrome 远程调试没开
（见上文「Chrome 远程调试」）；显示 `[FAIL] daemon alive` 则重跑任意命令拉起 daemon。

---

## 功能 / Features

- **能力层可切换 / switchable capability layer**（行配置 `mode`，默认 `mcp`）：

  | 模式 | 工具面 | 说明 |
  |---|---|---|
  | `mcp`（默认） | 23 个 `mcp__bh__browser_*` + 5 个插件自带工具 | 通过宿主自带 `@deepseek-ai/dsh-mcp-client` 挂载 `browser-harness-mcp`；工具集随 CLI 升级自动增长。需要 CLI ≥0.1.13 且安装 `[mcp]` extra |
  | `builtin` | 12 个 `browser_*` | 插件内置工具（下表），不依赖 `[mcp]`；CLI 缺失或找不到 `browser-harness-mcp` 时也会自动降级到这里 |

  `mcp` 模式工具（23，前缀 `mcp__bh__browser_`）：`new_tab` `goto` `page_info` `click` `type` `fill` `press` `scroll` `screenshot` `list_tabs` `current_tab` `switch_tab` `close_tab` `ensure_real_tab` `wait` `wait_for_load` `wait_for_element` `js` `cdp` `upload_file` `http_get` `start_recording` `stop_recording`

  `builtin` 模式 12 个：

  | 工具 | 作用 |
  |---|---|
  | `browser_page_info` | 当前页 URL / 标题 / 视口 + 连接状态 |
  | `browser_new_tab` | 新标签页打开 URL（首次导航必用） |
  | `browser_goto` | 当前标签导航 |
  | `browser_click` | 视口坐标点击 |
  | `browser_click_selector` | 按 CSS 选择器点击 —— **任何模式下都存在**（MCP 只有坐标点击） |
  | `browser_type` | 聚焦元素输入文本 |
  | `browser_js` | 执行 JS 并返回 JSON 结果 |
  | `browser_screenshot` | 截图返回文件路径 |
  | `browser_annotate` | ★ 在页面上装元素批注拾取器，批注自动回到本会话 |
  | `browser_annotation_stop` | ★ 停止监听并释放浏览器（可选清空队列） |
  | `browser_annotation_list` | ★ 列出本会话收到的批注 |
  | `browser_doctor` | 连接诊断（Chrome / daemon / CLI）—— **任何模式下都存在** |

- **★ 元素批注 / element annotation**（v0.4.0 新增）：人在页面上圈一个元素、写一句话，这条批注**变成一条用户消息投递回发起它的会话**。人不用切回对话，模型也不用猜「你说的是哪个元素」。

  ```
  你说：「帮我改这个页面的价格显示」
    → 模型调 browser_annotate()
    → 页面右下角出现浮层面板
    → 你点「开始选择」→ 点元素 → 写批注 → 点「发送」
    → 批注进入当前会话，你可以立刻切去别的标签页
  ```

  会话 ID 是**自动的**（从 `exec.agent.id` 取），不需要指定。

  三条相关能力：

  | 能力 | 说明 |
  |---|---|
  | **Shadow DOM 穿透** | B站评论区那种 4 层嵌套 shadow 也能精确选中内部按钮（`elementFromPoint` 只给宿主，用 `composedPath()` / `shadowRoot.elementFromPoint()` 穿透） |
  | **关闭即释放** | 点面板「关闭」→ 停止轮询 + 释放浏览器所有权，不会后台空转 |
  | **切标签页自动重注入** | 面板因导航消失后自动装回（每 5 秒检测），但「关闭」不会让它自己弹回来 |

  投递走 `sessionController.prompt({ mode: 'queue' })` —— 模型正在回答时你发的批注不会打断它。

- **提示词注入 / prompt**：按当前模式注入对应的工具名（`mcp__bh__browser_*` 或 `browser_*`）
- **设置页 / settings**：连接状态（CLI / daemon / 当前页面）、一键诊断、截图、远程调试引导
- **插件配置卡片**：browser-harness 调用超时（5–300 秒）
- **更新检测 / updates**：自动检查上游 [browser-use/browser-harness](https://github.com/browser-use/browser-harness) 项目与 browser-harness CLI 是否有新版本，确认后一键升级

## 架构 / Architecture

```
┌─────────────────────── DSH 进程（Node/cordis）──────────────────────┐
│  src/index.js              ── 入口：能力层选择 + systemPrompt + HTTP │
│  src/engine.js             ── CLI 定位 + 调用                        │
│  src/tools.js              ── builtin 模式的 12 个工具（零依赖）     │
│  src/daemon-ipc.js         ── ★ 直连 daemon 的 TCP（往返 1–7 ms）    │
│  src/picker.js             ── ★ 页面内浮层拾取器（字符串模板注入）   │
│  src/annotation-store.js   ── ★ 批注队列 + 所有权 + 消息格式化       │
│  src/annotation-watcher.js ── ★ 每秒轮询事件，合并投递              │
│  src/update.js             ── 更新检测 + 执行升级                    │
└───────────┬───────────────────────────────────────┬─────────────────┘
            │ mcp 模式（默认）                       │ builtin 模式
            ▼                                       ▼
  dsh-mcp-client ──stdio JSON-RPC──▶ browser-harness-mcp      stdin 喂片段
                                     （Python，CDP 连本地 Chrome）
                                                │
                          ★ 批注路径（不走网络、不走 CLI 子进程）
                          页面 JS → window.__bhAnnotation(payload)
                                  → daemon 记 Runtime.bindingCalled 事件
                                  → watcher drain_events（1 Hz）
                                  → sessionController.prompt(mode:'queue')
                                  → 会话里多一条用户消息
```

### 关键设计

- **能力层可切换**：`mcp` 模式把 CLI 自带的服务端（23 工具）挂给宿主的 `@deepseek-ai/dsh-mcp-client`；`builtin` 模式用插件自带的 12 个工具。找不到 `browser-harness-mcp` 时自动降级，插件本身永远能激活。
- **批注为什么不用 MCP**：MCP 的 23 个工具**没有任何注入能力** —— 拾取器要在页面里常驻自己的 JS、要监听 CDP binding 事件，这些 MCP 都不提供。所以批注走独立的 daemon IPC 通道（`daemon-ipc.js`），每 tick 往返 1–7 ms，不 spawn 子进程。
- **Node ⇄ Python 桥**：`runHarness(code)` 把 Python 片段经 stdin 喂给 `browser-harness`，helpers（`page_info`/`new_tab`/`click_at_xy`…）预导入；`runHarnessArgs(args)` 处理 `--version`/`--update` 等命令行参数。统一 `print(json.dumps(_result, ensure_ascii=True))` 输出，Node 端解析最后一行 JSON。
- **参数防注入**：工具参数 `JSON.stringify` 后 base64 编码嵌进 Python 片段，杜绝引号/换行/中文破坏语法。
- **零运行时依赖**：工具描述符手写 dsh-tools 子集（`hoistRequired`/`validateArgs`），不 import `@deepseek-ai/dsh-tools`，规避 pnpm 布局差异。
- **更新检测源**：GitHub 项目版本走 `git ls-remote --tags`（自动用 git 代理配置，因为 Node fetch 忽略 HTTP_PROXY），查询 [browser-use/browser-harness](https://github.com/browser-use/browser-harness) 仓库的 `v0.1.x` release 标签（与 PyPI CLI 版本一一对应）；CLI 版本走 PyPI（直连）。30 分钟 TTL 缓存，`?force=1` 绕过。离线时明确报告"未知"而非误报"已是最新"。

## 使用 / Usage

告诉 Agent「用浏览器打开 XXX 并…」即可。Agent 会依次调用 `browser_new_tab` / `browser_goto` / `browser_js` / `browser_click` 等工具完成任务；连接异常时先跑 `browser_doctor`。

## 更新 / Updates

- 打开 **设置 → 浏览器连接**，更新区块会自动检查；也可点「检查更新」强制刷新。
- 检测两个层面：
  - **项目**：上游 [browser-use/browser-harness](https://github.com/browser-use/browser-harness) 最新 release tag（如 `v0.1.10`）vs 当前安装对应的项目版本
  - **CLI**：PyPI 最新 `browser-harness` vs 本机安装版本
- 有更新时点「更新 CLI」→ 二次确认 → 执行 `browser-harness --update -y`（uv tool upgrade + 重启 daemon）。

> 版本映射：browser-harness 以独立仓库发布，仓库 tag 与 PyPI 版本一一对应（`v0.1.10 ↔ 0.1.10`），映射表维护在 `src/update.js` 的 `CLI_TO_PROJECT`。

## HTTP API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/browser-harness/api/status` | 连接状态 |
| GET | `/browser-harness/api/doctor` | 运行诊断 |
| GET | `/browser-harness/api/screenshot` | 截图，返回路径 |
| GET | `/browser-harness/api/chrome-hint` | 远程调试引导 |
| GET | `/browser-harness/api/update-check[?force=1]` | 更新检测 |
| POST | `/browser-harness/api/update` | 执行更新，body 须 `{"confirm":true}` |
| GET | `/browser-harness/api/check-update[?repair=0&force=1]` | 深度检测（逐层 a/b/c/d） |
| GET | `/browser-harness/api/repair-status` | 自愈会话状态 |
| GET | `/browser-harness/api/repair-reset` | 忘掉记住的会话 |
| GET | `/browser-harness/api/annotation-start?session=<id>` | ★ 启动批注（等价于 `browser_annotate`，session 必填） |
| GET | `/browser-harness/api/annotation-status` | ★ 谁持有浏览器、轮询计数、投递统计 |
| GET | `/browser-harness/api/annotation-flush[?session=<id>]` | ★ 手动触发一次投递 |
| GET | `/browser-harness/api/annotation-list?session=<id>[&pending=1]` | ★ 列某会话的批注 |
| GET | `/browser-harness/api/annotation-stop[?session=<id>&clear=1]` | ★ 停止监听 + 释放所有权 |

> `session` 参数用 `session-<uuid>` 或裸 uuid 都可以，内部会归一化。

## 开发 / Develop

```bash
npm test            # 冒烟测试：CLI 连通性 + 工具描述符 + browser_page_info 执行
npm run check-update  # 更新检测自检：逐层验证 CLI 地址检测 / PyPI / GitHub，失败时给出原因
npm pack            # 打 tarball 用于本地安装
```

### 更新检测自检 / check-update

设置页「更新」区块显示"无法获取"时，在插件目录跑 `npm run check-update`，
会分 A（CLI 地址）→ B（PyPI）→ C（GitHub）→ D（完整 checkUpdates）四层报告：

- **A 失败**：CLI 未安装 → `uv tool install --python 3.12 browser-harness`
- **B 失败**：PyPI 不可达。注意 **Node fetch 不走 HTTP_PROXY 环境变量**，依赖 PyPI 代理的环境需自行解决
- **C 失败**：GitHub 不可达（git 代理未配置）→ `git config --global http.proxy <代理>` / `https.proxy`
- **D 中 project 为 none**：`CLI_TO_PROJECT` 映射缺失，不影响 CLI 升级检测

## 命名约定 / Naming

| 位置 | 命名 |
|---|---|
| npm 包名 | `dsh-plugin-browser-harness` |
| cordis 插件 id | `browser-harness` |
| agent 工具 | `browser_*`（snake_case） |
| HTTP 路由 | `/browser-harness/api/*` |
| 设置页 | `浏览器连接` |
| CSS 前缀 | `bhn-` |

## 兼容性 / Compatibility

- **dsh ≥ v0.1.2-alpha.1**：client 注入已从被移除的 `@deepseek-ai/dsh-client-runtime` 迁移到 `@deepseek-ai/dsh-client-ui-renderer`（`ctx.slots` 的运行时提供方）。dsh v0.1.1-rc.2 及更早版本仍受支持（ui-renderer 在 rc.2 中已存在）。
- 其余插件 API（cordis patch / settings / webServer / systemPrompt / tools / __ModuleLoader__）在 v0.1.1-rc.2 → v0.1.2-alpha.1 之间保持不变。
- **v0.3.0（本版）新增 MCP 能力层**：默认通过宿主自带的 `@deepseek-ai/dsh-mcp-client` 挂载 `browser-harness-mcp`，工具从 8 个变成 23 个（`mcp__bh__browser_*`），且随 CLI 升级自动增长。找不到 `browser-harness-mcp`（CLI < 0.1.13 / 没装 `[mcp]`）时自动降级为内置 8 工具，插件本身照常激活。工具名按模式生成，提示词同步。
- **v0.2.1** 修掉一处会在 dsh 0.2.1-rc.1 上直接起不来的写法：客户端 `exports.inject` 不再声明 `settingsScope`。该服务在 0.2.x 被移除后，硬等待会让插件永久 pending，启动审计随即报 `web boot: 1 entry did not activate`。现在改为运行时探测：服务存在 → 插件配置卡照常出现；不存在 → 只跳过卡片，`设置 → 浏览器连接` 页面（走插件自己的 HTTP API）不受影响。
- 宿主侧 `settings.register(namespace, schema)`（0.1.x 有、0.2.x 没有）同样改为显式探测，缺失时退回默认超时 60 秒。
- 下限说明：`dsh.client.inject` 是静态列表，`ui-renderer` 只在 **≥ v0.1.2-alpha.1** 存在，所以低于该版本的 dsh 不受支持（一份 manifest 无法同时满足两种 `slots` 来源）。

## 已知注意事项

- **Windows 安装**：`dsh plugin add <目录>` 在 Windows 上是 junction，Node 按 realpath 解析会跑出 profile、找不到 `@deepseek-ai/*`。**必须打 tarball 或用 profile 内 `link:` 目录**。
- **stdin 编码**：CLI 调用必须设 `PYTHONIOENCODING=utf-8`，否则 Windows GBK 解码崩。
- **代理**：GitHub 访问靠 git 代理配置（Node fetch 不走 HTTP_PROXY）；PyPI 直连。
- **离线语义**：检测失败时 `latest: null`，UI 明确区分「已是最新」vs「无法检测」，绝不谎报。
- **改完代码必须重启 dsh**：`src/` 是 ESM 源码，dsh 直接 import，模块在进程启动时加载一次就缓存。文件 mtime 再新也不影响正在跑的进程 —— 这是最容易误判成「改错了」的坑。
- **closed shadow root 穿不过**：`attachShadow({mode:'closed'})` 的宿主，脚本拿不到 `host.shadowRoot`，只能按坐标定位。这是浏览器限制，批注消息里会标 `reachable: false`。
- **拒绝执行 JS 的页面**：`chrome://`、部分 CSP 严格站点会让 `Runtime.evaluate` 挂到超时，此时无法注入拾取器。
- **同一时刻只有一个会话能持有批注**：后发起的会顶掉前一个（`previousOwner` 返回被顶掉的那个）。这是刻意设计 —— 两套拾取器同时存在会让人搞不清批注发去了哪。
- **批注草稿不持久化**：面板被重新注入时（切标签页、SPA 跳转），文本框里没发送的内容会丢。已发送的不受影响。

## License

MIT
