# pAIrens

**A Lisp REPL you and Claude share.** pAIrens is a mod for [Claude Code](https://claude.com/claude-code). It adds a REPL pane beside the chat, connected to your live Lisp image. You evaluate code there, Claude can evaluate code there, and either of you can see what the other did.

- **Common Lisp** over Swank (SLIME's server). Available now.
- **Clojure / ClojureScript** over nREPL. Coming soon.

Website: <https://pairens.dev>

## What it does

- **A REPL pane beside the chat.** The input stays pinned at the bottom, and the history shows output, values and errors. Each session (tab) keeps its own current package and `*`, `**`, `***`, all in one shared image.
- **Or in its own browser window.** `/pairens-browser` opens the same REPL as a local web page: a real code editor with Lisp highlighting, paren matching and ↑/↓ input history, plus normal scrolling and copy/paste. It shares one history with the pane, and the page runs only on your machine (`127.0.0.1`), protected by a private key.
- **Ask Claude right from the REPL.** Start a line with `pairens:` in the pane or the browser page:
  ```
  pairens: why is this nil?
  ```
  It goes to Claude as plain text (no quotes needed, apostrophes and parens are fine), and Claude's answer shows up in the REPL.
- **Or from Lisp code and SLIME.** `(pairens:claude "why is this nil?")` does the same from any REPL connected to the image, SLIME and Sly included, where the reply prints as `;;` comments. To send a value along: `(pairens:claude "explain this" (my-fn 3))`.
- **Claude uses the REPL too.** It inspects and evaluates code in your running image, and every eval shows in the pane marked `✻`. Long-running work goes into a session of Claude's own.
- **Debugger with restarts.** When a Lisp thread hits an error (a game's main loop, a worker), pAIrens shows the condition, its restarts (`RETRY`, `ABORT`, your own) and a backtrace. You pick one, or let Claude.
- **You choose how Claude's evals and restarts run** (`/pairens-mode`):
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

  Questions asked with `(pairens:claude …)` from SLIME are picked up fastest on SBCL. Other implementations work, but poll for questions instead.

## Use

| | |
|---|---|
| `/pairens` | Open the pane |
| `/pairens-browser` | Open the REPL in your web browser |
| `/pairens-launch` | Start SBCL with Swank (it keeps running after the mod reloads) |
| `/pairens-connect [host:]port` | Connect to a running Swank |
| `/pairens-disconnect` | Disconnect (the Lisp keeps running) |
| `/pairens-mode ask \| auto \| read-only` | Set how Claude's evals run |

On startup, pAIrens connects on its own to the port in `./.swank-port`, or failing that to port 4005.

The browser page lives at `http://127.0.0.1:4747/`, or the next free port. Its full address, including the key, is in `~/.pairens/endpoint.json`. It works while a Claude Code session with pAIrens is running, and otherwise says it's offline and reconnects by itself.

## What pAIrens runs and connects to

Everything pAIrens does happens on your machine. It has no server of its own, sends no analytics, and talks to nothing on the internet.

- **A helper process.** When the mod loads, it runs `node helper/pairens-helper.mjs` from the plugin folder. The helper holds the REPL connection and the shared history, and stops when Claude Code unloads the mod.
- **A Unix socket between the mod and the helper**, at `/tmp/pairens-<random>.sock`.
- **The browser page**, an HTTP server on `127.0.0.1` only, port 4747 or one of the next nine. Its API answers only requests that carry the random key in `~/.pairens/endpoint.json`, and it refuses requests from other web pages.
- **Your Lisp image.** The helper opens a plain TCP connection to Swank: the port in `./.swank-port`, or `127.0.0.1:4005`, or the host and port you give `/pairens-connect`. Swank isn't encrypted, so connect to another machine only over a network you trust.
- **SBCL, when you ask for it.** **Launch SBCL** or `/pairens-launch` starts `sbcl` in the background with `/bin/sh` and `nohup`, in the folder Claude Code is working in. It loads Quicklisp from `~/quicklisp` or `~/.quicklisp` if you have it, and loads Swank through Quicklisp. If Swank isn't installed yet, Quicklisp downloads it from its usual servers. SBCL then loads `lisp/pairens.lisp`, starts Swank on a free port, and writes that port to `./.swank-port`. SBCL keeps running after the mod stops, so your image survives a reload. To find `sbcl`, the helper also looks in `/opt/homebrew/bin` and `/usr/local/bin`.
- **Files it writes:** `~/.pairens/endpoint.json` (readable only by you), SBCL's output in `~/.pairens/logs/`, and `./.swank-port` when it launches SBCL.
- **Questions for Claude** go to the Claude Code session you're already in, as ordinary turns. pAIrens doesn't call any API itself.
- **The browser page's editor** is a bundle of CodeMirror and marked. [`browser/vendor/README.md`](https://github.com/megajess/pairens/blob/main/plugin/browser/vendor/README.md) lists the versions, licenses and source.

## Support the project

pAIrens is free and MIT-licensed. If it's useful to you, you can [sponsor its development](https://github.com/sponsors/megajess).

## License

[MIT](LICENSE) © 2026 Jesse Suter (megajess)

*pAIrens is an independent project. It is not made, endorsed or sponsored by Anthropic.*
