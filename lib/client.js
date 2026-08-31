// dsh-plugin-browser-harness — 设置 > 浏览器连接 client 半。
// 数据通过 fetch 调 host 的 /browser-harness/api/* HTTP 路由：
//   status      连接状态（CLI 是否安装、daemon 是否存活、当前页面）
//   doctor      运行 browser-harness --doctor 诊断
//   screenshot  对当前页面截图（返回路径）
//   chrome-hint 打开远程调试的引导文案
// 渲染模式与 dsh-plugin-guard 一致：__ModuleLoader__ + React.createElement。

window.__ModuleLoader__.load({
  id: 'dsh-plugin-browser-harness',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const React = require('react')

    const CSS = `
.bhn-wrap{display:flex;flex-direction:column;gap:14px;min-height:420px}
.bhn-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.bhn-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);margin:0}
.bhn-hint{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.bhn-hint.bhn-err{color:var(--dsw-alias-state-error-primary)}
.bhn-hint.bhn-ok{color:var(--dsw-alias-state-success-primary)}
.bhn-btn{font-family:inherit;font-size:12px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:6px 12px;cursor:pointer}
.bhn-btn:hover{background:var(--dsw-alias-interactive-bg-hover-solid)}
.bhn-btn[disabled]{opacity:.5;cursor:not-allowed}
.bhn-btn.bhn-primary{background:var(--dsw-alias-state-business-primary);color:#fff;border:none}
.bhn-card{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:12px;display:flex;flex-direction:column;gap:8px}
.bhn-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.bhn-kv{display:grid;grid-template-columns:110px 1fr;gap:4px 10px;font-size:12px;line-height:1.6}
.bhn-kv dt{color:var(--dsw-alias-label-tertiary);margin:0}
.bhn-kv dd{color:var(--dsw-alias-label-primary);margin:0;min-width:0;word-break:break-all}
.bhn-pill{font-size:10px;border-radius:999px;padding:2px 8px;white-space:nowrap}
.bhn-pill.bhn-ok{background:var(--dsw-alias-state-success-bg,transparent);color:var(--dsw-alias-state-success-primary)}
.bhn-pill.bhn-bad{background:var(--dsw-alias-state-error-bg,transparent);color:var(--dsw-alias-state-error-primary)}
.bhn-pre{font-family:ui-monospace,Consolas,'Courier New',monospace;font-size:11px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px;white-space:pre-wrap;word-break:break-all;max-height:240px;overflow:auto;margin:0}
.bhn-status{font-size:12px;color:var(--dsw-alias-label-tertiary);min-height:16px}
.bhn-status.bhn-err{color:var(--dsw-alias-state-error-primary)}
.bhn-status.bhn-ok{color:var(--dsw-alias-state-success-primary)}
.bhn-path{font-family:ui-monospace,Consolas,'Courier New',monospace;font-size:11px;color:var(--dsw-alias-label-primary)}
.bhn-card2{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;list-style:none;transition:border-color .16s,background .16s}
.bhn-card2:hover{border-color:var(--dsw-alias-label-dimmed)}
.bhn-card2-open{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}
.bhn-card-head{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}
.bhn-card-title{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4;flex:1}
.bhn-card-desc{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}
.bhn-card-body{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding-bottom:8px}
.bhn-field{flex-direction:column;gap:6px;padding:12px 0;display:flex}
.bhn-field-head{align-items:center;gap:8px;display:flex}
.bhn-label{min-width:0;color:var(--dsw-alias-label-primary);flex:1;font-size:13px;font-weight:500;line-height:1.5}
.bhn-badge{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}
.bhn-input-invalid{border-color:var(--dsw-alias-state-error-primary)}
.bhn-invalid{color:var(--dsw-alias-state-error-primary);margin:0;font-size:12px;line-height:1.5}
.bhn-card-footer{border-top:1px solid var(--dsw-alias-border-l2);justify-content:flex-end;align-items:center;gap:8px;padding:12px 0 4px;display:flex}
.bhn-card-footer .bhn-hint{flex:1}
.bhn-input{font-family:inherit;font-size:12px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:6px 8px;box-sizing:border-box;width:88px}
`

    function installStyles() {
      if (typeof document === 'undefined') return () => {}
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-plugin-browser-harness'
      tag.textContent = CSS
      document.head.appendChild(tag)
      return () => { tag.remove() }
    }

    async function api(method, args) {
      const base = '/browser-harness/api/' + method
      const q = new URLSearchParams()
      if (args) for (const k in args) { const v = args[k]; if (v !== undefined && v !== null && v !== '') q.set(k, String(v)) }
      const r = await fetch(base + (q.toString() ? '?' + q.toString() : ''))
      return r.json()
    }

    function BrowserSection() {
      const [phase, setPhase] = React.useState('loading')
      const [state, setState] = React.useState(null)
      const [doctorOut, setDoctorOut] = React.useState('')
      const [shot, setShot] = React.useState('')
      const [status, setStatus] = React.useState({ text: '', kind: '' })
      const [busy, setBusy] = React.useState(false)
      const [updates, setUpdates] = React.useState(null)
      const [updatePhase, setUpdatePhase] = React.useState('idle') // idle|checking|confirm|updating|done
      const [updateOut, setUpdateOut] = React.useState('')
      const [updateErr, setUpdateErr] = React.useState('')

      const refresh = async () => {
        try {
          const r = await api('status')
          if (r && r.ok) setState(r)
          else setStatus({ text: (r && r.error) || '加载失败', kind: 'err' })
        } catch (e) { setStatus({ text: String((e && e.message) || e), kind: 'err' }) }
        setPhase('ready')
      }
      React.useEffect(() => { refresh() }, [])

      const doCheckUpdates = async (force) => {
        setUpdatePhase('checking'); setUpdateErr(''); setUpdateOut('')
        try {
          const r = await api('update-check', force ? { force: '1' } : null)
          if (r && r.ok) setUpdates(r)
          else setUpdateErr((r && r.error) || '检查更新失败')
        } catch (e) { setUpdateErr(String((e && e.message) || e)) }
        setUpdatePhase('idle')
      }
      React.useEffect(() => { doCheckUpdates(false) }, [])

      const doUpdate = async () => {
        setUpdatePhase('updating'); setUpdateErr('')
        try {
          const r = await fetch('/browser-harness/api/update', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ confirm: true }),
          }).then((x) => x.json())
          if (r && r.ok) {
            setUpdateOut(r.output || '更新完成')
            setUpdates(r)
            setUpdatePhase('done')
          } else {
            setUpdateErr((r && r.error) || '更新失败')
            setUpdatePhase('idle')
          }
        } catch (e) { setUpdateErr(String((e && e.message) || e)); setUpdatePhase('idle') }
      }

      const doDoctor = async () => {
        setBusy(true); setStatus({ text: '', kind: '' }); setDoctorOut('')
        try {
          // 连接诊断（browser-harness --doctor）
          const d = await api('doctor')
          let text = ''
          if (d && d.ok) text += (d.detail || '(无输出)') + '\n'
          else text += ((d && d.error) || '诊断失败') + '\n'
          // 深度检测（CLI 地址 / PyPI / GitHub / 完整 checkUpdates）
          const c = await api('check-update')
          if (c && c.ok) {
            text += `\n${formatDiag(c)}`
            setStatus({ text: c.summary === '全部通过' ? '诊断完成：更新链路全部通过' : `诊断完成：${c.summary}`, kind: c.summary === '全部通过' ? 'ok' : 'err' })
          } else {
            text += `\n深度检测失败：${(c && c.error) || '未知错误'}`
            setStatus({ text: (c && c.error) || '深度检测失败', kind: 'err' })
          }
          setDoctorOut(text.trim())
          await refresh()
        } catch (e) { setStatus({ text: String((e && e.message) || e), kind: 'err' }) }
        setBusy(false)
      }

      // 把 check-update API 的逐层结果格式化为文本
      const formatDiag = (r) => {
        const L = []
        L.push(`【A. CLI 地址检测】${r.a && r.a.ok ? '✓' : '✗'}  ${(r.a && r.a.msg) || ''}`)
        if (r.a && r.a.detail) L.push(`      ${r.a.detail}`)
        L.push(`【B. PyPI 更新】${r.b && r.b.ok ? '✓' : '✗'}  ${(r.b && r.b.msg) || ''}`)
        if (r.b && r.b.upgrade) L.push(`      ${r.b.upgrade}`)
        L.push(`【C. GitHub 项目】${r.c && r.c.ok ? '✓' : '✗'}  ${(r.c && r.c.msg) || ''}`)
        if (r.c && r.c.compareMsg) L.push(`      ${r.c.compareMsg}`)
        L.push(`【D. 完整 checkUpdates】${r.d && r.d.ok ? '✓' : '✗'}  ${(r.d && r.d.msg) || ''}`)
        if (r.d && r.d.detail) L.push(`      ${r.d.detail}`)
        L.push(`汇总：${r.summary || ''}`)
        return L.join('\n')
      }
      const doShot = async () => {
        setBusy(true); setStatus({ text: '', kind: '' }); setShot('')
        try {
          const r = await api('screenshot')
          if (r && r.ok && r.path) {
            setShot(r.path)
            setStatus({ text: '截图已保存', kind: 'ok' })
          } else setStatus({ text: (r && r.error) || '截图失败', kind: 'err' })
        } catch (e) { setStatus({ text: String((e && e.message) || e), kind: 'err' }) }
        setBusy(false)
      }

      const h = React.createElement
      const ok = state && state.cliInstalled && !state.error
      const daemonOk = ok && state.daemonAlive

      return h('div', { className: 'bhn-wrap' },
        h('div', { className: 'bhn-toolbar' },
          h('h3', { className: 'bhn-title' }, '浏览器连接（browser-harness）'),
          h('span', { className: 'bhn-hint' }, 'Agent 通过本地 Chrome 远程调试（CDP）控制浏览器'),
          h('div', { style: { flex: 1 } }),
          h('button', { className: 'bhn-btn', disabled: busy, onClick: refresh }, '刷新'),
          h('button', { className: 'bhn-btn bhn-primary', disabled: busy, onClick: doDoctor }, busy ? '处理中…' : '运行诊断'),
          h('button', { className: 'bhn-btn', disabled: busy || !ok, onClick: doShot }, '截图'),
          h('button', { className: 'bhn-btn', disabled: updatePhase === 'checking', onClick: () => doCheckUpdates(true) }, updatePhase === 'checking' ? '检查中…' : '检查更新'),
        ),
        h('div', { className: 'bhn-card' },
          phase === 'loading'
            ? h('span', { className: 'bhn-hint' }, '加载中…')
            : h(React.Fragment, null,
                h('div', { className: 'bhn-row' },
                  h('span', { className: 'bhn-hint' }, 'CLI 安装：'),
                  state && state.cliInstalled
                    ? h('span', { className: 'bhn-pill bhn-ok' }, '已安装')
                    : h('span', { className: 'bhn-pill bhn-bad' }, '未安装'),
                  h('span', { className: 'bhn-hint' }, 'daemon：'),
                  state && daemonOk
                    ? h('span', { className: 'bhn-pill bhn-ok' }, '存活')
                    : h('span', { className: 'bhn-pill bhn-bad' }, '异常'),
                  state && state.page
                    ? h('span', { className: 'bhn-pill bhn-ok' }, '已连接')
                    : h('span', { className: 'bhn-pill bhn-bad' }, '未连接'),
                ),
                h('dl', { className: 'bhn-kv' },
                  h('dt', null, '可执行文件'),
                  h('dd', null, state && state.bin ? h('span', { className: 'bhn-path' }, state.bin) : '(未找到)'),
                  state && state.page ? h(React.Fragment, null,
                    h('dt', null, '当前页面'),
                    h('dd', null, String(state.page.title || '')),
                    h('dt', null, 'URL'),
                    h('dd', null, String(state.page.url || '')),
                    h('dt', null, '视口'),
                    h('dd', null, `${state.page.w} × ${state.page.h}`),
                  ) : null,
                ),
                state && state.error ? h('div', { className: 'bhn-hint bhn-err' }, String(state.error)) : null,
              ),
        ),
        doctorOut ? h('pre', { className: 'bhn-pre' }, doctorOut) : null,
        shot ? h('div', { className: 'bhn-hint' }, '截图已保存到：', h('span', { className: 'bhn-path' }, shot)) : null,

        // ── 更新区块 ──
        h('div', { className: 'bhn-card' },
          h('div', { className: 'bhn-row' },
            h('span', { className: 'bhn-title' }, '更新'),
            h('span', { className: 'bhn-hint' }, '上游项目 browser-use/browser-harness + browser-harness CLI'),
          ),
          updates === null
            ? h('span', { className: 'bhn-hint' }, updateErr ? '检查失败（离线？）' : '检查中…')
            : h(React.Fragment, null,
                h('dl', { className: 'bhn-kv' },
                  h('dt', null, '项目（GitHub）'),
                  h('dd', null, `browser-use/browser-harness${updates.project && updates.project.latest ? ` 最新 v${updates.project.latest}` : '（无法获取）'}`),
                  h('dt', null, '当前对应'),
                  h('dd', null, updates.cli && updates.cli.installed ? `browser-harness ${updates.cli.installed}（对应项目 ${updates.project && updates.project.baseline ? 'v' + updates.project.baseline : '未知'}）` : 'CLI 未安装'),
                  h('dt', null, 'CLI 最新'),
                  h('dd', null, updates.cli && updates.cli.latest ? `v${updates.cli.latest}` : '（无法获取）'),
                  h('dt', null, '检查时间'),
                  h('dd', null, String(updates.checkedAt || '').replace('T', ' ').slice(0, 19)),
                ),
                h('div', { className: 'bhn-row' },
                  updates.project && updates.project.updateAvailable
                    ? h('span', { className: 'bhn-pill bhn-bad' }, `项目有新版本 v${updates.project.latest}`)
                    : updates.project && updates.project.comparable
                      ? h('span', { className: 'bhn-pill bhn-ok' }, '项目已是最新')
                      : h('span', { className: 'bhn-pill' }, '项目版本未知'),
                  updates.cli && updates.cli.updateAvailable
                    ? h('span', { className: 'bhn-pill bhn-bad' }, `CLI 可升级 ${updates.cli.installed} → ${updates.cli.latest}`)
                    : updates.cli && updates.cli.installed
                      ? h('span', { className: 'bhn-pill bhn-ok' }, 'CLI 已是最新')
                      : null,
                ),
                updatePhase === 'confirm' && (updates.cli && updates.cli.updateAvailable)
                  ? h('div', { className: 'bhn-row' },
                      h('span', { className: 'bhn-hint bhn-err' }, `确认将 browser-harness CLI 升级到 v${updates.cli.latest}？`),
                      h('button', { className: 'bhn-btn bhn-primary', disabled: updatePhase === 'updating', onClick: doUpdate }, '确认更新'),
                      h('button', { className: 'bhn-btn', onClick: () => setUpdatePhase('idle') }, '取消'),
                    )
                  : updates.cli && updates.cli.updateAvailable && updatePhase !== 'done'
                    ? h('button', { className: 'bhn-btn bhn-primary', onClick: () => setUpdatePhase('confirm') }, '更新 CLI')
                    : null,
                updatePhase === 'updating' ? h('span', { className: 'bhn-hint' }, '正在更新（可能耗时 1-2 分钟）…') : null,
                updateOut ? h('pre', { className: 'bhn-pre' }, updateOut) : null,
                updateErr ? h('div', { className: 'bhn-hint bhn-err' }, String(updateErr)) : null,
                updatePhase === 'done' ? h('div', { className: 'bhn-hint bhn-ok' }, '更新完成。daemon 已重启；新版本立即生效。') : null,
              ),
        ),

        h('div', { className: 'bhn-hint' },
          '首次使用：在 Chrome 地址栏打开 chrome://inspect/#remote-debugging ，勾选 "Allow remote debugging for this browser instance"，然后点「刷新」。',
          ' 需要安装 CLI：uv tool install --python 3.12 browser-harness',
        ),
        h('div', { className: 'bhn-status' + (status.kind ? ' bhn-' + status.kind : '') }, status.text || ''),
      )
    }

    // ── 设置 > 插件 > 插件配置 card ──
    function BrowserCard(props) {
      const scope = props.scope
      const subscribe = React.useMemo(() => scope.subscribe.bind(scope), [scope])
      const getSnapshot = React.useMemo(() => scope.getSnapshot.bind(scope), [scope])
      const [drafts, setDrafts] = React.useState({})
      const [saving, setSaving] = React.useState(false)
      const [failed, setFailed] = React.useState(false)
      const [open, setOpen] = React.useState(false)
      let snapshot = null
      try {
        snapshot = React.useSyncExternalStore(subscribe, getSnapshot)
      } catch { snapshot = null }
      if (!snapshot || snapshot.status !== 'ready') return null
      const writable = snapshot.writable
      const current = snapshot.value && Number.isFinite(snapshot.value.timeoutSec) ? snapshot.value.timeoutSec : 60
      const draft = 'timeoutSec' in drafts ? drafts.timeoutSec : String(current)
      const dirty = Object.keys(drafts).length > 0
      const n = Number(draft)
      const invalid = !Number.isFinite(n) || n < 5 || n > 300
      const blocked = !dirty || invalid || saving || !writable

      const save = async () => {
        if (blocked) return
        setSaving(true); setFailed(false)
        const ok = await scope.set('timeoutSec', Math.floor(n)).then(() => true, () => false)
        if (ok) setDrafts({})
        setSaving(false)
        setFailed(!ok)
      }

      const h = React.createElement
      return h('li', { className: 'bhn-card2' + (open ? ' bhn-card2-open' : '') },
        h('button', {
          type: 'button', className: 'bhn-card-head', 'aria-expanded': open,
          onClick: () => setOpen(!open),
        },
          h('span', { className: 'bhn-card-title' }, '浏览器连接（browser-harness）'),
          h('span', { className: 'bhn-card-desc' }, dirty ? '（有未保存的修改）' : 'browser_* 工具：本地 Chrome 控制'),
        ),
        open
          ? h('div', { className: 'bhn-card-body' },
              h('div', { className: 'bhn-field' },
                h('div', { className: 'bhn-field-head' },
                  h('span', { className: 'bhn-label' }, 'browser-harness 调用超时（秒）'),
                  h('span', { className: 'bhn-badge' }, writable ? '可编辑' : '只读'),
                ),
                h('input', {
                  className: 'bhn-input' + (invalid ? ' bhn-input-invalid' : ''), type: 'number', min: 5, max: 300,
                  value: draft, disabled: !writable,
                  onChange: (e) => { setFailed(false); setDrafts({ timeoutSec: e.target.value }) },
                }),
                invalid ? h('p', { className: 'bhn-invalid' }, '超时必须在 5–300 秒之间') : null,
                failed ? h('p', { className: 'bhn-invalid' }, '保存失败：宿主拒绝了本次写入，请重试。') : null,
              ),
              h('div', { className: 'bhn-card-footer' },
                h('button', { type: 'button', className: 'bhn-btn', disabled: !dirty || saving, onClick: () => { setFailed(false); setDrafts({}) } }, '放弃修改'),
                h('button', { type: 'button', className: 'bhn-btn bhn-primary', disabled: blocked, onClick: save }, saving ? '保存中…' : '保存'),
              ),
              h('p', { className: 'bhn-hint' }, '完整状态与诊断在 设置 → 浏览器连接 页面。'),
            )
          : null,
      )
    }

    function apply(ctx) {
      const slots = ctx.slots
      try { ctx.effect(installStyles) } catch { /* best effort */ }
      try {
        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'browser-harness', order: 50, label: '浏览器连接' },
          BrowserSection,
        ))
      } catch { /* best effort */ }
      try {
        const scope = ctx.settingsScope.bind({ namespace: 'browser-harness' })
        ctx.effect(() =>
          slots.inject('settings.plugin.item', function* () {
            yield slots.register(
              {
                name: 'settings.plugin.item',
                key: 'browser-harness',
                id: 'browser-harness',
                order: 50,
                label: '浏览器连接（browser-harness）',
                inject: () => ({ scope }),
              },
              BrowserCard,
            )
          }),
          'browser-harness: plugin settings card',
        )
      } catch { /* best effort */ }
    }

    exports.apply = apply
    exports.inject = ['slots', 'settingsScope']
    return module.exports
  },
})
