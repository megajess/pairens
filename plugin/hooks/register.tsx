// pAIrens: a Lisp REPL you and Claude share.
//
// Common Lisp over Swank, Clojure over nREPL. The mod starts a Node helper
// (helper/pairens-helper.mjs) that holds the connection and the shared
// history; the mod sends it requests over HTTP on a Unix socket and reads its
// events from stdout. The helper also serves the browser page (browser/) and
// the v1 API on 127.0.0.1; the page is another view of the same history.
// A reload restarts the helper; an SBCL or JVM it launched is not its child,
// so the image survives and the new helper reconnects to it.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Completion, Description, PairensDebug, PairensEntry, PairensMode, PairensStatus, ReplProps, TabsProps } from '../types'

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
const debugsAtom = atom({ plugin: 'pairens', key: 'debugs' } as const, [] as PairensDebug[], { shape: 'debugs-1' })
// The REPL Client's: what the hooks hand it through props, and a fault that
// sends the pane back to the classic view on that surface.
const pasteAtom = atom({ plugin: 'pairens', key: 'paste' } as const, null as { id: number; text: string } | null, {
  shape: 'paste-1',
})
const completionAtom = atom(
  { plugin: 'pairens', key: 'completion' } as const,
  null as { id: number; items: Completion[] } | null,
  { shape: 'completion-1' },
)
const describedAtom = atom(
  { plugin: 'pairens', key: 'described' } as const,
  null as { id: number; description: Description | null } | null,
  { shape: 'described-1' },
)
const replFaultAtom = atom({ plugin: 'pairens', key: 'replFault' } as const, null as { surface: string; reason: string } | null, {
  shape: 'repl-fault-1',
})

// ---------------------------------------------------------------------------
// The helper process

/** `via: 'prefix'` when typed as "pairens: <text>" in the pane or a client. */
type ClaudeRequest = { id: string; prompt: string; value: string; package: string; session: string; via?: 'prefix' }

/** A line for Claude rather than Lisp: `pairens:` then a space or newline. */
const MESSAGE_PREFIX = /^\s*pairens:(?=\s)/i

type HelperEvent =
  | { type: 'ready'; socket: string; url: string | null }
  | { type: 'status'; status: Omit<PairensStatus, 'helper' | 'browserUrl'> }
  | { type: 'entry'; entry: PairensEntry }
  | { type: 'claude-request'; request: ClaudeRequest }
  | { type: 'set-mode'; mode: string }
  | { type: 'clear'; session: string }
  | { type: 'debug'; debug: PairensDebug }
  | { type: 'debug-done'; id: string }
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
  // After a reload, reconnect to what the person was connected to, and stay
  // disconnected if they had disconnected on purpose.
  const before = await read($, statusAtom)
  const reconnect =
    before.connected && before.port
      ? ['--prefer', `${before.protocol ? `${before.protocol}:` : ''}${before.host ?? '127.0.0.1'}:${before.port}`]
      : before.disconnectedByUser
        ? ['--no-auto', '1']
        : []
  await update($, statusAtom, (s): PairensStatus => ({ ...s, helper: 'starting' }))

  void (async () => {
    let buffer = ''
    try {
      const lastJob = (await read($, entriesAtom)).reduce((n, x) => Math.max(n, Number(/^j(\d+)$/.exec(x.id)?.[1] ?? 0)), 0)
      const child = $.process.spawn({
        argv: [node, script, '--socket', socketPath, '--cwd', cwd, '--job-start', String(lastJob), ...reconnect],
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

type Protocol = 'swank' | 'nrepl'

/**
 * "[swank|nrepl] [host:]port" → host, port and maybe a protocol (default
 * 127.0.0.1:4005; without a protocol the helper tries the likelier one first).
 */
function parseAddress(text: string): { host: string; port: number; protocol?: Protocol } {
  const m = /^\s*(?:(swank|nrepl)\b[:\s]*)?(.*)$/i.exec(text) ?? []
  const protocol = m[1] ? (m[1].toLowerCase() as Protocol) : undefined
  const arg = (m[2] ?? '').trim() || '4005'
  const at = arg.lastIndexOf(':')
  const address =
    at < 0
      ? { host: '127.0.0.1', port: Number(arg) }
      : { host: arg.slice(0, at) || '127.0.0.1', port: Number(arg.slice(at + 1)) }
  return protocol ? { ...address, protocol } : address
}

const protocolName = (p?: string | null) => (p === 'nrepl' ? 'nREPL' : 'Swank')

/** How to call claude from code in the connected language. */
const claudeCall = (s: PairensStatus) => (s.protocol === 'nrepl' ? '(pairens/claude ...)' : '(pairens:claude ...)')

/** Adds an entry the mod made (a question or Claude's reply) and shares it. */
async function pushEntry($: Engine, entry: PairensEntry) {
  await update($, entriesAtom, list => [...(list ?? []), entry].slice(-MAX_ENTRIES))
  void helper($, '/entry', { entry }).catch(() => {})
}

async function clearSession($: Engine, session: string, { share = true } = {}) {
  await update($, entriesAtom, list => (list ?? []).filter(x => x.session !== session))
  if (share) void helper($, '/clear', { session }).catch(() => {})
}

/**
 * The one browser-pane open the person's last press of "open in Claude's
 * browser" allows without a prompt: that exact page address, for a short
 * while, once. Anything else asks as usual.
 */
let browserOpenAllowed: { url: string; until: number } | null = null
const BROWSER_OPEN_WINDOW_MS = 2 * 60 * 1000

/**
 * A `tool.check` hook on the browser pane's tools that open a URL
 * (`preview_start`, `navigate`): allows the one open a press asked for, else
 * hands the call on to the session's own rules and prompts.
 */
async function allowPressedBrowserOpen(
  _$: Engine,
  e: { input: unknown; agentId?: string; ceiling?: 'allow' | 'ask' | 'deny' },
  next: (e: never) => Promise<{ decision: 'allow' | 'ask' | 'deny'; reason?: string }>,
) {
  const url = (e.input as { url?: unknown } | null)?.url
  const allowed = browserOpenAllowed
  if (allowed && Date.now() < allowed.until && url === allowed.url && !e.agentId && e.ceiling !== 'deny') {
    browserOpenAllowed = null
    return { decision: 'allow' as const, reason: 'pAIrens: the person pressed "open in Claude\'s browser" for this page' }
  }
  return next(e as never)
}

/**
 * Asks Claude, with a turn of its own, to open the pAIrens page in the
 * desktop app's browser pane: the mod has no way to open that pane itself.
 */
async function openInClaudesBrowser($: Engine): Promise<string> {
  const url = (await read($, statusAtom)).browserUrl
  if (!url) return 'The pAIrens browser page is not available (the helper has no local web listener).'
  browserOpenAllowed = { url, until: Date.now() + BROWSER_OPEN_WINDOW_MS }
  const text = [
    "[pAIrens] The person pressed \"open in Claude's browser\" in the pAIrens pane.",
    '',
    `Open this page in your built-in browser (the desktop app's browser pane): ${url}`,
    'Then make sure the browser pane is showing (show the preview pane): loading a page in a hidden pane does not bring it into view.',
    '',
    "It is the pAIrens REPL page, served by the pAIrens helper on this machine (127.0.0.1). The address carries the page's key: don't repeat it in your reply. Reply in one short line once it is open.",
  ].join('\n')
  try {
    await $.prompt.submit({ text })
    return "Asked Claude to open the pAIrens REPL in its browser."
  } catch (err) {
    browserOpenAllowed = null
    return `Could not ask Claude: ${String(err)}`
  }
}

/** pAIrens' site, the manifest's homepage. */
const ABOUT_URL = 'https://pairens.dev/'

/** Opens pAIrens' site in the person's default browser. */
async function openAbout($: Engine): Promise<string> {
  const r = await $.process.run(['/usr/bin/open', ABOUT_URL])
  return r.exitCode === 0 ? 'Opened pairens.dev in your browser.' : `Could not open pairens.dev: ${r.stderr.trim()}`
}

async function openBrowser($: Engine): Promise<string> {
  const url = (await read($, statusAtom)).browserUrl
  if (!url) return 'The pAIrens browser page is not available (the helper has no local web listener).'
  const r = await $.process.run(['/usr/bin/open', url])
  return r.exitCode === 0 ? 'Opened the pAIrens REPL in your browser.' : `Could not open the browser: ${r.stderr.trim()}`
}

async function onHelperEvent($: Engine, event: HelperEvent) {
  switch (event.type) {
    case 'ready': {
      markReady()
      await update($, statusAtom, (s): PairensStatus => ({ ...s, helper: 'ready', browserUrl: event.url }))
      // Share this session's history and mode with the new helper.
      const r = await helper<{ debugs?: PairensDebug[] }>($, '/sync', {
        entries: await read($, entriesAtom),
        mode: await read($, modeAtom),
      }).catch(() => ({ debugs: [] as PairensDebug[] }))
      await update($, debugsAtom, () => r.debugs ?? [])
      return
    }
    case 'status':
      await update($, statusAtom, (s): PairensStatus => ({ ...s, ...event.status, helper: 'ready' }))
      return
    case 'entry': {
      const entry = event.entry
      await update($, entriesAtom, list => {
        const all = list ?? []
        const at = all.findIndex(x => x.id === entry.id && x.at === entry.at)
        if (at < 0) return [...all, entry].slice(-MAX_ENTRIES)
        const copy = all.slice()
        copy[at] = entry
        return copy
      })
      if (entry.session === (await read($, tabAtom))) void toEnd($)
      return
    }
    case 'claude-request':
      void askClaude($, event.request)
      return
    case 'set-mode':
      if (isMode(event.mode)) await setMode($, event.mode)
      return
    case 'clear':
      await clearSession($, event.session, { share: false })
      return
    case 'debug':
      await update($, debugsAtom, list => [...(list ?? []).filter(d => d.id !== event.debug.id), event.debug])
      $.ui.toast(`Lisp debugger: ${event.debug.message.slice(0, 120)}`)
      return
    case 'debug-done':
      await update($, debugsAtom, list => (list ?? []).filter(d => d.id !== event.id))
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
  // "help" is answered here, with no Claude turn.
  if (req.prompt.trim().toLowerCase() === 'help' && !req.value) {
    await showHelp($, session)
    if (req.session === 'editor') await helper($, '/deliver', { id: req.id, answer: HELP_TEXT }).catch(() => undefined)
    return
  }
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
  const status = await read($, statusAtom)
  const clojure = req.id.startsWith('clj-') || status.protocol === 'nrepl'
  const cljsBuild = status.cljsSessions?.[req.session]
  const lang = cljsBuild ? `ClojureScript (shadow-cljs build :${cljsBuild})` : clojure ? 'Clojure' : 'Lisp'
  const space = clojure ? 'namespace' : 'package'
  const where =
    req.session === 'editor'
      ? `the person's own editor REPL (connected to the same ${lang} image), ${space} ${req.package}`
      : `the pAIrens ${lang} REPL, session "${req.session}", ${space} ${req.package}`
  const how = req.via === 'prefix' ? 'by typing "pairens: …"' : `with ${clojure ? '(pairens/claude ...)' : '(pairens:claude ...)'}`
  const text = [
    `[pAIrens ${req.id}] Asked from ${where} ${how}:`,
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

/** What `pairens: help`, `(pairens:claude "help")` and /pairens-help print. */
const HELP_TEXT = `pAIrens help

THE REPL
  Enter             evaluate a complete form (inside an open form, a new line)
  Shift+Enter       a new line
  Up / Down         your earlier forms in this session
  Ctrl+Space        complete the symbol before the cursor (also Ctrl+I; Tab in a terminal)
  Option+click      a function's argument list and documentation
  drag, Cmd+C       select and copy anything in the transcript
  Cmd+V / X / A / Z paste, cut, select all, undo
  Ctrl+A / E / K / U  line start, line end, delete to the end, clear the input
  Esc               hand the keyboard back to Claude Code
  Parens pair as you type; the one at the cursor and its partner are underlined.

ASKING CLAUDE
  pairens: <question>         ask Claude from here; the answer prints in this REPL
  (pairens:claude "why?" x)   from Common Lisp code, optionally with a value
  (pairens/claude "why?" x)   from Clojure code
  An orange bar marks Claude's evals and answers; a blue bar, your results.

SESSIONS
  The tabs above the status line are sessions: each has its own package
  (namespace) and *, **, ***, all in one image. "user" is yours; Claude may
  open its own. "clear" empties the session shown.

CLAUDE'S PERMISSION MODE
  ask         you approve each eval Claude wants to run
  auto        Claude's evals run
  read-only   only code that inspects runs

COMMANDS (in Claude Code's prompt)
  /pairens                          open this pane
  /pairens-connect [host:]port      connect to a running Swank or nREPL (default 4005)
  /pairens-launch [sbcl | clojure]  start SBCL with Swank, or Clojure with nREPL
  /pairens-disconnect               disconnect (the image keeps running)
  /pairens-mode <mode>              set Claude's permission mode
  /pairens-cljs [build | quit]      ClojureScript in a shadow-cljs build, or back
  /pairens-browser                  this REPL in your web browser
  /pairens-help                     this help (or type: pairens: help)`

/** Prints the help in SESSION's history. */
async function showHelp($: Engine, session: string) {
  await pushEntry($, { id: `help-${Date.now()}`, session, origin: 'lisp', kind: 'help', text: HELP_TEXT, at: Date.now() })
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

function formatDebug(d: PairensDebug): string {
  return [
    `Debugger ${d.id} (thread ${d.thread}, level ${d.level}): ${d.message}`,
    `  condition type: ${d.type}`,
    '  restarts:',
    ...d.restarts.map((r, i) => `    ${i}: [${r.name}] ${r.description}`),
    '  backtrace (top):',
    ...d.frames.slice(0, 12).map((f, i) => `    ${i}: ${f}`),
  ].join('\n')
}

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

function formatEvalResult(x: PairensEntry): string {
  const lines = [`${shortPackage(x.package)}> ${x.text}`]
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
  'read-only': 'Read-only: Claude may only inspect (describe, documentation, apropos; in Clojure doc, source, dir, …)',
}

/** The pane's permission-mode picker: what each mode lets Claude do. */
const MODE_OPTIONS = [
  { value: 'ask', label: 'ask · approve each of Claude\'s evals' },
  { value: 'auto', label: 'auto · Claude\'s evals run' },
  { value: 'read-only', label: 'read-only · only code that inspects runs' },
] as const

const isMode = (s: string): s is PairensMode => s === 'ask' || s === 'auto' || s === 'read-only'

async function setMode($: Engine, m: PairensMode) {
  await update($, modeAtom, () => m)
  await $.store.set('mode', m)
  void helper($, '/mode', { mode: m }).catch(() => {})
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

/** What the person typed in the pane: Lisp, or "pairens: <text>", a question for Claude. */
function evalIn($: Engine, session: string, code: string) {
  if (!code.trim()) return
  void update($, scrollBackAtom, () => 0)
  const question = MESSAGE_PREFIX.test(code) ? code.replace(MESSAGE_PREFIX, '').trim() : null
  const sent = question
    ? helper($, '/api/v1/ask', { session, text: question })
    : helper($, '/eval', { session, code, origin: 'user', timeoutMs: 0 })
  void sent.catch(err => $.ui.toast(`pAIrens: ${String(err)}`))
}

/** Keeps the pane at its end, as a terminal REPL does, once its redraw is in. */
async function toEnd($: Engine) {
  try {
    await $.ui.scroll({ in: PANE, to: 'end' })
    // The redraw an update starts may land after the first scroll: once more.
    await $.clock.sleep(80)
    await $.ui.scroll({ in: PANE, to: 'end' })
  } catch {
    // Scrolling is a nicety; it never fails what asked for it.
  }
}

/** Plain data for a Client's props: no undefined anywhere. */
const plain = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T

/** A Client's props stay under 100,000 characters: the newest entries that fit in about 60,000. */
function newestThatFit(list: PairensEntry[], budget = 60000): PairensEntry[] {
  const out: PairensEntry[] = []
  let size = 0
  for (let i = list.length - 1; i >= 0; i--) {
    const x = list[i]
    if (!x) continue
    size += JSON.stringify(x).length
    if (size > budget) break
    out.unshift(x)
  }
  return out
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // A reload brings new code: give the REPL Client another try.
    await update($, replFaultAtom, () => null)
    const stored = await $.store.get('mode')
    if (typeof stored === 'string' && isMode(stored)) await update($, modeAtom, () => stored)

    await $.tool.register({
      name: 'eval',
      isDeferred: false,
      description:
        "Evaluate code in the person's live image through pAIrens: Common Lisp (over Swank) or Clojure (over nREPL), " +
        'whichever is connected; status says which. With a shadow-cljs server, a session can evaluate ClojureScript in a build\'s JS runtime: ' +
        'evaluate (shadow.cljs.devtools.api/repl :build) in it to switch, and :cljs/quit to switch back (status lists builds and which sessions are ClojureScript). ' +
        'The person sees every eval in their pAIrens REPL pane, marked as yours. ' +
        'Sessions share the image, but each keeps its own current package (Clojure: namespace) and *, **, *** (Clojure: *1, *2, *3): ' +
        '"user" is the person\'s own REPL session; pick your own session name (e.g. "claude" or "claude-tests") ' +
        "for background or long-running work so you don't disturb theirs; it shows as its own tab. " +
        'Returns output, return values or the error. An eval that outlasts timeout_seconds keeps running as a job: ' +
        'fetch it with job_result. The person sets a mode: ask (each eval needs approval), auto, or read-only ' +
        '(only inspection such as describe, documentation, apropos; in Clojure doc, source, dir, meta).',
      inputSchema: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'One or more forms in the connected language; each form\'s value is returned.' },
          session: { type: 'string', description: 'pAIrens session to evaluate in. Default "user".' },
          timeout_seconds: { type: 'number', description: 'How long to wait before handing back a job id. Default 30, max 55.' },
        },
        required: ['code'],
      },
    })
    await $.tool.register({
      name: 'history',
      description: "Read recent pAIrens REPL history: what the person and you evaluated, with output, values and errors, plus questions the person asked you (typed as 'pairens: …', or with (pairens:claude ...) in Common Lisp or (pairens/claude ...) in Clojure).",
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
      description:
        "pAIrens connection status (Common Lisp over Swank or Clojure over nREPL, the implementation and port), the person's eval mode, each session's current package or namespace, and any Lisp threads waiting in the debugger (with their restarts; Common Lisp only).",
    })
    await $.tool.register({
      name: 'debug_restart',
      description:
        'Pick a restart for a Lisp thread waiting in the debugger (for example after an error on a game\'s main thread). ' +
        'status lists waiting debuggers with their restarts; the person sees the same in pAIrens and may pick one themselves. ' +
        'Follows the person\'s eval mode: ask needs approval, read-only refuses.',
      inputSchema: {
        type: 'object',
        properties: {
          debugger: { type: 'string', description: 'The debugger id from status, e.g. "d123-1".' },
          restart: { type: 'string', description: 'The restart, by name (e.g. "RETRY-FRAME", "ABORT") or by its number.' },
        },
        required: ['debugger', 'restart'],
      },
    })

    await $.command.register({ name: 'pairens', description: 'Open the pAIrens Lisp REPL pane' })
    await $.command.register({
      name: 'pairens-mode',
      description: "Set how Claude's evals run: ask, auto or read-only",
      argumentHint: 'ask | auto | read-only',
    })
    await $.command.register({
      name: 'pairens-connect',
      description: 'Connect pAIrens to a running Swank (Common Lisp) or nREPL (Clojure) server',
      argumentHint: '[swank|nrepl] [host:]port',
    })
    await $.command.register({
      name: 'pairens-launch',
      description: "Start a REPL for pAIrens: SBCL with Swank, or Clojure with nREPL (the project's choice by default)",
      argumentHint: '[sbcl | clojure]',
    })
    await $.command.register({
      name: 'pairens-cljs',
      description: 'Switch the user session to ClojureScript in a shadow-cljs build, or back to Clojure with "quit"',
      argumentHint: '[build | quit]',
    })
    await $.command.register({ name: 'pairens-browser', description: 'Open the pAIrens REPL in your web browser' })
    await $.command.register({ name: 'pairens-help', description: 'Show pAIrens help in the REPL: keys, asking Claude, sessions, commands' })
    await $.command.register({
      name: 'pairens-disconnect',
      description: 'Disconnect pAIrens from the image (the Lisp or Clojure process keeps running)',
    })

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

  on('command.run', { command: 'pairens-help' }, async $ => {
    const tab = await read($, tabAtom)
    await showHelp($, tab || 'user')
    await $.ui.open({ id: PANE, title: 'pAIrens' })
    return { text: 'pAIrens help is in the REPL pane.' }
  })

  on('command.run', { command: 'pairens-mode' }, async ($, e) => {
    const wanted = e.args.trim()
    if (!isMode(wanted)) return { text: `Current mode: ${MODE_HELP[await read($, modeAtom)]}. Use ask, auto or read-only.` }
    await setMode($, wanted)
    return { text: `pAIrens mode: ${MODE_HELP[wanted]}.` }
  })

  on('command.run', { command: 'pairens-connect' }, async ($, e) => {
    const address = parseAddress(e.args)
    const { host, port } = address
    try {
      const s = await helper<PairensStatus>($, '/connect', address)
      return { text: `pAIrens connected to ${s.impl} over ${protocolName(s.protocol)} on ${host}:${port}.` }
    } catch (err) {
      return { text: `pAIrens could not connect to ${host}:${port}: ${String(err)}` }
    }
  })

  on('command.run', { command: 'pairens-launch' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const language = /^(clj|clojure|lein|nrepl)/.test(arg) ? 'clojure' : /^(sbcl|cl|lisp|common|swank)/.test(arg) ? 'common-lisp' : undefined
    const chosen = language ?? (await read($, statusAtom)).project?.language ?? 'common-lisp'
    void helper($, '/launch', { language: chosen }).catch(err => $.ui.toast(`pAIrens launch failed: ${String(err)}`))
    await $.ui.open({ id: PANE, title: 'pAIrens' })
    return {
      text:
        chosen === 'clojure'
          ? 'pAIrens is starting Clojure with nREPL (the first start may download dependencies); the pane shows when it is connected.'
          : 'pAIrens is starting SBCL with Swank; the pane shows when it is connected.',
    }
  })

  on('command.run', { command: 'pairens-browser' }, async $ => ({ text: await openBrowser($) }))

  on('command.run', { command: 'pairens-cljs' }, async ($, e) => {
    const arg = e.args.trim()
    const session = (await read($, tabAtom)) || 'user'
    try {
      if (/^(quit|clj|clojure|exit)$/i.test(arg)) {
        const entry = await helper<PairensEntry>($, '/eval', { session, code: ':cljs/quit', origin: 'user', timeoutMs: 20000 })
        return { text: entry.status === 'ok' ? `pAIrens session "${session}" is back in Clojure.` : `pAIrens: ${entry.error}` }
      }
      const entry = await helper<PairensEntry>($, '/cljs', { session, build: arg || undefined, origin: 'user', timeoutMs: 120000 })
      return {
        text:
          entry.status === 'ok'
            ? `pAIrens session "${session}" now evaluates ClojureScript (${(entry.values ?? []).join(' ')}). :cljs/quit or /pairens-cljs quit switches back.`
            : `pAIrens: ${entry.error}`,
      }
    } catch (err) {
      return { text: `pAIrens could not switch to ClojureScript: ${String(err)}` }
    }
  })

  on('command.run', { command: 'pairens-disconnect' }, async $ => {
    const before = await read($, statusAtom)
    if (!before.connected) return { text: 'pAIrens is not connected to an image.' }
    try {
      await helper($, '/disconnect', {})
      return {
        text: `pAIrens disconnected from ${before.impl} on ${before.host}:${before.port}. It keeps running; /pairens-connect ${[before.protocol, before.port].filter(Boolean).join(' ')} reconnects.`,
      }
    } catch (err) {
      return { text: `pAIrens could not disconnect: ${String(err)}` }
    }
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

  on('tool.check', { tool: 'mcp__pairens__debug_restart' }, async ($, e) => {
    const input = (e.input ?? {}) as { debugger?: string; restart?: string }
    const m = await read($, modeAtom)
    if (m === 'auto') return { decision: 'allow', reason: 'pAIrens is in auto mode' }
    if (m === 'read-only')
      return { decision: 'deny', reason: 'pAIrens is in read-only mode; ask the person to pick the restart.' }
    return { decision: 'ask', reason: `pAIrens (ask mode): Claude wants to pick restart ${input.restart} in debugger ${input.debugger}` }
  }).catch(() => ({ decision: 'ask', reason: 'pAIrens could not check this restart' }))

  // "open in Claude's browser": the press allows the one open it asked for.
  // Only the exact pAIrens page address, within the window, once, on the main
  // loop, and never past an organization's block. Every other call is left to
  // the session's own rules and prompts.
  on('tool.check', { tool: 'mcp__Claude_Browser__preview_start' }, allowPressedBrowserOpen)
  on('tool.check', { tool: 'mcp__Claude_Browser__navigate' }, allowPressedBrowserOpen)

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
      const entry = await helper<PairensEntry>($, '/eval', { session, code, origin: 'claude', timeoutMs })
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
      const entry = await helper<PairensEntry>($, '/job', {
        id: input.job,
        timeoutMs: Math.min(55, Math.max(0, input.wait_seconds ?? 0)) * 1000,
      })
      return { result: formatEvalResult(entry) }
    } catch (err) {
      return { result: `pAIrens: ${String(err)}`, isError: true as const }
    }
  })

  on('tool.call', { tool: 'mcp__pairens__debug_restart' }, async ($, e) => {
    const input = e as unknown as { debugger?: string; restart?: string | number }
    if ((await read($, modeAtom)) === 'read-only') return { deny: 'pAIrens is in read-only mode.' }
    const d = (await read($, debugsAtom)).find(x => x.id === input.debugger)
    if (!d) return { result: `pAIrens: no debugger ${input.debugger} is waiting (it may have been resolved).`, isError: true as const }
    const wanted = String(input.restart ?? '').trim()
    const index = /^\d+$/.test(wanted) ? Number(wanted) : d.restarts.findIndex(r => r.name.toUpperCase() === wanted.toUpperCase())
    if (index < 0 || index >= d.restarts.length)
      return { result: `pAIrens: no restart "${wanted}". Restarts:\n${d.restarts.map((r, i) => `${i}: ${r.name}`).join('\n')}`, isError: true as const }
    try {
      const r = await helper<{ restart: string }>($, '/restart', { id: d.id, index })
      return { result: `Invoked restart ${r.restart} in debugger ${d.id}.` }
    } catch (err) {
      return { result: `pAIrens: ${String(err)}`, isError: true as const }
    }
  })

  on('tool.call', { tool: 'mcp__pairens__status' }, async $ => {
    const s = await read($, statusAtom)
    const m = await read($, modeAtom)
    const debugs = await read($, debugsAtom)
    let sessions = ''
    try {
      const r = await helper<{ sessions: { name: string; package: string; cljs?: string }[] }>($, '/sessions', {})
      sessions = r.sessions
        .map(x => `  ${x.name}: ${shortPackage(x.package)}${x.cljs ? ` (ClojureScript, shadow-cljs build :${x.cljs})` : ''}`)
        .join('\n')
    } catch {}
    const shadow = s.connected && s.shadow
      ? `shadow-cljs builds: ${s.shadow.builds
          .map(b => `:${b}${s.shadow?.watching.includes(b) ? ` (watching, ${s.shadow?.runtimes[b] ?? 0} JS runtime(s) connected)` : ''}`)
          .join(', ')}. To evaluate ClojureScript in a session, eval (shadow.cljs.devtools.api/repl :build) there` +
        ' (start watching first with (shadow.cljs.devtools.api/watch :build) if needed; a build needs a connected JS runtime: the app running). :cljs/quit switches back. ' +
        'From ClojureScript code the person asks you by typing "pairens: …"; (pairens/claude ...) is Clojure only.'
      : ''
    const conn = s.connected
      ? `Connected to ${s.impl} via ${protocolName(s.protocol)} on ${s.host}:${s.port}. From code the person asks you with ${claudeCall(s)}.`
      : `Not connected${s.error ? ` (${s.error})` : ''}`
    return {
      result: [
        conn,
        shadow,
        `Mode: ${MODE_HELP[m]}`,
        sessions ? `Sessions:\n${sessions}` : 'No sessions yet.',
        debugs.length ? `Waiting in the debugger:\n${debugs.map(formatDebug).join('\n\n')}` : 'No Lisp thread is in the debugger.',
        s.browserUrl ? 'The person can also open this REPL in a browser with /pairens-browser.' : '',
      ]
        .filter(Boolean)
        .join('\n'),
    }
  })

  // --- the pane ---------------------------------------------------------------

  // The pane keeps its own window: the editor and controls stay pinned at the
  // bottom, and a scroll over the pane moves through the history instead.
  // The REPL is part of the pane's height, so the pane's own scrolling moves
  // it: every move goes through. The classic view (VS Code, or after the REPL
  // faulted) keeps a fixed window of its own, so the person's scrolling also
  // steps it through the history, entry by entry.
  on('ui.scroll', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    // `origin` is the engine's word; read it warily, as a test's raise may lack it.
    if (e.origin?.kind === 'person') {
      const all = await read($, entriesAtom)
      const selected = await read($, tabAtom)
      const count = all.filter(x => x.session === selected).length
      const step = Math.sign(e.by) * Math.max(1, Math.round(Math.abs(e.by) / 3))
      await update($, scrollBackAtom, n => Math.min(Math.max(0, count - 1), Math.max(0, (n ?? 0) - step)))
    }
    return next(e)
  })

  // What the REPL Client asks of the hooks: an eval, the clipboard to paste,
  // or text to copy. Its posts are input from code: checked before use.
  on('ui.message', { requestId: PANE }, async ($, e) => {
    const data = e.data as { type?: unknown; code?: unknown; id?: unknown; text?: unknown; session?: unknown; prefix?: unknown; token?: unknown } | null
    if (!data || typeof data !== 'object') return {}
    if (data.type === 'eval' && typeof data.code === 'string') {
      const all = await read($, entriesAtom)
      const sessions = new Set(['user', ...all.map(x => x.session)])
      const tab = await read($, tabAtom)
      evalIn($, sessions.has(tab) ? tab : 'user', data.code)
    } else if (data.type === 'paste' && typeof data.id === 'number') {
      // A Client gets Cmd+V as a key, never the clipboard's text: read it here.
      const id = data.id
      const r = await $.process.run(['pbpaste']).catch(() => null)
      if (!r || r.exitCode !== 0) $.ui.toast('pAIrens could not read the clipboard')
      await update($, pasteAtom, () => ({ id, text: r?.exitCode === 0 ? r.stdout : '' }))
    } else if (data.type === 'copy' && typeof data.text === 'string') {
      const r = await $.ui.copy({ text: data.text, surface: e.surface })
      if (!r.isCopied) $.ui.toast(`pAIrens could not copy: ${r.reason}`)
    } else if (data.type === 'end') {
      void toEnd($)
    } else if (data.type === 'complete' && typeof data.id === 'number' && typeof data.prefix === 'string') {
      // Tab: ask the image what the prefix could complete to, in the shown session.
      const id = data.id
      const prefix = data.prefix.slice(0, 200)
      const all = await read($, entriesAtom)
      const tab = await read($, tabAtom)
      const session = tab === 'user' || all.some(x => x.session === tab) ? tab : 'user'
      // No helper started (yet): nothing to offer, rather than waiting on it.
      const r = socketPath
        ? await helper<{ items?: Completion[] }>($, '/complete', { session, prefix }).catch(() => ({ items: [] }))
        : { items: [] }
      await update($, completionAtom, () => ({ id, items: plain(r.items ?? []).slice(0, 60) }))
    } else if (data.type === 'describe' && typeof data.id === 'number' && typeof data.token === 'string') {
      // Option-click: ask the image what the token names, in the shown session.
      const id = data.id
      const token = data.token.slice(0, 300)
      const all = await read($, entriesAtom)
      const tab = await read($, tabAtom)
      const session = tab === 'user' || all.some(x => x.session === tab) ? tab : 'user'
      const r = socketPath
        ? await helper<{ description?: Description | null }>($, '/describe', { session, token }).catch(() => ({ description: null }))
        : { description: null }
      await update($, describedAtom, () => ({ id, description: r.description ? plain(r.description) : null }))
    } else if (data.type === 'tab' && typeof data.session === 'string') {
      const all = await read($, entriesAtom)
      const name = data.session
      if (name === 'user' || all.some(x => x.session === name)) {
        await update($, tabAtom, () => name)
        await update($, scrollBackAtom, () => 0)
        void toEnd($)
      }
    }
    return {}
  })

  // The REPL Client failed: say why, and draw the classic view on that surface
  // until the next reload.
  on('ui.fault', { requestId: PANE }, async ($, e, next) => {
    await update($, replFaultAtom, () => ({ surface: e.surface, reason: e.reason }))
    $.ui.toast(`pAIrens REPL failed (${e.phase}): ${e.reason}. Showing the classic view.`)
    return next(e)
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
    const debugs = await read($, debugsAtom)
    const bodyRows = e.props.scroll?.bodyRows ?? e.viewport?.rows ?? 40

    if (e.surface === 'mobile') {
      const { Text } = $.ui.resolve(e)
      return <Text>pAIrens needs a surface with text input (desktop or terminal).</Text>
    }
    const els = $.ui.resolve(e)
    const { Box, Text, Button, Input, Select } = els
    // Desktop and terminal draw the REPL as a Client (hooks/repl.tsx); VS Code
    // has no Client, and a Client that failed here falls back the same way.
    const fault = await read($, replFaultAtom)
    const Client = 'Client' in els && fault?.surface !== e.surface ? els.Client : undefined

    const tabBuild = status.cljsSessions?.[selected]
    const statusLine = status.connected
      ? `● ${tabBuild ? `ClojureScript :${tabBuild} via ` : ''}${status.impl} · ${protocolName(status.protocol)} ${status.host}:${status.port}` +
        (status.compiling ? ` · compiling :${status.compiling}…` : '')
      : status.launching
        ? status.launchingWhat && status.launchingWhat !== 'SBCL'
          ? `◌ starting ${status.launchingWhat} with nREPL…`
          : '◌ starting SBCL with Swank…'
        : status.helper === 'starting'
          ? '◌ starting pAIrens…'
          : `○ not connected${status.error ? ` (${status.error})` : ''}`

    const evalHere = (code: string) => evalIn($, selected, code)

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

    const tabsProps: TabsProps = { view: 'tabs', session: selected, sessions }
    const replProps: ReplProps = {
      prompt: `${pkg}>`,
      session: selected,
      entries: plain(newestThatFit(shown)),
      history: shown.filter(x => x.kind === 'eval' && x.origin === 'user').map(x => x.text).slice(-100),
      paneFocused: e.props.isFocused,
      paste: await read($, pasteAtom),
      completion: await read($, completionAtom),
      described: await read($, describedAtom),
    }

    return (
      // The classic view keeps a fixed window; the REPL is the pane's own height.
      <Box flexDirection="column" height={Client ? undefined : bodyRows}>
        {Client ? (
          // The REPL: tabs, history and input as one transcript, as tall as it
          // is; the pane scrolls it and the hooks keep it at the end.
          <Box key="history" flexDirection="column">
            <Client key="repl" module="./repl.tsx" props={replProps} />
          </Box>
        ) : (
          // history: fills the room above the editor, newest at the bottom
          <Box key="history" flexDirection="column" flexGrow={1} flexShrink={1} overflow="hidden" justifyContent="flex-end" gap={1}>
            {rows.length ? rows : [<Text key="empty" dimColor>Nothing evaluated in "{selected}" yet. Try typing: pairens: hello!</Text>]}
          </Box>
        )}

        {/* pinned: debugger, editor, then status and controls */}
        <Box key="footer" flexDirection="column" flexShrink={0} gap={1} paddingTop={1} paddingBottom={1}>
          {debugs.map(d => (
            <Box key={`debug-${d.id}`} flexDirection="column" borderStyle="round" borderColor="warning" paddingX={1}>
              <Text color="warning" bold>
                Debugger: {d.message}
              </Text>
              <Text dimColor>
                {d.type} · thread {d.thread} · level {d.level}
              </Text>
              <Box flexDirection="row" gap={1} flexWrap="wrap">
                {d.restarts.map((r, index) => (
                  <Button
                    key={`restart-${d.id}-${index}`}
                    onPress={() => void helper($, '/restart', { id: d.id, index }).catch(err => $.ui.toast(`pAIrens: ${String(err)}`))}
                  >
                    {r.name}
                  </Button>
                ))}
              </Box>
            </Box>
          ))}
          {!Client && shown.length > 1 ? (
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

          {Client ? null : (
          <Box flexDirection="column">
            <Input
              key="repl"
              label={`${pkg}>`}
              value={draft}
              placeholder="(+ 1 2)"
              submitLabel="eval"
              rows={3}
              autoFocus
              onInput={value => void update($, draftAtom, () => value)}
              onSubmit={value => {
                evalHere(value)
                void update($, draftAtom, () => '')
              }}
            />
          </Box>
          )}

          {/* the session tabs sit right on the connection line */}
          <Box flexDirection="column">
          {Client ? (
            <Client key="tabs" module="./repl.tsx" props={tabsProps} />
          ) : (
            <Box key="tabs" flexDirection="row" gap={1} flexWrap="wrap">
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
            </Box>
          )}
          <Box flexDirection="row" gap={1} alignItems="center" flexWrap="wrap">
            <Text dimColor={!status.connected} color={status.connected ? 'success' : undefined}>
              {statusLine}
            </Text>
            {status.connected ? (
              <Button
                key="disconnect"
                plain
                dimColor
                onPress={() => void helper($, '/disconnect', {}).catch(err => $.ui.toast(`pAIrens: ${String(err)}`))}
              >
                ⏏ disconnect
              </Button>
            ) : null}
            {status.browserUrl ? (
              <Button key="browser" plain dimColor onPress={() => void openBrowser($).then(t => $.ui.toast(t))}>
                ↗ open in browser
              </Button>
            ) : null}
            {status.browserUrl && e.surface === 'desktop' ? (
              // Only the desktop app has a browser pane of Claude's.
              <Button key="claude-browser" plain dimColor onPress={() => void openInClaudesBrowser($).then(t => $.ui.toast(t))}>
                ↗ open in Claude's browser
              </Button>
            ) : null}
            <Button key="clear" plain dimColor onPress={() => void clearSession($, selected)}>
              ⌫ clear "{selected}"
            </Button>
          </Box>
          </Box>

          {status.connected && status.shadow?.builds.length ? (
            <Box flexDirection="row" gap={1} alignItems="center" flexWrap="wrap">
              <Text dimColor>ClojureScript:</Text>
              {tabBuild ? (
                <Button
                  key="cljs-quit"
                  onPress={() =>
                    void helper($, '/eval', { session: selected, code: ':cljs/quit', origin: 'user', timeoutMs: 0 }).catch(err =>
                      $.ui.toast(`pAIrens: ${String(err)}`),
                    )
                  }
                >
                  back to Clojure
                </Button>
              ) : (
                status.shadow.builds.slice(0, 6).map(build => (
                  <Button
                    key={`cljs-${build}`}
                    onPress={() =>
                      void helper($, '/cljs', { session: selected, build, origin: 'user', timeoutMs: 0 }).catch(err =>
                        $.ui.toast(`pAIrens: ${String(err)}`),
                      )
                    }
                  >
                    :{build}
                  </Button>
                ))
              )}
              {tabBuild && !status.shadow.runtimes[tabBuild] ? <Text color="warning">no JS runtime connected; start the app</Text> : null}
            </Box>
          ) : null}

          {!status.connected && !status.launching ? (
            <Box flexDirection="column" gap={1}>
              <Box flexDirection="row" gap={1}>
                {(status.project?.language === 'clojure' ? (['clojure', 'common-lisp'] as const) : (['common-lisp', 'clojure'] as const)).map(
                  (language, i) => (
                    <Button
                      key={`launch-${language}`}
                      variant={i === 0 ? 'primary' : 'secondary'}
                      onPress={() => void helper($, '/launch', { language }).catch(err => $.ui.toast(`pAIrens: ${String(err)}`))}
                    >
                      {language === 'clojure' ? 'Launch Clojure' : 'Launch SBCL'}
                    </Button>
                  ),
                )}
              </Box>
              <Input
                key="port"
                label="Or connect to a running Swank or nREPL"
                placeholder="port or host:port"
                submitLabel="Connect"
                onSubmit={value => {
                  void helper($, '/connect', parseAddress(value)).catch(err =>
                    $.ui.toast(`pAIrens could not connect: ${String(err)}`),
                  )
                }}
              />
            </Box>
          ) : null}

          {/* the permission mode picker, and on the same line, About */}
          <Box flexDirection="row" gap={2} alignItems="center" flexWrap="wrap">
            <Select
              key="mode"
              label="Claude's permission mode"
              value={mode}
              options={MODE_OPTIONS}
              onSelect={value => {
                if (isMode(value)) void setMode($, value)
              }}
            />
            <Button key="about" plain dimColor onPress={() => void openAbout($).then(t => $.ui.toast(t))}>
              ⓘ About pAIrens
            </Button>
          </Box>

        </Box>
      </Box>
    )
  })
}
