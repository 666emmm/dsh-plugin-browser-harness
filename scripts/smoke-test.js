// dsh-plugin-browser-harness — smoke test (no dsh runtime needed).
// Verifies the pieces that can run standalone:
//   1. engine: browser-harness CLI resolves and page_info round-trips.
//   2. tools: every tool's descriptor shape is valid (name/parameters/output).
//   3. tools: browser_doctor / browser_page_info execute through the CLI.
import { resolveHarnessBin, runJson, jsonSnippet } from '../src/engine.js'
import { createBrowserTools } from '../src/tools.js'

let failures = 0
const ok = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`)
  if (!cond) failures++
}

// 1. engine
const bin = resolveHarnessBin()
ok(bin !== null, `browser-harness CLI 可解析 (${bin ?? 'none'})`)

if (bin) {
  const res = await runJson(jsonSnippet(`
_result = { 'ok': True }
try:
    info = page_info()
    _result.update({ 'url': info.get('url'), 'title': info.get('title') })
except Exception as e:
    _result['ok'] = False
    _result['error'] = str(e)
`), { timeoutMs: 20_000 })
  ok(res.ok && res.value && res.value.ok !== false, `page_info round-trip: ${res.ok ? JSON.stringify(res.value).slice(0, 120) : (res.error && res.error.message)}`)
} else {
  console.log('SKIP  page_info round-trip (CLI missing)')
}

// 2. tool descriptors
const tools = createBrowserTools()
const names = tools.map((t) => t.name)
ok(names.length >= 7, `工具数量 ${names.length}: ${names.join(', ')}`)
for (const t of tools) {
  ok(typeof t.name === 'string' && t.name.startsWith('browser_'), `tool ${t.name}: name`)
  ok(typeof t.description === 'string' && t.description.length > 20, `tool ${t.name}: description`)
  ok(t.parameters && t.parameters.type === 'object', `tool ${t.name}: parameters object`)
  ok(t.output && t.output.schema && t.output.render, `tool ${t.name}: output schema+render`)
}

// 3. execute browser_page_info through the full stack
if (bin) {
  const info = tools.find((t) => t.name === 'browser_page_info')
  try {
    const v = await info.execute({})
    ok(v && v.ok !== false, `browser_page_info.execute: ${JSON.stringify(v).slice(0, 140)}`)
  } catch (e) {
    ok(false, `browser_page_info.execute threw: ${e.message}`)
  }
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
