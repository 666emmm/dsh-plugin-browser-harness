// dsh-plugin-browser-harness — in-process half.
//
//  1. systemPrompt section: tells the agent to prefer browser tools for
//     interactive web work and to start with browser_page_info.
//  2. Tools: browser_page_info / browser_new_tab / browser_goto /
//     browser_click / browser_type / browser_js / browser_screenshot /
//     browser_doctor.
//  3. HTTP API (via webServer, when present) backing the 设置 > 浏览器连接
//     page: status / doctor / screenshot / chrome-hint.
//  4. Settings namespace `browser-harness` (timeout, default tab URL) with a
//     settings card in 设置 > 插件 > 插件配置.
import { createBrowserTools } from './tools.js'
import { runJson, jsonSnippet, resolveHarnessBin, resolveMcpBin, installGuidance } from './engine.js'
import { checkUpdates, runCliUpdate, publishToGithub } from './update.js'
import { runUpdateDiagnostics } from './diagnostics.js'
import { dispatchRepair, resetRepairSession, readState as readRepairState, stateFile } from './repair.js'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'

export const name = 'browser-harness'

// 修复会话要改的两个目录 —— 启动时按本文件的真实位置推导，不写死。
const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_DIR = process.env.BH_REPO_DIR || 'D:\\大D老师\\dsh-plugin-browser-harness'

// handler 是模块级函数，拿不到 apply(ctx) 的 ctx；把用得到的那两个服务存这里。
const ctxRef = { sessionController: undefined, workspaceRegistry: undefined }

// ── tiny HTTP helpers (plain node:http) ──
const errMsg = (e) => (e && e.message) ? e.message : String(e)

function send(res, data, status = 200) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(data))
}

async function readBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch {
        resolve({})
      }
    })
    req.on('error', () => resolve({}))
  })
}

// ── status helpers ──
async function probeConnection() {
  const bin = resolveHarnessBin()
  const state = { bin: bin ?? null, cliInstalled: bin !== null, daemonAlive: null, page: null, error: null }
  if (!bin) {
    state.error = installGuidance()
    return state
  }
  const res = await runJson(jsonSnippet(`
_result = { 'ok': True }
try:
    _result['daemonAlive'] = bool(daemon_alive)
    info = page_info()
    _result['page'] = { 'url': info.get('url'), 'title': info.get('title'), 'w': info.get('w'), 'h': info.get('h') }
except Exception as e:
    _result['ok'] = False
    _result['error'] = str(e)
`), { timeoutMs: 15_000 })
  if (!res.ok) {
    state.error = (res.error && res.error.message) || 'browser-harness 连接失败'
    return state
  }
  state.daemonAlive = res.value.daemonAlive
  state.page = res.value.page
  state.error = res.value.error || null
  return state
}

// ── API handlers ──
async function handleStatus(_req, res) {
  try {
    const state = await probeConnection()
    send(res, { ok: true, ...state })
  } catch (e) { send(res, { ok: false, error: errMsg(e) }) }
}

async function handleDoctor(_req, res) {
  try {
    const bin = resolveHarnessBin()
    if (!bin) return send(res, { ok: false, error: installGuidance() })
    const out = await runJson(jsonSnippet(`
import io, json, contextlib
_result = { 'ok': True }
try:
    _buf = io.StringIO()
    with contextlib.redirect_stdout(_buf):
        result = run_doctor()
    _detail = _buf.getvalue().strip()
    if not _detail:
        _detail = json.dumps(result, ensure_ascii=True, default=str) if isinstance(result, (dict, list)) else str(result)
    _result['detail'] = _detail
except Exception as e:
    _result['ok'] = False
    _result['error'] = str(e)
`), { timeoutMs: 30_000 })
    if (!out.ok) return send(res, { ok: false, error: (out.error && out.error.message) || 'doctor 失败' })
    send(res, { ok: true, detail: out.value.detail, error: out.value.error || null })
  } catch (e) { send(res, { ok: false, error: errMsg(e) }) }
}

async function handleScreenshot(_req, res) {
  try {
    const out = await runJson(jsonSnippet(`
_result = { 'ok': True }
try:
    _result['path'] = capture_screenshot()
except Exception as e:
    _result['ok'] = False
    _result['error'] = str(e)
`), { timeoutMs: 20_000 })
    if (!out.ok) return send(res, { ok: false, error: (out.error && out.error.message) || '截图失败' })
    send(res, { ok: true, path: out.value.path, error: out.value.error || null })
  } catch (e) { send(res, { ok: false, error: errMsg(e) }) }
}

function handleChromeHint(_req, res) {
  send(res, {
    ok: true,
    hint: '请在 Chrome 地址栏打开 chrome://inspect/#remote-debugging ，勾选 "Allow remote debugging for this browser instance"（允许远程调试），然后重试。\nOpen chrome://inspect/#remote-debugging in Chrome, tick "Allow remote debugging for this browser instance", then retry.',
  })
}

// ── update handlers ──
async function handleUpdateCheck(req, res) {
  try {
    const force = new URL(req.url, 'http://localhost').searchParams.get('force') === '1'
    const state = await checkUpdates(force)
    send(res, { ok: true, ...state })
  } catch (e) { send(res, { ok: false, error: errMsg(e) }) }
}

// 深度检测：逐层（CLI 地址 / PyPI / GitHub / 完整 checkUpdates）运行并返回
// 每层结果与失败原因，供设置页「运行检测」按钮展示。
//
// 有异常时（且 repair=1，默认开启）把结论递给专用的「修复会话」，由那里的
// Agent 自己读代码、改代码。第一次新建会话，之后复用同一个 sessionId。
async function handleCheckUpdate(req, res) {
  try {
    const params = new URL(req.url, 'http://localhost').searchParams
    const result = await runUpdateDiagnostics()
    const repair = { attempted: false }
    if (params.get('repair') !== '0') {
      try {
        repair.attempted = true
        repair.result = await dispatchRepair({
          diag: result,
          sessionController: ctxRef.sessionController,
          workspaceRegistry: ctxRef.workspaceRegistry,
          cwd: process.cwd(),
          paths: {
            installedDir: PLUGIN_DIR,
            repoDir: REPO_DIR,
            bin: resolveHarnessBin(),
          },
          force: params.get('force') === '1',
        })
      } catch (e) {
        repair.result = { ok: false, action: 'failed', reason: errMsg(e) }
      }
    }
    send(res, { ok: true, ...result, repair })
  } catch (e) { send(res, { ok: false, error: errMsg(e) }) }
}

// 修复会话的状态：记住的 sessionId、上次发送时间、状态文件路径，
// 以及两个必需服务是否真的被注入到了 —— 否则界面看不出自愈是"跳过"还是"没能力"。
async function handleRepairStatus(_req, res) {
  try {
    const repair = await readRepairState()
    send(res, {
      ok: true,
      ...repair,
      stateFile: stateFile(),
      services: {
        sessionController: ctxRef.sessionController !== undefined,
        workspaceRegistry: ctxRef.workspaceRegistry !== undefined,
      },
    })
  } catch (e) { send(res, { ok: false, error: errMsg(e) }) }
}

// 忘掉记住的会话（会话坏了、或想强制下次换一个新的）。
async function handleRepairReset(_req, res) {
  try {
    await resetRepairSession()
    send(res, { ok: true, ...(await readRepairState()) })
  } catch (e) { send(res, { ok: false, error: errMsg(e) }) }
}

async function handleUpdate(req, res) {
  try {
    const body = await readBody(req)
    if (body.confirm !== true) {
      return send(res, { ok: false, error: '需要确认（confirm: true）才执行更新 / update requires confirm: true' }, 400)
    }
    const output = await runCliUpdate()
    // Auto-publish to GitHub once the CLI is updated. Failure to publish does
    // NOT fail the update — it is reported alongside the new state.
    let published = null
    try {
      published = await publishToGithub({ reason: `bump after browser-harness update: ${output.slice(0, 120)}` })
    } catch (e) {
      published = { ok: false, reason: e.message }
    }
    const state = await checkUpdates(true)
    send(res, { ok: true, output, published, ...state })
  } catch (e) {
    send(res, { ok: false, error: errMsg(e), hint: e.hint || undefined })
  }
}

// ── capability layer: MCP server (preferred) or this plugin's built-in tools ──
const DEFAULT_MCP_SERVER_NAME = 'bh'
const DEFAULT_MCP_TIMEOUT_MS = 120_000
const DOCTOR = 'browser_doctor'

/**
 * Read the loader row config defensively: this plugin exports no Config schema,
 * so an older host may pass anything (or nothing) through.
 * @param {unknown} config - raw loader config.
 * @returns {{ mode: 'mcp'|'builtin', serverName: string, toolCallTimeoutMs: number }}
 */
function readConfig(config) {
  const c = config !== null && typeof config === 'object' ? config : {}
  const raw = typeof c.mode === 'string' ? c.mode.trim().toLowerCase() : ''
  const serverName = typeof c.serverName === 'string' ? c.serverName.trim() : ''
  return {
    mode: raw === 'builtin' ? 'builtin' : 'mcp',
    serverName: serverName === '' ? DEFAULT_MCP_SERVER_NAME : serverName,
    toolCallTimeoutMs: Number.isFinite(c.toolCallTimeoutMs) && c.toolCallTimeoutMs > 0
      ? c.toolCallTimeoutMs
      : DEFAULT_MCP_TIMEOUT_MS,
  }
}

/**
 * Public name of one browser tool in the active mode. MCP-mounted tools are
 * namespaced by the host's MCP client as `mcp__<serverName>__<rawName>`.
 * @param {string} label - trailing name, e.g. `page_info`.
 * @param {'mcp'|'builtin'} mode - active capability layer.
 * @param {string} serverName - MCP namespace.
 * @returns {string}
 */
function toolName(label, mode, serverName) {
  return mode === 'mcp' ? `mcp__${serverName}__browser_${label}` : `browser_${label}`
}

/**
 * Prompt section body. Tool names must match what is actually registered, so the
 * text is built per mode instead of hard-coding one naming scheme.
 * @param {'mcp'|'builtin'} mode - active capability layer.
 * @param {string} serverName - MCP namespace.
 * @returns {string}
 */
function promptText(mode, serverName) {
  const n = (label) => toolName(label, mode, serverName)
  if (mode === 'mcp') {
    return [
      `网页交互任务（点击、输入、导航、截图、读取需 JS 渲染或登录态的页面）请使用 ${n('*')} 工具：`,
      `1. 先 ${n('page_info')} 确认连接与当前页面；`,
      `2. 首次导航用 ${n('new_tab')}(url)，之后用 ${n('goto')}(url)；`,
      `3. 等页面/元素就绪用 ${n('wait_for_element')} / ${n('wait_for_load')}，不要用固定 sleep 猜；`,
      `4. 表单优先 ${n('fill')}(selector, text)，聚焦输入才用 ${n('type')}；`,
      `5. 读 DOM 用 ${n('js')}，看布局用 ${n('screenshot')}；${n('click')} 是坐标点击，点前先确认元素可见；`,
      `6. 多标签用 ${n('list_tabs')} / ${n('switch_tab')}；需要任意 CDP 能力时才用 ${n('cdp')}；`,
      `7. 连接失败时先跑 ${DOCTOR} 诊断（该工具在任何模式下都叫 ${DOCTOR}）。`,
      'For interactive web tasks use the browser tools: page_info first, wait_for_element before acting, fill for inputs, js/screenshot for inspection, cdp only when no dedicated tool fits, doctor when connections fail.',
    ].join('\n')
  }
  return [
    `网页交互任务（点击、输入、导航、截图、读取需 JS 渲染或登录态的页面）请使用 ${n('*')} 工具：`,
    `1. 先 ${n('page_info')} 确认连接与当前页面；`,
    `2. 首次导航用 ${n('new_tab')}(url)，之后用 ${n('goto')}(url)；`,
    `3. 优先用 ${n('js')} 读 DOM / ${n('screenshot')} 看布局，坐标点击 ${n('click')} 前先确认元素可见；`,
    `4. 连接失败时先跑 ${DOCTOR} 诊断。`,
    'For interactive web tasks use the built-in browser tools: page_info first, new_tab for first navigation, js/screenshot for inspection, doctor when connections fail.',
  ].join('\n')
}

/**
 * Mount browser-harness' own MCP server through the host's generic MCP client.
 * Never throws: a machine without the CLI (or with an older one) still gets the
 * built-in tool set plus a working doctor, so this plugin can always activate.
 * @param {object} ctx - plugin context.
 * @param {{ mode: 'mcp'|'builtin', serverName: string, toolCallTimeoutMs: number }} cfg - resolved config.
 * @returns {Promise<'mcp'|'builtin'>} the mode actually in effect.
 */
async function mountCapability(ctx, cfg) {
  if (cfg.mode === 'builtin') return 'builtin'
  const warn = (message) => {
    try { ctx.logger?.warn?.(message) } catch { /* best effort */ }
  }
  let mcpBin = null
  try {
    mcpBin = resolveMcpBin(resolveHarnessBin())
  } catch { /* resolution is best effort */ }
  if (mcpBin === null) {
    warn('browser-harness: browser-harness-mcp not found (needs CLI >= 0.1.13 with the [mcp] extra); using the built-in tool set')
    return 'builtin'
  }
  try {
    const mcp = await import('@deepseek-ai/dsh-mcp-client')
    if (typeof mcp.apply !== 'function') throw new Error('@deepseek-ai/dsh-mcp-client exports no apply()')
    ctx.plugin(
      { name: mcp.name, apply: mcp.apply, inject: mcp.inject, Config: mcp.Config },
      {
        transport: 'stdio',
        serverName: cfg.serverName,
        command: mcpBin,
        args: [],
        toolCallTimeoutMs: cfg.toolCallTimeoutMs,
        // A broken MCP server must never block this plugin's activation: doctor and
        // the settings page stay reachable, and the MCP client retries on its own.
        failOnStartupError: false,
      },
    )
    try { ctx.logger?.info?.(`browser-harness: MCP tools mounted (serverName=${cfg.serverName})`) } catch { /* best effort */ }
    return 'mcp'
  } catch (error) {
    warn(`browser-harness: MCP client unavailable (${errMsg(error)}); using the built-in tool set`)
    return 'builtin'
  }
}

export async function apply(ctx, config) {
  const cfg = readConfig(config)

  // 1. Capability layer: the MCP server when available, built-in tools otherwise.
  const mode = await mountCapability(ctx, cfg)

  // 2. Browser-connection prompt section (tool names follow the active mode).
  const sp = ctx.get('systemPrompt')
  if (sp !== undefined) {
    sp.section({
      name: 'browser-harness:connection',
      order: -40,
      text: () => promptText(mode, cfg.serverName),
    })
  }

  // 3. Tools: the doctor is this plugin's own in every mode; the other seven are
  //    registered only when the MCP layer is not supplying them.
  const tools = ctx.get('tools')
  if (tools !== undefined) {
    for (const tool of createBrowserTools()) {
      if (tool.name === DOCTOR || mode !== 'mcp') tools.register(tool)
    }
  }

  // 3b. 自愈会话需要的两个服务。check-update 的 handler 是模块级函数，
  //     拿不到 ctx，所以把引用存到 ctxRef；服务缺席时 dispatchRepair 会自己降级。
  for (const serviceName of ['sessionController', 'workspaceRegistry']) {
    ctx.inject([serviceName], (sctx) => {
      try {
        ctxRef[serviceName] = sctx.get(serviceName)
      } catch { /* 服务不可用就让自愈功能降级 */ }
      sctx.effect(() => () => { ctxRef[serviceName] = undefined }, `browser-harness: ${serviceName} ref`)
    })
  }

  // 3. 设置 > 浏览器连接 HTTP API.
  ctx.inject(['webServer'], (wctx) => {
    const routes = [
      { kind: 'exact', path: '/browser-harness/api/status', handler: handleStatus },
      { kind: 'exact', path: '/browser-harness/api/doctor', handler: handleDoctor },
      { kind: 'exact', path: '/browser-harness/api/screenshot', handler: handleScreenshot },
      { kind: 'exact', path: '/browser-harness/api/chrome-hint', handler: handleChromeHint },
      { kind: 'exact', path: '/browser-harness/api/update-check', handler: handleUpdateCheck },
      { kind: 'exact', path: '/browser-harness/api/check-update', handler: handleCheckUpdate },
      { kind: 'exact', path: '/browser-harness/api/update', handler: handleUpdate },
      { kind: 'exact', path: '/browser-harness/api/repair-status', handler: handleRepairStatus },
      { kind: 'exact', path: '/browser-harness/api/repair-reset', handler: handleRepairReset },
    ]
    for (const route of routes) {
      wctx.effect(() => wctx.webServer.register(route), `browser-harness: ${route.path} route`)
    }
  })

  // 4. Settings namespace + plugin card.
  ctx.inject(['settings'], (sctx) => {
    try {
      // dsh 0.1.x exposes `settings.register(namespace, schema)`; dsh 0.2.x dropped it
      // (settings are declared through the plugin's Config schema instead). Probe it so
      // the timeout keeps working on old versions and silently falls back on new ones.
      if (typeof sctx.settings?.register !== 'function') throw new Error('settings.register unavailable')
      const scope = sctx.settings.register('browser-harness', z.object({
        timeoutSec: z.number().min(5).max(300).default(60),
      }), { base: { timeoutSec: 60 } })
      scope.watch(() => {
        try {
          const v = scope.get()
          if (v && Number.isFinite(v.timeoutSec)) globalThis.__BH_TIMEOUT_MS = v.timeoutSec * 1000
        } catch { /* best effort */ }
      })
    } catch {
      // settings unavailable — run without the namespace
    }
    sctx.effect(() => () => {}, 'browser-harness: settings teardown')
  })
}
