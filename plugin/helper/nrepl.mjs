// A minimal nREPL client: bencode framing, sessions, and evaluation.
//
// nREPL messages are bencoded dictionaries. Every request carries an "id";
// the server answers with one or more messages carrying the same id, the last
// of which has "done" in its "status" list.

import net from 'node:net'
import { EventEmitter } from 'node:events'

// ---------------------------------------------------------------------------
// Bencode

/** Encodes strings, integers, arrays and plain objects (keys sorted). */
export function encode(value) {
  const parts = []
  const walk = v => {
    if (typeof v === 'string') {
      const b = Buffer.from(v, 'utf8')
      parts.push(Buffer.from(`${b.length}:`, 'ascii'), b)
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      parts.push(Buffer.from(`i${Math.trunc(Number(v))}e`, 'ascii'))
    } else if (Array.isArray(v)) {
      parts.push(Buffer.from('l'))
      v.forEach(walk)
      parts.push(Buffer.from('e'))
    } else if (v && typeof v === 'object') {
      parts.push(Buffer.from('d'))
      for (const k of Object.keys(v).sort()) {
        if (v[k] === undefined) continue
        walk(k)
        walk(v[k])
      }
      parts.push(Buffer.from('e'))
    } else {
      throw new Error(`bencode: cannot encode ${typeof v}`)
    }
  }
  walk(value)
  return Buffer.concat(parts)
}

/**
 * Decodes one value from BUF at OFFSET. Returns { value, end }, or null when
 * the buffer doesn't hold a whole value yet. Byte strings decode as UTF-8.
 */
export function decode(buf, offset = 0) {
  const at = i => {
    if (i >= buf.length) throw INCOMPLETE
    return buf[i]
  }
  const walk = i => {
    const c = at(i)
    if (c === 0x69 /* i */) {
      const end = buf.indexOf(0x65 /* e */, i + 1)
      if (end < 0) throw INCOMPLETE
      return { value: Number(buf.subarray(i + 1, end).toString('ascii')), end: end + 1 }
    }
    if (c === 0x6c /* l */) {
      const list = []
      let j = i + 1
      while (at(j) !== 0x65) {
        const r = walk(j)
        list.push(r.value)
        j = r.end
      }
      return { value: list, end: j + 1 }
    }
    if (c === 0x64 /* d */) {
      const dict = {}
      let j = i + 1
      while (at(j) !== 0x65) {
        const k = walk(j)
        const v = walk(k.end)
        dict[k.value] = v.value
        j = v.end
      }
      return { value: dict, end: j + 1 }
    }
    if (c >= 0x30 && c <= 0x39) {
      const colon = buf.indexOf(0x3a /* : */, i)
      if (colon < 0) throw INCOMPLETE
      const length = Number(buf.subarray(i, colon).toString('ascii'))
      if (!Number.isInteger(length)) throw new Error('bencode: bad string length')
      const start = colon + 1
      if (start + length > buf.length) throw INCOMPLETE
      return { value: buf.subarray(start, start + length).toString('utf8'), end: start + length }
    }
    throw new Error(`bencode: unexpected byte ${c} at ${i}`)
  }
  try {
    return walk(offset)
  } catch (err) {
    if (err === INCOMPLETE) return null
    throw err
  }
}

const INCOMPLETE = Symbol('incomplete')

// ---------------------------------------------------------------------------
// The client

export class NreplClient extends EventEmitter {
  constructor() {
    super()
    this.socket = null
    this.buffer = Buffer.alloc(0)
    this.nextId = 1
    /** id → { onMessage(msg), reject(err) } */
    this.pending = new Map()
    this.connected = false
  }

  /** Connects and asks the server to describe itself (which proves it's nREPL). */
  connect(host, port, timeoutMs = 3000) {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host, port })
      const fail = err => {
        clearTimeout(timer)
        socket.destroy()
        reject(err)
      }
      const timer = setTimeout(() => fail(new Error(`no nREPL answer from ${host}:${port}`)), timeoutMs)
      socket.once('error', fail)
      socket.once('close', () => fail(new Error(`${host}:${port} closed the connection`)))
      socket.once('connect', () => {
        this.socket = socket
        this.connected = true
        // A web server answers our bencode with an HTTP error; say so plainly.
        socket.once('data', chunk => {
          if (chunk.subarray(0, 5).toString('latin1') === 'HTTP/')
            fail(new Error(`${host}:${port} is a web server, not a REPL server`))
        })
        socket.on('data', chunk => this.onData(chunk))
        this.request({ op: 'describe' })
          .then(msgs => {
            clearTimeout(timer)
            socket.removeAllListeners('error')
            socket.removeAllListeners('close')
            socket.on('error', err => this.emit('log', `nREPL socket error: ${err.message}`))
            socket.on('close', () => this.onClose())
            resolve(Object.assign({}, ...msgs))
          })
          .catch(fail)
      })
    })
  }

  close() {
    this.socket?.destroy()
  }

  onClose() {
    if (!this.connected) return
    this.connected = false
    for (const { reject } of this.pending.values()) reject(new Error('nREPL connection closed'))
    this.pending.clear()
    this.emit('close')
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk])
    let offset = 0
    for (;;) {
      let r
      try {
        r = decode(this.buffer, offset)
      } catch (err) {
        this.emit('log', `nREPL: unreadable message (${err.message}); dropping buffer`)
        this.buffer = Buffer.alloc(0)
        return
      }
      if (!r) break
      offset = r.end
      this.onMessage(r.value)
    }
    this.buffer = this.buffer.subarray(offset)
  }

  onMessage(msg) {
    const waiter = msg && this.pending.get(msg.id)
    if (!waiter) {
      // Output from evaluations nobody is waiting for (another thread, or a
      // request whose answer already finished).
      if (typeof msg?.out === 'string') this.emit('output', msg.out)
      if (typeof msg?.err === 'string') this.emit('output', msg.err)
      return
    }
    waiter.onMessage(msg)
    if (Array.isArray(msg.status) && msg.status.includes('done')) this.pending.delete(msg.id)
  }

  /**
   * Sends MSG (an id is added) and calls onMessage for each answer. Resolves
   * with every answer once one says "done".
   */
  request(msg, onMessage = () => {}) {
    if (!this.connected) return Promise.reject(new Error('not connected to nREPL'))
    const id = String(this.nextId++)
    return new Promise((resolve, reject) => {
      const all = []
      this.pending.set(id, {
        reject,
        onMessage: m => {
          all.push(m)
          try {
            onMessage(m)
          } catch {}
          if (Array.isArray(m.status) && m.status.includes('done')) resolve(all)
        },
      })
      this.socket.write(encode({ ...msg, id }))
    })
  }

  /** A new nREPL session; resolves with its id. */
  async clone(session) {
    const msgs = await this.request({ op: 'clone', ...(session ? { session } : {}) })
    const id = msgs.find(m => m['new-session'])?.['new-session']
    if (!id) throw new Error('nREPL did not create a session')
    return id
  }

  /**
   * Evaluates CODE in SESSION. Resolves with { values, out, err, ns, ex }:
   * the printed value of each top-level form, everything printed, the
   * session's namespace afterwards, and the exception class if one was thrown.
   * EXTRA keys go along in the request (the Clojure side can read them).
   */
  async eval(session, code, extra = {}) {
    const result = { values: [], out: '', err: '', ns: null, ex: null }
    await this.request({ op: 'eval', session, code, ...extra }, m => {
      if (typeof m.value === 'string') result.values.push(m.value)
      if (typeof m.out === 'string') result.out += m.out
      if (typeof m.err === 'string') result.err += m.err
      if (typeof m.ns === 'string') result.ns = m.ns
      if (typeof m.ex === 'string') result.ex = m.ex
      if (Array.isArray(m.status) && m.status.includes('eval-error') && !result.ex) result.ex = 'error'
    })
    return result
  }

  /** Evaluates CODE in SESSION and resolves with the last value read as EDN-ish JSON. */
  async value(session, code) {
    const r = await this.eval(session, code)
    if (r.ex) throw new Error(r.err.trim() || r.ex)
    return r.values[r.values.length - 1]
  }

  interrupt(session) {
    return this.request({ op: 'interrupt', session })
  }
}
