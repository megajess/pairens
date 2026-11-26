// The REPL: a Client surface module the pane draws on desktop and terminal.
//
// It draws the session's history and the input as one plain, monospaced REPL
// transcript, and keeps the input's buffer, cursor, selection and undo in its
// own state. It runs on the drawing thread with no `$`: what needs the engine
// (evaluating, the clipboard, scrolling the pane to the input as the person
// types) it posts to the hooks module (register.tsx),
// which answers through props (a paste).
//
// Pane text can't be selected, so the module does its own: drag anywhere to
// select, Cmd+C to copy. Cmd arrives as `meta`; Esc never arrives (it hands
// the focus back), so losing focus shows as the pane's isFocused going false.
import type { ClientKeyEvent, ClientModule, ClientSurface, JsonValue } from 'claude-code'

import type { Completion, Description, ReplPost, ReplProps, TabsProps } from '../types'

type Pos = { row: number; col: number }
type Snap = { lines: string[]; row: number; col: number }

type State = {
  lines: string[]
  row: number
  col: number
  /** The other end of the input's selection; null for none. */
  anchor: Pos | null
  /** A mouse selection over the whole drawing, in document coordinates. */
  docAnchor: Pos | null
  docHead: Pos | null
  /** Where the mouse went down, in document coordinates, while it is held. */
  dragFrom: Pos | null
  /** Index into props.history while walking it; -1 while editing fresh text. */
  hist: number
  /** The fresh text kept while walking history. */
  draft: string[]
  undo: Snap[]
  /** Clicked into since the pane last lost the keyboard. */
  clicked: boolean
  /** The pane's isFocused as last seen, to notice it going false. */
  paneWas: boolean
  /** The paste this instance asked for, and the last paste it applied. */
  pasteReq: number
  pasteSeen: number
  /** The session last drawn: a change drops the selection and history walk. */
  session: string
  /** The Tab waiting for the image's answer: its id, its prefix, and where that starts in the input. */
  compReq: { id: number; start: number; prefix: string } | null
  /** The completion list under the input: everything offered, the one picked
   *  among those still matching, and where the prefix starts. `note` stands
   *  in for an empty list (`no completions`). */
  menu: { items: Completion[]; index: number; start: number; note?: string } | null
  /** The Option-click waiting for the image's answer: its id, the document row clicked, the token. */
  docReq: { id: number; row: number; token: string } | null
  /** The description shown under a document row: undefined while it is looked up, null when nothing is known. */
  docBox: { row: number; token: string; description: Description | null | undefined } | null
}

const START: State = {
  lines: [''], row: 0, col: 0, anchor: null, docAnchor: null, docHead: null, dragFrom: null,
  hist: -1, draft: [''], undo: [], clicked: false, paneWas: false,
  pasteReq: 0, pasteSeen: 0, session: '', compReq: null, menu: null, docReq: null, docBox: null,
}

const NAMED = new Set([
  'up', 'down', 'left', 'right', 'return', 'enter', 'tab', 'backspace', 'delete',
  'pageup', 'pagedown', 'home', 'end', 'escape', 'space',
])

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))
const before = (a: Pos, b: Pos) => a.row < b.row || (a.row === b.row && a.col < b.col)
const same = (a: Pos, b: Pos) => a.row === b.row && a.col === b.col

/** Asks the hooks to scroll the pane to its end, where the input is. */
const END: ReplPost = { type: 'end' }

const shortPackage = (p?: string) => (!p || p === 'COMMON-LISP-USER' ? 'CL-USER' : p)

/** Fresh input, keeping what lives across edits. */
const cleared = (s: State): State => ({
  ...s, lines: [''], row: 0, col: 0, anchor: null, docAnchor: null, docHead: null, hist: -1, draft: [''],
})

/** True when every opener is closed, skipping strings, comments and #\ chars. */
function balanced(text: string): boolean {
  let depth = 0
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '\\') { i++; continue }
    if (c === '#' && text[i + 1] === '\\') { i += 2; continue }
    if (c === ';') { while (i < text.length && text[i] !== '\n') i++; continue }
    if (c === '"') {
      i++
      while (i < text.length && text[i] !== '"') { if (text[i] === '\\') i++; i++ }
      continue
    }
    if (c === '(' || c === '[' || c === '{') depth++
    if (c === ')' || c === ']' || c === '}') depth--
  }
  return depth <= 0
}

/** Indent for a new line: two past the innermost open paren, else none. */
function indentAfter(text: string): number {
  const stack: number[] = []
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '"') { i++; while (i < text.length && text[i] !== '"') { if (text[i] === '\\') i++; i++ } continue }
    if (c === ';') { while (i < text.length && text[i] !== '\n') i++; continue }
    if (c === '(' || c === '[' || c === '{') stack.push(i)
    if ((c === ')' || c === ']' || c === '}') && stack.length) stack.pop()
  }
  const open = stack[stack.length - 1]
  if (open === undefined) return 0
  return open - (text.lastIndexOf('\n', open) + 1) + 2
}

// --- the input's selection -----------------------------------------------------

function selection(s: State): [Pos, Pos] | null {
  if (!s.anchor) return null
  const cur = { row: s.row, col: s.col }
  if (same(s.anchor, cur)) return null
  return before(s.anchor, cur) ? [s.anchor, cur] : [cur, s.anchor]
}

function selectedText(s: State): string {
  const sel = selection(s)
  if (!sel) return ''
  const [a, b] = sel
  if (a.row === b.row) return (s.lines[a.row] ?? '').slice(a.col, b.col)
  return [
    (s.lines[a.row] ?? '').slice(a.col),
    ...s.lines.slice(a.row + 1, b.row),
    (s.lines[b.row] ?? '').slice(0, b.col),
  ].join('\n')
}

function deleteSelection(s: State): State {
  const sel = selection(s)
  if (!sel) return { ...s, anchor: null }
  const [a, b] = sel
  const lines = [...s.lines]
  lines.splice(a.row, b.row - a.row + 1, (s.lines[a.row] ?? '').slice(0, a.col) + (s.lines[b.row] ?? '').slice(b.col))
  return { ...s, lines, row: a.row, col: a.col, anchor: null }
}

// --- edits -----------------------------------------------------------------

/** Records an undo step, then applies an edit (replacing any selection first). */
function edit(s: State, f: (s: State) => State, replaceSelection = true): State {
  const snap: Snap = { lines: s.lines, row: s.row, col: s.col }
  const base = replaceSelection && selection(s) ? deleteSelection(s) : { ...s, anchor: null }
  return { ...f(base), undo: [...s.undo, snap].slice(-200), hist: -1 }
}

function insertRaw(s: State, text: string): State {
  const line = s.lines[s.row] ?? ''
  const head = line.slice(0, s.col) + text
  const tail = line.slice(s.col)
  const parts = head.split(/\r\n|\r|\n/)
  const lastPart = parts[parts.length - 1] ?? ''
  parts[parts.length - 1] = lastPart + tail
  const lines = [...s.lines]
  lines.splice(s.row, 1, ...parts)
  return { ...s, lines, row: s.row + parts.length - 1, col: lastPart.length }
}

const insert = (s: State, text: string) => edit(s, x => insertRaw(x, text))

function newline(s: State): State {
  return edit(s, x => {
    const upTo = [...x.lines.slice(0, x.row), (x.lines[x.row] ?? '').slice(0, x.col)].join('\n')
    return insertRaw(x, '\n' + ' '.repeat(indentAfter(upTo)))
  })
}

function backspaceRaw(s: State): State {
  if (s.col > 0) {
    const line = s.lines[s.row] ?? ''
    const lines = [...s.lines]
    lines[s.row] = line.slice(0, s.col - 1) + line.slice(s.col)
    return { ...s, lines, col: s.col - 1 }
  }
  if (s.row === 0) return s
  const prev = s.lines[s.row - 1] ?? ''
  const lines = [...s.lines]
  lines.splice(s.row - 1, 2, prev + (s.lines[s.row] ?? ''))
  return { ...s, lines, row: s.row - 1, col: prev.length }
}

function deleteRaw(s: State): State {
  const line = s.lines[s.row] ?? ''
  if (s.col < line.length) {
    const lines = [...s.lines]
    lines[s.row] = line.slice(0, s.col) + line.slice(s.col + 1)
    return { ...s, lines }
  }
  if (s.row >= s.lines.length - 1) return s
  const lines = [...s.lines]
  lines.splice(s.row, 2, line + (s.lines[s.row + 1] ?? ''))
  return { ...s, lines }
}

const backspace = (s: State) => (selection(s) ? edit(s, x => x) : edit(s, backspaceRaw, false))
const del = (s: State) => (selection(s) ? edit(s, x => x) : edit(s, deleteRaw, false))

function killLine(s: State): State {
  const line = s.lines[s.row] ?? ''
  if (s.col === line.length) return edit(s, deleteRaw, false)
  return edit(s, x => {
    const lines = [...x.lines]
    lines[x.row] = line.slice(0, x.col)
    return { ...x, lines }
  }, false)
}

function undo(s: State): State {
  const snap = s.undo[s.undo.length - 1]
  if (!snap) return s
  return { ...s, ...snap, anchor: null, undo: s.undo.slice(0, -1) }
}

// --- movement --------------------------------------------------------------

const WORD = /[\w*+!?<>=/.:-]/

function wordLeft(s: State): Pos {
  const line = s.lines[s.row] ?? ''
  let col = s.col
  if (col === 0 && s.row > 0) return { row: s.row - 1, col: (s.lines[s.row - 1] ?? '').length }
  while (col > 0 && !WORD.test(line[col - 1] ?? '')) col--
  while (col > 0 && WORD.test(line[col - 1] ?? '')) col--
  return { row: s.row, col }
}

function wordRight(s: State): Pos {
  const line = s.lines[s.row] ?? ''
  let col = s.col
  if (col === line.length && s.row < s.lines.length - 1) return { row: s.row + 1, col: 0 }
  while (col < line.length && !WORD.test(line[col] ?? '')) col++
  while (col < line.length && WORD.test(line[col] ?? '')) col++
  return { row: s.row, col }
}

/** Moves the cursor; with `extend` the selection grows, without it drops. */
function moveTo(s: State, to: Pos, extend: boolean): State {
  const anchor = extend ? (s.anchor ?? { row: s.row, col: s.col }) : null
  return { ...s, row: to.row, col: to.col, anchor }
}

function walkHistory(s: State, history: string[], dir: 1 | -1): State {
  // dir 1 = older. history is oldest-first.
  const n = history.length
  if (n === 0) return s
  const at = s.hist === -1 ? n : s.hist
  const next = at - dir
  if (next >= n) {
    const lines = s.draft
    return { ...s, hist: -1, anchor: null, lines, row: lines.length - 1, col: (lines[lines.length - 1] ?? '').length }
  }
  if (next < 0) return s
  const lines = (history[next] ?? '').split('\n')
  return {
    ...s,
    draft: s.hist === -1 ? s.lines : s.draft,
    hist: next,
    anchor: null,
    lines,
    row: lines.length - 1,
    col: (lines[lines.length - 1] ?? '').length,
  }
}

// --- keys ------------------------------------------------------------------

function onKey(s: State, k: ClientKeyEvent, props: ReplProps, post: (d: ReplPost) => void): State {
  // Any key closes a description.
  if (s.docBox || s.docReq) s = { ...s, docBox: null, docReq: null }
  // An open completion list takes the keys that move through it and pick.
  if (s.menu) {
    const shown = menuItems(s)
    const down = (k.key === 'down' && !k.shift) || (k.ctrl && k.key === 'n')
    const up = (k.key === 'up' && !k.shift) || (k.ctrl && k.key === 'p')
    if (shown.length && (down || up)) {
      const n = shown.length
      return { ...s, menu: { ...s.menu, index: (s.menu.index + (down ? 1 : n - 1)) % n } }
    }
    if (shown.length && !k.meta && !k.ctrl && (k.key === 'tab' || k.key === 'return' || k.key === 'enter')) {
      return acceptCompletion(s, shown[clamp(s.menu.index, 0, n0(shown))] ?? shown[0])
    }
  }
  return followMenu(onKeyText(s, k, props, post))
}

const n0 = (list: unknown[]) => Math.max(0, list.length - 1)

function onKeyText(s: State, k: ClientKeyEvent, props: ReplProps, post: (d: ReplPost) => void): State {
  const line = s.lines[s.row] ?? ''
  const text = s.lines.join('\n')
  const key = k.key
  const shift = k.shift === true
  const last = s.lines.length - 1

  // Cmd on macOS arrives as meta: the Mac's editing keys.
  if (k.meta) {
    switch (key) {
      case 'v': {
        const id = Date.now()
        post({ type: 'paste', id })
        return { ...s, pasteReq: id }
      }
      case 'c': {
        const sel = selectedText(s)
        if (sel) post({ type: 'copy', text: sel })
        return s
      }
      case 'x': {
        const sel = selectedText(s)
        if (!sel) return s
        post({ type: 'copy', text: sel })
        return edit(s, x => x)
      }
      case 'a': return { ...s, anchor: { row: 0, col: 0 }, row: last, col: (s.lines[last] ?? '').length }
      case 'z': return undo(s)
      case 'left': return moveTo(s, { row: s.row, col: 0 }, shift)
      case 'right': return moveTo(s, { row: s.row, col: line.length }, shift)
      case 'up': return moveTo(s, { row: 0, col: 0 }, shift)
      case 'down': return moveTo(s, { row: last, col: (s.lines[last] ?? '').length }, shift)
      case 'backspace':
        return edit(s, x => ({ ...x, lines: x.lines.map((l, i) => (i === x.row ? l.slice(x.col) : l)), col: 0 }))
      case 'return':
      case 'enter': return newline(s)
      // Emacs Meta word moves, should a terminal send Option as meta.
      case 'b': return moveTo(s, wordLeft(s), shift)
      case 'f': return moveTo(s, wordRight(s), shift)
      default: return s
    }
  }

  if (k.ctrl) {
    switch (key) {
      case 'a': return moveTo(s, { row: s.row, col: 0 }, shift)
      case 'e': return moveTo(s, { row: s.row, col: line.length }, shift)
      case 'b': return onKey(s, { key: 'left', shift: k.shift }, props, post)
      case 'f': return onKey(s, { key: 'right', shift: k.shift }, props, post)
      case 'p': return onKey(s, { key: 'up', shift: k.shift }, props, post)
      case 'n': return onKey(s, { key: 'down', shift: k.shift }, props, post)
      case 'd': return del(s)
      case 'h': return backspace(s)
      case 'k': return killLine(s)
      case 'u': return edit(s, x => cleared(x), false)
      case 'j': return newline(s)
      // Complete: Ctrl+Space (as in most IDEs), Ctrl+I (what Tab sends in a terminal).
      case 'space':
      case ' ': return startCompletion(s, post) ?? s
      case 'i': return startCompletion(s, post) ?? insert(s, '  ')
      case 'left': return moveTo(s, wordLeft(s), shift)
      case 'right': return moveTo(s, wordRight(s), shift)
      default: return s
    }
  }

  switch (key) {
    case 'return':
    case 'enter': {
      // Enter sends a complete form (or a `pairens:` line); inside an open
      // form it is a newline. Shift+Enter always is.
      const ask = /^\s*pairens:\s/i.test(text)
      if (shift || !text.trim() || (!ask && !balanced(text))) return newline(s)
      post({ type: 'eval', code: text })
      return cleared(s)
    }
    case 'backspace': return pairedBackspace(s)
    case 'delete': return del(s)
    case 'left': {
      const sel = selection(s)
      if (sel && !shift) return moveTo(s, sel[0], false)
      if (s.col > 0) return moveTo(s, { row: s.row, col: s.col - 1 }, shift)
      return s.row > 0 ? moveTo(s, { row: s.row - 1, col: (s.lines[s.row - 1] ?? '').length }, shift) : moveTo(s, s, shift)
    }
    case 'right': {
      const sel = selection(s)
      if (sel && !shift) return moveTo(s, sel[1], false)
      if (s.col < line.length) return moveTo(s, { row: s.row, col: s.col + 1 }, shift)
      return s.row < last ? moveTo(s, { row: s.row + 1, col: 0 }, shift) : moveTo(s, s, shift)
    }
    case 'up': {
      if (s.row === 0) return shift ? moveTo(s, { row: 0, col: 0 }, true) : walkHistory(s, props.history, 1)
      const row = s.row - 1
      return moveTo(s, { row, col: clamp(s.col, 0, (s.lines[row] ?? '').length) }, shift)
    }
    case 'down': {
      if (s.row === last) return shift ? moveTo(s, { row: last, col: line.length }, true) : walkHistory(s, props.history, -1)
      const row = s.row + 1
      return moveTo(s, { row, col: clamp(s.col, 0, (s.lines[row] ?? '').length) }, shift)
    }
    case 'home': return moveTo(s, { row: s.row, col: 0 }, shift)
    case 'end': return moveTo(s, { row: s.row, col: line.length }, shift)
    // Tab completes where it reaches us (the terminal); the desktop app keeps
    // it for moving the focus, so Ctrl+Space and Ctrl+I complete too.
    case 'tab': return startCompletion(s, post) ?? insert(s, '  ')
    case 'space': return insert(s, ' ')
  }
  if (NAMED.has(key)) return s
  // One character: auto-paired where it is code. Several at once: as typed.
  return key.length === 1 ? typeChar(s, key) : insert(s, key)
}

// --- completion ----------------------------------------------------------------

/**
 * Asks the image to complete the symbol before the cursor, when there is one
 * in code (not a selection, a string, a comment or a `pairens:` line);
 * `null` when there is nothing to complete.
 */
function startCompletion(s: State, post: (d: ReplPost) => void): State | null {
  const { text, off } = cursorText(s)
  const word = wordBefore(text, off)
  if (selection(s) || !word.prefix || contextAt(text, off) !== 'code' || /^\s*pairens:\s/i.test(text)) return null
  const id = Date.now()
  post({ type: 'complete', id, prefix: word.prefix })
  return { ...s, compReq: { id, start: word.start, prefix: word.prefix }, menu: null }
}

/** A character that can be part of a symbol (or `pkg:`, `ns/`, `:keyword`). */
const SYMBOL_CHAR = /[^\s()[\]{}"'`,;@^~]/

/** The symbol (or its start) just before offset OFF of TEXT, and where it starts. */
function wordBefore(text: string, off: number): { prefix: string; start: number } {
  let start = off
  while (start > 0 && SYMBOL_CHAR.test(text[start - 1] ?? '')) start--
  return { prefix: text.slice(start, off), start }
}

const startsWithCI = (text: string, prefix: string) => text.toLowerCase().startsWith(prefix.toLowerCase())

/** The completions still matching what is typed from the list's start to the cursor. */
function menuItems(s: State): Completion[] {
  if (!s.menu) return []
  const { text, off } = cursorText(s)
  const typed = text.slice(s.menu.start, off)
  return s.menu.items.filter(c => startsWithCI(c.text, typed))
}

/** Replaces the input from offset START to the cursor (all on the cursor's line) with TEXT. */
function replaceToCursor(s: State, start: number, text: string): State {
  const { off } = cursorText(s)
  const startCol = s.col - (off - start)
  return edit(s, x => {
    const line = x.lines[x.row] ?? ''
    const lines = [...x.lines]
    lines[x.row] = line.slice(0, startCol) + text + line.slice(x.col)
    return { ...x, lines, col: startCol + text.length }
  }, false)
}

/** Puts COMPLETION in place of the prefix and closes the list. */
function acceptCompletion(s: State, completion: Completion | undefined): State {
  if (!s.menu || !completion) return { ...s, menu: null }
  return { ...replaceToCursor(s, s.menu.start, completion.text), menu: null, compReq: null }
}

/** The longest start every TEXT shares, ignoring case (spelled as the first has it). */
function sharedStart(texts: string[]): string {
  const first = texts[0] ?? ''
  let n = first.length
  for (const t of texts) {
    let k = 0
    while (k < n && k < t.length && t[k]?.toLowerCase() === first[k]?.toLowerCase()) k++
    n = k
  }
  return first.slice(0, n)
}

/**
 * The image's answer to a Tab: one match is put in place; several put in
 * what they share and open the list; none says so. Dropped when the cursor
 * has left the prefix since (what is typed there no longer starts with it).
 */
function applyCompletion(s: State, items: Completion[]): State {
  const req = s.compReq
  if (!req) return s
  const { text, off } = cursorText(s)
  const word = wordBefore(text, off)
  if (word.start !== req.start || !word.prefix || !startsWithCI(word.prefix, req.prefix)) return { ...s, compReq: null }
  const matching = items.filter(c => startsWithCI(c.text, word.prefix))
  const base = { ...s, compReq: null }
  if (matching.length === 0) return { ...base, menu: { items: [], index: 0, start: req.start, note: 'no completions' } }
  if (matching.length === 1) return replaceToCursor(base, req.start, matching[0]?.text ?? word.prefix)
  const shared = sharedStart(matching.map(c => c.text))
  const grown = shared.length > word.prefix.length ? replaceToCursor(base, req.start, shared) : base
  return { ...grown, menu: { items: matching, index: 0, start: req.start } }
}

/** After a key: the list follows what is typed, and closes once the cursor leaves the prefix or nothing matches. */
function followMenu(s: State): State {
  if (!s.menu) return s
  if (s.menu.note) return { ...s, menu: null }
  const { text, off } = cursorText(s)
  if (wordBefore(text, off).start !== s.menu.start || off < s.menu.start) return { ...s, menu: null }
  const shown = menuItems(s)
  if (shown.length === 0) return { ...s, menu: null }
  return { ...s, menu: { ...s.menu, index: clamp(s.menu.index, 0, shown.length - 1) } }
}

// --- describing: Option-click ------------------------------------------------------

/** The symbol at column COL of a document row (past its prompt), or '' when there is none. */
function tokenAt(row: DocRow | undefined, col: number): string {
  if (!row || col < row.prompt) return ''
  const text = row.text
  if (!SYMBOL_CHAR.test(text[col] ?? '')) return ''
  let from = col
  let to = col
  while (from > row.prompt && SYMBOL_CHAR.test(text[from - 1] ?? '')) from--
  while (to < text.length && SYMBOL_CHAR.test(text[to] ?? '')) to++
  const token = text.slice(from, to).replace(/[.:]+$/, '')
  // A number names nothing.
  return /^[+-]?\d/.test(token) ? '' : token
}

/** How many lines of documentation the description shows before "…". */
const DOC_LINES = 14

/** A description's rows: name, kind and argument list, then its documentation; a grey bar in the gutter. */
function describeRows(box: NonNullable<State['docBox']>, width: number): Seg[][] {
  const gutter: Seg = { text: BAR, color: 'subtle' }
  const line = (segs: Seg[]): Seg[] => [gutter, ...fit([{ text: '  ' }, ...segs], width)]
  const d = box.description
  if (d === undefined) return [line([{ text: `; looking up ${box.token}…`, dim: true }])]
  if (d === null) return [line([{ text: `; nothing known about ${box.token}`, dim: true }])]
  const rows: Seg[][] = [
    line([
      { text: d.name, color: 'claude', bold: true },
      { text: `  ${d.kind}`, color: 'subtle' },
      ...(d.args ? [{ text: `  ${d.args}`, color: 'subtle', italic: true }] : []),
    ]),
  ]
  // The documentation, wrapped to the room, its common indent dropped.
  const room = Math.max(10, width - 4)
  const docLines = d.doc ? d.doc.replace(/\s+$/, '').split('\n') : []
  const indent = Math.min(...docLines.slice(1).filter(l => l.trim()).map(l => l.length - l.trimStart().length), 99)
  const wrapped: string[] = []
  docLines.forEach((l, i) => {
    let rest = i === 0 ? l : l.slice(Number.isFinite(indent) && indent < 99 ? indent : 0)
    do {
      wrapped.push(rest.slice(0, room))
      rest = rest.slice(room)
    } while (rest.length)
  })
  if (!wrapped.length) wrapped.push('(no documentation)')
  for (const l of wrapped.slice(0, DOC_LINES)) rows.push(line([{ text: `  ${l}`, ...(d.doc ? {} : { dim: true }) }]))
  if (wrapped.length > DOC_LINES) rows.push(line([{ text: '  …', dim: true }]))
  return rows
}

/** How many completions the list shows at once. */
const MENU_ROWS = 8

// --- auto-pairing ------------------------------------------------------------

/** What an opener pairs with: parens, brackets, braces, and the string quote. */
const PAIRS: Record<string, string> = { '(': ')', '[': ']', '{': '}', '"': '"' }

/** The input as one text, and the cursor's offset in it. */
function cursorText(s: State): { text: string; off: number } {
  let off = s.col
  for (let r = 0; r < s.row; r++) off += (s.lines[r] ?? '').length + 1
  return { text: s.lines.join('\n'), off }
}

/**
 * What the cursor at offset `k` of `text` is in: code, a string (between its
 * quotes), or a comment (`;` to the line's end, or `#| |#`).
 */
function contextAt(text: string, k: number): 'code' | 'string' | 'comment' {
  let i = 0
  while (i < k) {
    const c = text[i]
    if (c === ';') {
      let j = i
      while (j < text.length && text[j] !== '\n') j++
      if (k <= j) return 'comment'
      i = j
    } else if (c === '#' && text[i + 1] === '|') {
      let depth = 1
      let j = i + 2
      while (j < text.length && depth > 0) {
        if (text[j] === '|' && text[j + 1] === '#') { depth--; j += 2 }
        else if (text[j] === '#' && text[j + 1] === '|') { depth++; j += 2 }
        else j++
      }
      if (k < j) return 'comment'
      i = j
    } else if (c === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1
      // Inside: after the opening quote, up to and including just before the closing one.
      if (k <= j) return 'string'
      i = j + 1
    } else if (c === '\\' || (c === '#' && text[i + 1] === '\\')) {
      // A character literal or escape: its character is not syntax.
      i += c === '\\' ? 2 : 3
    } else i++
  }
  return 'code'
}

/**
 * Types one character, pairing it where the cursor is in code: an opener or
 * a quote inserts its pair with the cursor between (or wraps the selection);
 * a closer, or a quote at a string's end, steps over the same character ahead.
 * In strings and comments, and right after `\` (a character literal), it is
 * typed as is.
 */
function typeChar(s: State, key: string): State {
  const { text, off } = cursorText(s)
  const ctx = contextAt(text, off)
  const escaped = text[off - 1] === '\\'
  const next = text[off]
  const sel = selection(s)
  if (!escaped && !sel && (ctx === 'string' ? key === '"' : ctx === 'code' && CLOSERS.includes(key)) && next === key) {
    return moveTo(s, { row: s.row, col: s.col + 1 }, false)
  }
  const close = PAIRS[key]
  if (ctx === 'code' && !escaped && close) {
    if (sel) {
      const wrapped = key + selectedText(s) + close
      return edit(s, x => insertRaw(x, wrapped))
    }
    const r = insert(s, key + close)
    return { ...r, col: r.col - 1 }
  }
  return insert(s, key)
}

/** Backspace; between an empty pair in code (`(|)`, `""`), deletes both. */
function pairedBackspace(s: State): State {
  if (selection(s)) return backspace(s)
  const { text, off } = cursorText(s)
  const open = text[off - 1] ?? ''
  const isPair = PAIRS[open] !== undefined && PAIRS[open] === text[off]
  if (isPair && text[off - 2] !== '\\' && contextAt(text, off - 1) === 'code') {
    return edit(s, x => deleteRaw(backspaceRaw(x)), false)
  }
  return backspace(s)
}

// --- syntax: Lisp and Clojure, one class per character -------------------------

/** What a character of code is, for colouring and paren matching. */
type Cls = 'plain' | 'paren' | 'comment' | 'string' | 'number' | 'char' | 'keyword' | 'quote' | 'special'

/** Operators drawn as special forms when they head a list: Common Lisp's and Clojure's. */
const SPECIAL = new Set([
  // Common Lisp
  'defun', 'defmacro', 'defvar', 'defparameter', 'defconstant', 'defclass', 'defmethod', 'defgeneric',
  'defstruct', 'defpackage', 'deftype', 'define-condition', 'in-package', 'let', 'let*', 'flet', 'labels',
  'macrolet', 'lambda', 'if', 'when', 'unless', 'cond', 'case', 'ecase', 'typecase', 'etypecase', 'progn',
  'prog1', 'block', 'return', 'return-from', 'loop', 'do', 'do*', 'dolist', 'dotimes', 'setf', 'setq',
  'incf', 'decf', 'push', 'pop', 'multiple-value-bind', 'destructuring-bind', 'handler-case', 'handler-bind',
  'restart-case', 'unwind-protect', 'ignore-errors', 'declare', 'the', 'quote', 'function', 'and', 'or',
  'not', 'with-slots', 'with-accessors', 'with-open-file', 'eval-when', 'catch', 'throw', 'tagbody', 'go',
  // Clojure
  'def', 'defn', 'defn-', 'defmulti', 'defprotocol', 'defrecord', 'deftype', 'ns', 'fn', 'fn*', 'letfn',
  'recur', 'if-let', 'when-let', 'if-some', 'when-some', 'doseq', 'for', 'condp', 'cond->', 'cond->>', '->',
  '->>', 'as->', 'some->', 'try', 'finally', 'binding', 'require', 'import',
])

const OPENERS = '([{'
const CLOSERS = ')]}'
const isDelimiter = (c: string | undefined) => c === undefined || /[\s()[\]{}"';`,]/.test(c)
const NUMBER = /^[+-]?(\d+\.?\d*([eEdD][+-]?\d+)?|\.\d+|\d+\/\d+|\d+N|\d+M)$/

/** Classifies each character of `code`. Strings and `#| |#` comments may span lines. */
function classify(code: string): Cls[] {
  const out: Cls[] = new Array(code.length).fill('plain')
  const mark = (from: number, to: number, c: Cls) => {
    for (let k = from; k < to && k < code.length; k++) out[k] = c
  }
  let i = 0
  let afterOpen = false
  while (i < code.length) {
    const c = code[i] ?? ''
    if (/\s/.test(c)) { i++; continue }
    if (c === ';') {
      let j = i
      while (j < code.length && code[j] !== '\n') j++
      mark(i, j, 'comment')
      i = j
      continue
    }
    if (c === '#' && code[i + 1] === '|') {
      // Block comments nest.
      let depth = 1
      let j = i + 2
      while (j < code.length && depth > 0) {
        if (code[j] === '|' && code[j + 1] === '#') { depth--; j += 2 }
        else if (code[j] === '#' && code[j + 1] === '|') { depth++; j += 2 }
        else j++
      }
      mark(i, j, 'comment')
      i = j
      continue
    }
    if (c === '"') {
      let j = i + 1
      while (j < code.length && code[j] !== '"') j += code[j] === '\\' ? 2 : 1
      mark(i, j + 1, 'string')
      i = j + 1
      afterOpen = false
      continue
    }
    if (c === '#' && code[i + 1] === '\\') {
      // A character: #\a, #\(, #\Space.
      let j = i + 3
      while (j < code.length && !isDelimiter(code[j])) j++
      mark(i, j, 'char')
      i = j
      afterOpen = false
      continue
    }
    if (c === '\\' && /[a-zA-Z(),]/.test(code[i + 1] ?? '')) {
      // A Clojure character: \a, \newline, \(.
      let j = i + 2
      while (j < code.length && !isDelimiter(code[j])) j++
      mark(i, j, 'char')
      i = j
      afterOpen = false
      continue
    }
    if (OPENERS.includes(c) || CLOSERS.includes(c)) {
      out[i] = 'paren'
      i++
      afterOpen = OPENERS.includes(c)
      continue
    }
    // Quote marks and reader macros: ' ` , ,@ @ ^ #' #_ and the # of #( and #{.
    const next = code[i + 1] ?? ''
    const quote =
      c === "'" || c === '`' || c === '@' || c === '^'
        ? 1
        : c === ','
          ? next === '@' ? 2 : 1
          : c === '#' && (next === "'" || next === '_')
            ? 2
            : c === '#' && (next === '(' || next === '{')
              ? 1
              : 0
    if (quote) {
      mark(i, i + quote, 'quote')
      i += quote
      continue
    }
    // An atom: a symbol, number or keyword.
    let j = i
    while (j < code.length && !isDelimiter(code[j])) j++
    if (j === i) j = i + 1
    const word = code.slice(i, j)
    const cls: Cls = word.startsWith(':')
      ? 'keyword'
      : NUMBER.test(word)
        ? 'number'
        : afterOpen && SPECIAL.has(word.toLowerCase())
          ? 'special'
          : 'plain'
    mark(i, j, cls)
    i = j
    afterOpen = false
  }
  return out
}

/** Each paren's nesting depth (0 outermost; an opener and its closer share
 *  one), and -1 for every other character. */
function parenDepths(code: string, cls: Cls[]): number[] {
  const out: number[] = new Array(code.length).fill(-1)
  let depth = 0
  for (let k = 0; k < code.length; k++) {
    if (cls[k] !== 'paren') continue
    if (OPENERS.includes(code[k] ?? '')) out[k] = depth++
    else out[k] = depth = Math.max(0, depth - 1)
  }
  return out
}

/** What drawing needs of a piece of code: each character's class and paren depth. */
type Syntax = { cls: Cls[]; depth: number[] }
const syntaxOf = (code: string): Syntax => {
  const cls = classify(code)
  return { cls, depth: parenDepths(code, cls) }
}

/** syntaxOf, remembered by text: the history's forms don't change between keys. */
const syntaxCache = new Map<string, Syntax>()
function syntaxCached(code: string): Syntax {
  const hit = syntaxCache.get(code)
  if (hit) return hit
  const syn = syntaxOf(code)
  if (syntaxCache.size > 500) syntaxCache.clear()
  syntaxCache.set(code, syn)
  return syn
}

/** The parens' colours, by depth, cycling: theme colours, so each theme keeps them apart. */
const PAREN_COLORS = ['permission', 'success', 'warning', 'autoAccept', 'ide', 'planMode'] as const

/** How each class is drawn: theme colours, so every theme keeps them legible. */
const CLASS_STYLE: Record<Cls, { color?: string; italic?: boolean }> = {
  plain: {},
  paren: {},
  comment: { color: 'subtle', italic: true },
  string: { color: 'success' },
  number: { color: 'warning' },
  char: { color: 'warning' },
  keyword: { color: 'suggestion' },
  quote: { color: 'subtle' },
  special: { color: 'merged' },
}

/**
 * The paren matching the one at the cursor, in `code` offsets: a closer just
 * before the cursor, else an opener under it, else a closer under it. Only
 * parens outside strings, comments and characters count. `null` when the
 * cursor is at no paren; `match: null` when the paren has no partner.
 */
function parenAt(code: string, cls: Cls[], cursor: number): { at: number; match: number | null } | null {
  const isParen = (k: number) => cls[k] === 'paren'
  const pick =
    cursor > 0 && isParen(cursor - 1) && CLOSERS.includes(code[cursor - 1] ?? '')
      ? cursor - 1
      : isParen(cursor) && OPENERS.includes(code[cursor] ?? '')
        ? cursor
        : isParen(cursor) && CLOSERS.includes(code[cursor] ?? '')
          ? cursor
          : -1
  if (pick < 0) return null
  const ch = code[pick] ?? ''
  const forward = OPENERS.includes(ch)
  let depth = 0
  for (let k = pick; forward ? k < code.length : k >= 0; k += forward ? 1 : -1) {
    if (!isParen(k)) continue
    const c = code[k] ?? ''
    if ((forward ? OPENERS : CLOSERS).includes(c)) depth++
    else depth--
    if (depth === 0) {
      const pair = forward ? ch + c : c + ch
      return { at: pick, match: pair === '()' || pair === '[]' || pair === '{}' ? k : null }
    }
  }
  return { at: pick, match: null }
}

/** Closers in `code` with no opener before them, and openers of the wrong kind they close. */
function strayClosers(code: string, cls: Cls[]): number[] {
  const stack: number[] = []
  const stray: number[] = []
  for (let k = 0; k < code.length; k++) {
    if (cls[k] !== 'paren') continue
    const c = code[k] ?? ''
    if (OPENERS.includes(c)) stack.push(k)
    else {
      const open = stack.pop()
      if (open === undefined || OPENERS.indexOf(code[open] ?? '') !== CLOSERS.indexOf(c)) stray.push(k)
    }
  }
  return stray
}

// --- the document: history then input, as plain REPL text ---------------------

type DocRow = {
  text: string
  kind: 'code' | 'output' | 'value' | 'error' | 'claude' | 'reply' | 'note' | 'input' | 'help' | 'banner'
  /** How many leading characters are the prompt (or its indent). */
  prompt: number
  /** Claude's eval: its prompt is drawn in Claude's colour. */
  byClaude?: boolean
  /** The bar in the gutter: Claude's (its eval and what came of it, or its
   *  reply) in orange; what the REPL printed or returned for the person's own
   *  eval in light blue. */
  bar?: Bar
  /** Code rows (a past form, the input): the class of each character after the prompt. */
  classes?: Cls[]
  /** Code rows: each paren's nesting depth (-1 for other characters), aligned with `classes`. */
  depths?: number[]
  /** Banner rows: each character's colour (undefined: the text's own). */
  paint?: (string | undefined)[]
}
type VisualRow = { row: number; start: number }
type Bar = 'claude' | 'result'

// --- the banner: the site's (λ_) mark, the name, a line about pAIrens -----------

/** The mark as ASCII art, and which part each character is: P a paren, L the λ, U the cursor. */
const MARK = [
  ['  /  _          \\', '  P  L          P'],
  [' /    \\          \\', ' P    L          P'],
  ['|      \\          |', 'P      L          P'],
  ['|      /\\         |', 'P      LL         P'],
  ['|     /  \\        |', 'P     L  L        P'],
  [' \\   /    \\   ___/', ' P   L    L   UUUP'],
  ['  \\             /', '  P             P'],
] as const
const MARK_COLOR: Record<string, string | undefined> = { P: 'subtle', L: undefined, U: 'claude' }

/** The name in large letters (figlet's standard font), and whether each letter is the brand's AI. */
const NAME_LETTERS: [string[], boolean][] = [
  [['       ', ' _ __  ', "| '_ \\ ", '| |_) |', '| .__/ ', '|_|    '], false],
  [['    _    ', '   / \\   ', '  / _ \\  ', ' / ___ \\ ', '/_/   \\_\\', '         '], true],
  [[' ___ ', '|_ _|', ' | | ', ' | | ', '|___|', '     '], true],
  [['      ', ' _ __ ', "| '__|", '| |   ', '|_|   ', '      '], false],
  [['      ', '  ___ ', ' / _ \\', '|  __/', ' \\___|', '      '], false],
  [['       ', ' _ __  ', "| '_ \\ ", '| | | |', '|_| |_|', '       '], false],
  [['     ', ' ___ ', '/ __|', '\\__ \\', '|___/', '     '], false],
]
const NAME_WIDTH = NAME_LETTERS.reduce((n, [rows]) => n + (rows[0]?.length ?? 0), 0)

/**
 * What the REPL shows above the history, as a REPL prints a banner when it
 * starts: the mark, the name in large letters (just "pAIrens" when the room is
 * narrower than they are), a line about pAIrens, and how to get help.
 */
function bannerRows(width: number): DocRow[] {
  const rows: DocRow[] = []
  const paint = (text: string, colors: (string | undefined)[]): DocRow => ({ text, kind: 'banner', prompt: 0, paint: colors })
  const big = width >= NAME_WIDTH + 1
  const markIndent = big ? Math.max(0, Math.floor((NAME_WIDTH - (MARK[0]?.[0].length ?? 0)) / 2)) : 0
  if (width >= 20) {
    for (const [line, parts] of MARK) {
      const text = ' '.repeat(markIndent) + line
      const colors = [...' '.repeat(markIndent) + parts].map(c => MARK_COLOR[c])
      rows.push(paint(text, colors))
    }
    rows.push(paint('', []))
  }
  if (big) {
    for (let r = 0; r < 6; r++) {
      let text = ''
      const colors: (string | undefined)[] = []
      for (const [letter, ai] of NAME_LETTERS) {
        const piece = letter[r] ?? ''
        text += piece
        for (let k = 0; k < piece.length; k++) colors.push(ai ? 'claude' : undefined)
      }
      rows.push(paint(text.trimEnd(), colors))
    }
  } else {
    rows.push(paint('pAIrens', [undefined, 'claude', 'claude', undefined, undefined, undefined, undefined]))
  }
  rows.push(paint('', []))
  rows.push(paint('A Lisp REPL you and Claude share: Common Lisp over Swank, Clojure and ClojureScript over nREPL.', []))
  const help = 'Type pairens: help for help.'
  const from = help.indexOf('pairens: help')
  rows.push(paint(help, [...help].map((_, k) => (k >= from && k < from + 'pairens: help'.length ? 'claude' : undefined))))
  rows.push(paint('', []))
  return rows
}

function buildDoc(props: ReplProps, lines: string[], width: number): DocRow[] {
  const rows: DocRow[] = bannerRows(width)
  const add = (text: string, kind: DocRow['kind'], bar?: Bar) => {
    for (const line of String(text).replace(/\n+$/, '').split('\n'))
      rows.push({ text: line, kind, prompt: 0, ...(bar ? { bar } : {}) })
  }
  // Defensive throughout: props are plain data from another module, maybe older.
  for (const e of props.entries ?? []) {
    if (e.kind === 'eval') {
      const byClaude = e.origin === 'claude'
      const prompt = `${byClaude ? '✻ ' : ''}${shortPackage(e.package)}> `
      const code = String(e.text ?? '')
      const syn = syntaxCached(code)
      let offset = 0
      code.split('\n').forEach((l, i) => {
        rows.push({
          text: (i === 0 ? prompt : ' '.repeat(prompt.length)) + l,
          kind: 'code',
          prompt: prompt.length,
          byClaude,
          ...(byClaude ? { bar: 'claude' as const } : {}),
          classes: syn.cls.slice(offset, offset + l.length),
          depths: syn.depth.slice(offset, offset + l.length),
        })
        offset += l.length + 1
      })
      // What came of it: Claude's bar for Claude's eval, the REPL's for the person's.
      const result: Bar = byClaude ? 'claude' : 'result'
      if (e.output) add(e.output.trimEnd(), 'output', result)
      if (e.status === 'running') add(`; running… (${e.id})`, 'note', result)
      if (e.status === 'error') add(e.error ?? 'error', 'error', result)
      if (e.status === 'ok') {
        if (e.values?.length) for (const v of e.values) add(v, 'value', result)
        else add('; No values', 'note', result)
      }
    } else if (e.kind === 'ask') {
      add(`? (claude) ${e.text ?? ''}`, 'claude')
    } else if (e.kind === 'reply') {
      add('✻ Claude', 'claude', 'claude')
      add(e.text ?? '', 'reply', 'claude')
    } else if (e.kind === 'help') {
      add(String(e.text ?? '').trimEnd(), 'help')
    } else {
      add(String(e.text ?? '').trimEnd(), 'note')
    }
  }
  const lead = props.prompt.length + 1
  // A `pairens:` line is a question for Claude, not code: drawn plain.
  const typed = lines.join('\n')
  const syn = /^\s*pairens:\s/i.test(typed) ? null : syntaxOf(typed)
  let offset = 0
  lines.forEach((l, i) => {
    rows.push({
      text: (i === 0 ? props.prompt + ' ' : ' '.repeat(lead)) + l,
      kind: 'input',
      prompt: lead,
      ...(syn
        ? { classes: syn.cls.slice(offset, offset + l.length), depths: syn.depth.slice(offset, offset + l.length) }
        : {}),
    })
    offset += l.length + 1
  })
  return rows
}

/** Splits document rows into screen rows `width` cells wide (input rows keep a cell for the cursor). */
function wrapRows(doc: DocRow[], width: number): VisualRow[] {
  const out: VisualRow[] = []
  doc.forEach((r, row) => {
    const len = r.text.length + (r.kind === 'input' ? 1 : 0)
    for (let start = 0; start === 0 || start < len; start += width) {
      out.push({ row, start })
      if (!Number.isFinite(width)) break
    }
  })
  return out
}

function docSelection(s: State): [Pos, Pos] | null {
  if (!s.docAnchor || !s.docHead || same(s.docAnchor, s.docHead)) return null
  return before(s.docAnchor, s.docHead) ? [s.docAnchor, s.docHead] : [s.docHead, s.docAnchor]
}

function docText(doc: DocRow[], [a, b]: [Pos, Pos]): string {
  const line = (r: number) => doc[r]?.text ?? ''
  if (a.row === b.row) return line(a.row).slice(a.col, b.col)
  return [line(a.row).slice(a.col), ...doc.slice(a.row + 1, b.row).map(r => r.text), line(b.row).slice(0, b.col)].join('\n')
}

/** Columns assumed before the first layout. */
const UNLAID_COLUMNS = 78
/** The gutter's width, left of the text, where a thin bar marks whose a row is. */
const GUTTER = 1
const BAR = '▎'
/** Claude's rows in orange; the REPL's results for the person's evals in light blue. */
const BAR_COLOR: Record<Bar, string> = { claude: 'claude', result: 'suggestion' }
type Seg = {
  text: string
  color?: string
  background?: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
  dim?: boolean
  inverse?: boolean
  sel?: boolean
}
/** One session tab: its row in the tab strip and the cells it spans. */
type Tab = { name: string; row: number; x0: number; x1: number }

/** Lays the session tabs out as filled labels, ` name `, a cell apart,
 *  starting one cell in, wrapping onto more rows when they don't fit. */
function layoutTabs(sessions: string[], room: number): { tabs: Tab[]; rows: number } {
  const tabs: Tab[] = []
  let row = 0
  let x = 1
  for (const name of sessions) {
    const w = name.length + 2
    if (x > 1 && x + w > room) {
      row++
      x = 1
    }
    tabs.push({ name, row, x0: x, x1: x + w - 1 })
    x += w + 1
  }
  return { tabs, rows: row + 1 }
}

/** Cuts a row of segments to `n` cells, padding it with spaces when shorter. */
function fit(segs: Seg[], n: number): Seg[] {
  const out: Seg[] = []
  let used = 0
  for (const g of segs) {
    if (used >= n) break
    const text = g.text.slice(0, n - used)
    out.push({ ...g, text })
    used += text.length
  }
  if (used < n) out.push({ text: ' '.repeat(n - used) })
  return out
}

// --- drawing -----------------------------------------------------------------

const Repl: ClientModule<JsonValue, State> = (rawProps, surface: ClientSurface<State>) => {
  const { Box, Text } = surface.elements
  const props = rawProps as unknown as ReplProps
  let s = surface.state ?? START
  const lead = props.prompt.length + 1

  // The layout: in a bordered body, the whole transcript wrapped to the region. The pane scrolls it (its own
  // scrolling, wheel and trackpad included) and the hooks keep it at the end.
  // Inside the border: a one-cell gutter, then the text.
  const width = (surface.columns > 6 ? surface.columns : UNLAID_COLUMNS) - 2 - GUTTER
  // The first row of transcript: under the body's top border.
  const BODY_TOP = 1

  // Settle what the props brought, once each: a paste the hooks read, the
  // pane losing the keyboard (the only sign of Esc that reaches us), and a
  // new session.
  let changed = false
  if (props.paste && props.paste.id === s.pasteReq && s.pasteSeen !== props.paste.id) {
    s = { ...insert(s, props.paste.text), pasteSeen: props.paste.id }
    changed = true
    surface.post(END)
  }
  if (s.paneWas !== props.paneFocused) {
    s = { ...s, paneWas: props.paneFocused, clicked: props.paneFocused ? s.clicked : false }
    changed = true
  }
  if (s.session !== props.session) {
    s = { ...s, session: props.session, hist: -1, docAnchor: null, docHead: null, compReq: null, menu: null }
    changed = true
  }
  if (props.described && s.docReq && props.described.id === s.docReq.id) {
    s = { ...s, docBox: { row: s.docReq.row, token: s.docReq.token, description: props.described.description ?? null }, docReq: null }
    changed = true
  }
  if (props.completion && s.compReq && props.completion.id === s.compReq.id) {
    s = applyCompletion(s, props.completion.items ?? [])
    changed = true
    surface.post(END)
  }
  if (changed) surface.setState(s)

  const focused = s.clicked
  const doc = buildDoc(props, s.lines, width)
  const visual = wrapRows(doc, width)
  const inputStart = doc.length - s.lines.length

  // The completion list's window: up to MENU_ROWS entries around the picked one.
  const shownItems = menuItems(s)
  const picked = s.menu ? clamp(s.menu.index, 0, n0(shownItems)) : 0
  const first = clamp(picked - MENU_ROWS + 1, 0, Math.max(0, shownItems.length - MENU_ROWS))
  const menuRows = shownItems.slice(first, first + MENU_ROWS)

  // An Option-click's description, drawn under the clicked row: where it goes
  // among the screen rows, and its rows.
  const box = s.docBox
  const boxAfter = box ? visual.reduce((at, v, i) => (v.row === box.row ? i : at), -1) : -1
  const boxRows: Seg[][] = box && boxAfter >= 0 ? describeRows(box, width) : []

  /** The screen row (in `visual`) a pointer row shows, past the description's rows; -1 on them. */
  const visualAt = (y: number): number => {
    const vi = y - BODY_TOP
    if (!boxRows.length || vi <= boxAfter) return vi
    return vi <= boxAfter + boxRows.length ? -1 : vi - boxRows.length
  }

  /** The document position under a pointer event (region cells: the body inside its border). */
  const docPos = (x: number, y: number): Pos => {
    const v = visual[clamp(visualAt(y), 0, visual.length - 1)] ?? { row: 0, start: 0 }
    return { row: v.row, col: clamp(v.start + x - 1 - GUTTER, 0, (doc[v.row]?.text ?? '').length) }
  }
  const isInput = (p: Pos) => p.row >= inputStart
  const toInput = (p: Pos): Pos => {
    const row = p.row - inputStart
    return { row, col: clamp(p.col - lead, 0, (s.lines[row] ?? '').length) }
  }

  // Replaced on every call so the listeners see the latest props and layout.
  surface.onKey(k => {
    const now = surface.state ?? START
    const dsel = docSelection(now)
    if (k.meta && k.key === 'c' && dsel) {
      const copy: ReplPost = { type: 'copy', text: docText(buildDoc(props, now.lines, width), dsel) }
      surface.post(copy)
      return
    }
    // A post in the same frame replaces an undelivered one, so the request to
    // scroll to the end goes only when the key posted nothing else (an eval's
    // result scrolls the pane by itself).
    let posted = false
    const next = onKey({ ...now, docAnchor: null, docHead: null }, k, props, d => {
      posted = true
      surface.post(d)
    })
    surface.setState({ ...next, clicked: true })
    if (!posted && (next.lines !== now.lines || next.row !== now.row || next.col !== now.col)) {
      surface.post(END)
    }
  })
  surface.onPointer(p => {
    const now = surface.state ?? START
    if (p.type === 'down' && p.alt) {
      // Option-click: ask the image what the symbol under the pointer names.
      if (visualAt(p.y) < 0) return
      const at = docPos(Math.round(p.fine?.x ?? p.x), p.y)
      const token = tokenAt(doc[at.row], at.col)
      if (!token) return
      const id = Date.now()
      surface.post({ type: 'describe', id, token })
      surface.setState({ ...now, docReq: { id, row: at.row, token }, docBox: { row: at.row, token, description: undefined }, menu: null })
      return
    }
    if (p.type === 'down' && (now.docBox || now.docReq)) {
      // The next click closes the description, and does nothing else.
      surface.setState({ ...now, docBox: null, docReq: null })
      return
    }
    const menuRow = p.y - BODY_TOP - visual.length
    if (p.type === 'down' && now.menu && menuRow >= 0 && menuRow < menuRows.length) {
      // A click on the completion list picks that entry.
      const picked = menuRows[menuRow]
      if (picked) surface.setState({ ...acceptCompletion(now, picked), clicked: true })
      return
    }
    const at = docPos(Math.round(p.fine?.x ?? p.x), p.y)
    if (p.type === 'down' && p.button === 'left') {
      if (isInput(at)) {
        const i = toInput(at)
        const anchor = p.shift ? (now.anchor ?? { row: now.row, col: now.col }) : null
        surface.setState({ ...now, ...i, anchor, docAnchor: null, docHead: null, dragFrom: at, clicked: true })
      } else {
        surface.setState({ ...now, anchor: null, docAnchor: at, docHead: at, dragFrom: at, clicked: true })
      }
    } else if (p.type === 'move' && p.button && now.dragFrom) {
      if (isInput(now.dragFrom) && isInput(at)) {
        // Within the input: an ordinary editing selection, which typing replaces.
        surface.setState({ ...now, ...toInput(at), anchor: toInput(now.dragFrom), docAnchor: null, docHead: null })
      } else {
        surface.setState({ ...now, anchor: null, docAnchor: now.dragFrom, docHead: at })
      }
    } else if (p.type === 'up') {
      const empty = now.docAnchor && now.docHead && same(now.docAnchor, now.docHead)
      surface.setState({ ...now, dragFrom: null, ...(empty ? { docAnchor: null, docHead: null } : {}) })
    }
  })

  // What is highlighted, in document coordinates: a mouse selection, else the
  // input's own selection.
  const isel = selection(s)
  const hl: [Pos, Pos] | null =
    docSelection(s) ??
    (isel
      ? [
          { row: inputStart + isel[0].row, col: isel[0].col + lead },
          { row: inputStart + isel[1].row, col: isel[1].col + lead },
        ]
      : null)
  const cursor: Pos | null = focused ? { row: inputStart + s.row, col: s.col + lead } : null

  // Paren matching in the input, while it has the cursor: the paren at the
  // cursor and its partner, or the paren alone in red when it has none; and
  // any closer with no opener, in red.
  const parenMarks = new Map<string, 'match' | 'stray'>()
  if (focused) {
    const typed = s.lines.join('\n')
    if (!/^\s*pairens:\s/i.test(typed)) {
      const cls = classify(typed)
      const starts: number[] = []
      let o = 0
      for (const l of s.lines) {
        starts.push(o)
        o += l.length + 1
      }
      const toDoc = (k: number): string => {
        let row = 0
        while (row + 1 < starts.length && (starts[row + 1] ?? Infinity) <= k) row++
        return `${inputStart + row}:${k - (starts[row] ?? 0) + lead}`
      }
      for (const k of strayClosers(typed, cls)) parenMarks.set(toDoc(k), 'stray')
      const p = parenAt(typed, cls, (starts[s.row] ?? 0) + s.col)
      if (p) {
        if (p.match === null) parenMarks.set(toDoc(p.at), 'stray')
        else {
          parenMarks.set(toDoc(p.at), 'match')
          parenMarks.set(toDoc(p.match), 'match')
        }
      }
    }
  }

  /** How a character of a row is drawn, before selection and the cursor. */
  const styleOf = (r: DocRow, col: number): Pick<Seg, 'color' | 'italic' | 'bold' | 'underline'> => {
    if (col < r.prompt) return { color: r.byClaude || (r.kind === 'input' && focused) ? 'claude' : 'subtle' }
    if (r.kind === 'error') return { color: 'error' }
    if (r.kind === 'output' || r.kind === 'note') return { color: 'subtle' }
    if (r.kind === 'claude') return { color: 'claude' }
    if (r.kind === 'banner') {
      const color = r.paint?.[col]
      return color ? { color } : {}
    }
    // Help: its title and section headings (lines in capitals) stand out.
    if (r.kind === 'help') return /^[A-Z][A-Z']+(\s|$)|^pAIrens help$/.test(r.text) ? { bold: true } : {}
    const cls = r.classes?.[col - r.prompt]
    if (cls === 'paren') {
      const depth = r.depths?.[col - r.prompt] ?? -1
      return depth >= 0 ? { color: PAREN_COLORS[depth % PAREN_COLORS.length] } : {}
    }
    return cls ? CLASS_STYLE[cls] : {}
  }

  const edge = focused ? 'claude' : 'subtle'

  /** One body row of the transcript, as segments `width` cells wide. */
  const bodyRow = (v: VisualRow): Seg[] => {
    const r = doc[v.row] ?? { text: '', kind: 'note' as const, prompt: 0 }
    const end = Math.min(v.start + width, r.text.length + (r.kind === 'input' ? 1 : 0))
    const segs: (Seg & { key: string })[] = []
    for (let col = v.start; col < Math.max(end, v.start + 1); col++) {
      const at = { row: v.row, col }
      const cur = cursor !== null && same(cursor, at)
      const sel = !cur && hl !== null && !before(at, hl[0]) && before(at, hl[1])
      const mark = parenMarks.get(`${v.row}:${col}`)
      const style =
        mark === 'match'
          ? { color: 'claude', bold: true, underline: true }
          : mark === 'stray'
            ? { color: 'error', bold: true }
            : styleOf(r, col)
      const key = `${cur}|${sel}|${style.color}|${style.italic}|${style.bold}|${style.underline}`
      const ch = r.text[col] ?? ' '
      const tail = segs[segs.length - 1]
      if (tail && tail.key === key) tail.text += ch
      else segs.push({ key, text: ch, ...style, sel, inverse: cur })
    }
    const placeholder = r.kind === 'input' && !focused && s.lines.length === 1 && s.lines[0] === '' && v.start === 0
    return fit([...segs, ...(placeholder ? [{ text: 'click to type', dim: true }] : [])], width)
  }

  // Each row: the gutter (a bar, or blank), then the text; an Option-click's
  // description under the row clicked.
  const body: Seg[][] = []
  visual.forEach((v, i) => {
    const bar = doc[v.row]?.bar
    body.push([bar ? { text: BAR, color: BAR_COLOR[bar] } : { text: ' ' }, ...bodyRow(v)])
    if (i === boxAfter) body.push(...boxRows)
  })

  // Under the input, the completion list: name, kind, argument list; the
  // picked one highlighted. Indented to where the prefix starts.
  if (s.menu) {
    const startCol = s.col - (cursorText(s).off - s.menu.start)
    const indent = ' '.repeat(Math.min(lead + Math.max(0, startCol), Math.floor(width / 2)))
    if (s.menu.note) body.push([{ text: ' ' }, ...fit([{ text: `${indent}; ${s.menu.note}`, dim: true }], width)])
    const nameWidth = Math.max(0, ...menuRows.map(c => c.text.length))
    menuRows.forEach((c, i) => {
      const on = first + i === picked
      const name = c.text.padEnd(nameWidth)
      const segs: Seg[] = on
        ? [{ text: ` ${name}  ${c.kind}  ${c.args} `, sel: true }]
        : [{ text: ` ${name}  ` }, { text: c.kind, color: 'subtle' }, { text: `  ${c.args}`, color: 'subtle', italic: true }]
      body.push([{ text: ' ' }, ...fit([{ text: indent }, ...segs], width)])
    })
    if (shownItems.length > MENU_ROWS) {
      body.push([{ text: ' ' }, ...fit([{ text: `${indent} ${picked + 1}/${shownItems.length}`, dim: true }], width)])
    }
  }

  const draw = drawWith(Text)

  return (
    <Box borderStyle="round" borderColor={edge} flexDirection="column" flexGrow={1}>
      {body.map(row => (
        <Text mono>{row.map(draw)}</Text>
      ))}
    </Box>
  )
}

/**
 * Draws one segment of a row in the surface's Text. The cursor and a
 * selection take over the colour; otherwise only the styles set are passed,
 * so no prop is ever undefined.
 */
const drawWith = (Text: ClientSurface['elements']['Text']) => (g: Seg) => {
  if (g.inverse) return <Text mono inverse>{g.text}</Text>
  if (g.sel) return <Text mono backgroundColor="suggestion" color="inverseText">{g.text}</Text>
  if (g.dim) return <Text mono dimColor>{g.text}</Text>
  const style: { color?: string; backgroundColor?: string; bold?: boolean; italic?: boolean; underline?: boolean } = {}
  if (g.color) style.color = g.color
  if (g.background) style.backgroundColor = g.background
  if (g.bold) style.bold = true
  if (g.italic) style.italic = true
  if (g.underline) style.underline = true
  return (
    <Text mono {...style}>
      {g.text}
    </Text>
  )
}

// --- the session tabs ----------------------------------------------------------

/** The session tabs, a second instance of this module drawn above the
 *  connection line: filled labels, the selected one in Claude's colour like an
 *  active browser tab, the rest dim. A click on one switches session. */
const Tabs = (props: TabsProps, surface: ClientSurface<State>) => {
  const { Box, Text } = surface.elements
  const room = surface.columns > 6 ? surface.columns : UNLAID_COLUMNS
  const sessions = props.sessions?.length ? props.sessions : [props.session]
  const { tabs, rows } = layoutTabs(sessions, room)

  surface.onPointer(p => {
    if (p.type !== 'down') return
    const tab = tabs.find(t => t.row === p.y && p.x >= t.x0 && p.x <= t.x1)
    if (tab && tab.name !== props.session) {
      const post: ReplPost = { type: 'tab', session: tab.name }
      surface.post(post)
    }
  })

  const strip: Seg[][] = []
  for (let row = 0; row < rows; row++) {
    const segs: Seg[] = [{ text: ' ' }]
    for (const t of tabs.filter(x => x.row === row)) {
      if (segs.length > 1) segs.push({ text: ' ' })
      segs.push(
        t.name === props.session
          ? { text: ` ${t.name} `, background: 'claude', color: 'inverseText', bold: true }
          : { text: ` ${t.name} `, dim: true },
      )
    }
    strip.push(segs)
  }
  const draw = drawWith(Text)
  return (
    <Box flexDirection="column">
      {strip.map(row => (
        <Text mono>{row.map(draw)}</Text>
      ))}
    </Box>
  )
}

/** The completion steps, for tests: they change a State and draw nothing. */
export { START, applyCompletion, followMenu, menuItems, onKey as replKey }
export type { State as ReplState }

/** One module, two instances: the REPL, and (with `view: 'tabs'`) its tabs. */
const Module: ClientModule<JsonValue, State> = (rawProps, surface) =>
  (rawProps as { view?: unknown } | null)?.view === 'tabs'
    ? Tabs(rawProps as unknown as TabsProps, surface)
    : Repl(rawProps, surface)

export default Module
