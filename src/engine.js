// dsh-plugin-browser-harness — engine: drive the `browser-harness` CLI from
// Node. The CLI is a Python wrapper that reads a Python snippet on stdin and
// executes it with browser-harness helpers pre-imported (page_info, new_tab,
// click_at_xy, js, cdp, ...). We always ask the snippet to print exactly one
// JSON line (ensure_ascii=True) and parse that from stdout, so encoding and
// banner noise are handled once here.
//
// Fully self-contained (node:child_process / node:fs only) — zero runtime deps.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const DEFAULT_TIMEOUT_MS = 60_000

// ── binary resolution ────────────────────────────────────────────────────────
// Resolution order:
//   1. $BROWSER_HARNESS_BIN (explicit override)
//   2. uv tool install default location (~/.local/bin/browser-harness(.exe))
//   3. the venv shim directory next to the uv tool (Windows: %APPDATA%/uv/tools)
//   4. `browser-harness` on PATH (last resort)
// NOTE: the bare name MUST come last — the running dsh web process's PATH
// snapshot often predates `uv tool install` and lacks the uv bin dir, so a
// bare-name spawn would ENOENT even though the CLI is installed. The absolute
// candidates exist on disk regardless of PATH and are checked first.
function candidatePaths() {
  const list = []
  if (process.env.BROWSER_HARNESS_BIN) list.push(process.env.BROWSER_HARNESS_BIN)
  const home = process.env.USERPROFILE || process.env.HOME || ''
  if (home) {
    list.push(join(home, '.local', 'bin', process.platform === 'win32' ? 'browser-harness.exe' : 'browser-harness'))
    if (process.platform === 'win32') {
      const appData = process.env.APPDATA || ''
      if (appData) list.push(join(appData, 'uv', 'tools', 'browser-harness', 'Scripts', 'browser-harness.exe'))
    }
  }
  list.push('browser-harness') // resolved by spawn via PATH — last resort only
  return [...new Set(list)]
}

/** Resolve the browser-harness executable, or null when unavailable. */
export function resolveHarnessBin() {
  for (const p of candidatePaths()) {
    if (p === 'browser-harness') {
      // PATH lookup without spawning: probe a trivial --help run is expensive,
      // so just trust PATH for the bare name; spawn reports ENOENT on failure.
      return p
    }
    try {
      if (existsSync(p)) return p
    } catch { /* ignore */ }
  }
  return null
}

/** Human-readable install guidance when the CLI is missing. */
export function installGuidance() {
  return [
    'browser-harness CLI 未找到 / browser-harness CLI not found.',
    '安装方法 / install:',
    '  uv tool install --python 3.12 browser-harness',
    '（uv 可从 https://astral.sh/uv/ 安装；或设置 BROWSER_HARNESS_BIN 指向可执行文件。）',
    '(install uv from https://astral.sh/uv/ , or point $BROWSER_HARNESS_BIN at the executable.)',
  ].join('\n')
}

// ── process runner ───────────────────────────────────────────────────────────
/**
 * Spawn `browser-harness`, feed `code` on stdin, collect stdout/stderr.
 * @returns {{ ok: boolean, stdout: string, stderr: string, code: number|null, error?: Error }}
 */
export function runHarness(code, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const bin = resolveHarnessBin()
    if (!bin) {
      resolve({ ok: false, stdout: '', stderr: installGuidance(), code: null, error: new Error('browser-harness not found') })
      return
    }
    const child = spawn(bin, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { child.kill('SIGKILL') } catch { /* ignore */ }
      resolve({ ok: false, stdout, stderr: `${stderr}\nbrowser-harness timed out after ${timeoutMs}ms`.trim(), code: null, error: new Error('timeout') })
    }, timeoutMs)
    child.stdout.on('data', (d) => { stdout += d.toString('utf8') })
    child.stderr.on('data', (d) => { stderr += d.toString('utf8') })
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const hint = err.code === 'ENOENT'
        ? installGuidance()
        : `failed to spawn browser-harness: ${err.message}`
      resolve({ ok: false, stdout, stderr: hint, code: null, error: err })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok: code === 0, stdout, stderr, code })
    })
    child.stdin.on('error', () => { /* EPIPE when the CLI exits early */ })
    child.stdin.end(code)
  })
}

/**
 * Run `browser-harness <args...>` as a plain CLI invocation (no stdin code),
 * e.g. `--version`, `--update -y`. Collects stdout/stderr.
 * @returns {{ ok: boolean, stdout: string, stderr: string, code: number|null }}
 */
export function runHarnessArgs(args, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const bin = resolveHarnessBin()
    if (!bin) {
      resolve({ ok: false, stdout: '', stderr: installGuidance(), code: null })
      return
    }
    const child = spawn(bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { child.kill('SIGKILL') } catch { /* ignore */ }
      resolve({ ok: false, stdout, stderr: `${stderr}\nbrowser-harness timed out after ${timeoutMs}ms`.trim(), code: null })
    }, timeoutMs)
    child.stdout.on('data', (d) => { stdout += d.toString('utf8') })
    child.stderr.on('data', (d) => { stderr += d.toString('utf8') })
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok: false, stdout, stderr: err.code === 'ENOENT' ? installGuidance() : `failed to spawn browser-harness: ${err.message}`, code: null })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok: code === 0, stdout, stderr, code })
    })
  })
}

/**
 * Run a snippet and parse the LAST JSON line from stdout.
 * The CLI prints banners/updates to stderr; stdout should be our JSON line,
 * but we scan all lines so a stray log cannot break parsing.
 * @returns {Promise<{ok: boolean, value: any, stderr: string, error?: Error}>}
 */
export async function runJson(code, opts) {
  const res = await runHarness(code, opts)
  if (!res.ok && !res.stdout.trim()) {
    return { ok: false, value: null, stderr: res.stderr, error: res.error || new Error(res.stderr || 'browser-harness failed') }
  }
  const lines = res.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  let value = null
  let error = null
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      value = JSON.parse(lines[i])
      break
    } catch {
      /* try previous line */
    }
  }
  if (value === null) {
    error = new Error(`无法解析 browser-harness 输出 / cannot parse output:\n${res.stdout.slice(0, 500)}${res.stderr ? `\nstderr: ${res.stderr.slice(0, 300)}` : ''}`)
    return { ok: false, value: null, stderr: res.stderr, error }
  }
  if (!res.ok && res.code !== 0) {
    return { ok: false, value, stderr: res.stderr, error: new Error(value?.error || res.stderr || `browser-harness exited ${res.code}`) }
  }
  return { ok: true, value, stderr: res.stderr }
}

/**
 * Build a snippet that prints `json.dumps(payload, ensure_ascii=True)`.
 * @param {string} body - Python statements; may reference `json` (pre-imported).
 * @returns {string}
 */
export function jsonSnippet(body) {
  return `${body}\nprint(json.dumps(_result, ensure_ascii=True))`
}
