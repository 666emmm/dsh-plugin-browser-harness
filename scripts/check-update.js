// dsh-plugin-browser-harness — 更新检测自检 / update-check self-test.
//
// 复用 src/diagnostics.js 的逐层检测（与设置页「深度检测」按钮共用同一逻辑）。
// 别人 clone 后运行：node scripts/check-update.js（或 npm run check-update）
import { runUpdateDiagnostics } from '../src/diagnostics.js'

const out = await runUpdateDiagnostics()

console.log('=== A. CLI 地址检测 ===')
console.log(`${out.a.ok ? 'PASS' : 'FAIL'}  ${out.a.msg}`)
if (out.a.detail) console.log(`      ${out.a.detail}`)

console.log('')
console.log('=== B. PyPI 更新获取（fetchCliLatest）===')
console.log(`${out.b.ok ? 'PASS' : 'FAIL'}  ${out.b.msg}`)
console.log(`      ${out.b.detail}`)
console.log(`      ${out.b.upgrade}`)

console.log('')
console.log('=== C. GitHub 项目更新获取（fetchProjectLatest）===')
console.log(`${out.c.ok ? 'PASS' : 'FAIL'}  ${out.c.msg}`)
console.log(`      ${out.c.detail}`)
console.log(`      ${out.c.compareMsg}`)

console.log('')
console.log('=== D. 完整 checkUpdates()（插件设置页实际调用）===')
console.log(`${out.d.ok ? 'PASS' : 'FAIL'}  ${out.d.msg}`)
console.log(`      ${out.d.detail}`)

console.log('')
console.log('说明：')
console.log('  - 若 A 失败：CLI 未安装 → 安装 `uv tool install --python 3.12 browser-harness`')
console.log('  - 若 B 失败：PyPI 无法访问（Node fetch 不走代理）→ 排查网络')
console.log('  - 若 C 失败：GitHub 无法访问（git 代理未配）→ git config --global https.proxy <代理>')
console.log('  - 若仅 D 中 project 显示 none：CLI_TO_PROJECT 映射缺失，不影响 CLI 升级检测')
console.log(out.summary === '全部通过' ? '\nALL PASS' : `\n${out.summary}`)
process.exit(out.summary === '全部通过' ? 0 : 1)
