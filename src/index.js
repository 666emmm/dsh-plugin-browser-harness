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
import { runJson, jsonSnippet, resolveHarnessBin, installGuidance } from './engine.js'
import { checkUpdates, runCliUpdate, publishToGithub } from './update.js'
import z from '@deepseek-ai/schemastery'

export const name = 'browser-harness'

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
import json
_result = { 'ok': True }
try:
    result = run_doctor()
    _result['detail'] = json.dumps(result, ensure_ascii=True, default=str) if isinstance(result, (dict, list)) else str(result)
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

export function apply(ctx) {
  // 1. Browser-connection prompt section.
  const sp = ctx.get('systemPrompt')
  if (sp !== undefined) {
    sp.section({
      name: 'browser-harness:connection',
      order: -40,
      text: () => [
        '网页交互任务（点击、输入、导航、截图、读取需 JS 渲染或登录态的页面）请使用 browser_* 工具：',
        '1. 先 browser_page_info 确认连接与当前页面；',
        '2. 首次导航用 browser_new_tab(url)，之后用 browser_goto(url)；',
        '3. 优先用 browser_js 读 DOM / browser_screenshot 看布局，坐标点击 browser_click 前先确认元素可见；',
        '4. 连接失败时先跑 browser_doctor 诊断。',
        'For interactive web tasks use browser_* tools: page_info first, new_tab for first navigation, js/screenshot for inspection, doctor when connections fail.',
      ].join('\n'),
    })
  }

  // 2. Tools.
  const tools = ctx.get('tools')
  if (tools !== undefined) {
    for (const tool of createBrowserTools()) {
      tools.register(tool)
    }
  }

  // 3. 设置 > 浏览器连接 HTTP API.
  ctx.inject(['webServer'], (wctx) => {
    const routes = [
      { kind: 'exact', path: '/browser-harness/api/status', handler: handleStatus },
      { kind: 'exact', path: '/browser-harness/api/doctor', handler: handleDoctor },
      { kind: 'exact', path: '/browser-harness/api/screenshot', handler: handleScreenshot },
      { kind: 'exact', path: '/browser-harness/api/chrome-hint', handler: handleChromeHint },
      { kind: 'exact', path: '/browser-harness/api/update-check', handler: handleUpdateCheck },
      { kind: 'exact', path: '/browser-harness/api/update', handler: handleUpdate },
    ]
    for (const route of routes) {
      wctx.effect(() => wctx.webServer.register(route), `browser-harness: ${route.path} route`)
    }
  })

  // 4. Settings namespace + plugin card.
  ctx.inject(['settings'], (sctx) => {
    try {
      const scope = sctx.settings.register('browser-harness', z.object({
        timeoutSec: z.number().min(5).max(300).default(60),
      }), { base: { timeoutSec: 60 } })
      scope.watch(() => {
        try {
          const v = scope.get()
          if (v && Number.isFinite(v.timeoutSec)) globalThis.__BH_TIMEOUT_MS = v.timeoutSec * 1000
        } catch { /* best effort */ }
      })
      const llm = ctx.get('llm')
      if (llm !== undefined) {
        try {
          llm.registerConfigurableProviders([{ provider: 'browser-harness', displayName: '浏览器连接（browser-harness）' }])
        } catch { /* best effort */ }
      }
    } catch {
      // settings unavailable — run without the namespace
    }
    sctx.effect(() => () => {}, 'browser-harness: settings teardown')
  })
}
