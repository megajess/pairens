/** Who caused a history entry. */
export type PairensOrigin = 'user' | 'claude' | 'editor' | 'lisp'

/** One row of a pAIrens session's history. */
export type PairensEntry = {
  id: string
  session: string
  origin: PairensOrigin
  kind: 'eval' | 'ask' | 'reply' | 'output' | 'note' | 'help'
  /** eval: the code; ask: the prompt; reply: Claude's answer; output/note/help: the text */
  text: string
  status?: 'running' | 'ok' | 'error'
  package?: string
  output?: string
  values?: string[]
  error?: string
  at: number
}

export type PairensStatus = {
  helper: 'starting' | 'ready' | 'failed'
  connected: boolean
  host?: string | null
  port?: number | null
  impl?: string | null
  /** How pAIrens talks to the image: Swank (Common Lisp) or nREPL (Clojure). */
  protocol?: 'swank' | 'nrepl' | null
  /** 'Common Lisp' or 'Clojure' while connected. */
  language?: string | null
  launching?: boolean
  /** What Launch is starting: 'SBCL', 'Clojure' or 'Leiningen'. */
  launchingWhat?: string | null
  /** What the project folder looks like: which language Launch starts by default. */
  project?: { language: 'common-lisp' | 'clojure'; deps: boolean; lein: boolean; shadow?: boolean } | null
  /** When connected to a shadow-cljs server: its builds, the watched ones, and JS runtimes per watched build. */
  shadow?: { builds: string[]; watching: string[]; runtimes: Record<string, number> } | null
  /** Sessions evaluating ClojureScript: session name → shadow-cljs build. */
  cljsSessions?: Record<string, string>
  /** A shadow-cljs build being compiled before a session switches to it. */
  compiling?: string | null
  error?: string | null
  /** The person disconnected on purpose; a reload doesn't reconnect. */
  disconnectedByUser?: boolean
  /** The browser page's address, key included, while the helper serves it. */
  browserUrl?: string | null
}

/** A Lisp thread waiting in the debugger, as the helper reports it. */
export type PairensDebug = {
  /** `d<thread>-<level>` */
  id: string
  thread: number
  level: number
  message: string
  type: string
  restarts: { name: string; description: string }[]
  frames: string[]
  at: number
}

/** One thing a prefix could complete to, as the image reports it. */
export type Completion = {
  /** The whole token to put in place of the prefix (`mapcar`, `sb-ext:gc`, `s/join`). */
  text: string
  /** `function`, `macro`, `special`, `variable`, `class`, `keyword`, `namespace` or `symbol`. */
  kind: string
  /** The function's argument list, printed short; '' when none. */
  args: string
}

/** What a symbol names, as the image describes it for Option-click. */
export type Description = {
  /** The symbol, qualified only where the session can't see it as is. */
  name: string
  kind: string
  /** Its argument list, printed short; '' when none. */
  args: string
  /** Its documentation string; '' when none. */
  doc: string
}

/** The props the pane hands its REPL Client (hooks/repl.tsx): plain data only. */
export type ReplProps = {
  /** The input's prompt, `CL-USER>`. */
  prompt: string
  /** The session shown; a change returns the transcript to the bottom. */
  session: string
  /** The session's history drawn above the input, oldest first. */
  entries: PairensEntry[]
  /** The person's earlier forms in this session, oldest first, for Up and Down. */
  history: string[]
  /** The pane holds the keyboard (Pane's isFocused). */
  paneFocused: boolean
  /** Clipboard text the hooks read for a paste the REPL asked for. */
  paste: { id: number; text: string } | null
  /** What the image offered for the REPL's last Tab, by the request's id. */
  completion: { id: number; items: Completion[] } | null
  /** What the image said of the REPL's last Option-click, by the request's id (null: nothing known). */
  described: { id: number; description: Description | null } | null
}

/** The props of the session tabs, a second instance of hooks/repl.tsx. */
export type TabsProps = {
  view: 'tabs'
  /** The session shown. */
  session: string
  /** Every session, in tab order. */
  sessions: string[]
}

/** What the REPL Client posts to the hooks module. */
export type ReplPost =
  | { type: 'eval'; code: string }
  | { type: 'paste'; id: number }
  | { type: 'copy'; text: string }
  | { type: 'tab'; session: string }
  /** The input changed: scroll the pane to its end, where the input is. */
  | { type: 'end' }
  /** Tab after PREFIX: ask the image what it could complete to. */
  | { type: 'complete'; id: number; prefix: string }
  /** Option-click on TOKEN: ask the image what it names. */
  | { type: 'describe'; id: number; token: string }

/** ask: Claude's evals go through the permission prompt; auto: they run;
 * read-only: only inspection calls run. */
export type PairensMode = 'ask' | 'auto' | 'read-only'

declare module 'claude-code' {
  interface PluginState {
    pairens: {
      entries: Shaped<PairensEntry[]>
      status: Shaped<PairensStatus>
      mode: Shaped<PairensMode>
      tab: Shaped<string>
      /** what is typed in the REPL input, so an eval can clear it */
      draft: Shaped<string>
      /** how many history entries the pane is scrolled back from the newest */
      scrollBack: Shaped<number>
      /** Lisp threads waiting in the debugger */
      debugs: Shaped<PairensDebug[]>
      /** clipboard text read for the REPL's last Cmd+V */
      paste: Shaped<{ id: number; text: string } | null>
      /** what the image offered for the REPL's last Tab */
      completion: Shaped<{ id: number; items: Completion[] } | null>
      /** what the image said of the REPL's last Option-click */
      described: Shaped<{ id: number; description: Description | null } | null>
      /** the REPL Client failed on this surface: the pane draws the classic view there */
      replFault: Shaped<{ surface: string; reason: string } | null>
    }
  }
}
