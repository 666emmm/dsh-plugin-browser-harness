// dsh-plugin-browser-harness — self-repair session.
//
// 检测（/browser-harness/api/check-update）发现异常后，把结论交给一个专用的
// 「修复会话」，由那里的 Agent 自己去读代码、改代码。第一次新建，之后复用同一个
// sessionId（冷会话由 sessionController.prompt 内部自动 resume）。
//
// 状态存在 ~/.dsh/browser-harness-repair.json —— 不写死在代码里，也不依赖
// settings 命名空间（dsh 0.2.x 的 SettingsForms 已经没有 register() 了）。
//
// 递归防护（两重）：
//   1. 消息正文写明「你是自动拉起的修复会话，不要再次触发检测」
//   2. 状态文件里的 lastPromptAt：REPAIR_COOLDOWN_MS 内不再开新会话
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 冷却窗口：这段时间内重复检测不再拉起新会话。 */
const REPAIR_COOLDOWN_MS = 10 * 60 * 1000

/** 状态文件位置（与 dsh 的其它运行时状态并列）。 */
export function stateFile() {
  const base = process.env.DSH_HOME || join(process.env.USERPROFILE || homedir(), '.dsh')
  return join(base, 'browser-harness-repair.json')
}

export async function readState() {
  try {
    const raw = await readFile(stateFile(), 'utf8')
    const parsed = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

async function writeState(next) {
  const file = stateFile()
  try {
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, JSON.stringify(next, null, 2), 'utf8')
  } catch { /* 状态文件写不进去不能阻断修复流程 */ }
}

/** 内容哈希，作为 prompt 的 requestId —— 同样的结论重复提交会被幂等吞掉。 */
function hashText(text) {
  let h = 5381
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0
  return h.toString(36)
}

/**
 * 选一个工作区：优先 cwd 与之一致的，其次第一个有 sessionIds 的，最后降级到 cwd。
 * 用 workspaceId 而不是 cwd，修复会话才会出现在侧边栏的工作区下面（见知识库 bh-plugin n7）。
 */
function pickWorkspace(registry, cwd) {
  if (registry === undefined || typeof registry.list !== 'function') return null
  let workspaces = []
  try { workspaces = registry.list() } catch { return null }
  if (!Array.isArray(workspaces) || workspaces.length === 0) return null
  const norm = (p) => String(p || '').replace(/[\\/]+$/, '').toLowerCase()
  const exact = workspaces.find((w) => norm(w.path) === norm(cwd))
  if (exact !== undefined) return exact
  const withSessions = workspaces.find((w) => Array.isArray(w.sessionIds) && w.sessionIds.length > 0)
  return withSessions ?? workspaces[0] ?? null
}

/** 把 diagnostics 的分层结果压成给 Agent 看的文本。 */
export function formatFindings(diag) {
  const lines = []
  const label = { a: 'A. CLI 地址检测', b: 'B. PyPI 更新获取', c: 'C. GitHub 项目更新', d: 'D. 完整 checkUpdates()' }
  for (const key of ['a', 'b', 'c', 'd']) {
    const layer = diag?.[key]
    if (layer === undefined) continue
    const mark = layer.ok ? 'OK  ' : 'FAIL'
    lines.push(`[${mark}] ${label[key]} — ${layer.msg ?? ''}`)
    if (!layer.ok && layer.detail) {
      for (const line of String(layer.detail).split('\n')) lines.push(`         ${line}`)
    }
  }
  return lines.join('\n')
}

/** diagnostics 里是否有需要修的层。 */
export function hasFindings(diag) {
  return ['a', 'b', 'c', 'd'].some((key) => diag?.[key] !== undefined && diag[key].ok !== true)
}

function buildMessage(findings, context) {
  return [
    '这是 dsh-plugin-browser-harness 自动发起的自愈请求。你在一个「修复会话」里。',
    '',
    '## 重要：不要再次触发检测',
    '',
    '你是被自动拉起的修复会话。**不要**去点设置页的「检测」按钮，也**不要**调用',
    '/browser-harness/api/check-update —— 那会再拉起一个会话，无限套娃。',
    '改完代码直接汇报即可，由人来复检。',
    '',
    '## 检测结论',
    '',
    '```',
    findings,
    '```',
    '',
    '## 环境',
    '',
    `- 已安装插件（正在运行，改这里立刻生效）：${context.installedDir}`,
    `- 上游仓库（改完要推）：${context.repoDir}`,
    `- CLI：${context.bin ?? '(未解析到)'}`,
    `- 时间：${context.now}`,
    '',
    '## 要做的事',
    '',
    '1. 先读知识库 `bh-plugin`（如果可用），里面记着这个插件三次修复的根因和手法，',
    '   尤其是「找唯一的例外路径」和「必须包 jsonSnippet」这两条。',
    '2. 针对上面 FAIL 的那一层定位根因，**改已安装目录让它立刻生效**，',
    '   再同步改仓库目录。',
    '3. 改完用 node 逐字复现验证，不要只看代码就说修好了。',
    '4. 汇报：根因 / 改了哪些文件 / 怎么验证的。',
  ].join('\n')
}

/**
 * 确保有一个可用的修复会话，并把结论发过去。
 *
 * @param {object} opts
 * @param {object} opts.diag - runUpdateDiagnostics() 的返回值
 * @param {object} [opts.sessionController] - ctx.sessionController
 * @param {object} [opts.workspaceRegistry] - ctx.workspaceRegistry
 * @param {string} [opts.cwd] - 降级用的工作目录
 * @param {object} [opts.paths] - { installedDir, repoDir, bin }
 * @param {boolean} [opts.force] - 忽略冷却窗口
 * @returns {Promise<{ok:boolean, action:string, sessionId?:string, reason?:string}>}
 */
export async function dispatchRepair(opts) {
  const { diag, sessionController, workspaceRegistry, cwd, paths = {}, force = false } = opts

  if (!hasFindings(diag)) {
    return { ok: true, action: 'skipped', reason: '全部通过，没有需要修的东西' }
  }
  if (sessionController === undefined) {
    return { ok: false, action: 'skipped', reason: 'ctx.sessionController 不可用（这个 profile 没装 session-controller？）' }
  }

  const findings = formatFindings(diag)
  // 空结论绝不发 —— prompt 对纯空白内容会抛 gateway/bad-request
  if (findings.trim() === '') {
    return { ok: false, action: 'skipped', reason: '结论为空' }
  }

  const now = Date.now()
  const state = await readState()
  if (!force && typeof state.lastPromptAt === 'number' && now - state.lastPromptAt < REPAIR_COOLDOWN_MS) {
    const left = Math.ceil((REPAIR_COOLDOWN_MS - (now - state.lastPromptAt)) / 60000)
    return {
      ok: true,
      action: 'cooling',
      sessionId: state.sessionId,
      reason: `冷却中，还有 ${left} 分钟；同一个会话里已经发过结论了`,
    }
  }

  const context = {
    installedDir: paths.installedDir ?? '(未知)',
    repoDir: paths.repoDir ?? '(未知)',
    bin: paths.bin ?? null,
    now: new Date().toISOString(),
  }
  const message = buildMessage(findings, context)
  const requestId = `bh-repair-${hashText(findings)}`

  const promptInto = async (sessionId) => sessionController.prompt({
    requestId,
    sessionId,
    mode: 'queue',
    content: [{ type: 'text', text: message }],
    clientTimeZone: 'Asia/Shanghai',
  })

  // 1. 先试复用的那个会话
  if (typeof state.sessionId === 'string' && state.sessionId !== '') {
    try {
      await promptInto(state.sessionId)
      await writeState({ ...state, lastPromptAt: now })
      return { ok: true, action: 'reused', sessionId: state.sessionId }
    } catch (error) {
      // 会话被归档/删掉了 —— 往下走，建一个新的。
      // DSH 抛的文案是 `session "<id>" not found`（带空格），不是 `not-found`；
      // 这里把连字符/下划线/空格三种写法、以及 resume 失败的各变体都覆盖掉。
      const reason = error?.message ?? String(error)
      const recoverable = /not[\s_-]?found|disposed|archived|resume|unknown session|invalid session/i.test(reason)
      if (!recoverable) {
        return { ok: false, action: 'failed', sessionId: state.sessionId, reason }
      }
    }
  }

  // 2. 新建
  let created
  try {
    const workspace = pickWorkspace(workspaceRegistry, cwd)
    // workspaceId 与 cwd 不能同时给，否则 gateway/bad-request
    created = workspace !== null
      ? await sessionController.create({ workspaceId: workspace.id })
      : await sessionController.create({ cwd: cwd ?? process.cwd() })
  } catch (error) {
    return { ok: false, action: 'failed', reason: `create 失败: ${error?.message ?? String(error)}` }
  }

  const sessionId = created?.sessionId
  if (typeof sessionId !== 'string' || sessionId === '') {
    return { ok: false, action: 'failed', reason: 'create 没返回 sessionId' }
  }

  try {
    await promptInto(sessionId)
  } catch (error) {
    return { ok: false, action: 'failed', sessionId, reason: `prompt 失败: ${error?.message ?? String(error)}` }
  }

  await writeState({ sessionId, lastPromptAt: now, createdAt: state.createdAt ?? new Date(now).toISOString() })
  return { ok: true, action: 'created', sessionId }
}

/** 清掉记住的会话（会话坏了、或想强制换一个新的）。 */
export async function resetRepairSession() {
  const state = await readState()
  await writeState({ createdAt: state.createdAt })
  return { ok: true }
}
