# browser/vendor

`editor.js` is the code editor on the pAIrens browser page (`/pairens-browser`).
It's a minified bundle of [CodeMirror 6](https://codemirror.net/) with its Common
Lisp and Clojure modes, plus [marked](https://marked.js.org/) for rendering Claude's replies.

`editor.src.js`, next to it, is the pAIrens code the bundle is built from: the
REPL keys, Lisp and Clojure highlighting for history rows, and the Markdown renderer, which
escapes raw HTML and only links `http`, `https` and `mailto` addresses. Everything
else in the bundle is the unmodified packages below.

To rebuild it (from the pAIrens source repository), run `npm ci` and then
`npm run build`. The bundle is made with esbuild 0.25.5:

```
esbuild editor.js --bundle --format=esm --minify --legal-comments=eof --target=es2022
```

The bundle makes no network requests. It runs only in the browser page, which
pAIrens serves on `127.0.0.1`.

## Packages in the bundle

All are MIT-licensed. The license text follows the list.

| Package | Version | Copyright |
|---|---|---|
| @codemirror/autocomplete | 6.18.6 | © 2018-2021 Marijn Haverbeke and others |
| @codemirror/commands | 6.8.1 | © 2018-2021 Marijn Haverbeke and others |
| @codemirror/language | 6.11.2 | © 2018-2021 Marijn Haverbeke and others |
| @codemirror/legacy-modes | 6.5.1 | © 2018-2021 Marijn Haverbeke and others |
| @codemirror/state | 6.5.2 | © 2018-2021 Marijn Haverbeke and others |
| @codemirror/view | 6.38.0 | © 2018-2021 Marijn Haverbeke and others |
| @lezer/common | 1.5.5 | © 2018 Marijn Haverbeke and others |
| @lezer/highlight | 1.2.1 | © 2018 Marijn Haverbeke and others |
| @marijn/find-cluster-break | 1.0.4 | © 2024 Marijn Haverbeke |
| crelt | 1.0.7 | © 2020 Marijn Haverbeke |
| marked | 15.0.12 | © 2018+ MarkedJS; © 2011-2018 Christopher Jeffrey |
| style-mod | 4.1.4 | © 2018 Marijn Haverbeke and others |
| w3c-keyname | 2.2.8 | © 2016 Marijn Haverbeke and others |

## MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
