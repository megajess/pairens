# pAIrens

**A Lisp REPL you and Claude share.** pAIrens is a mod for [Claude Code](https://claude.com/claude-code). It adds a REPL pane beside the chat, connected to your live Lisp image. You evaluate code there, Claude can evaluate code there, and either of you can see what the other did.

- **Common Lisp** over Swank (SLIME's server). Available now.
- **Clojure / ClojureScript** over nREPL. Coming soon.

Website: <https://megajess.github.io/pairens/>

## What it does

- **A REPL pane beside the chat.** The input stays pinned at the bottom, and the history shows output, values and errors. Each session (tab) keeps its own current package and `*`, `**`, `***`, all in one shared image.
- **Ask Claude from your REPL.** `(pairens:claude "why is this nil?")` returns right away, and Claude's answer shows up in the REPL. To send a value along: `(pairens:claude "explain this" (my-fn 3))`. This also works from SLIME or Sly connected to the same image, where the reply prints as `;;` comments.
- **Claude uses the REPL too.** It inspects and evaluates code in your running image, and every eval shows in the pane marked `✻`. Long-running work goes into a session of Claude's own.
- **You choose how Claude's evals run** (`/pairens-mode`):
  - `ask`: you approve each one.
  - `auto`: they run straight away.
  - `read-only`: only inspection is allowed (`describe`, `documentation`, `apropos`, …).

pAIrens uses the Claude Code session you're already signed in to. It needs no API key and never sees your credentials. Questions you ask from the REPL become ordinary turns in that session.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install pairens --marketplace megajess/pairens
```

Or from a shell:

```bash
claude plugin install pairens --marketplace megajess/pairens
```

In the Claude desktop app:
1. Click **+** next to the prompt box, then **Plugins**.
2. Choose **Add marketplace** and enter `megajess/pairens`.
3. Choose **Add plugin**.

## Requirements

- **Claude Code**, in the desktop app or the terminal. pAIrens relies on Claude Code's mod API, which is in early access and can change between releases. This release was tested with Claude Code 2.1.325.
- **Node.js**, which runs the small helper that holds the REPL connection.
- **A Common Lisp image with Swank.** Either way works:
  - Let pAIrens start one: **Launch SBCL** in the pane, or `/pairens-launch`. This needs SBCL plus Quicklisp with Swank available.
  - Start Swank yourself, e.g. `(swank:create-server :port 4005 :dont-close t)`, then connect with **Connect** in the pane or `/pairens-connect 4005`.

  `(pairens:claude …)` replies arrive fastest on SBCL. Other implementations work, but poll for questions instead.

## Use

| | |
|---|---|
| `/pairens` | Open the pane |
| `/pairens-launch` | Start SBCL with Swank (it keeps running after the mod reloads) |
| `/pairens-connect [host:]port` | Connect to a running Swank |
| `/pairens-mode ask \| auto \| read-only` | Set how Claude's evals run |

On startup, pAIrens connects on its own to the port in `./.swank-port`, or failing that to port 4005.

## Support the project

pAIrens is free and MIT-licensed. If it's useful to you, you can [sponsor its development](https://github.com/sponsors/megajess).

## License

[MIT](LICENSE) © 2026 Jesse Suter (megajess)

*pAIrens is an independent project. It is not made, endorsed or sponsored by Anthropic.*
