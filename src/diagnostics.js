// dsh-plugin-browser-harness — update-check diagnostics (shared).
//
// 把"更新检测自检"的逐层逻辑抽出来，供两处复用：
//   - scripts/check-update.js  命令行自检（npm run check-update）
//   - src/index.js             HTTP API /browser-harness/api/check-update，
//                              设置页「深度检测」按钮调用
//
// 每层返回 { ok, msg, detail? }，所有网络失败都带原因，不再静默吞错。
import { resolveHarnessBin, runHarnessArgs } from './engine.js'
import { fetchCliLatest, fetchProjectLatest, checkUpdates, CLI_TO_PROJECT } from './update.js'

/**
 * 逐层运行更新检测自检。
 * @returns {Promise<{ a:object, b:object, c:object, d:object, summary:string }>}
 */
export async function runUpdateDiagnostics() {
  const out = {}

  // ── A. CLI 地址检测 ──
  const bin = resolveHarnessBin()
  const candidates = []
  if (process.env.BROWSER_HARNESS_BIN) candidates.push(`env BROWSER_HARNESS_BIN=${process.env.BROWSER_HARNESS_BIN}`)
  candidates.push('PATH 上的 browser-harness')
  if (process.env.USERPROFILE || process.env.HOME) {
    candidates.push(`${process.env.USERPROFILE || process.env.HOME}\\.local\\bin\\browser-harness(.exe)`)
    if (process.platform === 'win32' && process.env.APPDATA) {
      candidates.push(`${process.env.APPDATA}\\uv\\tools\\browser-harness\\Scripts\\browser-harness.exe`)
    }
  }
  out.a = { ok: bin !== null, msg: bin !== null ? `resolveHarnessBin() 找到 CLI (${bin})` : 'resolveHarnessBin() 未找到 CLI', detail: `查找顺序: ${candidates.join(' → ')}` }

  let cliVersion = null
  if (bin) {
    try {
      const res = await runHarnessArgs(['--version'], { timeoutMs: 15_000 })
      cliVersion = (res.stdout || '').trim()
      out.a.version = cliVersion || null
      out.a.msg = /^\d+(\.\d+){1,2}/.test(cliVersion)
        ? `CLI --version 输出: ${cliVersion}`
        : `CLI --version 输出异常: ${cliVersion || '(空)'}${res.stderr ? ` / stderr: ${res.stderr.slice(0, 200)}` : ''}`
      if (!/^\d+(\.\d+){1,2}/.test(cliVersion)) out.a.ok = false
    } catch (e) {
      out.a.ok = false
      out.a.msg = 'CLI --version 执行失败'
      out.a.detail = (out.a.detail ? out.a.detail + '\n' : '') + e.message
    }
  } else {
    out.a.msg += '（请先安装：uv tool install --python 3.12 browser-harness）'
  }
  out.a.cliVersion = cliVersion

  // ── B. PyPI 更新获取 ──
  const cliLatest = await fetchCliLatest()
  out.b = {
    ok: cliLatest !== null,
    msg: cliLatest !== null ? `PyPI 最新版本: ${cliLatest}` : 'PyPI 无法获取最新版本',
    detail: cliLatest === null
      ? '检查网络/代理。注意：Node fetch 不走 HTTP_PROXY/HTTPS_PROXY 环境变量！\nPyPI 网址: https://pypi.org/pypi/browser-harness/json'
      : '来源: https://pypi.org/pypi/browser-harness/json（Node fetch 直连，不走代理）',
    latest: cliLatest,
  }
  out.b.upgrade = (cliVersion !== null && cliLatest !== null)
    ? (cliLatest > cliVersion ? `有升级: ${cliVersion} → ${cliLatest}` : `已是最新: ${cliVersion}`)
    : '无法比较（CLI 或 PyPI 缺失）'
  out.b.upgradeable = cliVersion !== null && cliLatest !== null && cliLatest > cliVersion

  // ── C. GitHub 项目更新获取 ──
  const projectLatest = await fetchProjectLatest()
  out.c = {
    ok: projectLatest !== null,
    msg: projectLatest !== null ? `GitHub 最新 release tag: ${projectLatest}` : 'GitHub 无法获取最新 release tag',
    detail: projectLatest === null
      ? '检查网络/代理。注意：走 git ls-remote，使用 git 自身的代理配置（与 Node fetch 无关）。\n仓库: https://github.com/browser-use/browser-harness\n可配置: git config --global http.proxy <代理> / https.proxy'
      : '来源: git ls-remote --tags https://github.com/browser-use/browser-harness.git（走 git 代理配置）',
    latest: projectLatest,
  }
  const baseline = cliVersion !== null ? (CLI_TO_PROJECT[cliVersion] ?? cliVersion) : null
  out.c.baseline = baseline
  out.c.comparable = projectLatest !== null && baseline !== null
  out.c.compareMsg = out.c.comparable ? `当前对应 ${baseline} vs 最新 ${projectLatest}` : 'CLI 未装或版本无映射，无法对比'

  // ── D. 完整 checkUpdates() ──
  try {
    const r = await checkUpdates(true)
    out.d = {
      ok: r.repo === 'browser-use/browser-harness',
      repo: r.repo,
      msg: `checkUpdates() 完成，仓库: ${r.repo}`,
      cli: r.cli,
      project: r.project,
      detail: `CLI: installed=${r.cli.installed ?? 'none'} latest=${r.cli.latest ?? 'none'} updateAvailable=${r.cli.updateAvailable}\n项目: latest=${r.project.latest ?? 'none'} baseline=${r.project.baseline ?? 'none'} updateAvailable=${r.project.updateAvailable} comparable=${r.project.comparable}`,
    }
    if (r.repo !== 'browser-use/browser-harness') out.d.msg = `检测的仓库不正确: ${r.repo}（应为 browser-use/browser-harness）`
  } catch (e) {
    out.d = { ok: false, msg: 'checkUpdates() 抛异常', detail: e.message }
  }

  // ── 汇总 ──
  const fails = ['a', 'b', 'c', 'd'].filter((k) => !out[k].ok)
  out.summary = fails.length === 0 ? '全部通过' : `发现 ${fails.length} 处异常（${fails.join('/')}）`
  return out
}
