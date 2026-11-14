// The pAIrens browser page's editor bundle: CodeMirror 6 with the Common Lisp
// and Clojure modes, REPL keys, highlighting for history rows, and safe
// Markdown for Claude's replies. Built by `npm run build` into ../browser/vendor/editor.js.

import { EditorState, Compartment } from '@codemirror/state'
import { EditorView, keymap, placeholder, drawSelection, highlightActiveLine } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, insertNewlineAndIndent, indentWithTab } from '@codemirror/commands'
import { StreamLanguage, bracketMatching, indentOnInput, syntaxHighlighting, HighlightStyle } from '@codemirror/language'
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete'
import { commonLisp } from '@codemirror/legacy-modes/mode/commonlisp'
import { clojure } from '@codemirror/legacy-modes/mode/clojure'
import { tags as t, highlightTree, classHighlighter } from '@lezer/highlight'
import { Marked } from 'marked'

const languages = {
  'common-lisp': StreamLanguage.define(commonLisp),
  clojure: StreamLanguage.define(clojure),
}
const languageFor = name => languages[name] ?? languages['common-lisp']

// Colours come from the page's CSS variables, so light and dark both work.
const lispHighlight = HighlightStyle.define([
  { tag: [t.comment, t.lineComment, t.blockComment], color: 'var(--tok-comment)', fontStyle: 'italic' },
  { tag: t.string, color: 'var(--tok-string)' },
  { tag: [t.number, t.bool, t.atom], color: 'var(--tok-number)' },
  { tag: [t.keyword, t.atom], color: 'var(--tok-keyword)' },
  { tag: [t.definitionKeyword, t.special(t.variableName)], color: 'var(--tok-def)' },
  { tag: t.bracket, color: 'var(--tok-bracket)' },
  { tag: t.meta, color: 'var(--tok-meta)' },
])

/** A line for Claude rather than Lisp: `pairens:` then a space or newline. */
export const MESSAGE_PREFIX = /^\s*pairens:(?=\s)/i

/** If TEXT is a message for Claude, its text without the prefix; else null. */
export function messageText(text) {
  return MESSAGE_PREFIX.test(text) ? text.replace(MESSAGE_PREFIX, '').trim() : null
}

/** True when TEXT is complete: balanced brackets outside strings, comments and characters. */
export function isComplete(text, language = 'common-lisp') {
  return language === 'clojure' ? isCompleteClojure(text) : isCompleteLisp(text)
}

/** Clojure: (), [] and {} outside strings, #"regexes", ; comments and \chars. */
function isCompleteClojure(text) {
  let depth = 0
  let i = 0
  while (i < text.length) {
    const c = text[i]
    if (c === ';') {
      while (i < text.length && text[i] !== '\n') i++
    } else if (c === '\\') {
      i++ // the character itself, whatever it is
    } else if (c === '"') {
      i++
      while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1
      if (i >= text.length) return false
    } else if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']' || c === '}') depth--
    i++
  }
  return depth <= 0
}

/** Common Lisp: balanced parens outside strings, comments, |symbols| and #\chars. */
function isCompleteLisp(text) {
  let depth = 0
  let i = 0
  while (i < text.length) {
    const c = text[i]
    if (c === ';') {
      while (i < text.length && text[i] !== '\n') i++
    } else if (c === '#' && text[i + 1] === '|') {
      const end = text.indexOf('|#', i + 2)
      if (end < 0) return false
      i = end + 1
    } else if (c === '#' && text[i + 1] === '\\') {
      i += 2 // the character itself, whatever it is
    } else if (c === '"') {
      i++
      while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1
      if (i >= text.length) return false
    } else if (c === '|') {
      const end = text.indexOf('|', i + 1)
      if (end < 0) return false
      i = end
    } else if (c === '(') depth++
    else if (c === ')') depth--
    i++
  }
  return depth <= 0
}

/**
 * Creates the REPL editor in PARENT.
 *   onSubmit(text)   called on Enter when the input is a complete form
 *   history()        returns past inputs, oldest first, for Up/Down
 *   placeholderText  dim text in the empty editor
 *   language         'common-lisp' (default) or 'clojure'; setLanguage changes it
 */
export function createEditor({ parent, onSubmit, history: pastInputs = () => [], placeholderText = '', language = 'common-lisp' }) {
  let current = language
  const languageSlot = new Compartment()
  let walk = -1 // -1: editing the draft; otherwise an index into pastInputs()
  let draft = ''

  const setText = (view, text) =>
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, selection: { anchor: text.length } })

  const submit = view => {
    const text = view.state.doc.toString()
    if (!text.trim()) return true
    onSubmit(text)
    walk = -1
    draft = ''
    setText(view, '')
    return true
  }

  const replKeys = keymap.of([
    {
      key: 'Enter',
      run: view => {
        const text = view.state.doc.toString()
        // A message for Claude is sent whatever its parens; Lisp only when complete.
        return MESSAGE_PREFIX.test(text) || isComplete(text, current) ? submit(view) : insertNewlineAndIndent(view)
      },
    },
    { key: 'Shift-Enter', run: insertNewlineAndIndent },
    { key: 'Mod-Enter', run: submit },
    {
      key: 'ArrowUp',
      run: view => {
        const line = view.state.doc.lineAt(view.state.selection.main.head)
        if (line.number !== 1) return false
        const past = pastInputs()
        if (!past.length) return false
        if (walk === -1) {
          draft = view.state.doc.toString()
          walk = past.length - 1
        } else if (walk > 0) walk--
        else return true
        setText(view, past[walk])
        return true
      },
    },
    {
      key: 'ArrowDown',
      run: view => {
        const line = view.state.doc.lineAt(view.state.selection.main.head)
        if (line.number !== view.state.doc.lines || walk === -1) return false
        const past = pastInputs()
        if (walk < past.length - 1) {
          walk++
          setText(view, past[walk])
        } else {
          walk = -1
          setText(view, draft)
        }
        return true
      },
    },
  ])

  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: '',
      extensions: [
        replKeys,
        history(),
        drawSelection(),
        highlightActiveLine(),
        languageSlot.of(languageFor(current)),
        syntaxHighlighting(lispHighlight),
        bracketMatching(),
        closeBrackets(),
        indentOnInput(),
        placeholder(placeholderText),
        EditorView.lineWrapping,
        keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab]),
      ],
    }),
  })

  return {
    view,
    focus: () => view.focus(),
    getText: () => view.state.doc.toString(),
    setText: text => {
      setText(view, text)
      view.focus()
    },
    setLanguage: name => {
      if (name === current || !languages[name]) return
      current = name
      view.dispatch({ effects: languageSlot.reconfigure(languageFor(name)) })
    },
  }
}

/** Fills ELEMENT with TEXT highlighted as LANGUAGE (tok-* classes). */
export function highlightLisp(text, element, language = 'common-lisp') {
  element.textContent = ''
  const tree = languageFor(language).parser.parse(text)
  let at = 0
  const add = (to, cls) => {
    if (to <= at) return
    const piece = text.slice(at, to)
    if (cls) {
      const span = document.createElement('span')
      span.className = cls
      span.textContent = piece
      element.appendChild(span)
    } else element.appendChild(document.createTextNode(piece))
    at = to
  }
  highlightTree(tree, classHighlighter, (from, to, cls) => {
    add(from, '')
    add(to, cls)
  })
  add(text.length, '')
}

const escapeHtml = s =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// Markdown for Claude's replies. Raw HTML in the text is shown as text, and
// only http(s)/mailto links are made clickable.
const markdown = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    html: token => escapeHtml(token.text ?? token.raw ?? ''),
    link: function (token) {
      const href = token.href ?? ''
      const text = this.parser.parseInline(token.tokens ?? [])
      return /^(https?:|mailto:)/i.test(href)
        ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${text}</a>`
        : text
    },
    image: token => escapeHtml(token.text ?? ''),
  },
})

export function renderMarkdown(text) {
  return markdown.parse(text ?? '')
}
