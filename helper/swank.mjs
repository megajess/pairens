// A minimal Swank client: framing, :emacs-rex calls, and the messages a
// client must answer (:ping, :debug, :read-string).
//
// Wire format: a 6-digit hex length (in UTF-8 bytes), then the s-expression.

import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'

import { read, write, isSym, Sym, str } from './sexp.mjs'

export class SwankClient extends EventEmitter {
  constructor() {
    super()
    this.socket = null
    this.buffer = Buffer.alloc(0)
    this.nextId = 1
    this.pending = new Map()
    this.connected = false
  }

  connect(host, port, timeoutMs = 3000) {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host, port })
      const timer = setTimeout(() => {
        socket.destroy()
        reject(new Error(`timed out connecting to ${host}:${port}`))
      }, timeoutMs)
      socket.once('error', err => {
        clearTimeout(timer)
        reject(err)
      })
      socket.once('connect', () => {
        clearTimeout(timer)
        this.socket = socket
        this.connected = true
        socket.on('data', chunk => this.onData(chunk))
        socket.on('error', err => this.emit('log', `swank socket error: ${err.message}`))
        socket.on('close', () => this.onClose())
        const secret = readSecret()
        if (secret) this.sendRaw(secret)
        resolve()
      })
    })
  }

  close() {
    this.socket?.destroy()
  }

  onClose() {
    if (!this.connected) return
    this.connected = false
    for (const { reject } of this.pending.values()) reject(new Error('Swank connection closed'))
    this.pending.clear()
    this.emit('close')
  }

  sendRaw(text) {
    const body = Buffer.from(text, 'utf8')
    const header = body.length.toString(16).padStart(6, '0')
    this.socket.write(Buffer.concat([Buffer.from(header, 'ascii'), body]))
  }

  send(form) {
    this.sendRaw(typeof form === 'string' ? form : write(form))
  }

  /**
   * Evaluates `formText` (Lisp source of one form) in the image and resolves
   * with the value Swank returns, read into JS. Rejects on :abort.
   */
  rex(formText, { pkg = 'COMMON-LISP-USER', thread = 't' } = {}) {
    if (!this.connected) return Promise.reject(new Error('not connected to Swank'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.sendRaw(`(:emacs-rex ${formText} ${str(pkg)} ${thread} ${id})`)
    })
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk])
    while (this.buffer.length >= 6) {
      const length = parseInt(this.buffer.subarray(0, 6).toString('ascii'), 16)
      if (Number.isNaN(length)) {
        this.emit('log', 'swank: bad frame header; dropping buffer')
        this.buffer = Buffer.alloc(0)
        return
      }
      if (this.buffer.length < 6 + length) return
      const body = this.buffer.subarray(6, 6 + length).toString('utf8')
      this.buffer = this.buffer.subarray(6 + length)
      let message
      try {
        message = read(body)
      } catch (err) {
        this.emit('log', `swank: unreadable message (${err.message}): ${body.slice(0, 200)}`)
        continue
      }
      this.onMessage(message)
    }
  }

  onMessage(m) {
    if (!Array.isArray(m) || !(m[0] instanceof Sym)) return
    switch (m[0].sym) {
      case ':RETURN': {
        const [, result, id] = m
        const waiter = this.pending.get(id)
        if (!waiter) return
        this.pending.delete(id)
        if (isSym(result[0], ':OK')) waiter.resolve(result[1])
        else waiter.reject(new Error(`aborted: ${typeof result[1] === 'string' ? result[1] : 'evaluation aborted'}`))
        return
      }
      case ':WRITE-STRING':
        this.emit('output', m[1])
        return
      case ':PING':
        this.send([new Sym(':emacs-pong'), m[1], m[2]])
        return
      case ':DEBUG': {
        // (:debug thread level condition restarts frames conts)
        const [, thread, level, condition, restarts] = m
        const text = Array.isArray(condition) ? condition.filter(x => typeof x === 'string').join(' ') : ''
        this.emit('debug', text)
        const abortAt = Array.isArray(restarts)
          ? restarts.findIndex(r => Array.isArray(r) && /ABORT/i.test(String(r[0])))
          : -1
        const id = this.nextId++
        if (abortAt >= 0) {
          this.sendRaw(`(:emacs-rex (swank:invoke-nth-restart-for-emacs ${level} ${abortAt}) nil ${thread} ${id})`)
        } else {
          this.sendRaw(`(:emacs-rex (swank:throw-to-toplevel) nil ${thread} ${id})`)
        }
        return
      }
      case ':READ-STRING':
        // (:read-string thread tag): nothing to type here; answer end of line.
        this.emit('log', 'Lisp asked for input; pAIrens answered an empty line')
        this.send([new Sym(':emacs-return-string'), m[1], m[2], '\n'])
        return
      case ':INVALID-RPC':
      case ':READER-ERROR': {
        const id = m[1]
        const waiter = this.pending.get(id)
        if (waiter) {
          this.pending.delete(id)
          waiter.reject(new Error(String(m[2] ?? 'invalid request')))
        }
        return
      }
      default:
        // :new-features, :indentation-update, :debug-activate, :debug-return, ...
        return
    }
  }
}

function readSecret() {
  try {
    return fs.readFileSync(path.join(os.homedir(), '.slime-secret'), 'utf8').split('\n')[0]
  } catch {
    return undefined
  }
}
