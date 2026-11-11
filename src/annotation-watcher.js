// dsh-plugin-browser-harness — annotation watcher.
//
// The one piece that makes "click send in the page → the owning session gets a
// message, without the human switching back" work.
//
// How the pieces fit
// ------------------
//   page picker  →  window.__bhAnnotation(json)      (no network, no CSP)
//                        ↓ CDP runtime binding
//   daemon       →  Runtime.bindingCalled in its event buffer
//                        ↓ drained by THIS watcher over loopback TCP (≈1.3 ms)
//   watcher      →  annotation-store.enqueue(ownerSession, payload)
//                        ↓ sessionController.prompt(...)
//   owning session → a new user message appears; the model starts working
//
// Why poll instead of subscribe
// -----------------------------
// The daemon's IPC is request/response only — there is no push channel — and its
// event buffer is a destructive deque (`drain_events` clears it). Polling once a
// second over loopback costs ~1.3 ms and is the only option that needs no change
// to browser-harness itself.
//
// The drain is destructive, so the watcher is careful:
//   * It only runs while a picker is claimed. Outside that window nothing drains
//     the buffer, so browser-harness' own `wait_for_network_idle` (the only
//     in-tree consumer) keeps working exactly as before.
//   * Events it does not care about are discarded, which is what the daemon
//     would do anyway once the 500-slot deque wraps.
//
// Delivery semantics
// ------------------
//   * One prompt per annotation by default: the user's model is "each send is a
//     separate task". A short debounce coalesces bursts (several annotations
//     sent within a second or two) into one message so the model is not spammed.
//   * `mode: 'queue'` — never 'steer': a queued prompt waits for the model's
//     current turn instead of interrupting it. The user explicitly said "模型还在
//     回答也算" — the message only has to arrive, not preempt.
//   * `requestId` is derived from the annotation id so a retry is idempotent on
//     the host side.
import { addBinding, currentSession, currentTab, daemonAlive, drainEvents, evaluate } from './daemon-ipc.js'
import {
  claimOwnership,
  enqueue,
  formatBatch,
  listFor,
  markDelivered,
  owner,
  pendingFor,
  touchOwnerTab,
} from './annotation-store.js'
import { buildPickerScript, buildPickerProbe, buildDrainPending } from './picker.js'

const DEFAULT_INTERVAL_MS = 1_000
const DEFAULT_DEBOUNCE_MS = 1_200
const DEFAULT_IDLE_TIMEOUT_MS = 60 * 60 * 1000 // one hour of no annotations
const MAX_PROMPT_ATTEMPTS = 3

/** @typedef {{ sessionId: string, binding: string, targetId: string|null }} Owner */

/**
 * Normalise a DSH session id to the `session-<uuid>` form the host expects.
 *
 * DSH is inconsistent about this in the wild: `exec.sessionId` inside a tool can
 * be the bare uuid, while `workspace.json`, the on-disk directory (`session-<uuid>`)
 * and `sessionController.prompt` all use the prefixed form. Passing the bare uuid
 * to prompt fails with `session "<id>" not found`, which reads like a missing
 * session rather than a formatting problem.
 *
 * Already-prefixed ids (and anything not shaped like a uuid) pass through
 * untouched, so a host that changes its scheme cannot be broken by this.
 *
 * @param {string} id
 * @returns {string}
 */
export function normalizeSessionId(id) {
  if (typeof id !== 'string') return id
  const trimmed = id.trim()
  if (trimmed === '') return trimmed
  if (trimmed.startsWith('session-')) return trimmed
  // 8-4-4-4-12 hex is the only shape we rewrite.
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)) {
    return `session-${trimmed}`
  }
  return trimmed
}

/**
 * The watcher is a singleton: one poll loop, one claimed owner at a time.
 * Keeping it module-level (rather than per-session) matches the user's mental
 * model — the browser has exactly one owner.
 */
const runtime = {
  timer: null,
  intervalMs: DEFAULT_INTERVAL_MS,
  debounceMs: DEFAULT_DEBOUNCE_MS,
  idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS,
  startedAt: null,
  lastAnnotationAt: null,
  lastPollAt: null,
  lastPollError: null,
  pollCount: 0,
  deliveredCount: 0,
  failedCount: 0,
  bindingName: null,
  // Prompt delivery is injected by index.js so this module never imports the
  // host's session-controller plumbing directly.
  sendPrompt: null,
  // Batches waiting for the debounce window to close.
  pendingFlush: null,
  flushing: false,
  // Re-entrancy guard: the poll must not overlap itself.
  polling: false,
  log: () => {},
}

/**
 * Register the function used to hand text to a session.
 * @param {(args: { sessionId: string, text: string, requestId: string }) => Promise<{ ok: boolean, error?: string }>} fn
 */
export function setPromptSender(fn) {
  runtime.sendPrompt = fn
}

/** Inject a logger (defaults to a no-op so tests stay quiet). */
export function setLogger(fn) {
  runtime.log = typeof fn === 'function' ? fn : () => {}
}

/** Watcher status for the HTTP route and the settings page. */
export function watcherStatus() {
  return {
    running: runtime.timer !== null,
    owner: owner(),
    bindingName: runtime.bindingName,
    intervalMs: runtime.intervalMs,
    startedAt: runtime.startedAt,
    lastPollAt: runtime.lastPollAt,
    lastPollError: runtime.lastPollError,
    lastAnnotationAt: runtime.lastAnnotationAt,
    pollCount: runtime.pollCount,
    deliveredCount: runtime.deliveredCount,
    failedCount: runtime.failedCount,
  }
}

/**
 * Install (or re-install) the picker in the currently attached page and start
 * watching for its binding events.
 *
 * Re-injection is the normal path, not an error case: the picker dies on every
 * navigation, and the user is expected to move between tabs. Callers should
 * therefore treat `browser_annotate` as idempotent.
 *
 * @param {{ sessionId: string, binding?: string, intervalMs?: number, idleTimeoutMs?: number }} options
 * @returns {Promise<object>} a result record shaped for the tool output.
 */
export async function startWatching({ sessionId, binding = '__bhAnnotation', intervalMs, idleTimeoutMs } = {}) {
  if (typeof sessionId !== 'string' || sessionId === '') {
    return { ok: false, error: '缺少 sessionId / sessionId is required' }
  }
  // DSH addresses sessions as `session-<uuid>`; workspace.json, the session
  // directory names and sessionController.prompt all agree on that form. A bare
  // uuid is rejected by prompt with `session "<id>" not found` — which looks like
  // a dead session and sends you hunting for the wrong bug. Normalise here so
  // every caller (tool, HTTP route, tests) can pass either form.
  sessionId = normalizeSessionId(sessionId)
  if (intervalMs !== undefined && Number.isFinite(intervalMs) && intervalMs >= 250) {
    runtime.intervalMs = intervalMs
  }
  if (idleTimeoutMs !== undefined && Number.isFinite(idleTimeoutMs) && idleTimeoutMs > 0) {
    runtime.idleTimeoutMs = idleTimeoutMs
  }
  runtime.bindingName = binding

  // 1. The daemon must be alive; without it there is no CDP and no events.
  if (!(await daemonAlive())) {
    return {
      ok: false,
      error: 'browser-harness daemon 未运行 / daemon not running。请先确认浏览器连接正常（可用 browser_doctor）。',
    }
  }

  // 2. Bindings are per CDP session, and the daemon rebuilds the session on
  //    switch_tab / new_tab, so register on every start.
  const bound = await addBinding(binding)
  if (!bound) {
    return { ok: false, error: 'Runtime.addBinding 失败 / could not register the CDP binding' }
  }

  // 3. Install the picker in the active page.
  const tab = await currentTab()
  const script = buildPickerScript({ binding, sessionTag: sessionId })
  const injected = await evaluate(script)
  if (!injected.ok) {
    return {
      ok: false,
      error: `注入拾取器失败 / could not inject the picker: ${injected.error}`,
      tab,
    }
  }

  // 4. Collect anything the previous session left in localStorage (page was
  //    reloaded between the send and the next poll).
  const recovered = await drainLocalMirror(sessionId)

  // 5. Claim ownership. This MUST happen before the loop starts: the loop stops
  //    itself when there is no owner, so claiming later would kill it on the
  //    first tick. A claim from a different session replaces the previous owner
  //    (the human decides when to switch, the plugin only records it).
  const claim = claimOwnership(sessionId, {
    binding,
    targetId: tab?.targetId ?? null,
    url: tab?.url ?? '',
    title: tab?.title ?? '',
  })

  // 6. Start the loop.
  startLoop()

  return {
    ok: true,
    sessionId,
    binding,
    tab,
    picker: injected.value,
    recovered,
    owner: claim.owner,
    previousOwner: claim.previous,
    watcher: { running: true, intervalMs: runtime.intervalMs },
    hint: '拾取器已注入当前标签页。请在页面上点「开始选择」→ 点元素 → 写批注 → 发送。发送后本会话会自动收到消息；你可以继续切到别的标签页。',
  }
}

/** Start (or restart) the poll loop. Idempotent. */
function startLoop() {
  if (runtime.timer !== null) return
  runtime.startedAt = new Date().toISOString()
  runtime.lastAnnotationAt = null
  runtime.timer = setInterval(() => {
    void pollOnce()
  }, runtime.intervalMs)
  runtime.timer.unref?.()
  runtime.log(`annotation watcher started (every ${runtime.intervalMs}ms)`)
}

/** Stop the loop. Annotations already queued are kept. */
export function stopLoop(reason = 'stopped') {
  if (runtime.timer !== null) {
    clearInterval(runtime.timer)
    runtime.timer = null
  }
  if (runtime.pendingFlush !== null) {
    clearTimeout(runtime.pendingFlush)
    runtime.pendingFlush = null
  }
  runtime.log(`annotation watcher stopped (${reason})`)
}

/**
 * Stop watching and clear the in-memory claim. Queued annotations stay on disk.
 * @param {{ sessionId?: string, clear?: boolean }} [options]
 */
export async function stopWatching({ sessionId, clear = false } = {}) {
  stopLoop('stopWatching')
  const { releaseOwnership, clearSession } = await import('./annotation-store.js')
  const normalised = sessionId === undefined ? undefined : normalizeSessionId(sessionId)
  const released = releaseOwnership(normalised)
  let cleared = 0
  if (clear && typeof normalised === 'string') cleared = clearSession(normalised)
  return { ok: true, released, cleared, watcher: watcherStatus() }
}

/**
 * One poll iteration: drain, filter, enqueue, schedule delivery.
 * Never throws — a failure is recorded in `lastPollError` so the status route
 * can show it without the interval dying.
 */
async function pollOnce() {
  if (runtime.polling) return
  runtime.polling = true
  try {
    runtime.pollCount += 1
    runtime.lastPollAt = new Date().toISOString()

    const claim = owner()
    if (claim === null) {
      stopLoop('owner released')
      return
    }

    const events = await drainEvents()
    runtime.lastPollError = null

    const annotations = []
    let pickerClosed = false
    for (const event of events) {
      if (event.method !== 'Runtime.bindingCalled') continue
      if (event.params?.name !== runtime.bindingName) continue
      const parsed = safeParse(event.params?.payload)
      if (parsed === null) continue
      // Attribute by the tag the picker was injected with; a picker from another
      // session (stale injection) must not feed this session's queue.
      if (parsed.sessionTag !== claim.sessionId) continue

      // The human pressed 「关闭」. Stop polling and release the browser so the
      // daemon's event buffer is left alone again — an idle watcher that keeps
      // draining it forever was the old behaviour and it served no purpose.
      // Annotations already sent are flushed first, then the loop stops.
      if (parsed.kind === 'picker_closed') {
        pickerClosed = true
        continue
      }
      if (parsed.kind === 'annotation') annotations.push(parsed)
    }

    if (annotations.length > 0) {
      runtime.lastAnnotationAt = new Date().toISOString()
      for (const annotation of annotations) {
        const result = enqueue(claim.sessionId, annotation)
        if (result.ok) {
          runtime.log(`annotation queued: ${result.id} (${result.queued} in queue)`)
        } else if (!result.duplicate) {
          runtime.log(`annotation rejected: ${result.id}`)
        }
      }
      scheduleFlush(claim.sessionId)
    }

    if (pickerClosed) {
      runtime.log('picker closed by the human — releasing the browser')
      // Flush whatever is still queued before tearing the loop down, otherwise
      // an annotation sent right before closing would sit undelivered.
      await flushPending(claim.sessionId)
      const { releaseOwnership } = await import('./annotation-store.js')
      releaseOwnership(claim.sessionId)
      stopLoop('picker closed')
      return
    }

    // Keep the owner's tab record fresh so the status page shows where the user
    // is, and so a later "which page was this from" question has an answer.
    // Every 5th tick also re-installs the picker if the page navigated away from
    // it — a closed panel is an explicit release, but a navigation is not, and
    // silently losing the UI mid-task would be baffling.
    if (runtime.pollCount % 5 === 0) {
      const before = owner()
      const tab = await currentTab()
      if (tab !== null) touchOwnerTab(tab)
      const changed = before !== null && tab !== null && tab.targetId !== before.targetId
      if (changed || runtime.pollCount % 15 === 0) {
        try {
          await ensurePicker(claim.sessionId, runtime.bindingName)
        } catch { /* re-injection is best effort */ }
      }
    }

    // Idle timeout: an abandoned claim should not poll forever.
    if (runtime.lastAnnotationAt !== null) {
      const idleMs = Date.now() - Date.parse(runtime.lastAnnotationAt)
      if (idleMs > runtime.idleTimeoutMs) {
        stopLoop(`idle for ${Math.round(idleMs / 60000)}min`)
      }
    } else if (runtime.startedAt !== null) {
      const ageMs = Date.now() - Date.parse(runtime.startedAt)
      if (ageMs > runtime.idleTimeoutMs) {
        stopLoop(`no annotations for ${Math.round(ageMs / 60000)}min`)
      }
    }
  } catch (error) {
    runtime.lastPollError = error?.message ?? String(error)
  } finally {
    runtime.polling = false
  }
}

/**
 * Coalesce bursts: several annotations sent in quick succession become one
 * message. A lone annotation is still delayed by `debounceMs`, which is short
 * enough to feel immediate but long enough to merge a rapid multi-pick.
 */
function scheduleFlush(sessionId) {
  if (runtime.pendingFlush !== null) clearTimeout(runtime.pendingFlush)
  runtime.pendingFlush = setTimeout(() => {
    runtime.pendingFlush = null
    void flushPending(sessionId)
  }, runtime.debounceMs)
  runtime.pendingFlush.unref?.()
}

/**
 * Hand every undelivered annotation for `sessionId` to the model.
 * @param {string} sessionId
 * @returns {Promise<{ ok: boolean, delivered: number, failed: number, error?: string }>}
 */
export async function flushPending(sessionId) {
  if (runtime.flushing) return { ok: false, delivered: 0, failed: 0, error: 'flush already in progress' }
  if (typeof runtime.sendPrompt !== 'function') {
    return { ok: false, delivered: 0, failed: 0, error: 'prompt sender not configured' }
  }
  // queue keys and prompt ids must be the same string, so normalise before either.
  sessionId = normalizeSessionId(sessionId)
  runtime.flushing = true
  try {
    const pending = pendingFor(sessionId)
    if (pending.length === 0) return { ok: true, delivered: 0, failed: 0 }

    const text = formatBatch(pending)
    // Deterministic requestId: a retry of the same batch is idempotent on the
    // host (same requestId returns the original acceptance instead of a dup).
    const requestId = `bh-annot-${sessionId.slice(0, 8)}-${pending.map((a) => a.id).join('-')}`.slice(0, 180)

    let lastError = null
    for (let attempt = 1; attempt <= MAX_PROMPT_ATTEMPTS; attempt += 1) {
      const result = await runtime.sendPrompt({ sessionId, text, requestId })
      if (result.ok) {
        for (const annotation of pending) markDelivered(sessionId, annotation.id)
        runtime.deliveredCount += pending.length
        runtime.log(`delivered ${pending.length} annotation(s) to session ${sessionId}`)
        return { ok: true, delivered: pending.length, failed: 0 }
      }
      lastError = result.error ?? 'unknown error'
      // A cold session is the common transient failure: the host resumes it on
      // demand, so one immediate retry usually succeeds.
      if (attempt < MAX_PROMPT_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, 250 * attempt))
      }
    }

    runtime.failedCount += pending.length
    runtime.log(`delivery failed for ${pending.length} annotation(s): ${lastError}`)
    return { ok: false, delivered: 0, failed: pending.length, error: lastError }
  } finally {
    runtime.flushing = false
  }
}

/** Manual trigger, used by the HTTP route and tests. */
export async function flushNow(sessionId) {
  const claim = owner()
  const target = sessionId === undefined || sessionId === null
    ? claim?.sessionId
    : normalizeSessionId(sessionId)
  if (typeof target !== 'string') return { ok: false, delivered: 0, failed: 0, error: 'no owner session' }
  return flushPending(target)
}

/**
 * Drain the localStorage mirror left by pickers whose binding call did not land
 * (page unloaded mid-send, binding not yet registered). Runs on start and on
 * every poll that finds a fresh page.
 * @param {string} sessionId
 * @returns {Promise<number>} how many annotations were recovered.
 */
async function drainLocalMirror(sessionId) {
  const drained = await evaluate(buildDrainPending())
  if (!drained.ok) return 0
  const items = drained.value?.items
  if (!Array.isArray(items) || items.length === 0) return 0
  let recovered = 0
  for (const item of items) {
    if (item?.kind !== 'annotation') continue
    if (item.sessionTag !== sessionId) continue
    const result = enqueue(sessionId, item)
    if (result.ok) recovered += 1
  }
  if (recovered > 0) {
    runtime.log(`recovered ${recovered} annotation(s) from the page mirror`)
    scheduleFlush(sessionId)
  }
  return recovered
}

/**
 * Re-inject the picker when it is gone (navigation, SPA teardown).
 * Cheap: a probe evaluate (≈1 ms) plus the injection only when needed.
 * @param {string} sessionId
 * @param {string} binding
 * @returns {Promise<{ reinstalled: boolean, reason?: string }>}
 */
export async function ensurePicker(sessionId, binding) {
  const probe = await evaluate(buildPickerProbe())
  if (probe.ok && probe.value?.alive === true) return { reinstalled: false }
  if (!probe.ok) return { reinstalled: false, reason: probe.error }

  const bound = await addBinding(binding)
  if (!bound) return { reinstalled: false, reason: 'addBinding failed' }
  const injected = await evaluate(buildPickerScript({ binding, sessionTag: sessionId }))
  if (!injected.ok) return { reinstalled: false, reason: injected.error }
  runtime.log('picker re-injected after page change')
  return { reinstalled: true }
}

function safeParse(text) {
  if (typeof text !== 'string') return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** Test seam: forget all in-memory watcher state. */
export function resetWatcherForTests() {
  stopLoop('test reset')
  runtime.pollCount = 0
  runtime.deliveredCount = 0
  runtime.failedCount = 0
  runtime.startedAt = null
  runtime.lastAnnotationAt = null
  runtime.lastPollAt = null
  runtime.lastPollError = null
  runtime.bindingName = null
  runtime.polling = false
  runtime.flushing = false
}

/** Expose the loop internals the tests need without exporting the mutable object. */
export function _internals() {
  return {
    pollOnce,
    flushPending,
    pendingFor,
    listFor,
    currentSession,
  }
}
