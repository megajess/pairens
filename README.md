# pAIrens

**A Lisp REPL you and Claude share.** pAIrens is a mod for [Claude Code](https://claude.com/claude-code). It adds a REPL pane beside the chat, connected to your live Lisp or Clojure image. You evaluate code there, Claude can evaluate code there, and either of you can see what the other did.

- **Common Lisp** over Swank (SLIME's server).
- **Clojure** over nREPL (the server CIDER, Calva and Cursive use).
- **ClojureScript** through shadow-cljs's nREPL, evaluated in your running app.

Website: <https://pairens.dev>

## What it does

- **A REPL pane beside the chat.** The input stays pinned at the bottom, and the history shows output, values and errors. Each session (tab) keeps its own current package and `*`, `**`, `***` (in Clojure: namespace and `*1`, `*2`, `*3`), all in one shared image.
- **Or in its own browser window.** `/pairens-browser` opens the same REPL as a local web page: a real code editor with Lisp and Clojure highlighting, bracket matching and ↑/↓ input history, plus normal scrolling and copy/paste. It shares one history with the pane, and the page runs only on your machine (`127.0.0.1`), protected by a private key.
- **Ask Claude right from the REPL.** Start a line with `pairens:` in the pane or the browser page:
  ```
  pairens: why is this nil?
  ```
  It goes to Claude as plain text (no quotes needed, apostrophes and parens are fine), and Claude's answer shows up in the REPL.
- **Or from code and your editor's REPL.** `(pairens:claude "why is this nil?")` in Common Lisp, or `(pairens/claude "why is this nil?")` in Clojure, does the same from any REPL connected to the image (SLIME, Sly, CIDER, Calva, …), where the reply prints as `;;` comments. To send a value along: `(pairens/claude "explain this" (my-fn 3))`.
- **Claude uses the REPL too.** It inspects and evaluates code in your running image, and every eval shows in the pane marked `✻`. Long-running work goes into a session of Claude's own.
- **ClojureScript in your running app.** Connected to a shadow-cljs server, any tab can switch to a build (the build's button in the pane or page, or `/pairens-cljs app`): its code then runs in the app's JS runtime, in the browser or Node, until **back to Clojure** or `:cljs/quit`. Claude can do the same in its own session. From ClojureScript, ask Claude with the `pairens:` prefix; `(pairens/claude …)` is Clojure only.
- **Debugger with restarts** (Common Lisp). When a Lisp thread hits an error (a game's main loop, a worker), pAIrens shows the condition, its restarts (`RETRY`, `ABORT`, your own) and a backtrace. You pick one, or let Claude.
- **You choose how Claude's evals and restarts run** (`/pairens-mode`):
  - `ask`: you approve each one.
  - `auto`: they run straight away.
  - `read-only`: only inspection is allowed (`describe`, `documentation`, `apropos`, …; in Clojure `doc`, `source`, `dir`, `meta`, …).

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
- **For Common Lisp, an image with Swank.** Either way works:
  - Let pAIrens start one: **Launch SBCL** in the pane, or `/pairens-launch sbcl`. This needs SBCL plus Quicklisp with Swank available.
  - Start Swank yourself, e.g. `(swank:create-server :port 4005 :dont-close t)`, then connect with **Connect** in the pane or `/pairens-connect 4005`.

  Questions asked with `(pairens:claude …)` from SLIME are picked up fastest on SBCL. Other implementations work, but poll for questions instead.
- **For Clojure, a JDK and an nREPL server.** Either way works:
  - Let pAIrens start one: **Launch Clojure** in the pane, or `/pairens-launch clojure`. In a folder with `project.clj` (and no `deps.edn`) this runs Leiningen; otherwise it needs the [Clojure CLI](https://clojure.org/guides/install_clojure), which adds nREPL to your project's dependencies for that run.
  - Start nREPL yourself the way you usually do (`clj -M:nrepl`, `lein repl`, your editor's jack-in). pAIrens finds it through `./.nrepl-port`, or connect with `/pairens-connect nrepl 7888`.
- **For ClojureScript, [shadow-cljs](https://shadow-cljs.github.io/docs/UsersGuide.html)** (installed in the project with npm, or on your `PATH`) and the app running so it can connect: open its page, or run it with Node.
  - Let pAIrens start the shadow-cljs server: **Launch Clojure** in a folder with `shadow-cljs.edn`.
  - Or run `shadow-cljs server` or `shadow-cljs watch app` yourself. pAIrens finds it through `./.shadow-cljs/nrepl.port`.

## Use

| | |
|---|---|
| `/pairens` | Open the pane |
| `/pairens-browser` | Open the REPL in your web browser |
| `/pairens-launch [sbcl \| clojure]` | Start SBCL with Swank, or Clojure with nREPL (it keeps running after the mod reloads). Without an argument, Clojure in a Clojure project, else SBCL. |
| `/pairens-connect [swank\|nrepl] [host:]port` | Connect to a running Swank or nREPL. Without `swank` or `nrepl`, pAIrens works out which it is. |
| `/pairens-cljs [build \| quit]` | Switch the current tab to ClojureScript in a shadow-cljs build (starting its watch if needed), or back to Clojure |
| `/pairens-disconnect` | Disconnect (the Lisp or Clojure process keeps running) |
| `/pairens-mode ask \| auto \| read-only` | Set how Claude's evals run |

On startup, pAIrens connects on its own to the nREPL port in `./.nrepl-port` or `./.shadow-cljs/nrepl.port`, else to the Swank port in `./.swank-port`, else to Swank on port 4005.

The browser page lives at `http://127.0.0.1:4747/`, or the next free port. Its full address, including the key, is in `~/.pairens/endpoint.json`. It works while a Claude Code session with pAIrens is running, and otherwise says it's offline and reconnects by itself.

## What pAIrens runs and connects to

Everything pAIrens does happens on your machine. It has no server of its own, sends no analytics, and talks to nothing on the internet. The only downloads are the ones the Lisp and Clojure tools it starts for you make themselves, described below.

- **A helper process.** When the mod loads, it runs `node helper/pairens-helper.mjs` from the plugin folder. The helper holds the REPL connection and the shared history, and stops when Claude Code unloads the mod.
- **A Unix socket between the mod and the helper**, at `/tmp/pairens-<random>.sock`.
- **The browser page**, an HTTP server on `127.0.0.1` only, port 4747 or one of the next nine. Its API answers only requests that carry the random key in `~/.pairens/endpoint.json`, and it refuses requests from other web pages.
- **Your Lisp image.** The helper opens a plain TCP connection to Swank: the port in `./.swank-port`, or `127.0.0.1:4005`, or the host and port you give `/pairens-connect`. Swank isn't encrypted, so connect to another machine only over a network you trust.
- **Your Clojure process.** The helper opens a plain TCP connection to nREPL: the port in `./.nrepl-port` or `./.shadow-cljs/nrepl.port`, or the host and port you give `/pairens-connect`. nREPL isn't encrypted either. pAIrens evaluates `clojure/pairens.clj` there (the `pairens` namespace), opens nREPL sessions for the REPL's tabs and its own use, and closes them when it disconnects. When you connect to a port without saying `swank` or `nrepl`, pAIrens first sends that port an nREPL `describe` request (or, on Swank's usual ports, a Swank request) to find out which server it is.
- **SBCL, when you ask for it.** **Launch SBCL** or `/pairens-launch` starts `sbcl` in the background with `/bin/sh` and `nohup`, in the folder Claude Code is working in. It loads Quicklisp from `~/quicklisp` or `~/.quicklisp` if you have it, and loads Swank through Quicklisp. If Swank isn't installed yet, Quicklisp downloads it from its usual servers. SBCL then loads `lisp/pairens.lisp`, starts Swank on a free port, and writes that port to `./.swank-port`. SBCL keeps running after the mod stops, so your image survives a reload. To find `sbcl`, the helper also looks in `/opt/homebrew/bin` and `/usr/local/bin`.
- **Clojure, when you ask for it.** **Launch Clojure** or `/pairens-launch clojure` starts, in the background with `/bin/sh` and `nohup` in the folder Claude Code is working in, one of: `shadow-cljs server` (for a folder with `shadow-cljs.edn`; the project's `node_modules/.bin/shadow-cljs` if there is one, else `shadow-cljs` on your `PATH`), `lein repl :headless` (for a Leiningen project), or `clojure -Sdeps '{:deps {nrepl/nrepl {:mvn/version "1.3.1"}}}' -M -m nrepl.cmdline`. shadow-cljs writes its port to `./.shadow-cljs/nrepl.port`, the others to `./.nrepl-port`. On first use, the Clojure CLI, Leiningen or shadow-cljs downloads nREPL and your project's dependencies from Maven Central and Clojars, as they always do. The JVM keeps running after the mod stops. To find `clojure` and `lein`, the helper also looks in `/opt/homebrew/bin` and `/usr/local/bin`.
- **ClojureScript through shadow-cljs.** Connected to a shadow-cljs server, pAIrens asks it every five seconds, over the same nREPL connection, which builds `shadow-cljs.edn` defines, which are being watched, and how many JS runtimes are connected. Switching a tab to a build starts watching it if it isn't already (shadow-cljs compiles it and writes its output where `shadow-cljs.edn` says), then evaluates `(shadow.cljs.devtools.api/repl :build)` in that tab's session. The code you and Claude evaluate there runs in your app.
- **Files it writes:** `~/.pairens/endpoint.json` (readable only by you), the launched SBCL's or JVM's output in `~/.pairens/logs/`, and `./.swank-port` when it launches SBCL. (The nREPL server writes `./.nrepl-port` itself.)
- **Questions for Claude** go to the Claude Code session you're already in, as ordinary turns. pAIrens doesn't call any API itself.
- **The browser page's editor** is a bundle of CodeMirror and marked. [`browser/vendor/README.md`](https://github.com/megajess/pairens/blob/main/plugin/browser/vendor/README.md) lists the versions, licenses and source.

## Support the project

pAIrens is free and MIT-licensed. If it's useful to you, you can [sponsor its development](https://github.com/sponsors/megajess).

## License

[MIT](LICENSE) © 2026 Jesse Suter (megajess)

*pAIrens is an independent project. It is not made, endorsed or sponsored by Anthropic.*
