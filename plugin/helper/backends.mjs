// The two kinds of image pAIrens talks to, behind one interface:
//
//   SwankBackend  Common Lisp over Swank (lisp/pairens.lisp loaded into the image)
//   NreplBackend  Clojure over nREPL (clojure/pairens.clj evaluated into the process)
//
// Both are EventEmitters ('output', 'log', 'close', and for Swank 'debug' and
// 'debug-return') with:
//
//   connect(host, port)       → { impl }
//   evaluate(session, code)   → { status: 'ok', output, values, package }
//                              | { status: 'error', error, output, package }
//   classify(session, code)   → true when the code only inspects
//   complete(session, prefix) → [{ text, kind, args }] PREFIX could complete to
//   describe(session, token)  → { name, kind, args, doc } for what TOKEN names, or null
//   deliver(id, answer)       → true when the reply printed in an editor REPL
//   takeOutbox()              → (pairens claude) calls, waiting up to ~20 s
//   sessions()                → [{ name, package }]
//   close()
//
// `package` is the session's package (Common Lisp) or namespace (Clojure).
//
// NreplBackend also handles ClojureScript through a shadow-cljs server: a
// session switched with (shadow.cljs.devtools.api/repl :build) evaluates in
// that build's JS runtime until :cljs/quit. It emits 'cljs' with the
// { session: build } map whenever that changes, and has shadow() and
// watch(build).

import fs from 'node:fs'
import { EventEmitter } from 'node:events'

import { SwankClient } from './swank.mjs'
import { NreplClient } from './nrepl.mjs'
import { str } from './sexp.mjs'

/** [[text, kind, args], ...] from either side → [{ text, kind, args }]; anything else → []. */
const asCompletions = r =>
  Array.isArray(r)
    ? r
        .filter(x => Array.isArray(x) && typeof x[0] === 'string')
        .map(([text, kind, args]) => ({ text, kind: String(kind ?? ''), args: String(args ?? '') }))
    : []

/** [name, kind, args, doc] from either side → { name, kind, args, doc }; anything else → null. */
const asDescription = r =>
  Array.isArray(r) && typeof r[0] === 'string'
    ? { name: r[0], kind: String(r[1] ?? ''), args: String(r[2] ?? ''), doc: String(r[3] ?? '') }
    : null

const forward = (from, to, events) => events.forEach(name => from.on(name, (...a) => to.emit(name, ...a)))

// ---------------------------------------------------------------------------
// Common Lisp over Swank

export class SwankBackend extends EventEmitter {
  constructor({ lispFile }) {
    super()
    this.protocol = 'swank'
    this.language = 'Common Lisp'
    this.lispFile = lispFile
    this.client = new SwankClient()
    forward(this.client, this, ['output', 'log', 'debug', 'debug-return', 'close'])
  }

  get connected() {
    return this.client.connected
  }

  async connect(host, port, timeoutMs) {
    await this.client.connect(host, port, timeoutMs)
    const loaded = await this.client.rex(
      `(cl:progn (cl:load ${str(this.lispFile)}) (cl:list (cl:lisp-implementation-type) (cl:lisp-implementation-version)))`,
    )
    return { impl: Array.isArray(loaded) ? loaded.join(' ') : 'Common Lisp' }
  }

  async evaluate(session, code) {
    const r = await this.client.rex(`(pairens::rex-eval ${str(session)} ${str(code)})`, { pkg: 'PAIRENS' })
    if (String(r[0]) === ':OK') {
      const [, output, values, pkg] = r
      return { status: 'ok', output, values, package: pkg }
    }
    const [, message, output, pkg] = r
    return { status: 'error', error: message, output, package: pkg }
  }

  async classify(session, code) {
    const r = await this.client.rex(`(pairens::read-only-code-p ${str(session)} ${str(code)})`, { pkg: 'PAIRENS' })
    return !(Array.isArray(r) && r.length === 0)
  }

  async complete(session, prefix) {
    const r = await this.client.rex(`(pairens::completions ${str(session)} ${str(prefix)})`, { pkg: 'PAIRENS' })
    return asCompletions(r)
  }

  async describe(session, token) {
    const r = await this.client.rex(`(pairens::describe-symbol ${str(session)} ${str(token)})`, { pkg: 'PAIRENS' })
    return asDescription(r)
  }

  async deliver(id, answer) {
    const r = await this.client.rex(`(pairens::deliver ${str(id)} ${str(answer)})`, { pkg: 'PAIRENS' })
    return !(Array.isArray(r) && r.length === 0)
  }

  async takeOutbox() {
    const requests = await this.client.rex('(pairens::take-outbox 20)', { pkg: 'PAIRENS' })
    return (requests ?? []).map(([id, prompt, value, pkg, session]) => ({ id, prompt, value, package: pkg, session }))
  }

  async sessions() {
    const r = await this.client.rex('(pairens::session-info)', { pkg: 'PAIRENS' })
    return (r ?? []).map(([name, pkg]) => ({ name, package: pkg }))
  }

  restart(thread, level, index) {
    this.client.invokeRestart(thread, level, index)
  }

  close() {
    this.client.close()
  }
}

// ---------------------------------------------------------------------------
// Clojure over nREPL

/** A Clojure string literal (JSON's escapes are a subset of Clojure's). */
const clj = s => JSON.stringify(String(s))

/**
 * A shadow-cljs compiler warning block in an eval's *err* text:
 *   ------ WARNING - :undeclared-var ------
 *    Resource: <eval>:1:2
 *    Use of undeclared Var cljs.user/x
 *   ---------------------------------------
 * Captures the warning type and its message.
 */
const WARNING_BLOCK = /-{3,} WARNING - (:[\w-]+) -+\n(?: Resource: .*\n)?([\s\S]*?)\n-{10,}\n*/g

/** Where Clojure's error report starts in an eval's *err* text. */
const ERROR_START = /(?:^|\n)((?:Execution|Syntax|Unexpected) error[\s\S]*)$/

export class NreplBackend extends EventEmitter {
  constructor({ cljFile }) {
    super()
    this.protocol = 'nrepl'
    this.language = 'Clojure'
    this.cljFile = cljFile
    this.client = new NreplClient()
    /** pAIrens session name → Promise of its nREPL session id */
    this.ids = new Map()
    /** pAIrens session name → its namespace after the last eval */
    this.namespaces = new Map()
    /** pAIrens session name → the shadow-cljs build it evaluates ClojureScript in */
    this.cljs = new Map()
    forward(this.client, this, ['output', 'log', 'close'])
  }

  get connected() {
    return this.client.connected
  }

  async connect(host, port, timeoutMs) {
    const described = await this.client.connect(host, port, timeoutMs)
    const v = described.versions ?? {}
    const clojure = v.clojure?.['version-string']
    // The pairens namespace, evaluated from source so it works on a remote
    // process too. Its own session keeps it from touching the person's.
    const internal = await this.sessionId('pairens internal')
    const r = await this.client.eval(internal, fs.readFileSync(this.cljFile, 'utf8'))
    if (r.ex) throw new Error(`could not load pairens.clj: ${r.err.trim() || r.ex}`)
    return { impl: clojure ? `Clojure ${clojure}` : 'Clojure' }
  }

  sessionId(name) {
    let id = this.ids.get(name)
    if (!id) {
      id = this.client.clone()
      // The person's and Claude's sessions start like a Clojure REPL (doc,
      // source, ... in user); pAIrens's own sessions don't need it.
      if (!name.startsWith('pairens '))
        id = id.then(async session => {
          await this.client.eval(session, '(pairens/start-session)')
          return session
        })
      this.ids.set(name, id)
      id.catch(() => this.ids.delete(name))
    }
    return id
  }

  /** Runs one of pairens.clj's entry points (it prints JSON) in SESSION. */
  async call(session, code) {
    const r = await this.client.eval(await this.sessionId(session), code)
    if (r.ex) throw new Error(r.err.trim() || r.ex)
    return JSON.parse(r.out)
  }

  async evaluate(session, code) {
    const r = await this.client.eval(await this.sessionId(session), code, { 'pairens-session': session })
    if (r.ns) this.namespaces.set(session, r.ns)
    const pkg = this.namespaces.get(session) ?? 'user'
    const wasCljs = this.cljs.has(session)
    this.trackCljs(session, r.values)
    if (wasCljs) {
      // shadow-cljs reports ClojureScript errors without an exception class:
      // a :repl/exception! value, a reader error with no value, or no runtime.
      const failed =
        r.values.includes(':repl/exception!') ||
        (!r.values.length && r.err.trim()) ||
        /No available JS runtime/.test(r.err)
      if (failed) {
        const noRuntime = /No available JS runtime/.test(r.err)
        return {
          status: 'error',
          error: noRuntime
            ? `No JS runtime is connected to build :${this.cljs.get(session)}. Start the app (open its page, or run it with node) so it connects, then try again.`
            : r.err.trim() || 'ClojureScript error',
          output: r.out,
          package: pkg,
        }
      }
      // A form with a compiler warning isn't run at all; its "nil" is not a
      // result. Show the warnings, one line each, as the error.
      const warnings = [...r.err.matchAll(WARNING_BLOCK)].map(m => `${m[2].trim()} (${m[1]})`)
      if (warnings.length)
        return {
          status: 'error',
          error: `Not run: ${[...new Set(warnings)].join('; ')}`,
          output: r.out + r.err.replace(WARNING_BLOCK, '').trim(),
          package: pkg,
        }
      if (!r.ex) return { status: 'ok', output: r.out + r.err, values: r.values.filter(v => v !== ':repl/exception!'), package: pkg }
    }
    if (!r.ex) return { status: 'ok', output: r.out + r.err, values: r.values, package: pkg }
    // nREPL prints the error report to *err*, after anything the code printed there.
    const m = ERROR_START.exec(r.err)
    const report = (m ? m[1] : r.err).trim()
    const before = m ? r.err.slice(0, r.err.length - m[1].length) : ''
    return {
      status: 'error',
      error: report || r.ex,
      output: r.out + before,
      package: pkg,
      values: r.values.length ? r.values : undefined,
    }
  }

  classify(session, code) {
    if (this.cljs.has(session)) return this.call('pairens internal', `(pairens/read-only-cljs-code? ${clj(code)})`)
    return this.call('pairens internal', `(pairens/read-only-code? ${clj(code)} ${clj(this.namespaces.get(session) ?? 'user')})`)
  }

  async complete(session, prefix) {
    // ClojureScript sessions complete nothing yet: their names live in the build, not this JVM.
    if (this.cljs.has(session)) return []
    const r = await this.call('pairens internal', `(pairens/completions ${clj(prefix)} ${clj(this.namespaces.get(session) ?? 'user')})`)
    return asCompletions(r)
  }

  async describe(session, token) {
    if (this.cljs.has(session)) return null
    return asDescription(await this.call('pairens internal', `(pairens/describe ${clj(token)} ${clj(this.namespaces.get(session) ?? 'user')})`))
  }

  /** Notes a session entering ClojureScript ([:selected :app]) or leaving it (:cljs/quit). */
  trackCljs(session, values) {
    let changed = false
    for (const v of values) {
      const selected = /^\[:selected :([^\s\]]+)\]$/.exec(v)
      if (selected && this.cljs.get(session) !== selected[1]) {
        this.cljs.set(session, selected[1])
        changed = true
      }
      if (v === ':cljs/quit' && this.cljs.delete(session)) changed = true
    }
    if (changed) this.emit('cljs', Object.fromEntries(this.cljs))
  }

  /** { shadow, builds, watching, runtimes } when the process is a shadow-cljs server. */
  shadow() {
    return this.call('pairens internal', '(pairens/shadow-info)')
  }

  /** Starts watching BUILD (compiling it) unless it already is. */
  watch(build) {
    return this.call('pairens internal', `(pairens/shadow-watch ${clj(build)})`)
  }

  deliver(id, answer) {
    return this.call('pairens internal', `(pairens/deliver ${clj(id)} ${clj(answer)})`)
  }

  async takeOutbox() {
    const requests = await this.call('pairens poll', '(pairens/take-outbox 20)')
    return requests.map(([id, prompt, value, pkg, session]) => ({ id, prompt, value, package: pkg, session }))
  }

  async sessions() {
    const names = [...this.ids.keys()].filter(n => !n.startsWith('pairens '))
    return names.map(name => ({ name, package: this.namespaces.get(name) ?? 'user', ...(this.cljs.has(name) ? { cljs: this.cljs.get(name) } : {}) }))
  }

  restart() {
    throw new Error('Clojure has no debugger restarts')
  }

  close() {
    // Close our nREPL sessions so they don't linger in the server, then hang up.
    const ids = [...this.ids.values()]
    Promise.allSettled(ids.map(p => p.then(session => this.client.request({ op: 'close', session }))))
    setTimeout(() => this.client.close(), 200).unref?.()
    if (!ids.length) this.client.close()
  }
}
