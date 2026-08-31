// dsh-plugin-browser-harness — 更新检测自检 / update-check self-test.
//
// 单独逐层验证"CLI 地址检测"和"更新获取"的每一步，失败时给出具体原因。
// 别人 clone 后运行：node scripts/check-update.js（或 npm run check-update）
//
// 本机能检测成功需要同时满足 3 个条件，本脚本会逐条报告：
//   A. CLI 已安装且能被找到（resolveHarnessBin → --version）
//   B. Node fetch 能访问 PyPI（注意：Node fetch 不走 HTTP_PROXY 环境变量！）
//   C. git ls-remote 能访问 GitHub（走 git 自己的代理配置，与 B 独立）
import { resolveHarnessBin, runHarnessArgs } from '../src/engine.js'
import { fetchCliLatest, fetchProjectLatest, checkUpdates, CLI_TO_PROJECT } from '../src/update.js'

let failures = 0
const ok = (cond, msg, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${extra ? `\n      ${extra}` : ''}`)
  if (!cond) failures++
}

console.log('=== A. CLI 地址检测 ===')
const bin = resolveHarnessBin()
ok(bin !== null, `resolveHarnessBin() 找到 CLI (${bin ?? 'none'})`)
const candidates = []
if (process.env.BROWSER_HARNESS_BIN) candidates.push(`env BROWSER_HARNESS_BIN=${process.env.BROWSER_HARNESS_BIN}`)
candidates.push('PATH 上的 browser-harness')
if (process.env.USERPROFILE || process.env.HOME) {
  candidates.push(`${process.env.USERPROFILE || process.env.HOME}\\.local\\bin\\browser-harness(.exe)`)
  if (process.platform === 'win32' && process.env.APPDATA) {
    candidates.push(`${process.env.APPDATA}\\uv\\tools\\browser-harness\\Scripts\\browser-harness.exe`)
  }
}
console.log(`      查找顺序: ${candidates.join(' → ')}`)

let cliVersion = null
if (bin) {
  try {
    const res = await runHarnessArgs(['--version'], { timeoutMs: 15_000 })
    cliVersion = (res.stdout || '').trim()
    ok(/^\d+(\.\d+){1,2}/.test(cliVersion), `CLI --version 输出: ${cliVersion}`, res.stderr ? `stderr: ${res.stderr.slice(0, 200)}` : '')
  } catch (e) {
    ok(false, 'CLI --version 执行失败', e.message)
  }
} else {
  console.log('SKIP  CLI --version（未找到 CLI，请先：uv tool install --python 3.12 browser-harness）')
}
ok(cliVersion !== null, 'CLI 版本可解析（fetchCliInstalled 依赖此值）')

console.log('')
console.log('=== B. PyPI 更新获取（fetchCliLatest）===')
console.log('      注意：Node fetch 不走 HTTP_PROXY/HTTPS_PROXY 环境变量！')
console.log('      若 PyPI 需代理才能访问，此步会超时失败——这是"别人检测不了"的常见原因之一。')
const cliLatest = await fetchCliLatest()
ok(cliLatest !== null, `PyPI 最新版本: ${cliLatest ?? '无法获取'}`, cliLatest === null ? '检查网络/代理；PyPI 网址 https://pypi.org/pypi/browser-harness/json' : '')
ok(cliVersion !== null && cliLatest !== null, 'CLI 升级判断可执行', cliVersion !== null && cliLatest !== null ? (cliLatest > cliVersion ? `有升级: ${cliVersion} → ${cliLatest}` : `已是最新: ${cliVersion}`) : '')

console.log('')
console.log('=== C. GitHub 项目更新获取（fetchProjectLatest）===')
console.log('      注意：走 git ls-remote，使用 git 自身的代理配置（Node fetch 与此无关）。')
console.log('      若 GitHub 需代理，请配置：git config --global http.proxy <代理> 等。')
const projectLatest = await fetchProjectLatest()
ok(projectLatest !== null, `GitHub 最新 release tag: ${projectLatest ?? '无法获取'}`, projectLatest === null ? '检查网络/代理；仓库 https://github.com/browser-use/browser-harness' : '')
const baseline = cliVersion !== null ? (CLI_TO_PROJECT[cliVersion] ?? cliVersion) : null
ok(projectLatest !== null && baseline !== null, '项目版本对比可执行', projectLatest !== null && baseline !== null ? `当前对应 ${baseline} vs 最新 ${projectLatest}` : 'CLI 未装或版本无映射，无法对比')

console.log('')
console.log('=== D. 完整 checkUpdates()（插件设置页实际调用）===')
try {
  const r = await checkUpdates(true)
  console.log(`      仓库: ${r.repo}`)
  console.log(`      CLI:   installed=${r.cli.installed ?? 'none'} latest=${r.cli.latest ?? 'none'} updateAvailable=${r.cli.updateAvailable}`)
  console.log(`      项目:  latest=${r.project.latest ?? 'none'} baseline=${r.project.baseline ?? 'none'} updateAvailable=${r.project.updateAvailable} comparable=${r.project.comparable}`)
  ok(r.repo === 'browser-use/browser-harness', '检测的仓库是 browser-use/browser-harness（不是旧仓库）')
} catch (e) {
  ok(false, 'checkUpdates() 抛异常', e.message)
}

console.log('')
console.log('说明：')
console.log('  - 若 A 失败：CLI 未安装 → 安装 `uv tool install --python 3.12 browser-harness`')
console.log('  - 若 B 失败：PyPI 无法访问（Node fetch 不走代理）→ 排查网络，或设 BROWSER_HARNESS_BIN 后手动升级')
console.log('  - 若 C 失败：GitHub 无法访问（git 代理未配）→ git config --global https.proxy <代理>')
console.log('  - 若仅 D 中 project 显示 none：CLI_TO_PROJECT 映射缺失，不影响 CLI 升级检测')
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
