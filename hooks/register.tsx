// pAIrens: a Lisp REPL you and Claude share.
//
// Milestone 1: Common Lisp over Swank. The mod starts a Node helper
// (helper/pairens-helper.mjs) that holds the Swank connection; the mod sends
// it requests over HTTP on a Unix socket and reads its events from stdout.
// A reload restarts the helper; an SBCL it launched is not its child, so the
// image survives and the new helper reconnects through ./.swank-port.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { PairensEntry, PairensMode, PairensStatus } from '../types'

type Engine = EngineInterface

const PANE = 'pairens'
const MAX_ENTRIES = 400

const entriesAtom = atom({ plugin: 'pairens', key: 'entries' } as const, [] as PairensEntry[], {
  shape: 'entries-1',
})
const statusAtom = atom(
  { plugin: 'pairens', key: 'status' } as const,
  { helper: 'starting', connected: false } as PairensStatus,
  { shape: 'status-1' },
)
const modeAtom = atom({ plugin: 'pairens', key: 'mode' } as const, 'ask' as PairensMode, {
  shape: 'mode-1',
})
const tabAtom = atom({ plugin: 'pairens', key: 'tab' } as const, 'user', { shape: 'tab-1' })
const scrollBackAtom = atom({ plugin: 'pairens', key: 'scrollBack' } as const, 0, { shape: 'scroll-1' })
const draftAtom = atom({ plugin: 'pairens', key: 'draft' } as const, '', { shape: 'draft-1' })

// ---------------------------------------------------------------------------
// The helper process

type HelperEntry = {
  id: string
  session: string
  origin: 'user' | 'claude'
  code: string
  status: 'running' | 'ok' | 'error'
  startedAt: number
  output?: string
  values?: string[]
  package?: string
  error?: string
  errorType?: string
}

type ClaudeRequest = { id: string; prompt: string; value: string; package: string; session: string }

type HelperEvent =
  | { type: 'ready'; socket: string }
  | { type: 'status'; status: Omit<PairensStatus, 'helper'> }
  | { type: 'entry'; entry: HelperEntry }
  | { type: 'output'; text: string }
  | { type: 'claude-request'; request: ClaudeRequest }
  | { type: 'log'; text: string }

let socketPath = ''
let markReady: () => void = () => {}
let helperReady: Promise<void> = new Promise(resolve => (markReady = resolve))

/** (pairens:claude ...) requests waiting for their turn to start, by id. */
const waitingForTurn = new Map<string, ClaudeRequest>()
/** Turns answering a (pairens:claude ...) request, by turn id. */
const answeringTurns = new Map<string, ClaudeRequest>()

async function findNode($: Engine): Promise<string> {
  for (const candidate of ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node']) {
    try {
      const st = await $.fs.stat(candidate)
      if (st.kind === 'file' || st.kind === 'other') return candidate
    } catch {}
  }
  return 'node'
}

async function startHelper($: Engine, cwd: string) {
  helperReady = new Promise(resolve => (markReady = resolve))
  socketPath = `/tmp/pairens-${crypto.randomUUID().slice(0, 8)}.sock`
  const node = await findNode($)
  const script = `${$.plugin.root}/helper/pairens-helper.mjs`
  await update($, statusAtom, (s): PairensStatus => ({ ...s, helper: 'starting' }))

  void (async () => {
    let buffer = ''
    try {
      const lastJob = (await read($, entriesAtom)).reduce((n, x) => Math.max(n, Number(/^j(\d+)$/.exec(x.id)?.[1] ?? 0)), 0)
      const child = $.process.spawn({
        argv: [node, script, '--socket', socketPath, '--cwd', cwd, '--job-start', String(lastJob)],
        cwd,
      })
      for await (const chunk of child) {
        if (chunk.stream === 'stderr') {
          $.ui.log(`pairens helper: ${chunk.text}`, { to: 'debug' })
          continue
        }
        buffer += chunk.text
        let at: number
        while ((at = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, at)
          buffer = buffer.slice(at + 1)
          if (!line.trim()) continue
          try {
            await onHelperEvent($, JSON.parse(line) as HelperEvent)
          } catch (err) {
            $.ui.log(`pairens: bad helper event: ${String(err)}`, { to: 'debug' })
          }
        }
      }
    } catch (err) {
      $.ui.log(`pairens: helper failed: ${String(err)}`, { to: 'debug' })
    }
    await update($, statusAtom, (s): PairensStatus => ({ ...s, helper: 'failed', connected: false, error: 'the pAIrens helper stopped' }))
  })()
}

async function helper<T>($: Engine, path: string, body?: Record<string, unknown>): Promise<T> {
  await helperReady
  const res = await $.http.fetch(`http://pairens${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    socketPath,
  })
  const data = JSON.parse(res.text || '{}')
  if (!res.ok) throw new Error(data.error ?? `pAIrens helper ${path} failed (${res.status})`)
  return data as T
}

/** "host:port" or "port" → host and port (default 127.0.0.1:4005). */
function parseAddress(text: string): { host: string; port: number } {
  const arg = text.trim() || '4005'
  const at = arg.lastIndexOf(':')
  return at < 0
    ? { host: '127.0.0.1', port: Number(arg) }
    : { host: arg.slice(0, at) || '127.0.0.1', port: Number(arg.slice(at + 1)) }
}

async function pushEntry($: Engine, entry: PairensEntry) {
  await update($, entriesAtom, list => [...(list ?? []), entry].slice(-MAX_ENTRIES))
}

async function onHelperEvent($: Engine, event: HelperEvent) {
  switch (event.type) {
    case 'ready':
      markReady()
      await update($, statusAtom, (s): PairensStatus => ({ ...s, helper: 'ready' }))
      return
    case 'status':
      await update($, statusAtom, (s): PairensStatus => ({ ...s, ...event.status, helper: 'ready' }))
      return
    case 'entry': {
      const h = event.entry
      const entry: PairensEntry = {
        id: h.id,
        session: h.session,
        origin: h.origin,
        kind: 'eval',
        text: h.code,
        status: h.status,
        package: h.package,
        output: h.output,
        values: h.values,
        error: h.error,
        at: h.startedAt,
      }
      await update($, entriesAtom, list => {
        const all = list ?? []
        const at = all.findIndex(x => x.kind === 'eval' && x.id === h.id && x.at === h.startedAt)
        if (at < 0) return [...all, entry].slice(-MAX_ENTRIES)
        const copy = all.slice()
        copy[at] = entry
        return copy
      })
      return
    }
    case 'output':
      await update($, entriesAtom, list => {
        const all = list ?? []
        const last = all[all.length - 1]
        if (last && last.kind === 'output' && last.session === 'user')
          return [...all.slice(0, -1), { ...last, text: last.text + event.text }]
        const entry: PairensEntry = {
          id: `out-${Date.now()}`,
          session: 'user',
          origin: 'lisp',
          kind: 'output',
          text: event.text,
          at: Date.now(),
        }
        return [...all, entry].slice(-MAX_ENTRIES)
      })
      return
    case 'claude-request':
      void askClaude($, event.request)
      return
    case 'log':
      $.ui.log(`pairens: ${event.text}`, { to: 'debug' })
      return
  }
}

// ---------------------------------------------------------------------------
// (pairens:claude ...) → a prompt for this session → the reply back to Lisp

async function askClaude($: Engine, req: ClaudeRequest) {
  const session = req.session === 'editor' ? 'editor' : req.session
  await pushEntry($, {
    id: `ask-${req.id}`,
    session,
    origin: req.session === 'editor' ? 'editor' : 'user',
    kind: 'ask',
    text: req.value ? `${req.prompt}\n  with value: ${req.value}` : req.prompt,
    package: req.package,
    at: Date.now(),
  })
  const recent = (await read($, entriesAtom))
    .filter(x => x.session === session && x.kind === 'eval')
    .slice(-5)
    .map(formatEntry)
    .join('\n')
  const where =
    req.session === 'editor'
      ? `the person's own editor REPL (connected to the same Lisp image), package ${req.package}`
      : `the pAIrens REPL, session "${req.session}", package ${req.package}`
  const text = [
    `[pAIrens ${req.id}] Asked from ${where} with (pairens:claude ...):`,
    '',
    req.prompt,
    ...(req.value ? ['', `Value passed along: ${req.value}`] : []),
    ...(recent ? ['', `Recent evals in this session:`, recent] : []),
    '',
    'Your final message is printed back into that REPL. The pairens tools (eval, history, status) reach the same live image.',
  ].join('\n')
  waitingForTurn.set(req.id, req)
  try {
    await $.prompt.submit({ text })
  } catch (err) {
    waitingForTurn.delete(req.id)
    await pushEntry($, { id: `note-${req.id}`, session, origin: 'lisp', kind: 'note', text: `Could not send to Claude: ${String(err)}`, at: Date.now() })
  }
}

async function deliverReply($: Engine, req: ClaudeRequest, answer: string) {
  const session = req.session === 'editor' ? 'editor' : req.session
  await pushEntry($, {
    id: `reply-${req.id}`,
    session,
    origin: 'claude',
    kind: 'reply',
    text: answer || '(Claude finished without a text reply)',
    at: Date.now(),
  })
  if (req.session === 'editor') {
    try {
      await helper($, '/deliver', { id: req.id, answer })
    } catch (err) {
      $.ui.log(`pairens: could not print the reply in the editor: ${String(err)}`, { to: 'debug' })
    }
  }
}

// ---------------------------------------------------------------------------
// Formatting

const shortPackage = (p?: string) => (!p || p === 'COMMON-LISP-USER' ? 'CL-USER' : p)

function formatEntry(x: PairensEntry): string {
  switch (x.kind) {
    case 'eval': {
      const lines = [`[${x.id} ${x.session} by ${x.origin}] ${shortPackage(x.package)}> ${x.text}`]
      if (x.output) lines.push(...x.output.trimEnd().split('\n').map(l => `  | ${l}`))
      if (x.status === 'running') lines.push('  … still running')
      if (x.status === 'ok') lines.push(`  => ${(x.values ?? []).join(', ') || '; no values'}`)
      if (x.status === 'error') lines.push(`  !! ${x.error}`)
      return lines.join('\n')
    }
    case 'ask':
      return `[${x.session}] (claude) ${x.text}`
    case 'reply':
      return `[${x.session}] claude: ${x.text}`
    default:
      return `[${x.session}] ${x.text}`
  }
}

/** What the pane's copy button puts on the clipboard for an entry. */
function entryText(x: PairensEntry): string {
  if (x.kind !== 'eval') return x.text
  const parts = [x.text]
  if (x.output) parts.push(x.output.trimEnd())
  if (x.status === 'ok') parts.push(`=> ${(x.values ?? []).join('\n=> ')}`)
  if (x.status === 'error') parts.push(`!! ${x.error}`)
  return parts.join('\n')
}

function formatEvalResult(x: PairensEntry | HelperEntry): string {
  const isHelper = 'code' in x
  const code = isHelper ? (x as HelperEntry).code : (x as PairensEntry).text
  const lines = [`${shortPackage(x.package)}> ${code}`]
  if (x.output) lines.push('Output:', x.output.trimEnd())
  if (x.status === 'running')
    lines.push(`Still running as job ${x.id} in session "${x.session}". Fetch it later with job_result.`)
  if (x.status === 'ok') lines.push(`=> ${(x.values ?? []).join('\n=> ') || '; no values'}`)
  if (x.status === 'error') lines.push(`Error: ${x.error}`)
  return lines.join('\n')
}

// ---------------------------------------------------------------------------

const MODE_HELP: Record<PairensMode, string> = {
  ask: 'Ask: you approve each eval Claude wants to run',
  auto: 'Auto: Claude evals freely; every eval shows here',
  'read-only': 'Read-only: Claude may only inspect (describe, documentation, apropos, …)',
}

const isMode = (s: string): s is PairensMode => s === 'ask' || s === 'auto' || s === 'read-only'

async function setMode($: Engine, m: PairensMode) {
  await update($, modeAtom, () => m)
  await $.store.set('mode', m)
}

async function readOnly($: Engine, session: string, code: string): Promise<boolean> {
  try {
    const { readOnly } = await helper<{ readOnly: boolean }>($, '/classify', { session, code })
    return readOnly
  } catch {
    return false
  }
}

/** tool.check hook for pAIrens tools that only read. */
async function allowRead() {
  return { decision: 'allow' as const, reason: 'pAIrens: read-only' }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const stored = await $.store.get('mode')
    if (typeof stored === 'string' && isMode(stored)) await update($, modeAtom, () => stored)

    await $.tool.register({
      name: 'eval',
      isDeferred: false,
      description:
        "Evaluate Common Lisp code in the person's live Lisp image through pAIrens (Swank). " +
        'The person sees every eval in their pAIrens REPL pane, marked as yours. ' +
        'Sessions share the image, but each keeps its own current package and *, **, ***: ' +
        '"user" is the person\'s own REPL session; pick your own session name (e.g. "claude" or "claude-tests") ' +
        "for background or long-running work so you don't disturb theirs; it shows as its own tab. " +
        'Returns output, return values or the error. An eval that outlasts timeout_seconds keeps running as a job: ' +
        'fetch it with job_result. The person sets a mode: ask (each eval needs approval), auto, or read-only ' +
        '(only inspection such as describe, documentation, apropos).',
      inputSchema: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'One or more Lisp forms; the last form\'s values are returned.' },
          session: { type: 'string', description: 'pAIrens session to evaluate in. Default "user".' },
          timeout_seconds: { type: 'number', description: 'How long to wait before handing back a job id. Default 30, max 55.' },
        },
        required: ['code'],
      },
    })
    await $.tool.register({
      name: 'history',
      description: "Read recent pAIrens REPL history: what the person and you evaluated, with output, values and errors, plus (pairens:claude ...) questions.",
      inputSchema: {
        type: 'object',
        properties: {
          session: { type: 'string', description: 'Only this session ("user", "editor", or one of yours). Default: all.' },
          limit: { type: 'number', description: 'How many entries, newest last. Default 20.' },
        },
      },
    })
    await $.tool.register({
      name: 'job_result',
      description: 'Get the result of a pAIrens eval that was still running when eval returned.',
      inputSchema: {
        type: 'object',
        properties: {
          job: { type: 'string', description: 'The job id eval handed back (e.g. "j12").' },
          wait_seconds: { type: 'number', description: 'Wait up to this long for it to finish. Default 0, max 55.' },
        },
        required: ['job'],
      },
    })
    await $.tool.register({
      name: 'status',
      description: "pAIrens connection status (Lisp implementation, Swank port), the person's eval mode, and each session's current package.",
    })

    await $.command.register({ name: 'pairens', description: 'Open the pAIrens Lisp REPL pane' })
    await $.command.register({
      name: 'pairens-mode',
      description: "Set how Claude's evals run: ask, auto or read-only",
      argumentHint: 'ask | auto | read-only',
    })
    await $.command.register({
      name: 'pairens-connect',
      description: 'Connect pAIrens to a running Swank server',
      argumentHint: '[host:]port',
    })
    await $.command.register({ name: 'pairens-launch', description: 'Start SBCL with Swank for pAIrens' })

    await startHelper($, e.cwd)
    // Opened unasked: the surface seats it once one attaches and has room;
    // /pairens (asked) places it at any width.
    void $.ui.open({ id: PANE, title: 'pAIrens' }).then(r => {
      if (!r.isPlaced) $.ui.log(`pairens: pane waits: ${r.reason}`, { to: 'debug' })
    })

    return next(e)
  })

  // --- commands -------------------------------------------------------------

  on('command.run', { command: 'pairens' }, async $ => {
    const r = await $.ui.open({ id: PANE, title: 'pAIrens' })
    return { text: r.isPlaced ? 'pAIrens pane opened.' : `pAIrens pane could not be shown: ${r.reason}` }
  })

  on('command.run', { command: 'pairens-mode' }, async ($, e) => {
    const wanted = e.args.trim()
    if (!isMode(wanted)) return { text: `Current mode: ${MODE_HELP[await read($, modeAtom)]}. Use ask, auto or read-only.` }
    await setMode($, wanted)
    return { text: `pAIrens mode: ${MODE_HELP[wanted]}.` }
  })

  on('command.run', { command: 'pairens-connect' }, async ($, e) => {
    const { host, port } = parseAddress(e.args)
    try {
      const s = await helper<PairensStatus>($, '/connect', { host, port })
      return { text: `pAIrens connected to ${s.impl} on ${host}:${port}.` }
    } catch (err) {
      return { text: `pAIrens could not connect to ${host}:${port}: ${String(err)}` }
    }
  })

  on('command.run', { command: 'pairens-launch' }, async $ => {
    void helper($, '/launch', {}).catch(err => $.ui.toast(`pAIrens launch failed: ${String(err)}`))
    await $.ui.open({ id: PANE, title: 'pAIrens' })
    return { text: 'pAIrens is starting SBCL with Swank; the pane shows when it is connected.' }
  })

  // --- (pairens:claude ...) turns --------------------------------------------

  on('turn.start', async ($, e, next) => {
    if (!e.agentId) {
      const m = /\[pAIrens ([\w-]+)\]/.exec(e.text)
      const req = m?.[1] ? waitingForTurn.get(m[1]) : undefined
      if (req) {
        waitingForTurn.delete(req.id)
        answeringTurns.set(e.turnId, req)
      }
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    const req = answeringTurns.get(e.turnId)
    if (req) {
      answeringTurns.delete(e.turnId)
      void deliverReply($, req, e.answer)
    }
    return result
  })

  // --- permissions: the person's mode decides Claude's evals ------------------

  on('tool.check', { tool: 'mcp__pairens__eval' }, async ($, e) => {
    const input = (e.input ?? {}) as { code?: string; session?: string }
    const session = input.session || 'user'
    const m = await read($, modeAtom)
    if (m === 'auto') return { decision: 'allow', reason: 'pAIrens is in auto mode' }
    if (m === 'read-only') {
      return (await readOnly($, session, input.code ?? ''))
        ? { decision: 'allow', reason: 'pAIrens read-only mode: this code only inspects' }
        : { decision: 'deny', reason: 'pAIrens is in read-only mode and this code does more than inspect. Ask the person to switch modes (/pairens-mode) or suggest the code for them to run.' }
    }
    return { decision: 'ask', reason: `pAIrens (ask mode): Claude wants to evaluate this in session "${session}"` }
  }).catch(() => ({ decision: 'ask', reason: 'pAIrens could not check this eval' }))

  on('tool.check', { tool: 'mcp__pairens__history' }, allowRead)
  on('tool.check', { tool: 'mcp__pairens__job_result' }, allowRead)
  on('tool.check', { tool: 'mcp__pairens__status' }, allowRead)

  // --- tools ------------------------------------------------------------------

  on('tool.call', { tool: 'mcp__pairens__eval' }, async ($, e) => {
    const input = e as unknown as { code?: string; session?: string; timeout_seconds?: number }
    const code = input.code ?? ''
    const session = (input.session || 'user').trim()
    if ((await read($, modeAtom)) === 'read-only' && !(await readOnly($, session, code)))
      return { deny: 'pAIrens is in read-only mode and this code does more than inspect.' }
    const timeoutMs = Math.min(55, Math.max(1, input.timeout_seconds ?? 30)) * 1000
    try {
      const entry = await helper<HelperEntry>($, '/eval', { session, code, origin: 'claude', timeoutMs })
      if (session !== 'user') await update($, tabAtom, t => t ?? 'user')
      return { result: formatEvalResult(entry), ...(entry.status === 'error' ? { isError: true as const } : {}) }
    } catch (err) {
      return { result: `pAIrens: ${String(err)}`, isError: true as const }
    }
  })

  on('tool.call', { tool: 'mcp__pairens__history' }, async ($, e) => {
    const input = e as unknown as { session?: string; limit?: number }
    const all = await read($, entriesAtom)
    const picked = all.filter(x => !input.session || x.session === input.session).slice(-(input.limit ?? 20))
    return { result: picked.length ? picked.map(formatEntry).join('\n\n') : 'No pAIrens history yet.' }
  })

  on('tool.call', { tool: 'mcp__pairens__job_result' }, async ($, e) => {
    const input = e as unknown as { job: string; wait_seconds?: number }
    try {
      const entry = await helper<HelperEntry>($, '/job', {
        id: input.job,
        timeoutMs: Math.min(55, Math.max(0, input.wait_seconds ?? 0)) * 1000,
      })
      return { result: formatEvalResult(entry) }
    } catch (err) {
      return { result: `pAIrens: ${String(err)}`, isError: true as const }
    }
  })

  on('tool.call', { tool: 'mcp__pairens__status' }, async $ => {
    const s = await read($, statusAtom)
    const m = await read($, modeAtom)
    let sessions = ''
    try {
      const r = await helper<{ sessions: { name: string; package: string }[] }>($, '/sessions', {})
      sessions = r.sessions.map(x => `  ${x.name}: ${shortPackage(x.package)}`).join('\n')
    } catch {}
    const conn = s.connected ? `Connected to ${s.impl} via Swank on ${s.host}:${s.port}` : `Not connected${s.error ? ` (${s.error})` : ''}`
    return { result: [conn, `Mode: ${MODE_HELP[m]}`, sessions ? `Sessions:\n${sessions}` : 'No sessions yet.'].join('\n') }
  })

  // --- the pane ---------------------------------------------------------------

  // The pane keeps its own window: the editor and controls stay pinned at the
  // bottom, and a scroll over the pane moves through the history instead.
  on('ui.scroll', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const all = await read($, entriesAtom)
    const selected = await read($, tabAtom)
    const count = all.filter(x => x.session === selected).length
    const step = Math.sign(e.by) * Math.max(1, Math.round(Math.abs(e.by) / 3))
    await update($, scrollBackAtom, n => Math.min(Math.max(0, count - 1), Math.max(0, (n ?? 0) - step)))
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const status = await read($, statusAtom)
    const mode = await read($, modeAtom)
    const all = await read($, entriesAtom)
    const sessions = Array.from(new Set(['user', ...all.map(x => x.session)]))
    const selected = sessions.includes(await read($, tabAtom)) ? await read($, tabAtom) : 'user'
    const shown = all.filter(x => x.session === selected)
    const scrollBack = Math.min(await read($, scrollBackAtom), Math.max(0, shown.length - 1))
    const pkg = shortPackage([...shown].reverse().find(x => x.package)?.package)
    const draft = await read($, draftAtom)
    const bodyRows = e.props.scroll?.bodyRows ?? e.viewport?.rows ?? 40

    if (e.surface === 'mobile') {
      const { Text } = $.ui.resolve(e)
      return <Text>pAIrens needs a surface with text input (desktop or terminal).</Text>
    }
    const { Box, Text, Button, Input } = $.ui.resolve(e)

    const statusLine = status.connected
      ? `● ${status.impl} · Swank ${status.host}:${status.port}`
      : status.launching
        ? '◌ starting SBCL with Swank…'
        : status.helper === 'starting'
          ? '◌ starting pAIrens…'
          : `○ not connected${status.error ? ` (${status.error})` : ''}`

    const evalHere = (code: string) => {
      if (!code.trim()) return
      void update($, scrollBackAtom, () => 0)
      void helper($, '/eval', { session: selected, code, origin: 'user', timeoutMs: 0 }).catch(err =>
        $.ui.toast(`pAIrens: ${String(err)}`),
      )
    }

    // Text in the pane can't be selected, so entries carry copy/edit buttons.
    const copy = (text: string) =>
      void $.ui.copy({ text, surface: e.surface }).then(r =>
        $.ui.toast(r.isCopied ? 'Copied' : `Could not copy: ${r.reason}`),
      )
    const entryTools = (x: PairensEntry) => (
      <Box flexDirection="row" gap={1}>
        <Button key={`copy-${x.id}-${x.at}`} plain dimColor onPress={() => copy(entryText(x))}>
          copy
        </Button>
        {x.kind === 'eval' ? (
          <Button key={`edit-${x.id}-${x.at}`} plain dimColor onPress={() => void update($, draftAtom, () => x.text)}>
            edit
          </Button>
        ) : null}
      </Box>
    )

    // Enough entries to fill the history area; the area clips the oldest.
    const visible = shown.slice(0, shown.length - scrollBack).slice(-Math.max(5, bodyRows))
    const rows = visible.map(x => {
      if (x.kind === 'eval')
        return (
          <Box key={`${x.id}-${x.at}`} flexDirection="column" flexShrink={0}>
            <Box flexDirection="row" justifyContent="space-between" gap={1}>
              <Text mono color={x.origin === 'claude' ? 'claude' : undefined}>
                {x.origin === 'claude' ? '✻ ' : ''}
                {shortPackage(x.package)}&gt; {x.text}
              </Text>
              {entryTools(x)}
            </Box>
            {x.output ? <Text mono dimColor>{x.output.trimEnd()}</Text> : null}
            {x.status === 'running' ? <Text dimColor>… running ({x.id})</Text> : null}
            {x.status === 'ok' ? <Text mono color="success">⇒ {(x.values ?? []).join('  ') || '; no values'}</Text> : null}
            {x.status === 'error' ? <Text mono color="error">✗ {x.error}</Text> : null}
          </Box>
        )
      if (x.kind === 'ask')
        return (
          <Box key={x.id} flexShrink={0}>
            <Text color="claude">? (claude) {x.text}</Text>
          </Box>
        )
      if (x.kind === 'reply')
        return (
          <Box key={x.id} flexDirection="column" flexShrink={0}>
            <Box flexDirection="row" justifyContent="space-between" gap={1}>
              <Text color="claude" bold>✻ Claude</Text>
              {entryTools(x)}
            </Box>
            <Text>{x.text}</Text>
          </Box>
        )
      return (
        <Box key={x.id} flexShrink={0}>
          <Text mono dimColor>{x.text.trimEnd()}</Text>
        </Box>
      )
    })

    return (
      <Box flexDirection="column" height={bodyRows}>
        {/* history: fills the room above the editor, newest at the bottom */}
        <Box key="history" flexDirection="column" flexGrow={1} flexShrink={1} overflow="hidden" justifyContent="flex-end" gap={1}>
          {rows.length ? rows : [<Text key="empty" dimColor>Nothing evaluated in "{selected}" yet. Try (pairens:claude "hello!")</Text>]}
        </Box>

        {/* pinned: editor, then status and controls */}
        <Box key="footer" flexDirection="column" flexShrink={0} gap={1} paddingTop={1} paddingBottom={1}>
          {shown.length > 1 ? (
            <Box flexDirection="row" gap={1} alignItems="center" flexWrap="wrap">
              <Button
                key="older"
                dimColor={scrollBack >= shown.length - 1}
                onPress={() => void update($, scrollBackAtom, n => Math.min(shown.length - 1, (n ?? 0) + 1))}
              >
                ▲ older
              </Button>
              <Button key="newer" dimColor={scrollBack === 0} onPress={() => void update($, scrollBackAtom, n => Math.max(0, (n ?? 0) - 1))}>
                ▼ newer
              </Button>
              {scrollBack > 0 ? (
                <Button key="latest" onPress={() => void update($, scrollBackAtom, () => 0)}>
                  ⤓ latest
                </Button>
              ) : null}
              <Text dimColor>
                {scrollBack > 0 ? `${scrollBack} newer hidden · ` : ''}
                {shown.length} {shown.length === 1 ? 'entry' : 'entries'}
              </Text>
            </Box>
          ) : null}

          <Box flexDirection="column">
            <Text mono bold>
              {pkg}&gt;
            </Text>
            <Input
              key="repl"
              value={draft}
              placeholder="(+ 1 2)"
              submitLabel="⏎"
              rows={3}
              autoFocus
              onInput={value => void update($, draftAtom, () => value)}
              onSubmit={value => {
                evalHere(value)
                void update($, draftAtom, () => '')
              }}
            />
          </Box>

          <Text dimColor={!status.connected} color={status.connected ? 'success' : undefined}>
            {statusLine}
          </Text>

          {!status.connected && !status.launching ? (
            <Box flexDirection="column" gap={1}>
              <Box flexDirection="row" gap={1}>
                <Button key="launch" variant="primary" onPress={() => void helper($, '/launch', {}).catch(err => $.ui.toast(`pAIrens: ${String(err)}`))}>
                  Launch SBCL
                </Button>
              </Box>
              <Input
                key="port"
                label="Or connect to a running Swank"
                placeholder="4005 or host:port"
                submitLabel="Connect"
                onSubmit={value => {
                  void helper($, '/connect', parseAddress(value)).catch(err =>
                    $.ui.toast(`pAIrens could not connect: ${String(err)}`),
                  )
                }}
              />
            </Box>
          ) : null}

          <Box flexDirection="row" gap={1} flexWrap="wrap">
            <Text dimColor>Claude:</Text>
            {(['ask', 'auto', 'read-only'] as const).map(m => (
              <Button key={`mode-${m}`} variant={m === mode ? 'primary' : 'secondary'} onPress={() => void setMode($, m)}>
                {m}
              </Button>
            ))}
          </Box>

          <Box flexDirection="row" gap={1} flexWrap="wrap">
            {sessions.map(name => (
              <Button
                key={`tab-${name}`}
                variant={name === selected ? 'primary' : 'secondary'}
                onPress={() => {
                  void update($, tabAtom, () => name)
                  void update($, scrollBackAtom, () => 0)
                }}
              >
                {name}
              </Button>
            ))}
            <Button key="clear" dimColor onPress={() => void update($, entriesAtom, list => (list ?? []).filter(x => x.session !== selected))}>
              clear
            </Button>
          </Box>
        </Box>
      </Box>
    )
  })
}
