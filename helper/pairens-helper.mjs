#!/usr/bin/env node
// pAIrens helper: holds the Swank connection for the mod.
//
// The mod talks to it over HTTP on a Unix socket (--socket) and reads its
// events as JSON lines on stdout. Usage:
//
//   node pairens-helper.mjs --socket /tmp/pairens-x.sock --cwd <project> --lisp <pairens.lisp>
//
// Events (one JSON object per stdout line):
//   { type: 'ready', socket }
//   { type: 'status', status }
//   { type: 'entry', entry }            an eval started or finished
//   { type: 'output', text }            Lisp wrote to this connection
//   { type: 'claude-request', request } (pairens:claude ...) was called
//   { type: 'log', text }

import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

import { SwankClient } from './swank.mjs'
import { str } from './sexp.mjs'

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, a, i, all) => {
    if (a.startsWith('--')) pairs.push([a.slice(2), all[i + 1]])
    return pairs
  }, []),
)
const SOCKET = args.socket
const CWD = args.cwd ?? process.cwd()
const LISP_FILE = args.lisp ?? path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'lisp', 'pairens.lisp')
const PORT_FILE = path.join(CWD, '.swank-port')
const LOG_DIR = path.join(os.homedir(), '.pairens', 'logs')

process.env.PATH = ['/opt/homebrew/bin', '/usr/local/bin', process.env.PATH].filter(Boolean).join(':')

const emit = event => process.stdout.write(JSON.stringify(event) + '\n')
const log = text => emit({ type: 'log', text })

// ---------------------------------------------------------------------------
// Connection state

let swank = null
let status = { connected: false, host: null, port: null, impl: null, launching: false, error: null }
let pollGeneration = 0

const setStatus = patch => {
  status = { ...status, ...patch }
  emit({ type: 'status', status })
}

async function connect(host = '127.0.0.1', port = 4005) {
  if (swank) swank.close()
  const client = new SwankClient()
  client.on('log', log)
  client.on('debug', text => log(`Lisp debugger entered and aborted: ${text}`))
  client.on('output', text => emit({ type: 'output', text }))
  client.on('close', () => {
    if (swank !== client) return
    swank = null
    setStatus({ connected: false, impl: null, error: 'connection closed' })
  })
  await client.connect(host, port)
  swank = client
  const loaded = await client.rex(`(cl:progn (cl:load ${str(LISP_FILE)}) (cl:list (cl:lisp-implementation-type) (cl:lisp-implementation-version)))`)
  const impl = Array.isArray(loaded) ? loaded.join(' ') : 'Common Lisp'
  setStatus({ connected: true, host, port, impl, error: null })
  pollOutbox(client, ++pollGeneration)
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

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function autoConnect() {
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
  const entry = { id, session, origin, code, status: 'running', startedAt: Date.now() }
  const job = { entry, done: null }
  jobs.set(id, job)
  emit({ type: 'entry', entry })
  job.done = (async () => {
    try {
      if (!swank) throw new Error('not connected to a Lisp image')
      const r = await swank.rex(`(pairens::rex-eval ${str(session)} ${str(code)})`, { pkg: 'PAIRENS' })
      const [tag] = r
      if (String(tag) === ':OK') {
        const [, output, values, pkg] = r
        Object.assign(entry, { status: 'ok', output, values, package: pkg })
      } else {
        const [, message, output, pkg, type] = r
        Object.assign(entry, { status: 'error', error: message, output, package: pkg, errorType: type })
      }
    } catch (err) {
      Object.assign(entry, { status: 'error', error: err.message })
    }
    entry.endedAt = Date.now()
    emit({ type: 'entry', entry })
    return entry
  })()
  // keep the last 200 jobs
  if (jobs.size > 200) jobs.delete(jobs.keys().next().value)
  return job
}

async function waitFor(job, timeoutMs) {
  if (timeoutMs <= 0) return job.entry
  return Promise.race([job.done, sleep(timeoutMs).then(() => job.entry)])
}

// ---------------------------------------------------------------------------
// HTTP over the Unix socket

const routes = {
  'GET /status': async () => status,
  'POST /connect': async ({ host, port }) => connect(host || '127.0.0.1', Number(port) || 4005),
  'POST /launch': async () => launch(),
  'POST /disconnect': async () => {
    swank?.close()
    return status
  },
  'POST /eval': async ({ session, code, origin, timeoutMs = 0 }) => {
    if (typeof code !== 'string' || !code.trim()) throw new Error('no code to evaluate')
    const job = startEval({ session, code, origin })
    return waitFor(job, Number(timeoutMs))
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
  'POST /sessions': async () => {
    if (!swank) return { sessions: [] }
    const r = await swank.rex('(pairens::session-info)', { pkg: 'PAIRENS' })
    return { sessions: (r ?? []).map(([name, pkg]) => ({ name, package: pkg })) }
  },
}

const server = http.createServer(async (req, res) => {
  let body = ''
  req.on('data', c => (body += c))
  req.on('end', async () => {
    const route = routes[`${req.method} ${new URL(req.url, 'http://x').pathname}`]
    res.setHeader('content-type', 'application/json')
    if (!route) {
      res.statusCode = 404
      return res.end(JSON.stringify({ error: 'no such route' }))
    }
    try {
      const result = await route(body ? JSON.parse(body) : {})
      res.end(JSON.stringify(result))
    } catch (err) {
      res.statusCode = 500
      res.end(JSON.stringify({ error: err.message }))
    }
  })
})

try {
  fs.unlinkSync(SOCKET)
} catch {}
server.listen(SOCKET, () => {
  emit({ type: 'ready', socket: SOCKET })
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
