// pAIrens browser page: a client of the helper's v1 API.
// GET /api/v1/events streams state; commands are POSTs with the key.

import { createEditor, highlightLisp, renderMarkdown } from '/vendor/editor.js'

const key = new URLSearchParams(location.search).get('key') ?? ''
const $ = sel => document.querySelector(sel)

const state = {
  entries: [],
  status: { connected: false },
  mode: 'ask',
  debugs: new Map(),
  tab: localStorage.getItem('pairens.tab') || 'user',
  online: false,
}

// --- API ---------------------------------------------------------------------

async function api(path, body) {
  const res = await fetch(`/api/v1/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error ?? `request failed (${res.status})`)
  return data
}

const report = err => {
  const box = document.createElement('div')
  box.className = 'entry output-entry'
  box.innerHTML = '<pre></pre>'
  box.querySelector('pre').textContent = `pAIrens: ${err.message ?? err}`
  $('#history').appendChild(box)
  scrollToEnd(true)
}

// --- live updates ------------------------------------------------------------

function connectEvents() {
  if (!key) {
    $('#status').textContent = 'no key in the address; open this page with /pairens-browser'
    return
  }
  const events = new EventSource(`/api/v1/events?key=${encodeURIComponent(key)}`)
  events.addEventListener('hello', e => {
    const s = JSON.parse(e.data)
    state.entries = s.entries ?? []
    state.status = s.status ?? state.status
    state.mode = s.mode ?? state.mode
    state.debugs = new Map((s.debugs ?? []).map(d => [d.id, d]))
    setOnline(true)
    renderAll()
  })
  events.addEventListener('entry', e => {
    const entry = JSON.parse(e.data)
    const at = state.entries.findIndex(x => x.id === entry.id && x.at === entry.at)
    if (at < 0) state.entries.push(entry)
    else state.entries[at] = entry
    if (state.entries.length > 400) state.entries.splice(0, state.entries.length - 400)
    renderTabs()
    renderHistory()
  })
  events.addEventListener('reset', e => {
    state.entries = JSON.parse(e.data).entries ?? []
    renderTabs()
    renderHistory(true)
  })
  events.addEventListener('status', e => {
    state.status = JSON.parse(e.data)
    renderStatus()
  })
  events.addEventListener('mode', e => {
    state.mode = JSON.parse(e.data).mode
    renderModes()
  })
  events.addEventListener('debug', e => {
    const d = JSON.parse(e.data)
    state.debugs.set(d.id, d)
    renderDebugs()
  })
  events.addEventListener('debug-done', e => {
    state.debugs.delete(JSON.parse(e.data).id)
    renderDebugs()
  })
  events.onerror = () => setOnline(false) // EventSource retries on its own
}

function setOnline(online) {
  state.online = online
  $('#offline').hidden = online
}

// --- rendering -----------------------------------------------------------------

const shortPackage = p => (!p || p === 'COMMON-LISP-USER' ? 'CL-USER' : p)
const shownEntries = () => state.entries.filter(x => x.session === state.tab)
const currentPackage = () => shortPackage([...shownEntries()].reverse().find(x => x.package)?.package)

function renderAll() {
  renderStatus()
  renderModes()
  renderTabs()
  renderDebugs()
  renderHistory(true)
}

function renderStatus() {
  const s = state.status
  const el = $('#status')
  el.className = 'status' + (s.connected ? ' ok' : '')
  el.textContent = s.connected
    ? `● ${s.impl} · Swank ${s.host}:${s.port}`
    : s.launching
      ? '◌ starting SBCL with Swank…'
      : `○ not connected${s.error ? ` (${s.error})` : ''}`
  $('#connect').hidden = s.connected || s.launching
  $('#disconnect').hidden = !s.connected
}

function renderModes() {
  for (const b of document.querySelectorAll('.modes button')) b.classList.toggle('on', b.dataset.mode === state.mode)
}

function renderTabs() {
  const sessions = Array.from(new Set(['user', ...state.entries.map(x => x.session)]))
  if (!sessions.includes(state.tab)) state.tab = 'user'
  const nav = $('#tabs')
  nav.textContent = ''
  for (const name of sessions) {
    const b = document.createElement('button')
    b.textContent = name
    b.className = name === state.tab ? 'on' : ''
    b.onclick = () => {
      state.tab = name
      try {
        localStorage.setItem('pairens.tab', name)
      } catch {}
      renderTabs()
      renderHistory(true)
      editor.focus()
    }
    nav.appendChild(b)
  }
  const clear = document.createElement('button')
  clear.className = 'clear'
  clear.textContent = `clear "${state.tab}"`
  clear.onclick = () => api('clear', { session: state.tab }).catch(report)
  nav.appendChild(clear)
  $('#prompt').textContent = `${currentPackage()}>`
}

function renderDebugs() {
  const box = $('#debugs')
  box.textContent = ''
  for (const d of state.debugs.values()) {
    const card = document.createElement('div')
    card.className = 'debug'
    const head = document.createElement('div')
    head.className = 'head'
    head.textContent = `Debugger: ${d.message}`
    const type = document.createElement('div')
    type.className = 'type'
    type.textContent = `${d.type} · thread ${d.thread} · level ${d.level}`
    const restarts = document.createElement('div')
    restarts.className = 'restarts'
    d.restarts.forEach((r, index) => {
      const b = document.createElement('button')
      const name = document.createElement('span')
      name.className = 'name'
      name.textContent = r.name
      b.append(name, r.description)
      b.onclick = () => api('restart', { id: d.id, index }).catch(report)
      restarts.appendChild(b)
    })
    const trace = document.createElement('details')
    const summary = document.createElement('summary')
    summary.textContent = `Backtrace (${d.frames.length} frames)`
    const pre = document.createElement('pre')
    pre.textContent = d.frames.map((f, i) => `${i}: ${f}`).join('\n')
    trace.append(summary, pre)
    card.append(head, type, restarts, trace)
    box.appendChild(card)
  }
}

// History rows are cached by entry and redrawn only when they change.
const rows = new Map()
const signature = x => JSON.stringify([x.status, x.text, x.output, x.values, x.error, x.package])

function entryRow(x) {
  const el = document.createElement('div')
  el.className = `entry ${x.kind}${x.origin === 'claude' ? ' claude' : ''}${x.kind === 'output' ? ' output-entry' : ''}`
  const tools = document.createElement('div')
  tools.className = 'tools'
  const copy = document.createElement('button')
  copy.textContent = 'copy'
  copy.onclick = () => navigator.clipboard.writeText(entryText(x)).catch(report)
  tools.appendChild(copy)
  if (x.kind === 'eval') {
    const edit = document.createElement('button')
    edit.textContent = 'edit'
    edit.onclick = () => editor.setText(x.text)
    tools.appendChild(edit)
  }

  if (x.kind === 'eval') {
    const code = document.createElement('div')
    code.className = 'code'
    const pkg = document.createElement('span')
    pkg.className = 'pkg'
    pkg.textContent = `${shortPackage(x.package)}>`
    const pre = document.createElement('pre')
    highlightLisp(x.text, pre)
    code.append(pkg, pre)
    el.appendChild(code)
    if (x.output) el.appendChild(pre_('output', x.output.replace(/\s+$/, '')))
    if (x.status === 'running') el.appendChild(pre_('running', `… running (${x.id})`))
    if (x.status === 'ok') for (const v of x.values?.length ? x.values : ['; no values']) el.appendChild(pre_('value', v))
    if (x.status === 'error') el.appendChild(pre_('error', x.error ?? 'error'))
  } else if (x.kind === 'ask') {
    el.appendChild(pre_('', `? (claude) ${x.text}`))
  } else if (x.kind === 'reply') {
    const who = document.createElement('div')
    who.className = 'who'
    who.textContent = '✻ Claude'
    const md = document.createElement('div')
    md.className = 'md'
    md.innerHTML = renderMarkdown(x.text) // raw HTML is escaped by renderMarkdown
    el.append(who, md)
  } else {
    el.appendChild(pre_('', x.text.replace(/\s+$/, '')))
  }
  el.appendChild(tools)
  return el
}

function pre_(cls, text) {
  const pre = document.createElement('pre')
  if (cls) pre.className = cls
  pre.textContent = text
  return pre
}

function entryText(x) {
  if (x.kind !== 'eval') return x.text
  const parts = [x.text]
  if (x.output) parts.push(x.output.replace(/\s+$/, ''))
  if (x.status === 'ok') parts.push(`=> ${(x.values ?? []).join('\n=> ')}`)
  if (x.status === 'error') parts.push(`!! ${x.error}`)
  return parts.join('\n')
}

function isNearEnd() {
  const h = $('#history')
  return h.scrollHeight - h.scrollTop - h.clientHeight < 80
}

function scrollToEnd(force) {
  const h = $('#history')
  if (force || isNearEnd()) requestAnimationFrame(() => (h.scrollTop = h.scrollHeight))
}

function renderHistory(jump = false) {
  const follow = jump || isNearEnd()
  const h = $('#history')
  const list = shownEntries()
  const wanted = new Set()
  let prev = null
  for (const x of list) {
    const k = `${x.id}@${x.at}`
    wanted.add(k)
    const sig = signature(x)
    let row = rows.get(k)
    if (!row || row.sig !== sig) {
      const el = entryRow(x)
      if (row) row.el.replaceWith(el)
      row = { el, sig }
      rows.set(k, row)
    }
    // keep DOM order matching the list
    const want = prev ? prev.nextSibling : h.firstChild
    if (row.el !== want) h.insertBefore(row.el, want)
    prev = row.el
  }
  for (const [k, row] of rows) {
    if (!wanted.has(k)) {
      row.el.remove()
      rows.delete(k)
    }
  }
  h.querySelector('.empty')?.remove()
  if (!list.length) {
    const empty = document.createElement('div')
    empty.className = 'empty'
    empty.textContent = `Nothing evaluated in "${state.tab}" yet. Try (pairens:claude "hello!")`
    h.appendChild(empty)
  }
  $('#prompt').textContent = `${currentPackage()}>`
  if (follow) scrollToEnd(true)
}

// --- editor and controls ------------------------------------------------------

/** Inputs submitted from this page, per tab, newest last. */
const submitted = new Map()

const editor = createEditor({
  parent: $('#editor'),
  placeholderText: '(+ 1 2)',
  history: () => {
    const past = []
    for (const x of shownEntries())
      if (x.kind === 'eval' && x.origin === 'user' && past[past.length - 1] !== x.text) past.push(x.text)
    // What was just submitted may not be back from the helper yet.
    for (const text of submitted.get(state.tab) ?? []) if (!past.includes(text)) past.push(text)
    return past
  },
  onSubmit: code => {
    const mine = submitted.get(state.tab) ?? []
    submitted.set(state.tab, [...mine.filter(t => t !== code), code].slice(-20))
    api('eval', { session: state.tab, code }).catch(report)
    scrollToEnd(true)
  },
})

for (const b of document.querySelectorAll('.modes button'))
  b.onclick = () => api('mode', { mode: b.dataset.mode }).catch(report)

$('#launch').onclick = () => api('launch', {}).catch(report)
$('#disconnect').onclick = () => api('disconnect', {}).catch(report)
$('#connect-form').onsubmit = e => {
  e.preventDefault()
  const arg = $('#connect-addr').value.trim() || '4005'
  const at = arg.lastIndexOf(':')
  const host = at < 0 ? '127.0.0.1' : arg.slice(0, at) || '127.0.0.1'
  const port = Number(at < 0 ? arg : arg.slice(at + 1))
  api('connect', { host, port }).catch(report)
}

connectEvents()
editor.focus()
