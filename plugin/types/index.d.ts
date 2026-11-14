/** Who caused a history entry. */
export type PairensOrigin = 'user' | 'claude' | 'editor' | 'lisp'

/** One row of a pAIrens session's history. */
export type PairensEntry = {
  id: string
  session: string
  origin: PairensOrigin
  kind: 'eval' | 'ask' | 'reply' | 'output' | 'note'
  /** eval: the code; ask: the prompt; reply: Claude's answer; output/note: the text */
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
  launching?: boolean
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
    }
  }
}
