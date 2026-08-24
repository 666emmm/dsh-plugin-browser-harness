// dsh-plugin-browser-harness — tools registered for the agent.
// Self-contained `defineTool` (dsh-tools subset, same pattern as
// dsh-plugin-guard) so this plugin has ZERO runtime dependencies.
// Each tool pipes a Python snippet into the browser-harness CLI; arguments
// travel base64-encoded so quotes/newlines never break the snippet.
import { runJson, jsonSnippet, installGuidance } from './engine.js'

const renderText = (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }]

// ── tiny self-contained defineTool (dsh-tools subset) ────────────────────────
function hoistRequired(schema) {
  if (!schema || typeof schema !== 'object') return schema
  if (Array.isArray(schema)) {
    for (const item of schema) hoistRequired(item)
    return schema
  }
  if (schema.type === 'object' && schema.properties && typeof schema.properties === 'object') {
    const required = []
    for (const [key, prop] of Object.entries(schema.properties)) {
      if (prop && prop.required === true) {
        delete prop.required
        required.push(key)
      }
    }
    if (required.length > 0) schema.required = required
    for (const prop of Object.values(schema.properties)) hoistRequired(prop)
  }
  if (schema.items) hoistRequired(schema.items)
  return schema
}

function compileParameters(spec) {
  const schema = { type: 'object', properties: { ...spec } }
  return hoistRequired(schema)
}

function validateArgs(parameters, args) {
  const violations = []
  const walk = (schema, value, path) => {
    if (schema.type === 'object') {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        violations.push(`${path || 'value'} must be an object`)
        return
      }
      if (Array.isArray(schema.required)) {
        for (const key of schema.required) {
          if (value[key] === undefined) violations.push(`${path ? `${path}.` : ''}${key} is required`)
        }
      }
      for (const [key, prop] of Object.entries(schema.properties || {})) {
        if (value[key] !== undefined) walk(prop, value[key], `${path ? `${path}.` : ''}${key}`)
      }
    } else if (schema.type === 'string') {
      if (typeof value !== 'string') violations.push(`${path} must be a string`)
      else if (Array.isArray(schema.enum) && !schema.enum.includes(value)) violations.push(`${path} must be one of: ${schema.enum.join(', ')}`)
    } else if (schema.type === 'boolean') {
      if (typeof value !== 'boolean') violations.push(`${path} must be a boolean`)
    } else if (schema.type === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) violations.push(`${path} must be a number`)
    } else if (schema.type === 'array') {
      if (!Array.isArray(value)) violations.push(`${path} must be an array`)
    }
  }
  walk(parameters, args === undefined ? {} : args, '')
  return violations
}

function defineTool(options) {
  const parameters = compileParameters(options.parameters || {})
  const outputSchema = hoistRequired(JSON.parse(JSON.stringify(options.output.schema)))
  return {
    name: options.name,
    description: options.description,
    parameters,
    output: {
      schema: outputSchema,
      render: options.output.render,
    },
    async execute(args, exec) {
      const violations = validateArgs(parameters, args === undefined ? {} : args)
      if (violations.length > 0) throw new Error(`invalid arguments: ${violations.join('; ')}`)
      return options.execute(args, exec)
    },
  }
}

// ── snippet builders ─────────────────────────────────────────────────────────
// Pass args as base64 of JSON; Python decodes into `_args` (a dict). The body
// must set `_result` (JSON-serializable) — jsonSnippet prints it as ASCII JSON.
function b64(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64')
}

const BOILER = (args, body) => `
import json, base64
_args = json.loads(base64.b64decode(${JSON.stringify(b64(args))}))
${body}
_result = _result
`.trim()

async function execSnippet(args, body, opts) {
  const res = await runJson(jsonSnippet(BOILER(args, body)), opts)
  if (!res.ok) {
    const err = res.error
    throw new Error(err && err.message ? err.message : installGuidance())
  }
  return res.value
}

// ── tools ────────────────────────────────────────────────────────────────────
export function createBrowserTools() {
  return [
    defineTool({
      name: 'browser_page_info',
      description: '读取当前浏览器标签页的信息：URL、标题、视口尺寸，以及当前是否连接成功。任何网页任务的第一步。/ Read the current browser tab: URL, title, viewport size, and connection status. First step of any web task.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            url: { type: 'string' },
            title: { type: 'string' },
            w: { type: 'number' },
            h: { type: 'number' },
            ok: { type: 'boolean', required: true },
            error: { type: 'string' },
          },
        },
        render: renderText,
      },
      async execute() {
        return execSnippet({}, `
_result = { 'ok': True }
try:
    info = page_info()
    _result.update({ 'url': info.get('url'), 'title': info.get('title'), 'w': info.get('w'), 'h': info.get('h') })
except Exception as e:
    _result['ok'] = False
    _result['error'] = str(e)
`)
      },
    }),

    defineTool({
      name: 'browser_new_tab',
      description: '在浏览器中打开一个新标签页并导航到指定 URL。首次导航请用本工具而不是 browser_goto。/ Open a new tab and navigate to the given URL. Use this (not browser_goto) for the first navigation.',
      parameters: {
        url: { type: 'string', required: true, description: '要打开的完整 URL，含协议（https://...）。/ Full URL including protocol (https://...).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            url: { type: 'string' },
            title: { type: 'string' },
            error: { type: 'string' },
          },
        },
        render: renderText,
      },
      async execute(args) {
        return execSnippet(args, `
_result = { 'ok': True, 'url': _args['url'] }
try:
    new_tab(_args['url'])
    wait_for_load()
    info = page_info()
    _result['title'] = info.get('title')
except Exception as e:
    _result['ok'] = False
    _result['error'] = str(e)
`)
      },
    }),

    defineTool({
      name: 'browser_goto',
      description: '让当前标签页导航到指定 URL（新任务开始或页面已存在时用）。/ Navigate the current tab to a URL (when a tab already exists).',
      parameters: {
        url: { type: 'string', required: true, description: '要导航的完整 URL，含协议。/ Full URL including protocol.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            url: { type: 'string' },
            title: { type: 'string' },
            error: { type: 'string' },
          },
        },
        render: renderText,
      },
      async execute(args) {
        return execSnippet(args, `
_result = { 'ok': True, 'url': _args['url'] }
try:
    ensure_real_tab()
    goto_url(_args['url'])
    wait_for_load()
    info = page_info()
    _result['title'] = info.get('title')
except Exception as e:
    _result['ok'] = False
    _result['error'] = str(e)
`)
      },
    }),

    defineTool({
      name: 'browser_click',
      description: '在视口坐标 (x, y) 处点击。坐标来自 accessibility tree 元素盒中心（见 browser_ax 或结合 JS 计算）。/ Click at viewport coordinates (x, y). Coordinates should come from an accessibility-tree element box center.',
      parameters: {
        x: { type: 'number', required: true, description: '视口内水平像素坐标。/ Horizontal viewport pixel coordinate.' },
        y: { type: 'number', required: true, description: '视口内垂直像素坐标。/ Vertical viewport pixel coordinate.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            error: { type: 'string' },
          },
        },
        render: renderText,
      },
      async execute(args) {
        return execSnippet(args, `
_result = { 'ok': True }
try:
    click_at_xy(_args['x'], _args['y'])
    wait_for_load()
except Exception as e:
    _result['ok'] = False
    _result['error'] = str(e)
`)
      },
    }),

    defineTool({
      name: 'browser_type',
      description: '在当前聚焦的元素中键入文本（先点击目标元素使其聚焦）。/ Type text into the currently focused element (click the target first to focus it).',
      parameters: {
        text: { type: 'string', required: true, description: '要输入的文本。/ Text to type.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            error: { type: 'string' },
          },
        },
        render: renderText,
      },
      async execute(args) {
        return execSnippet(args, `
_result = { 'ok': True }
try:
    type_text(_args['text'])
except Exception as e:
    _result['ok'] = False
    _result['error'] = str(e)
`)
      },
    }),

    defineTool({
      name: 'browser_js',
      description: '在当前页面执行一段 JavaScript，返回其结果（可 JSON 序列化的值）。用于读取 DOM、提取数据或触发页面行为。/ Run JavaScript in the current page and return the JSON-serializable result. Use to read DOM, extract data, or trigger page behavior.',
      parameters: {
        code: { type: 'string', required: true, description: '要执行的 JavaScript 表达式或语句。/ JavaScript expression or statements.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            result: {},
            error: { type: 'string' },
          },
        },
        render: renderText,
      },
      async execute(args) {
        return execSnippet(args, `
_result = { 'ok': True }
try:
    _result['result'] = js(_args['code'])
except Exception as e:
    _result['ok'] = False
    _result['error'] = str(e)
`)
      },
    }),

    defineTool({
      name: 'browser_screenshot',
      description: '对当前页面截图，返回截图文件路径（浏览器控制台 / 设置页可查看）。/ Take a screenshot of the current page and return the file path.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            path: { type: 'string' },
            error: { type: 'string' },
          },
        },
        render: renderText,
      },
      async execute() {
        return execSnippet({}, `
_result = { 'ok': True }
try:
    _result['path'] = capture_screenshot()
except Exception as e:
    _result['ok'] = False
    _result['error'] = str(e)
`)
      },
    }),

    defineTool({
      name: 'browser_doctor',
      description: '诊断浏览器连接：Chrome 是否在运行、远程调试是否开启、daemon 是否存活、browser-harness CLI 是否安装。连接异常时先跑本工具。/ Diagnose the browser connection: Chrome running, remote debugging enabled, daemon alive, CLI installed. Run this first when connections fail.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            detail: { type: 'string' },
          },
        },
        render: renderText,
      },
      async execute() {
        const res = await runJson(`
import json
_result = { 'ok': True }
try:
    result = run_doctor()
    if isinstance(result, dict):
        _result['detail'] = json.dumps(result, ensure_ascii=True, default=str)
    else:
        _result['detail'] = str(result)
    _result['ok'] = bool(getattr(result, 'ok', True)) if not isinstance(result, dict) else True
except Exception as e:
    _result['ok'] = False
    _result['error'] = str(e)
`)
        if (!res.ok) {
          throw new Error((res.error && res.error.message) || 'doctor failed')
        }
        return res.value
      },
    }),
  ]
}
