// dsh-plugin-browser-harness — update detection & execution.
//
// Two layers, both reported in one check:
//   project  — the upstream repo browser-use/browser-harness. Latest release
//              tag is read via `git ls-remote --tags` (goes through the user's
//              git proxy config, which is the only route out on proxy-only
//              machines; Node fetch ignores HTTP_PROXY entirely).
//   cli      — the installed browser-harness CLI (the thing we can actually
//              upgrade). Latest is read from PyPI (direct fetch works).
//
// The browser-harness repo tags releases v0.1.x that match the PyPI CLI
// version 1:1 (v0.1.10 ↔ browser-harness 0.1.10), so the project version the
// current install corresponds to is the CLI version itself. CLI_TO_PROJECT
// stays as an override table for any future divergence; when the mapping has
// no entry we report the CLI version and never claim a project update.
//
// Updates run `browser-harness --update -y` — the CLI's own upgrade path
// (`uv tool upgrade browser-harness` + daemon restart).
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { runHarnessArgs, resolveHarnessBin } from './engine.js'

const UPDATES_TTL_MS = 30 * 60 * 1000
// The CLI's own repo — tags v0.1.x that match PyPI versions 1:1.
const REPO = 'browser-use/browser-harness'
const PYPI_JSON = 'https://pypi.org/pypi/browser-harness/json'

// browser-harness CLI version -> repo release tag it shipped with.
// The repo tags match PyPI versions 1:1 (v0.1.10 ↔ 0.1.10), so entries are
// normally redundant; keep this as an override for future divergence.
export const CLI_TO_PROJECT = {
  '0.1.9': '0.1.9',
  '0.1.10': '0.1.10',
}

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

function parseSemver(v) {
  if (typeof v !== 'string') return null
  const m = SEMVER.exec(v.trim())
  if (m === null) return null
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] === undefined ? [] : m[4].split('.') }
}

/** Semver-ish compare: positive when a > b, negative when a < b, 0 equal, null undecidable. */
export function compareVersions(a, b) {
  const pa = parseSemver(a)
  const pb = parseSemver(b)
  if (pa === null || pb === null) return null
  for (let i = 0; i < 3; i++) {
    if (pa.core[i] !== pb.core[i]) return pa.core[i] - pb.core[i]
  }
  if (pa.pre.length === 0 || pb.pre.length === 0) return pb.pre.length - pa.pre.length
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
    const x = pa.pre[i]
    const y = pb.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    const nx = /^\d+$/.test(x)
    const ny = /^\d+$/.test(y)
    if (nx && ny) return Number(x) - Number(y)
    if (nx !== ny) return nx ? -1 : 1
    return x < y ? -1 : 1
  }
  return 0
}

function isUpgrade(installed, latest) {
  if (installed === null || latest === null) return false
  const cmp = compareVersions(latest, installed)
  return cmp !== null && cmp > 0
}

// ── version sources ──────────────────────────────────────────────────────────
async function fetchJson(url, init) {
  const res = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': 'dsh-plugin-browser-harness' },
    signal: AbortSignal.timeout(10_000),
    ...init,
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

/** Latest browser-harness on PyPI, or null when unreachable. */
export async function fetchCliLatest() {
  try {
    const doc = await fetchJson(PYPI_JSON)
    return typeof doc?.info?.version === 'string' ? doc.info.version : null
  } catch {
    return null
  }
}

/** Installed browser-harness CLI version, or null when the CLI is missing. */
export async function fetchCliInstalled() {
  const bin = resolveHarnessBin()
  if (!bin) return null
  try {
    const res = await runHarnessArgs(['--version'], { timeoutMs: 15_000 })
    const v = (res.stdout || '').trim()
    return /^\d+(\.\d+){1,2}/.test(v) ? v : null
  } catch {
    return null
  }
}

/** Latest browser-use release tag via git ls-remote (uses git proxy config). */
export async function fetchProjectLatest() {
  return new Promise((resolve) => {
    const child = spawn('git', ['ls-remote', '--tags', '--refs', `https://github.com/${REPO}.git`], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* ignore */ }
      resolve(null)
    }, 20_000)
    child.stdout.on('data', (d) => { out += d.toString('utf8') })
    child.stderr.on('data', (d) => { err += d.toString('utf8') })
    child.on('error', () => { clearTimeout(timer); resolve(null) })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) return resolve(null)
      // Tags look like `refs/tags/v0.1.10` (or `0.1.10`). Take the newest semver.
      let best = null
      let bestCmp = null
      for (const line of out.split(/\r?\n/)) {
        const m = /refs\/tags\/(\S+)$/.exec(line.trim())
        if (!m) continue
        const tag = m[1]
        if (!parseSemver(tag)) continue
        const cmp = parseSemver(tag)
        if (bestCmp === null || compareVersions(tag, best) > 0) {
          best = tag
          bestCmp = cmp
        }
      }
      resolve(best)
    })
  })
}

// ── composite check ──────────────────────────────────────────────────────────
let cache = null

/**
 * Full update picture: project (GitHub repo) + CLI (PyPI vs installed).
 * TTL-cached for 30 minutes; pass `force` to bypass.
 * A failure on any source reports that source as unknown rather than failing
 * the whole check — an offline machine must not look "up to date" as if a
 * check had happened.
 */
export async function checkUpdates(force = false) {
  if (!force && cache !== null && Date.now() - cache.at < UPDATES_TTL_MS) {
    return cache.data
  }
  const [cliInstalled, cliLatest, projectLatest] = await Promise.all([
    fetchCliInstalled(),
    fetchCliLatest(),
    fetchProjectLatest(),
  ])
  const projectBaseline = cliInstalled !== null ? (CLI_TO_PROJECT[cliInstalled] ?? null) : null
  const data = {
    repo: REPO,
    checkedAt: new Date().toISOString(),
    cli: {
      installed: cliInstalled,
      latest: cliLatest,
      updateAvailable: isUpgrade(cliInstalled, cliLatest),
    },
    project: {
      latest: projectLatest,
      baseline: projectBaseline,
      updateAvailable: projectBaseline !== null && projectLatest !== null && isUpgrade(projectBaseline, projectLatest),
      // When we can't resolve the baseline we say "unknown" instead of "no
      // update": the check didn't really happen.
      comparable: projectBaseline !== null && projectLatest !== null,
    },
  }
  cache = { at: Date.now(), data }
  return data
}

export function invalidateUpdates() {
  cache = null
}

// ── execution ────────────────────────────────────────────────────────────────
/**
 * Run `browser-harness --update -y`. Resolves with the CLI's output.
 * Throws on non-zero exit / missing CLI.
 */
export async function runCliUpdate() {
  const bin = resolveHarnessBin()
  if (!bin) {
    const err = new Error('browser-harness CLI 未找到 / CLI not found')
    err.hint = 'uv tool install --python 3.12 browser-harness'
    throw err
  }
  const res = await runHarnessArgs(['--update', '-y'], { timeoutMs: 120_000 })
  if (!res.ok && res.code !== 0) {
    const err = new Error((res.stderr || res.stdout || `browser-harness --update exited ${res.code}`).trim().slice(0, 600))
    err.hint = '可在终端手动执行：browser-harness --update -y'
    throw err
  }
  invalidateUpdates()
  return (res.stdout + (res.stderr ? `\n${res.stderr}` : '')).trim()
}

// ── GitHub auto-publish ───────────────────────────────────────────────────────
/**
 * Run a git command in the plugin source dir (which doubles as its repo).
 * Git picks up the user's proxy config automatically, so this also works on
 * proxy-only machines.
 * @returns {{ok:boolean, out:string, err:string, code:number|null}}
 */
function runGit(dir, args, { timeoutMs = 60_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn('git', args, {
      cwd: dir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      windowsHide: true,
    })
    let out = ''
    let err = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { child.kill('SIGKILL') } catch { /* ignore */ }
      resolve({ ok: false, out, err: `${err}\ngit timed out after ${timeoutMs}ms`.trim(), code: null })
    }, timeoutMs)
    child.stdout.on('data', (d) => { out += d.toString('utf8') })
    child.stderr.on('data', (d) => { err += d.toString('utf8') })
    child.on('error', (e) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok: false, out, err: `failed to spawn git: ${e.message}`, code: null })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok: code === 0, out, err, code })
    })
  })
}

/** Locate the plugin's own source repo. Prefer the explicit env override
 *  (the developer's checkout, where the real git remote lives); fall back to
 *  the directory this code is running from. */
function pluginSourceDir() {
  const override = process.env.DSH_PLUGIN_BROWSER_HARNESS_REPO
  if (override && typeof override === 'string' && override.trim()) return override.trim().replace(/[\\/]+$/, '')
  return fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '')
}

/**
 * Publish the plugin source to its GitHub remote as a new release:
 *   git add -A → commit → bump patch version in package.json → tag vX.Y.Z → push.
 * No-op (returns {ok:false, reason}) when the dir is not a git repo with a remote.
 */
export async function publishToGithub({ reason = 'update' } = {}) {
  const dir = pluginSourceDir()
  const remote = await runGit(dir, ['remote', 'get-url', 'origin'])
  if (!remote.ok) {
    return { ok: false, reason: '不是 git 仓库或未配置 origin 远程（发布到 GitHub 需要先 git init + 配置 origin）' }
  }
  const branch = await runGit(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const head = (branch.ok ? branch.out.trim() : 'master') || 'master'

  // 1. Stage everything (respects .gitignore; never tracks the tarball).
  const add = await runGit(dir, ['add', '-A'])
  if (!add.ok) return { ok: false, reason: `git add 失败: ${(add.err || add.out).trim().slice(0, 300)}` }

  // 2. Commit (no-op if nothing changed).
  const commit = await runGit(dir, ['commit', '-m', `chore: ${reason}`])
  if (!commit.ok && !/nothing to commit|no changes added/.test((commit.err || commit.out))) {
    return { ok: false, reason: `git commit 失败: ${(commit.err || commit.out).trim().slice(0, 300)}` }
  }

  // 3. Determine next patch version from package.json, bump it, and commit
  //    the version change so the tag points at the release content.
  const pkgPath = join(dir, 'package.json')
  const pkg = JSON.parse(await readFile(pkgPath, 'utf8'))
  const [maj, min, pat] = (pkg.version || '0.0.0').split('.').map((n) => Number(n) || 0)
  const next = `${maj}.${min}.${pat + 1}`
  pkg.version = next
  await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
  await runGit(dir, ['add', 'package.json'])
  const vcommit = await runGit(dir, ['commit', '-m', `chore: bump version to ${next} (${reason})`])
  if (!vcommit.ok && !/nothing to commit|no changes added/.test((vcommit.err || vcommit.out))) {
    return { ok: false, reason: `git commit (version bump) 失败: ${(vcommit.err || vcommit.out).trim().slice(0, 300)}` }
  }

  // 4. Tag + push.
  const tag = `v${next}`
  const tagRes = await runGit(dir, ['tag', '-a', tag, '-m', `release ${tag} (${reason})`])
  if (!tagRes.ok) return { ok: false, reason: `git tag 失败: ${(tagRes.err || tagRes.out).trim().slice(0, 300)}` }
  const push = await runGit(dir, ['push', 'origin', head, '--tags'], { timeoutMs: 120_000 })
  if (!push.ok) {
    return { ok: false, reason: `git push 失败: ${(push.err || push.out).trim().slice(0, 300)}（请检查远程认证）` }
  }
  return { ok: true, version: next, tag, pushed: true }
}

