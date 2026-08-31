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

安装后**重启 dsh web** 生效。之后在设置页「浏览器连接」里看到状态为已连接，即可让 Agent 使用 `browser_*` 工具。

---

## 前置依赖 / Requirements

| 依赖 | 版本 | 用途 |
|---|---|---|
| DeepSeek Harness | ≥ v0.1.2-alpha.1 | 插件宿主 |
| Node.js | ≥ 18 | 插件运行时 |
| [uv](https://astral.sh/uv/) | 任意较新版本 | 安装 Python CLI |
| [browser-harness CLI](https://github.com/browser-use/browser-harness) | Python 3.12 | 真正的浏览器控制（CDP） |
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
# 从 GitHub 安装（推荐）
dsh plugin --profile web add github:666emmm/dsh-plugin-browser-harness

# 本地 tarball（开发）
npm pack
dsh plugin --profile web add ./dsh-plugin-browser-harness-0.2.0.tgz

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

- **Agent 工具 / tools**（8 个，`browser_*` 前缀）：

  | 工具 | 作用 |
  |---|---|
  | `browser_page_info` | 当前页 URL / 标题 / 视口 + 连接状态 |
  | `browser_new_tab` | 新标签页打开 URL（首次导航必用） |
  | `browser_goto` | 当前标签导航 |
  | `browser_click` | 视口坐标点击 |
  | `browser_type` | 聚焦元素输入文本 |
  | `browser_js` | 执行 JS 并返回 JSON 结果 |
  | `browser_screenshot` | 截图返回文件路径 |
  | `browser_doctor` | 连接诊断（Chrome / daemon / CLI） |

- **提示词注入 / prompt**：引导 Agent 在网页交互任务中使用 browser_* 工具
- **设置页 / settings**：连接状态（CLI / daemon / 当前页面）、一键诊断、截图、远程调试引导
- **插件配置卡片**：browser-harness 调用超时（5–300 秒）
- **更新检测 / updates**：自动检查上游 [browser-use/browser-harness](https://github.com/browser-use/browser-harness) 项目与 browser-harness CLI 是否有新版本，确认后一键升级

## 架构 / Architecture

```
┌─────────────────────── DSH 进程（Node/cordis）──────────────────────┐
│  src/index.js   ── 入口：systemPrompt 段 + 工具注册 + HTTP API      │
│  src/engine.js  ── browser-harness CLI 调用层（spawn/UTF-8/JSON）   │
│  src/tools.js   ── 8 个 agent 工具（自包含 defineTool，零依赖）     │
│  src/update.js  ── 更新检测（GitHub 项目 + PyPI CLI）+ 执行升级      │
└──────────────────────────────────┬──────────────────────────────────┘
                                   │ stdin 喂 Python 片段，stdout 解析 JSON
                                   ▼
              browser-harness CLI（Python，CDP 连本地 Chrome）
```

### 关键设计

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

## 开发 / Develop

```bash
npm test        # 冒烟测试：CLI 连通性 + 工具描述符 + browser_page_info 执行
npm pack        # 打 tarball 用于本地安装
```

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

## 已知注意事项

- **Windows 安装**：`dsh plugin add <目录>` 在 Windows 上是 junction，Node 按 realpath 解析会跑出 profile、找不到 `@deepseek-ai/*`。**必须打 tarball 或用 profile 内 `link:` 目录**。
- **stdin 编码**：CLI 调用必须设 `PYTHONIOENCODING=utf-8`，否则 Windows GBK 解码崩。
- **代理**：GitHub 访问靠 git 代理配置（Node fetch 不走 HTTP_PROXY）；PyPI 直连。
- **离线语义**：检测失败时 `latest: null`，UI 明确区分「已是最新」vs「无法检测」，绝不谎报。

## License

MIT
