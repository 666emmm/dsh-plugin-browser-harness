// dsh-plugin-browser-harness — annotation store.
//
// Holds the annotations collected from the page picker, per owning DSH session,
// plus the "who currently owns the browser" record.
//
// Two things live here:
//
//  1. Ownership. The user's model is "whichever session started the picker owns
//     the whole Chrome until it says otherwise". `browser_annotate` claims
//     ownership for its session; a later claim from another session replaces it
//     (the plugin only records the latest owner — it does not arbitrate, because
//     the human is the one who decides when to switch).
//
//  2. A bounded queue of annotations per session. Bounded because an annotation
//     carries a full element description (attributes + computed styles); an
//     unbounded queue would grow without limit if a user annotated hundreds of
//     elements and never read them.
//
// Persistence: JSON on disk under the dsh home so annotations survive a plugin
// reload / dsh restart. Writes are debounced — the file is small but the watcher
// can enqueue in bursts.
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const MAX_PER_SESSION = 200
const MAX_SESSIONS = 40
const SAVE_DEBOUNCE_MS = 400

/** @returns {string} absolute path of the annotation state file. */
export function stateFile() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'browser-harness-annotations.json')
}

/** In-memory state. Shape: { owner, sessions: { [sessionId]: Annotation[] } } */
let state = null
let saveTimer = null
let dirty = false

function emptyState() {
  return { owner: null, sessions: {} }
}

function load() {
  if (state !== null) return state
  try {
    const raw = readFileSync(stateFile(), 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && parsed.sessions && typeof parsed.sessions === 'object') {
      state = {
        owner: parsed.owner && typeof parsed.owner === 'object' ? parsed.owner : null,
        sessions: parsed.sessions,
      }
    } else {
      state = emptyState()
    }
  } catch {
    state = emptyState()
  }
  return state
}

function scheduleSave() {
  dirty = true
  if (saveTimer !== null) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    flush()
  }, SAVE_DEBOUNCE_MS)
  saveTimer.unref?.()
}

/** Write pending changes to disk immediately (also used by tests). */
export function flush() {
  if (!dirty || state === null) return
  dirty = false
  try {
    const file = stateFile()
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
    renameSync(tmp, file)
  } catch {
    // Persistence is best effort: losing the on-disk copy must not break the
    // in-memory flow, which is what the model actually reads.
  }
}

// ── ownership ────────────────────────────────────────────────────────────────

/**
 * Record that `sessionId` now owns the picker.
 * @param {string} sessionId
 * @param {{ binding?: string, targetId?: string|null, url?: string, title?: string }} meta
 * @returns {{ previous: string|null, owner: object }}
 */
export function claimOwnership(sessionId, meta = {}) {
  const s = load()
  const previous = s.owner?.sessionId ?? null
  s.owner = {
    sessionId: normalizeKey(sessionId),
    claimedAt: new Date().toISOString(),
    binding: meta.binding ?? null,
    targetId: meta.targetId ?? null,
    url: meta.url ?? '',
    title: meta.title ?? '',
  }
  scheduleSave()
  return { previous, owner: s.owner }
}

/** Current owner record, or null. */
export function owner() {
  return load().owner
}

/** True when `sessionId` is the current owner. */
export function ownsBrowser(sessionId) {
  const o = load().owner
  return o !== null && o.sessionId === normalizeKey(sessionId)
}

/** Refresh the owner's last-seen tab (called by the watcher as tabs change). */
export function touchOwnerTab(meta = {}) {
  const s = load()
  if (s.owner === null) return null
  if (meta.targetId !== undefined) s.owner.targetId = meta.targetId
  if (meta.url !== undefined) s.owner.url = meta.url
  if (meta.title !== undefined) s.owner.title = meta.title
  s.owner.lastSeenAt = new Date().toISOString()
  scheduleSave()
  return s.owner
}

/**
 * Release ownership. Annotations already queued stay queued — the user may
 * still want them; only the live picker claim is dropped.
 * @param {string} [sessionId] - only clear when this session is the owner.
 * @returns {boolean} whether ownership was cleared.
 */
export function releaseOwnership(sessionId) {
  const s = load()
  if (s.owner === null) return false
  if (sessionId !== undefined && s.owner.sessionId !== normalizeKey(sessionId)) return false
  s.owner = null
  scheduleSave()
  return true
}

// ── annotation queue ─────────────────────────────────────────────────────────

/**
 * Normalise a session id to the `session-<uuid>` form used by the host.
 *
 * Duplicated from annotation-watcher on purpose: the store must not import the
 * watcher (the watcher imports the store). Both entry points need the same
 * answer, because a queue keyed `abc-…` can never be found by a prompt addressed
 * to `session-abc-…`.
 *
 * @param {string} id
 * @returns {string}
 */
function normalizeKey(id) {
  if (typeof id !== 'string') return id
  const trimmed = id.trim()
  if (trimmed === '' || trimmed.startsWith('session-')) return trimmed
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)) {
    return `session-${trimmed}`
  }
  return trimmed
}

/**
 * Append one annotation to its session's queue.
 *
 * @param {string} sessionId - owning session.
 * @param {object} annotation - payload from the picker.
 * @returns {{ ok: boolean, id: string|null, duplicate: boolean, queued: number, dropped: number }}
 *   `duplicate` is true when an annotation with the same id is already queued —
 *   the binding channel and the localStorage mirror can both deliver the same
 *   annotation, so callers must tolerate repeats.
 */
export function enqueue(sessionId, annotation) {
  const s = load()
  const key = normalizeKey(sessionId)
  if (!s.sessions[key]) s.sessions[key] = []
  const list = s.sessions[key]

  const id = typeof annotation?.id === 'string' ? annotation.id : null
  if (id !== null && list.some((a) => a.id === id)) {
    return { ok: false, id, duplicate: true, queued: list.length, dropped: 0 }
  }

  const record = {
    ...annotation,
    id: id ?? `ann_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    receivedAt: new Date().toISOString(),
    delivered: false,
    deliveredAt: null,
  }
  list.push(record)

  let dropped = 0
  while (list.length > MAX_PER_SESSION) {
    list.shift()
    dropped += 1
  }

  // Bound the number of sessions we remember, oldest-touched first.
  const sessionIds = Object.keys(s.sessions)
  if (sessionIds.length > MAX_SESSIONS) {
    const ordered = sessionIds
      .map((sid) => ({ sid, at: s.sessions[sid]?.[s.sessions[sid].length - 1]?.receivedAt ?? '' }))
      .sort((a, b) => a.at.localeCompare(b.at))
    for (const { sid } of ordered.slice(0, sessionIds.length - MAX_SESSIONS)) {
      delete s.sessions[sid]
    }
  }

  scheduleSave()
  return { ok: true, id: record.id, duplicate: false, queued: list.length, dropped }
}

/** All annotations for a session (newest last). */
export function listFor(sessionId) {
  return [...(load().sessions[normalizeKey(sessionId)] ?? [])]
}

/** Annotations not yet handed to the model. */
export function pendingFor(sessionId) {
  return listFor(sessionId).filter((a) => a.delivered !== true)
}

/**
 * Mark one annotation as delivered to the model.
 * @returns {boolean} whether a matching undelivered record was found.
 */
export function markDelivered(sessionId, id) {
  const s = load()
  const list = s.sessions[normalizeKey(sessionId)]
  if (!list) return false
  const record = list.find((a) => a.id === id)
  if (!record) return false
  if (record.delivered === true) return false
  record.delivered = true
  record.deliveredAt = new Date().toISOString()
  scheduleSave()
  return true
}

/** Drop every annotation for a session. @returns {number} removed count. */
export function clearSession(sessionId) {
  const s = load()
  const key = normalizeKey(sessionId)
  const list = s.sessions[key]
  if (!list) return 0
  const count = list.length
  delete s.sessions[key]
  scheduleSave()
  return count
}

/** Summary for the HTTP status route / the settings page. */
export function summary() {
  const s = load()
  const sessions = {}
  for (const [sid, list] of Object.entries(s.sessions)) {
    sessions[sid] = {
      total: list.length,
      pending: list.filter((a) => a.delivered !== true).length,
      lastAt: list[list.length - 1]?.receivedAt ?? null,
    }
  }
  return {
    owner: s.owner,
    sessions,
    stateFile: stateFile(),
  }
}

/** Test seam: drop in-memory state so the next call re-reads from disk. */
export function resetForTests() {
  state = null
  dirty = false
  if (saveTimer !== null) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
}

/**
 * Render one annotation as the text block handed to the model.
 *
 * Deliberately verbose: the model cannot see the page, so the selector, the
 * matched-element text, the box and the few style facts that are usually the
 * point all belong in the message. The comment stays verbatim and first —
 * it is the human's actual instruction.
 *
 * @param {object} annotation - one queued record.
 * @param {{ index?: number, total?: number }} [position] - for multi-annotation batches.
 * @returns {string}
 */
export function formatForModel(annotation, position = {}) {
  const el = annotation?.element ?? {}
  const styles = el.styles ?? {}
  const rect = styles.rect ?? {}
  const lines = []

  const header = position.total && position.total > 1
    ? `页面批注 ${position.index}/${position.total}`
    : '页面批注'
  lines.push(`【${header}】`)
  lines.push('')
  lines.push(`批注内容：${annotation?.comment ?? '（无）'}`)
  lines.push('')

  lines.push('元素定位：')
  // Shadow DOM 必须先说清楚，否则模型会拿一个只在 shadow root 内有效的选择器
  // 去主文档里查，然后得出"这个元素不存在"的错误结论。这是实际发生过的事：
  // 一条 B站 评论的 #count 被报成"主文档里根本不存在"。
  const shadow = el.shadow ?? null
  if (shadow && shadow.inShadow) {
    lines.push(`  ⚠ 此元素在 Shadow DOM 内（${shadow.depth} 层）。下面的选择器只在对应 shadow root 内有效，主文档 querySelector 找不到它。`)
    lines.push(`  穿透路径：${shadow.selector || '(未获取)'}`)
    if (Array.isArray(shadow.hostTags) && shadow.hostTags.length > 0) {
      lines.push(`  宿主标签：${shadow.hostTags.join(' > ')}`)
    }
    if (shadow.reachable === false) {
      lines.push('  注意：宿主是 closed shadow root，脚本无法访问其内部，只能按坐标定位。')
    }
    lines.push(`  本层选择器：${el.selector || '(未获取)'}`)
    // 给一段能直接粘进 browser_js 的代码，省掉模型自己拼穿透链的步骤 ——
    // 拼错了就会再次得出"元素不存在"。
    if (Array.isArray(shadow.hostSelectors) && shadow.hostSelectors.length > 0 && shadow.reachable !== false) {
      const steps = [...shadow.hostSelectors, el.selector]
        .filter((s) => typeof s === 'string' && s !== '')
        .map((s) => JSON.stringify(s))
      lines.push(`  取元素代码：` + 'let e=document; for (const s of [' + steps.join(', ')
        + ']) { e = e && (e.shadowRoot || e).querySelector(s); } e')
    }
  } else {
    lines.push(`  选择器：${el.selector || '(未获取)'}`)
  }
  if (el.structuralSelector && el.structuralSelector !== el.selector) {
    lines.push(`  备用选择器：${el.structuralSelector}`)
  }
  if (typeof el.matchCount === 'number') {
    const scope = shadow && shadow.inShadow ? '（该 shadow root 内）' : ''
    lines.push(`  匹配数量：${el.matchCount}${scope}${el.matchCount === 1 ? '' : '（选择器不唯一，优先用备用选择器）'}`)
  }
  lines.push(`  标签：<${el.tag || '?'}>${el.id ? ` id="${el.id}"` : ''}${el.role ? ` role="${el.role}"` : ''}`)
  if (el.className) lines.push(`  class：${el.className}`)
  if (el.text) lines.push(`  可见文本：${JSON.stringify(el.text)}`)

  const attrEntries = Object.entries(el.attributes ?? {})
  if (attrEntries.length > 0) {
    lines.push(`  属性：${attrEntries.map(([k, v]) => `${k}="${v}"`).join(' ')}`)
  }

  lines.push('')
  lines.push('位置与样式：')
  lines.push(`  位置：x=${rect.x} y=${rect.y} 宽=${rect.width} 高=${rect.height}`)
  const styleBits = []
  if (styles.fontSize) styleBits.push(`字号 ${styles.fontSize}`)
  if (styles.fontWeight) styleBits.push(`字重 ${styles.fontWeight}`)
  if (styles.color) styleBits.push(`文字色 ${styles.color}`)
  if (styles.backgroundColor && styles.backgroundColor !== 'rgba(0, 0, 0, 0)') {
    styleBits.push(`背景 ${styles.backgroundColor}`)
  }
  if (styles.display) styleBits.push(`display ${styles.display}`)
  if (styles.position) styleBits.push(`position ${styles.position}`)
  if (styles.opacity && styles.opacity !== '1') styleBits.push(`opacity ${styles.opacity}`)
  if (styles.border && !/^0px/.test(styles.border)) styleBits.push(`边框 ${styles.border}`)
  if (styleBits.length > 0) lines.push(`  ${styleBits.join(' · ')}`)

  lines.push('')
  lines.push('所在页面：')
  lines.push(`  URL：${annotation?.page?.url || el.frameUrl || '(未知)'}`)
  if (annotation?.page?.title) lines.push(`  标题：${annotation.page.title}`)

  return lines.join('\n')
}

/**
 * Render several annotations into one message body. Used when a batch of
 * pending annotations is flushed in a single prompt.
 * @param {object[]} annotations
 * @returns {string}
 */
export function formatBatch(annotations) {
  if (annotations.length === 0) return ''
  if (annotations.length === 1) return formatForModel(annotations[0])
  return annotations
    .map((a, i) => formatForModel(a, { index: i + 1, total: annotations.length }))
    .join('\n\n' + '─'.repeat(40) + '\n\n')
}
