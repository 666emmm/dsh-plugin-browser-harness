// dsh-plugin-browser-harness — the in-page element picker.
//
// This module holds a single string of JavaScript that gets evaluated inside the
// page (through the daemon's Runtime.evaluate). It installs a floating overlay
// that lets the HUMAN point at an element and write a comment, then hands the
// result back over a CDP runtime binding — no fetch, no CORS, no CSP.
//
// Design constraints that shaped it:
//
//  * It must never throw into the page's own error handling, so everything is
//    wrapped and the whole installer is idempotent (re-injecting replaces the
//    previous instance instead of stacking overlays).
//  * It must not steal the page's input until the user opts in: the toolbar
//    starts collapsed, and "picking" is a mode the user toggles.
//  * The result travels through `window[<binding>](payloadJson)`, which the
//    daemon turns into a Runtime.bindingCalled event. That is why nothing here
//    performs network I/O: page CSP would block a fetch to 127.0.0.1, and the
//    DSH server token is not available to page scripts.
//  * A localStorage mirror keeps the annotation alive across reloads/navigation,
//    because the binding call may race a page unload.
//  * Comments are written by the human; the picker must not invent any.

/** CSS injected into the page. Uses a high z-index and its own reset so host pages cannot restyle it. */
const PICKER_CSS = `
.bh-annot-root {
  position: fixed;
  inset: 0;
  z-index: 2147483600;
  pointer-events: none;
  font: 13px/1.5 -apple-system, "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
  color: #1a1a1a;
}
.bh-annot-root * { box-sizing: border-box; }
.bh-annot-hl {
  position: fixed;
  pointer-events: none;
  border: 2px solid #2f6fed;
  background: rgba(47, 111, 237, 0.10);
  border-radius: 3px;
  transition: all 60ms linear;
  z-index: 2147483601;
}
.bh-annot-hl::after {
  content: attr(data-tag);
  position: absolute;
  top: -20px;
  left: -2px;
  background: #2f6fed;
  color: #fff;
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 3px 3px 3px 0;
  white-space: nowrap;
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.bh-annot-panel {
  position: fixed;
  right: 16px;
  bottom: 16px;
  width: 340px;
  pointer-events: auto;
  background: #fff;
  border: 1px solid #d8dde6;
  border-radius: 10px;
  box-shadow: 0 12px 32px rgba(16, 24, 40, 0.18);
  overflow: hidden;
}
.bh-annot-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 12px;
  background: #f6f8fb;
  border-bottom: 1px solid #e6eaf0;
  cursor: move;
  user-select: none;
}
.bh-annot-title { font-weight: 600; font-size: 12.5px; flex: 1; }
.bh-annot-dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: #b8c0cc; flex: none;
}
.bh-annot-dot.on { background: #2f6fed; box-shadow: 0 0 0 3px rgba(47,111,237,.18); }
.bh-annot-body { padding: 10px 12px 12px; }
.bh-annot-target {
  font-size: 11.5px;
  color: #5b6675;
  background: #f6f8fb;
  border: 1px solid #e6eaf0;
  border-radius: 6px;
  padding: 6px 8px;
  margin-bottom: 8px;
  word-break: break-all;
  max-height: 66px;
  overflow: auto;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
}
.bh-annot-target.empty { color: #98a2b3; font-style: italic; font-family: inherit; }
.bh-annot-text {
  width: 100%;
  min-height: 68px;
  max-height: 180px;
  resize: vertical;
  padding: 7px 9px;
  font: inherit;
  font-size: 12.5px;
  color: #1a1a1a;
  background: #fff;
  border: 1px solid #d8dde6;
  border-radius: 6px;
  outline: none;
}
.bh-annot-text:focus { border-color: #2f6fed; box-shadow: 0 0 0 3px rgba(47,111,237,.14); }
.bh-annot-row { display: flex; gap: 6px; margin-top: 8px; align-items: center; }
.bh-annot-btn {
  font: inherit;
  font-size: 12px;
  padding: 5px 11px;
  border-radius: 6px;
  border: 1px solid #d8dde6;
  background: #fff;
  color: #344054;
  cursor: pointer;
  white-space: nowrap;
}
.bh-annot-btn:hover:not(:disabled) { background: #f6f8fb; }
.bh-annot-btn:disabled { opacity: .45; cursor: not-allowed; }
.bh-annot-btn.primary { background: #2f6fed; border-color: #2f6fed; color: #fff; }
.bh-annot-btn.primary:hover:not(:disabled) { background: #245cd0; }
.bh-annot-btn.danger { color: #b42318; }
.bh-annot-spacer { flex: 1; }
.bh-annot-status { font-size: 11px; color: #5b6675; }
.bh-annot-status.err { color: #b42318; }
.bh-annot-status.ok { color: #067647; }
.bh-annot-count {
  font-size: 11px;
  background: #eef3fe;
  color: #245cd0;
  border-radius: 9px;
  padding: 1px 7px;
}
`

/**
 * The installer. Written as a template so values are interpolated once, at
 * build time, into a self-contained IIFE.
 *
 * @param {{ binding: string, sessionTag: string }} options
 *   binding — CDP runtime binding name the payload is sent through.
 *   sessionTag — opaque id of the owning DSH session, echoed back in every
 *     payload so the host can attribute an annotation even if several sessions
 *     injected pickers into the same Chrome.
 * @returns {string} JavaScript source to evaluate in the page.
 */
export function buildPickerScript({ binding, sessionTag }) {
  return `(() => {
  const BINDING = ${JSON.stringify(binding)};
  const SESSION_TAG = ${JSON.stringify(sessionTag)};
  const STORE_KEY = '__bh_annotation_draft_v1';

  // ── idempotency: tear down any previous instance ──────────────────────────
  // reason:'reinject' — this is the installer replacing itself, NOT the human
  // closing the panel, so it must not send picker_closed and release the watcher.
  if (window.__bhPicker && typeof window.__bhPicker.destroy === 'function') {
    try { window.__bhPicker.destroy({ reason: 'reinject' }); } catch (e) { /* ignore */ }
  }

  // ── state ────────────────────────────────────────────────────────────────
  const state = {
    picking: false,
    hovered: null,
    selected: null,
    destroyed: false,
    sentCount: 0,
  };

  // ── a stable, human-meaningful selector for an element ───────────────────
  // Preference order: id → data-testid/name → a short structural path.
  // The result is for a human reading the annotation, so it stays readable;
  // correctness beats brevity but a 300-char path helps nobody.
  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(value);
    return String(value).replace(/[^a-zA-Z0-9_-]/g, (c) => '\\\\' + c);
  }

  /**
   * Shortest usable selector for one element, walking up within its own tree.
   *
   * Stops at the tree root: for an element inside a shadow root the walk ends
   * at the shadow root, so the result is a selector valid *inside* that root,
   * not in the document. describeShadow() pairs it with the host chain so the
   * pair is unambiguous.
   */
  function selectorWithinTree(el, maxDepth) {
    if (!el || el.nodeType !== 1) return '';
    const parts = [];
    let node = el;
    let depth = 0;
    while (node && node.nodeType === 1 && depth < (maxDepth || 6)) {
      let piece = node.tagName.toLowerCase();
      if (node.id) {
        parts.unshift('#' + cssEscape(node.id));
        break;
      }
      const testId = node.getAttribute && (node.getAttribute('data-testid') || node.getAttribute('data-test-id'));
      if (testId) {
        piece += '[data-testid="' + String(testId).replace(/"/g, '\\\\"') + '"]';
        parts.unshift(piece);
        break;
      }
      const name = node.getAttribute && node.getAttribute('name');
      if (name && (node.tagName === 'INPUT' || node.tagName === 'SELECT' || node.tagName === 'TEXTAREA')) {
        piece += '[name="' + String(name).replace(/"/g, '\\\\"') + '"]';
        parts.unshift(piece);
        break;
      }
      const parent = node.parentElement;
      if (parent) {
        const sameTag = Array.prototype.filter.call(parent.children, (c) => c.tagName === node.tagName);
        if (sameTag.length > 1) piece += ':nth-of-type(' + (sameTag.indexOf(node) + 1) + ')';
      }
      parts.unshift(piece);
      node = parent;
      depth += 1;
    }
    return parts.join(' > ');
  }

  function selectorFor(el) {
    return selectorWithinTree(el, 6);
  }

  /**
   * Describe how an element sits inside shadow roots.
   *
   * Returns '{ inShadow: false }' for light-DOM nodes, or a record naming the
   * host chain and a human/model-readable path. Closed roots are reported as
   * 'closed: true' because nothing deeper can be observed there.
   */
  function describeShadow(el) {
    const hosts = shadowChain(el);
    if (hosts.length === 0) return { inShadow: false };
    const hostSelectors = hosts.map((h) => selectorWithinTree(h, 8) || h.tagName.toLowerCase());
    // The chain uses '>>>' — CSS shadow-piercing syntax that is widely
    // understood, even though plain querySelector no longer accepts it.
    const selector = hostSelectors.join(' >>> ') + ' >>> ' + selectorWithinTree(el, 6);
    return {
      inShadow: true,
      depth: hosts.length,
      hostTags: hosts.map((h) => h.tagName.toLowerCase()),
      hostSelectors,
      selector,
      // Can the element actually be reached by script from the document?
      reachable: hosts.every((h) => h.shadowRoot !== null && h.shadowRoot !== undefined),
    };
  }

  // A second, structural selector anchored on the nearest ancestor with an id.
  // Helps the agent retry when the short one matches several nodes.
  function structuralSelectorFor(el) {
    if (!el || el.nodeType !== 1) return '';
    const parts = [];
    let node = el;
    let depth = 0;
    while (node && node.nodeType === 1 && depth < 10) {
      let piece = node.tagName.toLowerCase();
      if (node.id) {
        parts.unshift('#' + cssEscape(node.id));
        break;
      }
      const parent = node.parentElement;
      if (parent) {
        const idx = Array.prototype.indexOf.call(parent.children, node) + 1;
        piece += ':nth-child(' + idx + ')';
      }
      parts.unshift(piece);
      node = node.parentElement;
      depth += 1;
    }
    return parts.join(' > ');
  }

  function matchCount(selector) {
    try { return document.querySelectorAll(selector).length; } catch (e) { return -1; }
  }

  // ── shadow DOM support ───────────────────────────────────────────────────
  // elementFromPoint never descends into a shadow root, so on component-heavy
  // sites (bilibili's <bili-comments>, YouTube's <ytd-*>, most modern web apps)
  // the picker would only ever hit the outermost host element. The event's
  // composedPath() DOES cross open shadow roots, so picking uses that instead.
  //
  // Closed shadow roots stay opaque — the browser gives no path into them — so
  // those still resolve to the host element. That is a platform limit, not a
  // bug; the payload marks the result so the model is not misled.

  /** Root of a node's tree: the document, or the shadow root that owns it. */
  function rootOf(node) {
    const root = node.getRootNode ? node.getRootNode() : null;
    return root && root.host ? root : null;
  }

  /** True when 'node' lives inside any shadow root. */
  function inShadow(node) {
    return rootOf(node) !== null;
  }

  /**
   * Chain of shadow hosts from the outermost to the node's own root.
   * '[]' means the node is in the light DOM.
   */
  function shadowChain(node) {
    const chain = [];
    let current = node;
    let guard = 0;
    while (current && guard < 12) {
      const root = current.getRootNode ? current.getRootNode() : null;
      if (!root || !root.host) break;
      chain.unshift(root.host);
      current = root.host;
      guard += 1;
    }
    return chain;
  }

  /** 'elementFromPoint' that descends through open shadow roots. */
  function deepElementFromPoint(x, y) {
    let el = document.elementFromPoint(x, y);
    let guard = 0;
    while (el && el.shadowRoot && guard < 12) {
      // The host may paint over its own shadow content; if the point misses,
      // stop descending rather than looping.
      const inner = el.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
      guard += 1;
    }
    return el;
  }

  function textOf(el, limit) {
    const raw = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
    return raw.length > limit ? raw.slice(0, limit) + '…' : raw;
  }

  // A few computed-style facts that are frequently the thing the human means
  // ("this is red", "it's hidden", "it's 12px"). Deliberately small.
  function stylesOf(el) {
    const cs = window.getComputedStyle(el);
    const box = el.getBoundingClientRect();
    return {
      display: cs.display,
      position: cs.position,
      color: cs.color,
      backgroundColor: cs.backgroundColor,
      fontSize: cs.fontSize,
      fontWeight: cs.fontWeight,
      border: cs.border,
      opacity: cs.opacity,
      overflow: cs.overflow,
      zIndex: cs.zIndex,
      rect: {
        x: Math.round(box.x),
        y: Math.round(box.y),
        width: Math.round(box.width),
        height: Math.round(box.height),
      },
    };
  }

  function describeElement(el) {
    if (!el || el.nodeType !== 1) return null;
    const shadow = describeShadow(el);
    // Match count only means something for a light-DOM selector; inside a shadow
    // root the short selector is scoped to that root, so count within it instead.
    const shortSelector = selectorFor(el);
    const structural = structuralSelectorFor(el);
    let count = -1;
    try {
      const scope = rootOf(el) || document;
      count = scope.querySelectorAll(shortSelector).length;
    } catch (e) { count = -1; }
    const attrs = {};
    if (el.attributes) {
      for (let i = 0; i < el.attributes.length && i < 24; i += 1) {
        const a = el.attributes[i];
        // Skip style/class blobs; they are long and rarely the point.
        if (a.name === 'style') continue;
        attrs[a.name] = a.value.length > 200 ? a.value.slice(0, 200) + '…' : a.value;
      }
    }
    return {
      tag: el.tagName.toLowerCase(),
      selector: shortSelector,
      structuralSelector: structural,
      matchCount: count,
      shadow,
      id: el.id || null,
      className: typeof el.className === 'string' ? el.className : null,
      role: el.getAttribute ? el.getAttribute('role') : null,
      text: textOf(el, 300),
      attributes: attrs,
      styles: stylesOf(el),
      frameUrl: location.href,
      frameTitle: document.title,
    };
  }

  // ── overlay DOM ──────────────────────────────────────────────────────────
  const root = document.createElement('div');
  root.className = 'bh-annot-root';
  root.setAttribute('data-bh-annot', '1');

  const highlight = document.createElement('div');
  highlight.className = 'bh-annot-hl';
  highlight.style.display = 'none';

  const panel = document.createElement('div');
  panel.className = 'bh-annot-panel';
  panel.innerHTML = [
    '<div class="bh-annot-head">',
    '  <span class="bh-annot-dot"></span>',
    '  <span class="bh-annot-title">元素批注</span>',
    '  <span class="bh-annot-count" style="display:none">0</span>',
    '</div>',
    '<div class="bh-annot-body">',
    '  <div class="bh-annot-target empty">未选择元素 —— 点「开始选择」后点击页面元素</div>',
    '  <textarea class="bh-annot-text" placeholder="写一句批注：想让它变成什么、哪里不对…"></textarea>',
    '  <div class="bh-annot-row">',
    '    <button type="button" class="bh-annot-btn primary" data-act="pick">开始选择</button>',
    '    <button type="button" class="bh-annot-btn" data-act="send" disabled>发送</button>',
    '    <span class="bh-annot-spacer"></span>',
    '    <span class="bh-annot-status"></span>',
    '  </div>',
    '  <div class="bh-annot-row">',
    '    <button type="button" class="bh-annot-btn danger" data-act="close">关闭</button>',
    '  </div>',
    '</div>',
  ].join('');

  const styleEl = document.createElement('style');
  styleEl.textContent = ${JSON.stringify(PICKER_CSS)};

  root.appendChild(highlight);
  root.appendChild(panel);

  const dot = panel.querySelector('.bh-annot-dot');
  const countEl = panel.querySelector('.bh-annot-count');
  const targetEl = panel.querySelector('.bh-annot-target');
  const textEl = panel.querySelector('.bh-annot-text');
  const pickBtn = panel.querySelector('[data-act="pick"]');
  const sendBtn = panel.querySelector('[data-act="send"]');
  const closeBtn = panel.querySelector('[data-act="close"]');
  const statusEl = panel.querySelector('.bh-annot-status');

  function setStatus(message, kind) {
    statusEl.textContent = message || '';
    statusEl.className = 'bh-annot-status' + (kind ? ' ' + kind : '');
  }

  function refreshButtons() {
    pickBtn.textContent = state.picking ? '停止选择' : '开始选择';
    dot.className = 'bh-annot-dot' + (state.picking ? ' on' : '');
    sendBtn.disabled = !state.selected || textEl.value.trim().length === 0;
    if (state.selected) {
      targetEl.className = 'bh-annot-target';
      const d = state.selected;
      const count = d.matchCount === 1 ? '' : '  (' + d.matchCount + ' 处匹配)';
      // 面板里必须显示穿透路径，否则人选完看到 '#count' 会以为那就是能直接查的
      // 选择器，而它在主文档里根本不存在。shadow 内用完整链，普通元素用短选择器。
      const shown = (d.shadow && d.shadow.inShadow && d.shadow.selector)
        ? d.shadow.selector
        : d.selector;
      targetEl.textContent = d.tag + '  ' + shown + count;
      targetEl.title = shown;
    } else {
      targetEl.className = 'bh-annot-target empty';
      targetEl.textContent = '未选择元素 —— 点「开始选择」后点击页面元素';
      targetEl.title = '';
    }
    countEl.style.display = state.sentCount > 0 ? '' : 'none';
    countEl.textContent = '已发送 ' + state.sentCount;
  }

  // ── picking ──────────────────────────────────────────────────────────────
  function isOwnNode(node) {
    return node === root || root.contains(node);
  }

  function onPointerMove(event) {
    if (!state.picking) return;
    // deepElementFromPoint crosses open shadow roots; plain elementFromPoint
    // would only ever return the outermost custom-element host.
    const el = deepElementFromPoint(event.clientX, event.clientY);
    if (!el || isOwnNode(el)) return;
    state.hovered = el;
    const box = el.getBoundingClientRect();
    highlight.style.display = 'block';
    highlight.style.left = box.left + 'px';
    highlight.style.top = box.top + 'px';
    highlight.style.width = box.width + 'px';
    highlight.style.height = box.height + 'px';
    const hosts = shadowChain(el);
    let label = el.tagName.toLowerCase() + (el.id ? '#' + el.id : '');
    if (hosts.length > 0) label = hosts.map((h) => h.tagName.toLowerCase()).join('>') + ' ▸ ' + label;
    highlight.setAttribute('data-tag', label);
  }

  function onClickCapture(event) {
    if (!state.picking) return;
    // composedPath()[0] is the real innermost target even inside a shadow root,
    // which event.target is not guaranteed to be once a root is retargeted.
    let el = null;
    try {
      const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
      el = path.find((n) => n && n.nodeType === 1 && !isOwnNode(n)) || event.target;
    } catch (e) {
      el = event.target;
    }
    if (!el || isOwnNode(el)) return;
    // The pick must not activate whatever it lands on.
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    state.selected = describeElement(el);
    state.picking = false;
    highlight.style.display = 'none';
    refreshButtons();
    const sh = state.selected.shadow;
    setStatus(sh && sh.inShadow ? '已选择（shadow 内 ' + sh.depth + ' 层）' : '已选择', 'ok');
    try { textEl.focus(); } catch (e) { /* ignore */ }
  }

  function onKeyDown(event) {
    if (event.key === 'Escape' && state.picking) {
      state.picking = false;
      highlight.style.display = 'none';
      refreshButtons();
      setStatus('已取消选择');
    }
  }

  // ── payload delivery ─────────────────────────────────────────────────────
  // Primary channel: the CDP runtime binding (no network, no CSP involvement).
  // Fallback: localStorage, drained by the host on the next injection.
  //
  // Order matters: the binding call serialises the payload at call time, so the
  // viaBinding flag must be set BEFORE the call, not from its return value —
  // otherwise every delivered payload reports viaBinding false even though it
  // arrived. That bug shipped once; keep the assignment first.
  //
  // The mirror is a *fallback*, not a journal: once the binding accepted the
  // payload the record is removed again. Leaving delivered records behind means
  // the next injection "recovers" them and the user gets their own annotations
  // replayed at them — which is exactly what happened on the first e2e run.
  function deliver(payload) {
    payload.viaBinding = false;
    try {
      const fn = window[BINDING];
      if (typeof fn === 'function') {
        payload.viaBinding = true;
        fn(JSON.stringify(payload));
      }
    } catch (e) { /* fall through to the local mirror */ }

    try {
      const raw = localStorage.getItem(STORE_KEY);
      const list = raw ? JSON.parse(raw) : [];
      const next = Array.isArray(list) ? list.filter((x) => x && x.id !== payload.id) : [];
      if (payload.viaBinding === false) next.push(payload);
      if (next.length === 0) localStorage.removeItem(STORE_KEY);
      else localStorage.setItem(STORE_KEY, JSON.stringify(next.slice(-20)));
    } catch (e) { /* storage may be unavailable (private mode, quota) */ }
    return payload.viaBinding;
  }

  function send() {
    if (!state.selected) return;
    const comment = textEl.value.trim();
    if (comment === '') return;
    const payload = {
      kind: 'annotation',
      id: 'ann_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8),
      sessionTag: SESSION_TAG,
      comment,
      element: state.selected,
      page: { url: location.href, title: document.title },
      at: new Date().toISOString(),
    };
    const delivered = deliver(payload);
    state.sentCount += 1;
    state.selected = null;
    textEl.value = '';
    refreshButtons();
    setStatus(delivered ? '已发送' : '已暂存（等待回收）', delivered ? 'ok' : '');
  }

  // ── panel dragging (the panel may cover the element you want to pick) ────
  let dragOffset = null;
  const head = panel.querySelector('.bh-annot-head');
  head.addEventListener('mousedown', (event) => {
    const box = panel.getBoundingClientRect();
    dragOffset = { x: event.clientX - box.left, y: event.clientY - box.top };
    event.preventDefault();
  });
  function onDragMove(event) {
    if (!dragOffset) return;
    panel.style.left = Math.max(0, event.clientX - dragOffset.x) + 'px';
    panel.style.top = Math.max(0, event.clientY - dragOffset.y) + 'px';
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
  }
  function onDragEnd() { dragOffset = null; }

  // ── wiring ───────────────────────────────────────────────────────────────
  pickBtn.addEventListener('click', () => {
    state.picking = !state.picking;
    if (!state.picking) highlight.style.display = 'none';
    refreshButtons();
    setStatus(state.picking ? '点击页面上的元素' : '');
  });
  sendBtn.addEventListener('click', send);
  textEl.addEventListener('input', refreshButtons);
  textEl.addEventListener('keydown', (event) => {
    // Ctrl/Cmd+Enter sends without reaching for the mouse.
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      send();
    }
  });
  closeBtn.addEventListener('click', () => {
    try { window.__bhPicker.destroy(); } catch (e) { /* ignore */ }
  });

  // Capture phase so the pick wins over the page's own handlers.
  document.addEventListener('pointermove', onPointerMove, true);
  document.addEventListener('click', onClickCapture, true);
  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('mousemove', onDragMove, true);
  document.addEventListener('mouseup', onDragEnd, true);

  (document.body || document.documentElement).appendChild(styleEl);
  (document.body || document.documentElement).appendChild(root);
  refreshButtons();
  setStatus('就绪');

  window.__bhPicker = {
    version: 1,
    state,
    send,
    /** Programmatic pick, used by tests and by an agent that already knows the element. */
    select(selector) {
      let el = null;
      // 'host >>> inner' addresses a node inside an open shadow root; plain
      // querySelector cannot cross the boundary, so walk it manually.
      if (typeof selector === 'string' && selector.includes('>>>')) {
        const parts = selector.split('>>>').map((s) => s.trim()).filter(Boolean);
        let scope = document;
        let found = null;
        for (let i = 0; i < parts.length; i += 1) {
          if (!scope) { found = null; break; }
          try { found = scope.querySelector(parts[i]); } catch (e) { found = null; }
          if (!found) break;
          if (i < parts.length - 1) scope = found.shadowRoot || null;
        }
        el = found;
      } else {
        try { el = document.querySelector(selector); } catch (e) { el = null; }
      }
      if (!el) return { ok: false, error: 'no element matches ' + selector };
      state.selected = describeElement(el);
      refreshButtons();
      return { ok: true, element: state.selected };
    },
    /** Annotations written to localStorage but never confirmed by the binding. */
    drainPending() {
      try {
        const raw = localStorage.getItem(STORE_KEY);
        if (!raw) return [];
        const list = JSON.parse(raw);
        localStorage.removeItem(STORE_KEY);
        return Array.isArray(list) ? list : [];
      } catch (e) { return []; }
    },
    destroy(options) {
      if (state.destroyed) return;
      state.destroyed = true;
      document.removeEventListener('pointermove', onPointerMove, true);
      document.removeEventListener('click', onClickCapture, true);
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('mousemove', onDragMove, true);
      document.removeEventListener('mouseup', onDragEnd, true);
      try { styleEl.remove(); } catch (e) { /* ignore */ }
      try { root.remove(); } catch (e) { /* ignore */ }
      // Tell the watcher this picker is gone so it can stop polling and release
      // the browser. Without this the watcher kept draining the daemon's event
      // buffer forever after the human closed the panel.
      // 'reason' distinguishes an explicit close from a re-inject teardown (the
      // installer calls destroy() itself, and must not release anything).
      const reason = options && options.reason ? options.reason : 'closed';
      if (reason === 'closed') {
        try {
          const fn = window[BINDING];
          if (typeof fn === 'function') {
            fn(JSON.stringify({
              kind: 'picker_closed',
              sessionTag: SESSION_TAG,
              sentCount: state.sentCount,
              at: new Date().toISOString(),
            }));
          }
        } catch (e) { /* the watcher also notices a missing picker on its own */ }
      }
      try { delete window.__bhPicker; } catch (e) { window.__bhPicker = undefined; }
    },
  };

  return { ok: true, installed: true, sessionTag: SESSION_TAG };
})()`
}

/**
 * Snippet that checks whether the picker is still alive in the page (it dies on
 * navigation, and a SPA route change can wipe body children).
 * @returns {string}
 */
export function buildPickerProbe() {
  return `(() => {
  const p = window.__bhPicker;
  if (!p) return { alive: false };
  return { alive: true, version: p.version || 0, sentCount: p.state ? p.state.sentCount : 0 };
})()`
}

/**
 * Snippet that drains the localStorage mirror left behind when the binding call
 * did not land (page unload race, binding not yet registered, …).
 * @returns {string}
 */
export function buildDrainPending() {
  return `(() => {
  const p = window.__bhPicker;
  if (!p || typeof p.drainPending !== 'function') return { ok: false, items: [] };
  return { ok: true, items: p.drainPending() };
})()`
}
