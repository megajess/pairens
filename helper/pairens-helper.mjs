#!/usr/bin/env node
// pAIrens helper: holds the Swank connection and the shared REPL history, and
// serves the pAIrens API.
//
//   node pairens-helper.mjs --socket /tmp/pairens-x.sock --cwd <project>
//        [--lisp <pairens.lisp>] [--job-start N] [--http-port 4747]
//
// Two listeners:
//   * a Unix socket (--socket) for the mod: every route, no key.
//   * HTTP on 127.0.0.1 (default port 4747, the next free one up to 4756) for
//     the browser page and other local clients: the page's files and the v1
//     API under /api/v1, which needs the key from ~/.pairens/endpoint.json.
//
// Events to the mod, one JSON object per stdout line:
//   { type: 'ready', socket, url }       url: the browser page, key included
//   { type: 'status', status }
//   { type: 'entry', entry }             an eval started or finished, or output
//   { type: 'claude-request', request }  (pairens:claude ...) was called
//   { type: 'set-mode', mode }           a client asked for another mode
//   { type: 'clear', session }           a client cleared a session's history
//   { type: 'debug', debug }             a Lisp thread is waiting in the debugger
//   { type: 'debug-done', id }           ... and has left it
//   { type: 'log', text }
//
// The same changes reach browser clients as server-sent events (GET
// /api/v1/events): hello (a full snapshot), entry, reset, status, mode,
// debug, debug-done.

import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'

import { SwankClient } from './swank.mjs'
import { str } from './sexp.mjs'

const API_VERSION = 1

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, a, i, all) => {
    if (a.startsWith('--')) pairs.push([a.slice(2), all[i + 1]])
    return pairs
  }, []),
)
const HERE = path.dirname(new URL(import.meta.url).pathname)
const SOCKET = args.socket
const CWD = args.cwd ?? process.cwd()
const LISP_FILE = args.lisp ?? path.join(HERE, '..', 'lisp', 'pairens.lisp')
const BROWSER_DIR = path.join(HERE, '..', 'browser')
const PORT_FILE = path.join(CWD, '.swank-port')
const HOME_DIR = path.join(os.homedir(), '.pairens')
const LOG_DIR = path.join(HOME_DIR, 'logs')
const ENDPOINT_FILE = path.join(HOME_DIR, 'endpoint.json')
const HTTP_PORT = Number(args['http-port']) || 4747
const MAX_ENTRIES = 400

process.env.PATH = ['/opt/homebrew/bin', '/usr/local/bin', process.env.PATH].filter(Boolean).join(':')

const emit = event => process.stdout.write(JSON.stringify(event) + '\n')
const log = text => emit({ type: 'log', text })
const sleep = ms => new Promise(r => setTimeout(r, ms))

// ---------------------------------------------------------------------------
// Browser clients (server-sent events)

const clients = new Set()

function broadcast(event, data) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  for (const res of clients) res.write(frame)
}

// ---------------------------------------------------------------------------
// Shared state: history, mode, debuggers

/** The history, in the mod's entry shape (types/index.d.ts PairensEntry). */
let entries = []
let mode = 'ask'
/** Threads waiting in the debugger, by id `d<thread>-<level>`. */
const debugs = new Map()

function upsertEntry(entry, { toMod = true } = {}) {
  const at = entries.findIndex(x => x.id === entry.id && x.at === entry.at)
  if (at < 0) entries = [...entries, entry].slice(-MAX_ENTRIES)
  else entries = entries.map((x, i) => (i === at ? entry : x))
  if (toMod) emit({ type: 'entry', entry })
  broadcast('entry', entry)
}

function clearSession(session, { toMod = true } = {}) {
  entries = entries.filter(x => x.session !== session)
  if (toMod) emit({ type: 'clear', session })
  broadcast('reset', { entries })
}

function snapshot() {
  return { version: API_VERSION, status, mode, entries, debugs: [...debugs.values()] }
}

// ---------------------------------------------------------------------------
// Connection state

let swank = null
let status = { connected: false, host: null, port: null, impl: null, launching: false, error: null }
let pollGeneration = 0

const setStatus = patch => {
  status = { ...status, ...patch }
  emit({ type: 'status', status })
  broadcast('status', status)
}

function dropDebugs() {
  for (const id of debugs.keys()) {
    emit({ type: 'debug-done', id })
    broadcast('debug-done', { id })
  }
  debugs.clear()
}

let outputSeq = 0

async function connect(host = '127.0.0.1', port = 4005) {
  if (swank) swank.close()
  dropDebugs()
  const client = new SwankClient()
  client.on('log', log)
  client.on('output', text => {
    // Coalesce consecutive output into one entry of the "user" session.
    const last = entries[entries.length - 1]
    if (last && last.kind === 'output' && last.session === 'user') upsertEntry({ ...last, text: last.text + text })
    else upsertEntry({ id: `out-${Date.now()}-${++outputSeq}`, session: 'user', origin: 'lisp', kind: 'output', text, at: Date.now() })
  })
  client.on('debug', d => {
    const debug = { id: `d${d.thread}-${d.level}`, ...d, at: Date.now() }
    debugs.set(debug.id, debug)
    emit({ type: 'debug', debug })
    broadcast('debug', debug)
  })
  client.on('debug-return', ({ thread, level }) => {
    const id = `d${thread}-${level}`
    if (!debugs.delete(id)) return
    emit({ type: 'debug-done', id })
    broadcast('debug-done', { id })
  })
  client.on('close', () => {
    if (swank !== client) return
    swank = null
    dropDebugs()
    setStatus({ connected: false, impl: null, error: 'connection closed' })
  })
  await client.connect(host, port)
  swank = client
  const loaded = await client.rex(`(cl:progn (cl:load ${str(LISP_FILE)}) (cl:list (cl:lisp-implementation-type) (cl:lisp-implementation-version)))`)
  const impl = Array.isArray(loaded) ? loaded.join(' ') : 'Common Lisp'
  setStatus({ connected: true, host, port, impl, error: null, disconnectedByUser: false })
  pollOutbox(client, ++pollGeneration)
  return status
}

/** Drops the Swank connection on purpose; the Lisp image keeps running. */
function disconnect() {
  const client = swank
  swank = null // the client's close handler sees it is no longer current
  pollGeneration++
  client?.close()
  dropDebugs()
  setStatus({ connected: false, host: null, port: null, impl: null, launching: false, error: null, disconnectedByUser: true })
  return status
}

/** Long-polls the image for (pairens:claude ...) calls while connected. */
async function pollOutbox(client, generation) {
  while (swank === client && generation === pollGeneration && client.connected) {
    try {
      const requests = await client.rex('(pairens::take-outbox 20)', { pkg: 'PAIRENS' })
      for (const r of requests ?? []) {
        const [id, prompt, value, pkg, session] = r
        emit({ type: 'claude-request', request: { id, prompt, value, package: pkg, session } })
      }
      if (!requests?.length) await sleep(250) // non-SBCL images return at once
    } catch (err) {
      if (!client.connected) return
      log(`outbox poll failed: ${err.message}`)
      await sleep(2000)
    }
  }
}

async function autoConnect() {
  // The mod passes what it was connected to before a reload (--prefer), or
  // --no-auto when the person had disconnected on purpose.
  if (args['no-auto'] !== undefined) {
    setStatus({ connected: false, error: null, disconnectedByUser: true })
    return
  }
  const prefer = /^(.*):(\d+)$/.exec(args.prefer ?? '')
  if (prefer) {
    try {
      await connect(prefer[1] || '127.0.0.1', Number(prefer[2]))
      log(`reconnected to Swank on ${args.prefer}`)
      return
    } catch {}
  }
  const candidates = []
  try {
    const port = Number(fs.readFileSync(PORT_FILE, 'utf8').trim())
    if (port) candidates.push(port)
  } catch {}
  if (!candidates.includes(4005)) candidates.push(4005)
  for (const port of candidates) {
    try {
      await connect('127.0.0.1', port)
      log(`connected to Swank on port ${port}`)
      return
    } catch {}
  }
  setStatus({ connected: false, error: null })
}

/** Starts SBCL with Swank on a free port, detached so it outlives the mod. */
async function launch() {
  if (status.connected) return status
  fs.mkdirSync(LOG_DIR, { recursive: true })
  try {
    fs.unlinkSync(PORT_FILE)
  } catch {}
  const logFile = path.join(LOG_DIR, `sbcl-${Date.now()}.log`)
  const boot = `(progn
    (unless (find-package "QUICKLISP")
      (let ((setup (or (probe-file (merge-pathnames ".quicklisp/setup.lisp" (user-homedir-pathname)))
                       (probe-file (merge-pathnames "quicklisp/setup.lisp" (user-homedir-pathname))))))
        (when setup (load setup))))
    (if (find-package "QUICKLISP")
        (funcall (intern "QUICKLOAD" "QL") :swank :silent t)
        (require :swank))
    (load ${str(LISP_FILE)})
    (let ((port (funcall (intern "CREATE-SERVER" "SWANK") :port 0 :dont-close t)))
      (with-open-file (o ${str(PORT_FILE)} :direction :output :if-exists :supersede)
        (format o "~D" port)))
    (loop (sleep 3600)))`
  // Started through a shell that backgrounds SBCL and exits at once, so SBCL
  // is re-parented away from this helper: when the mod reloads, the engine
  // stops the helper and its children, and SBCL (with your image) lives on.
  const pid = await new Promise((resolve, reject) => {
    const sh = spawn(
      '/bin/sh',
      ['-c', 'nohup sbcl --noinform --eval "$PAIRENS_BOOT" </dev/null >>"$PAIRENS_LOG" 2>&1 & echo $!'],
      { cwd: CWD, detached: true, env: { ...process.env, PAIRENS_BOOT: boot, PAIRENS_LOG: logFile }, stdio: ['ignore', 'pipe', 'ignore'] },
    )
    let text = ''
    sh.stdout.on('data', d => (text += d))
    sh.on('error', reject)
    sh.on('close', () => resolve(Number(text.trim())))
  })
  const isAlive = () => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  setStatus({ launching: true, error: null })
  log(`launched SBCL (pid ${pid}); its log is ${logFile}`)
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    await sleep(300)
    let port
    try {
      port = Number(fs.readFileSync(PORT_FILE, 'utf8').trim())
    } catch {}
    if (port) {
      try {
        await connect('127.0.0.1', port)
        setStatus({ launching: false, pid })
        return status
      } catch (err) {
        log(`Swank not ready yet: ${err.message}`)
      }
    }
    if (!pid || !isAlive()) break
  }
  setStatus({ launching: false, error: `SBCL did not start Swank; see ${logFile}` })
  return status
}

// ---------------------------------------------------------------------------
// Evaluation jobs

const jobs = new Map()
// The mod passes the highest job number in its history, so ids stay unique
// across helper restarts (each mod reload starts a new helper).
let jobCounter = Number(args['job-start']) || 0

function startEval({ session = 'user', code, origin = 'user' }) {
  const id = `j${++jobCounter}`
  const entry = { id, session, origin, kind: 'eval', text: code, status: 'running', at: Date.now() }
  const job = { entry, done: null }
  jobs.set(id, job)
  upsertEntry({ ...entry })
  job.done = (async () => {
    try {
      if (!swank) throw new Error('not connected to a Lisp image')
      const r = await swank.rex(`(pairens::rex-eval ${str(session)} ${str(code)})`, { pkg: 'PAIRENS' })
      const [tag] = r
      if (String(tag) === ':OK') {
        const [, output, values, pkg] = r
        Object.assign(entry, { status: 'ok', output, values, package: pkg })
      } else {
        const [, message, output, pkg] = r
        Object.assign(entry, { status: 'error', error: message, output, package: pkg })
      }
    } catch (err) {
      Object.assign(entry, { status: 'error', error: err.message })
    }
    upsertEntry({ ...entry })
    return entry
  })()
  // keep the last 200 jobs
  if (jobs.size > 200) jobs.delete(jobs.keys().next().value)
  return job
}

async function waitFor(job, timeoutMs) {
  if (timeoutMs <= 0) return { ...job.entry }
  return Promise.race([job.done, sleep(timeoutMs).then(() => job.entry)]).then(e => ({ ...e }))
}

function restart({ id, index }) {
  const d = debugs.get(id)
  if (!d) throw new Error(`no debugger ${id} (it may have been resolved already)`)
  const n = Number(index)
  if (!Number.isInteger(n) || n < 0 || n >= d.restarts.length) throw new Error(`no restart ${index} in ${id}`)
  swank.invokeRestart(d.thread, d.level, n)
  return { ok: true, restart: d.restarts[n].name }
}

// ---------------------------------------------------------------------------
// Routes

const MODES = new Set(['ask', 'auto', 'read-only'])

/** The v1 API: the browser page and other local clients. */
const api = {
  'GET /api/v1/state': async () => snapshot(),
  'POST /api/v1/eval': async ({ session, code, timeoutMs = 0 }) => {
    if (typeof code !== 'string' || !code.trim()) throw new Error('no code to evaluate')
    return waitFor(startEval({ session: String(session || 'user'), code, origin: 'user' }), Number(timeoutMs))
  },
  'POST /api/v1/job': async ({ id, timeoutMs = 0 }) => {
    const job = jobs.get(id)
    if (!job) throw new Error(`no job ${id}`)
    return waitFor(job, Number(timeoutMs))
  },
  'POST /api/v1/mode': async ({ mode: wanted }) => {
    if (!MODES.has(wanted)) throw new Error('mode must be ask, auto or read-only')
    emit({ type: 'set-mode', mode: wanted }) // the mod owns the mode and confirms it
    return { mode: wanted }
  },
  'POST /api/v1/clear': async ({ session }) => {
    clearSession(String(session || 'user'))
    return { ok: true }
  },
  'POST /api/v1/connect': async ({ host, port }) => connect(host || '127.0.0.1', Number(port) || 4005),
  'POST /api/v1/launch': async () => launch(),
  'POST /api/v1/disconnect': async () => disconnect(),
  'POST /api/v1/restart': async body => restart(body),
  'POST /api/v1/sessions': async () => sessions(),
}

async function sessions() {
  if (!swank) return { sessions: [] }
  const r = await swank.rex('(pairens::session-info)', { pkg: 'PAIRENS' })
  return { sessions: (r ?? []).map(([name, pkg]) => ({ name, package: pkg })) }
}

/** The mod's own routes (Unix socket only). */
const internal = {
  'GET /status': async () => status,
  'POST /connect': async ({ host, port }) => connect(host || '127.0.0.1', Number(port) || 4005),
  'POST /launch': async () => launch(),
  'POST /disconnect': async () => disconnect(),
  'POST /eval': async ({ session, code, origin, timeoutMs = 0 }) => {
    if (typeof code !== 'string' || !code.trim()) throw new Error('no code to evaluate')
    return waitFor(startEval({ session, code, origin }), Number(timeoutMs))
  },
  'POST /job': async ({ id, timeoutMs = 0 }) => {
    const job = jobs.get(id)
    if (!job) throw new Error(`no job ${id}`)
    return waitFor(job, Number(timeoutMs))
  },
  'POST /classify': async ({ session = 'user', code }) => {
    if (!swank) return { readOnly: false, reason: 'not connected' }
    const r = await swank.rex(`(pairens::read-only-code-p ${str(session)} ${str(code)})`, { pkg: 'PAIRENS' })
    return { readOnly: !(Array.isArray(r) && r.length === 0) }
  },
  'POST /deliver': async ({ id, answer }) => {
    if (!swank) return { delivered: false }
    const r = await swank.rex(`(pairens::deliver ${str(id)} ${str(answer)})`, { pkg: 'PAIRENS' })
    return { delivered: !(Array.isArray(r) && r.length === 0) }
  },
  'POST /sessions': async () => sessions(),
  'POST /restart': async body => restart(body),
  // The mod's view of shared state, pushed to browser clients.
  'POST /sync': async ({ entries: all, mode: m }) => {
    if (Array.isArray(all)) entries = all.slice(-MAX_ENTRIES)
    if (MODES.has(m)) mode = m
    broadcast('reset', { entries })
    broadcast('mode', { mode })
    return { ok: true, debugs: [...debugs.values()] }
  },
  'POST /entry': async ({ entry }) => {
    if (entry && typeof entry.id === 'string') upsertEntry(entry, { toMod: false })
    return { ok: true }
  },
  'POST /mode': async ({ mode: m }) => {
    if (MODES.has(m)) mode = m
    broadcast('mode', { mode })
    return { mode }
  },
  'POST /clear': async ({ session }) => {
    clearSession(String(session || 'user'), { toMod: false })
    return { ok: true }
  },
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', c => {
      body += c
      if (body.length > 5_000_000) reject(new Error('request too large'))
    })
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {})
      } catch {
        reject(new Error('body is not JSON'))
      }
    })
    req.on('error', reject)
  })
}

async function answer(res, routes, key, req) {
  res.setHeader('content-type', 'application/json')
  res.setHeader('cache-control', 'no-store')
  const route = routes[key]
  if (!route) {
    res.statusCode = 404
    return res.end(JSON.stringify({ error: 'no such route' }))
  }
  try {
    const result = await route(await readBody(req))
    res.end(JSON.stringify(result))
  } catch (err) {
    res.statusCode = 500
    res.end(JSON.stringify({ error: err.message }))
  }
}

// ---------------------------------------------------------------------------
// The mod's listener (Unix socket)

const unixServer = http.createServer((req, res) =>
  answer(res, { ...internal, ...api }, `${req.method} ${new URL(req.url, 'http://x').pathname}`, req),
)

// ---------------------------------------------------------------------------
// The browser listener (127.0.0.1, key required for the API)

function loadKey() {
  try {
    const saved = JSON.parse(fs.readFileSync(ENDPOINT_FILE, 'utf8'))
    if (typeof saved.key === 'string' && saved.key.length >= 32) return saved.key
  } catch {}
  return crypto.randomBytes(24).toString('hex')
}
const KEY = loadKey()
const keyMatches = given => {
  if (typeof given !== 'string' || given.length !== KEY.length) return false
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(KEY))
}

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
  '/vendor/editor.js': ['vendor/editor.js', 'text/javascript; charset=utf-8'],
}

let httpPort = null

function browserHandler(req, res) {
  const url = new URL(req.url, 'http://x')
  // Only answer requests addressed to this machine by name (no DNS rebinding).
  const host = req.headers.host
  if (host !== `127.0.0.1:${httpPort}` && host !== `localhost:${httpPort}`) {
    res.statusCode = 421
    return res.end('wrong host')
  }
  res.setHeader('x-content-type-options', 'nosniff')
  res.setHeader('referrer-policy', 'no-referrer')

  const file = req.method === 'GET' && STATIC[url.pathname]
  if (file) {
    fs.readFile(path.join(BROWSER_DIR, file[0]), (err, data) => {
      if (err) {
        res.statusCode = 404
        return res.end('not found')
      }
      res.setHeader('content-type', file[1])
      res.setHeader('cache-control', 'no-store')
      res.setHeader(
        'content-security-policy',
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
      )
      res.end(data)
    })
    return
  }

  if (!url.pathname.startsWith('/api/v1/')) {
    res.statusCode = 404
    return res.end('not found')
  }
  const bearer = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
  if (!keyMatches(bearer) && !keyMatches(url.searchParams.get('key'))) {
    res.statusCode = 401
    res.setHeader('content-type', 'application/json')
    return res.end(JSON.stringify({ error: 'missing or wrong key; see ~/.pairens/endpoint.json' }))
  }
  // A browser page from another site may not drive the API.
  const origin = req.headers.origin
  if (origin && origin !== `http://127.0.0.1:${httpPort}` && origin !== `http://localhost:${httpPort}`) {
    res.statusCode = 403
    return res.end('wrong origin')
  }

  if (req.method === 'GET' && url.pathname === '/api/v1/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    })
    res.write(`event: hello\ndata: ${JSON.stringify(snapshot())}\n\n`)
    clients.add(res)
    req.on('close', () => clients.delete(res))
    return
  }
  return answer(res, api, `${req.method} ${url.pathname}`, req)
}

const browserServer = http.createServer(browserHandler)

function listenBrowser(port, last) {
  return new Promise((resolve, reject) => {
    const onError = err => {
      browserServer.off('listening', onListening)
      if (err.code === 'EADDRINUSE' && port < last) resolve(listenBrowser(port + 1, last))
      else reject(err)
    }
    const onListening = () => {
      browserServer.off('error', onError)
      resolve(port)
    }
    browserServer.once('error', onError)
    browserServer.once('listening', onListening)
    browserServer.listen(port, '127.0.0.1')
  })
}

function writeEndpoint(port) {
  fs.mkdirSync(HOME_DIR, { recursive: true })
  const endpoint = {
    version: API_VERSION,
    url: `http://127.0.0.1:${port}/`,
    api: `http://127.0.0.1:${port}/api/v1/`,
    port,
    key: KEY,
    pid: process.pid,
    cwd: CWD,
    startedAt: new Date().toISOString(),
  }
  fs.writeFileSync(ENDPOINT_FILE, JSON.stringify(endpoint, null, 2) + '\n', { mode: 0o600 })
  fs.chmodSync(ENDPOINT_FILE, 0o600)
}

// heartbeat so proxies and browsers keep the stream open
setInterval(() => {
  for (const res of clients) res.write(': ping\n\n')
}, 20_000).unref()

// ---------------------------------------------------------------------------
// Start

try {
  fs.unlinkSync(SOCKET)
} catch {}

unixServer.listen(SOCKET, async () => {
  let url = null
  try {
    httpPort = await listenBrowser(HTTP_PORT, HTTP_PORT + 9)
    writeEndpoint(httpPort)
    url = `http://127.0.0.1:${httpPort}/?key=${KEY}`
  } catch (err) {
    log(`browser listener not started: ${err.message}`)
  }
  emit({ type: 'ready', socket: SOCKET, url })
  autoConnect()
})

const shutdown = () => {
  try {
    fs.unlinkSync(SOCKET)
  } catch {}
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
// The mod's end of the pipe closing means the mod is gone.
process.stdout.on('error', shutdown)
