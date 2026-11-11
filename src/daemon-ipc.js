// dsh-plugin-browser-harness — daemon IPC: talk to the browser-harness daemon
// directly over its loopback TCP socket, WITHOUT spawning a Python process.
//
// Why this exists
// ---------------
// Every regular tool call goes through `runJson()` → `spawn browser-harness`,
// which costs hundreds of milliseconds (process start + Python import). That is
// fine for an explicit tool call, but a background watcher cannot afford it.
//
// The daemon is already a long-lived service holding one CDP WebSocket. Its IPC
// is a newline-delimited JSON request/response protocol on TCP loopback
// (Windows) or an AF_UNIX socket (POSIX). A round trip measured 6.82 ms on this
// machine, so polling once per second costs ~0.7% of one core.
//
// Protocol (see browser_harness/_ipc.py):
//   - Windows: read <runtime>/bu-default.port → {"port": N, "token": "hex"}
//     every request must carry `token`; TCP loopback has no chmod boundary.
//   - POSIX:   connect to <runtime>/bu-default.sock, no token.
//   - Request: one JSON object + "\n". Response: one JSON object + "\n".
//
// Zero runtime dependencies (node:net / node:fs only).
import { connect } from 'node:net'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const IS_WINDOWS = process.platform === 'win32'
const DEFAULT_NAME = 'default'

/**
 * Candidate runtime directories that hold the daemon's port/pid/sock files.
 * `browser_harness.paths.runtime_dir()` resolves to ~/.config/browser-harness/runtime
 * on Windows; older installs used ~/.browser-harness or a temp dir, so probe a
 * few before giving up.
 * @returns {string[]}
 */
function runtimeDirs() {
  const home = homedir()
  const list = []
  const push = (p) => {
    if (p && !list.includes(p)) list.push(p)
  }
  if (process.env.BH_RUNTIME_DIR) push(process.env.BH_RUNTIME_DIR)
  if (process.env.BH_TMP_DIR) push(process.env.BH_TMP_DIR)
  if (IS_WINDOWS) {
    const appData = process.env.APPDATA || ''
    if (appData) push(join(appData, 'browser-harness', 'runtime'))
  }
  push(join(home, '.config', 'browser-harness', 'runtime'))
  push(join(home, '.browser-harness', 'runtime'))
  return list
}

/**
 * Locate the daemon endpoint.
 * @param {string} [name] - BU_NAME of the daemon instance (default "default").
 * @returns {{ kind: 'tcp', port: number, token: string } | { kind: 'unix', path: string } | null}
 */
export function resolveEndpoint(name = DEFAULT_NAME) {
  // The runtime stem is "bu" when the runtime dir is per-instance, "bu-<name>"
  // otherwise. Probe both spellings.
  const stems = [`bu-${name}`, 'bu']
  for (const dir of runtimeDirs()) {
    for (const stem of stems) {
      if (IS_WINDOWS) {
        try {
          const raw = readFileSync(join(dir, `${stem}.port`), 'utf8')
          const parsed = JSON.parse(raw)
          const port = Number(parsed.port)
          if (Number.isFinite(port) && port > 0) {
            return { kind: 'tcp', port, token: String(parsed.token ?? '') }
          }
        } catch { /* try the next candidate */ }
      } else {
        const sock = join(dir, `${stem}.sock`)
        try {
          readFileSync(sock) // existence probe only; connect() does the real work
          return { kind: 'unix', path: sock }
        } catch { /* try the next candidate */ }
      }
    }
  }
  return null
}

/**
 * One request/response round trip against the daemon.
 *
 * @param {object} request - JSON-serialisable request body, e.g. `{ meta: 'ping' }`
 *   or `{ method: 'Runtime.addBinding', params: { name: '__bhAnnotation' } }`.
 * @param {{ timeoutMs?: number, name?: string }} [options]
 * @returns {Promise<{ ok: boolean, value: any, error?: string, ms: number }>}
 *   `ok` is false when the socket could not be reached or the reply was not
 *   JSON; a daemon-level `{error: ...}` payload is returned as `ok: true` with
 *   the error inside `value`, mirroring how the CLI treats it.
 */
export function daemonCall(request, { timeoutMs = 5_000, name = DEFAULT_NAME } = {}) {
  const startedAt = process.hrtime.bigint()
  const elapsedMs = () => Number(process.hrtime.bigint() - startedAt) / 1e6

  return new Promise((resolve) => {
    const endpoint = resolveEndpoint(name)
    if (endpoint === null) {
      resolve({ ok: false, value: null, error: 'daemon 未运行（找不到 port/sock 文件）/ daemon not running (no port/sock file)', ms: elapsedMs() })
      return
    }

    const payload = endpoint.kind === 'tcp' && endpoint.token
      ? { ...request, token: endpoint.token }
      : request

    let socket
    let settled = false
    let buffer = ''

    const finish = (result) => {
      if (settled) return
      settled = true
      try { socket?.destroy() } catch { /* ignore */ }
      resolve({ ...result, ms: elapsedMs() })
    }

    try {
      socket = endpoint.kind === 'tcp'
        ? connect({ host: '127.0.0.1', port: endpoint.port })
        : connect({ path: endpoint.path })
    } catch (error) {
      finish({ ok: false, value: null, error: `连接 daemon 失败 / cannot connect: ${error.message}` })
      return
    }

    const timer = setTimeout(() => {
      finish({ ok: false, value: null, error: `daemon IPC 超时 / timed out after ${timeoutMs}ms` })
    }, timeoutMs)
    timer.unref?.()

    socket.setEncoding('utf8')
    socket.setNoDelay?.(true)

    socket.on('connect', () => {
      socket.write(`${JSON.stringify(payload)}\n`)
    })
    socket.on('data', (chunk) => {
      buffer += chunk
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      const line = buffer.slice(0, newline)
      clearTimeout(timer)
      let value
      try {
        value = JSON.parse(line)
      } catch (error) {
        finish({ ok: false, value: null, error: `daemon 返回非 JSON / non-JSON reply: ${line.slice(0, 200)}` })
        return
      }
      finish({ ok: true, value })
    })
    socket.on('error', (error) => {
      clearTimeout(timer)
      finish({ ok: false, value: null, error: `daemon IPC 错误 / IPC error: ${error.message}` })
    })
    socket.on('close', () => {
      clearTimeout(timer)
      // Reaching close without a parsed line means the daemon hung up early.
      finish({ ok: false, value: null, error: 'daemon 提前关闭连接 / daemon closed the connection' })
    })
  })
}

/** Liveness probe. @returns {Promise<boolean>} */
export async function daemonAlive(options) {
  const res = await daemonCall({ meta: 'ping' }, options)
  return res.ok && res.value?.pong === true
}

/**
 * Drain the daemon's global event buffer.
 *
 * NOTE: this is DESTRUCTIVE — the daemon does `out = list(self.events);
 * self.events.clear()`. Anything not consumed here is gone. In browser-harness
 * 0.1.13 no shipped MCP tool calls this (only `wait_for_network_idle`, which the
 * MCP server does not expose), so the annotation watcher is free to drain while
 * it is running — but it MUST stop draining when it stops, so a future
 * network-idle user is not starved.
 *
 * @param {{ timeoutMs?: number, name?: string }} [options]
 * @returns {Promise<Array<{method: string, params: object, session_id?: string}>>}
 */
export async function drainEvents(options) {
  const res = await daemonCall({ meta: 'drain_events' }, options)
  if (!res.ok) return []
  const events = res.value?.events
  return Array.isArray(events) ? events : []
}

/** The CDP session currently attached (i.e. the active tab). */
export async function currentSession(options) {
  const res = await daemonCall({ meta: 'session' }, options)
  if (!res.ok) return null
  return res.value?.session_id ?? null
}

/** Active tab identity: `{ targetId, url, title }`, or null when not attached. */
export async function currentTab(options) {
  const res = await daemonCall({ meta: 'current_tab' }, options)
  if (!res.ok) return null
  const value = res.value
  if (!value || value.error) return null
  return { targetId: value.targetId ?? null, url: value.url ?? '', title: value.title ?? '' }
}

/**
 * Move the daemon's attached CDP session to another tab.
 *
 * `Target.activateTarget` only raises a tab in the UI; it does NOT move the
 * daemon's session, so every later `Runtime.evaluate` keeps hitting the old page.
 * `meta: 'set_session'` is what actually re-attaches, and it also re-enables the
 * default CDP domains for the new session.
 *
 * @param {string} targetId - target to attach to.
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<{ ok: boolean, sessionId?: string, error?: string }>}
 */
/**
 * Move the daemon's attached CDP session to another tab.
 *
 * Two steps, and both are required — this mirrors `helpers.switch_tab`:
 *   1. `Target.attachToTarget { targetId, flatten: true }` → a CDP `sessionId`.
 *   2. `meta: 'set_session' { session_id, target_id }` → the daemon re-points at it
 *      and re-enables the default domains (Runtime/Page/DOM/Network).
 *
 * `Target.activateTarget` is NOT part of this: it only raises a tab in the UI and
 * leaves the daemon attached to the old page, which is the trap that made an
 * earlier e2e run inject the picker into the wrong tab.
 *
 * @param {string} targetId - target to attach to.
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<{ ok: boolean, sessionId?: string, error?: string }>}
 */
export async function setSession(targetId, options) {
  const attached = await daemonCall({
    method: 'Target.attachToTarget',
    params: { targetId, flatten: true },
  }, options)
  if (!attached.ok) return { ok: false, error: attached.error }
  const sessionId = attached.value?.result?.sessionId
  if (!sessionId) {
    return { ok: false, error: `attachToTarget 没有返回 sessionId: ${JSON.stringify(attached.value)?.slice(0, 200)}` }
  }
  // The daemon reads snake_case here (`req.get("session_id")` / `req.get("target_id")`);
  // camelCase would be silently ignored and the session would never move.
  const res = await daemonCall({
    meta: 'set_session',
    session_id: sessionId,
    target_id: targetId,
  }, options)
  if (!res.ok) return { ok: false, error: res.error }
  if (res.value?.error) return { ok: false, error: String(res.value.error) }
  return { ok: true, sessionId }
}

/**
 * Register a CDP runtime binding, so `window.__name(payload)` in the page turns
 * into a `Runtime.bindingCalled` event in the daemon's buffer.
 *
 * A binding is per CDP session (per attached target), and the daemon re-creates
 * the session on switch_tab/new_tab, so this must be called again after the
 * active tab changes. Calling it twice is harmless.
 *
 * @param {string} bindingName - e.g. `__bhAnnotation`.
 * @returns {Promise<boolean>}
 */
export async function addBinding(bindingName, options) {
  const res = await daemonCall({ method: 'Runtime.addBinding', params: { name: bindingName } }, options)
  return res.ok && !res.value?.error
}

/**
 * Evaluate an expression in the attached page and return its value.
 * Uses the daemon directly (no process spawn), so it is safe to call in a loop.
 * @param {string} expression - JS source; the value must be JSON-serialisable.
 * @returns {Promise<{ ok: boolean, value: any, error?: string }>}
 */
export async function evaluate(expression, options) {
  const res = await daemonCall({
    method: 'Runtime.evaluate',
    params: { expression, returnByValue: true, awaitPromise: true },
  }, options)
  if (!res.ok) return { ok: false, value: null, error: res.error }
  const payload = res.value
  if (payload?.error) return { ok: false, value: null, error: payload.error }
  const exception = payload?.result?.exceptionDetails
  if (exception) {
    return { ok: false, value: null, error: exception.exception?.description || exception.text || 'evaluate threw' }
  }
  return { ok: true, value: payload?.result?.result?.value ?? null }
}
