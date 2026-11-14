// A small reader and writer for the s-expressions Swank speaks.
//
// Read values: strings are JS strings, numbers are numbers, lists are arrays,
// and symbols are { sym: 'NAME' } with the name upcased (keywords keep their
// leading colon: { sym: ':RETURN' }). `nil` reads as an empty array.

export class Sym {
  constructor(name) {
    this.sym = name
  }
  toString() {
    return this.sym
  }
}

export const isSym = (x, name) =>
  x instanceof Sym && (name === undefined || x.sym === name.toUpperCase())

const DELIMITERS = new Set(['(', ')', '"', "'", ';', ' ', '\t', '\n', '\r', '\f'])

export function read(text) {
  let i = 0

  const skip = () => {
    for (;;) {
      const c = text[i]
      if (c === ';') {
        while (i < text.length && text[i] !== '\n') i++
      } else if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f') {
        i++
      } else {
        return
      }
    }
  }

  const readString = () => {
    i++ // opening quote
    let out = ''
    while (i < text.length) {
      const c = text[i++]
      if (c === '\\') out += text[i++]
      else if (c === '"') return out
      else out += c
    }
    throw new Error('unterminated string')
  }

  const readAtom = () => {
    let raw = ''
    let hadBars = false
    while (i < text.length && !DELIMITERS.has(text[i])) {
      const c = text[i]
      if (c === '|') {
        hadBars = true
        i++
        while (i < text.length && text[i] !== '|') raw += text[i++]
        i++
      } else if (c === '\\') {
        raw += text[i + 1]
        i += 2
      } else {
        raw += c
        i++
      }
    }
    if (!hadBars && /^[+-]?\d+$/.test(raw)) return Number(raw)
    if (!hadBars && /^[+-]?(\d+\.\d*|\.\d+|\d+)([eEdDfFsSlL][+-]?\d+)?$/.test(raw))
      return Number(raw.replace(/[dDfFsSlL]/, 'e'))
    const name = hadBars ? raw : raw.toUpperCase()
    if (name === 'NIL') return []
    return new Sym(name)
  }

  const readForm = () => {
    skip()
    if (i >= text.length) throw new Error('unexpected end of input')
    const c = text[i]
    if (c === '(') {
      i++
      const list = []
      for (;;) {
        skip()
        if (text[i] === ')') {
          i++
          return list
        }
        if (text[i] === '.' && DELIMITERS.has(text[i + 1] ?? ' ')) {
          // dotted pair: keep the tail as the last element
          i++
          list.push(readForm())
          skip()
          if (text[i] === ')') i++
          return list
        }
        list.push(readForm())
      }
    }
    if (c === ')') throw new Error('unexpected )')
    if (c === '"') return readString()
    if (c === "'") {
      i++
      return [new Sym('QUOTE'), readForm()]
    }
    if (c === '#' && text[i + 1] === '\\') {
      i += 2
      let raw = text[i++]
      while (i < text.length && !DELIMITERS.has(text[i])) raw += text[i++]
      return raw.length === 1 ? raw : raw
    }
    return readAtom()
  }

  return readForm()
}

/** A Lisp string literal for `s`. */
export const str = s => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

/** Writes a JS value back as an s-expression (strings quoted, Sym bare). */
export function write(x) {
  if (x instanceof Sym) return x.sym
  if (typeof x === 'string') return str(x)
  if (typeof x === 'number') return String(x)
  if (x === true) return 't'
  if (x === false || x === null || x === undefined) return 'nil'
  if (Array.isArray(x)) return `(${x.map(write).join(' ')})`
  throw new Error(`cannot write ${typeof x}`)
}
