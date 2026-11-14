;;;; pairens.clj — the Clojure side of pAIrens.
;;;;
;;;; Evaluated into the running Clojure process by the pAIrens helper over
;;;; nREPL. It gives the process:
;;;;
;;;;   (pairens/claude "why is this nil?")          ; ask Claude, reply prints later
;;;;   (pairens/claude "explain" (my-fn 3))         ; ...with a value attached
;;;;
;;;; (In the pAIrens pane or browser page you can also just type
;;;;  `pairens: why is this nil?` -- no quotes; the page sends it, not Clojure.)
;;;;
;;;; plus the entry points the helper calls in its own nREPL sessions:
;;;; TAKE-OUTBOX (the long poll for CLAUDE calls), DELIVER (print Claude's
;;;; reply where the CLAUDE call came from) and READ-ONLY-CODE? (the read-only
;;;; mode's check). They print JSON for the helper and return nil.

(ns pairens
  "Ask Claude from your Clojure REPL: (pairens/claude \"why is this nil?\")."
  (:refer-clojure :exclude [deliver])
  (:require [clojure.string :as str]
            [clojure.repl]
            [clojure.main])
  (:import (java.util.concurrent LinkedBlockingQueue ConcurrentHashMap TimeUnit)
           (java.io PushbackReader StringReader Writer)))

;;; ------------------------------------------------------------------
;;; JSON for the helper (no library needed)

(defn- json-string [^String s]
  (let [sb (StringBuilder. "\"")]
    (doseq [c s]
      (case c
        \" (.append sb "\\\"")
        \\ (.append sb "\\\\")
        \newline (.append sb "\\n")
        \return (.append sb "\\r")
        \tab (.append sb "\\t")
        (if (< (int c) 0x20)
          (.append sb (format "\\u%04x" (int c)))
          (.append sb c))))
    (str (.append sb "\""))))

(defn- json [x]
  (cond (nil? x) "null"
        (true? x) "true"
        (false? x) "false"
        (string? x) (json-string x)
        (number? x) (str x)
        (keyword? x) (json-string (name x))
        (map? x) (str "{" (str/join "," (map (fn [[k v]] (str (json-string (name k)) ":" (json v))) x)) "}")
        (coll? x) (str "[" (str/join "," (map json x)) "]")
        :else (json-string (str x))))

(defn- print-json [x]
  (print (json x))
  (flush)
  nil)

;;; ------------------------------------------------------------------
;;; Asking Claude

(defonce ^:private ^LinkedBlockingQueue outbox (LinkedBlockingQueue.))
(defonce ^:private ^ConcurrentHashMap reply-writers (ConcurrentHashMap.))
(defonce ^:private counter (atom 0))

(defn- pairens-session
  "The pAIrens session name while the helper evaluates code from the pane or
  for Claude (it sends it along with the nREPL eval); nil when the code came
  from somewhere else, such as an editor's REPL."
  []
  (when-let [v (resolve 'nrepl.middleware.interruptible-eval/*msg*)]
    (let [msg @v]
      (when (map? msg)
        (or (get msg :pairens-session) (get msg "pairens-session"))))))

(defn- truncated [^String s limit]
  (if (> (count s) limit) (str (subs s 0 limit) "...") s))

(defn- ask [prompt value]
  (let [id (str "clj-" (swap! counter inc))
        session (pairens-session)]
    (when-not session
      (.put reply-writers id *out*))
    (.put outbox [id (str prompt) value (str (ns-name *ns*)) (or session "editor")])
    (when-not session
      (println (str ";; pAIrens: sent to Claude as " id "; the reply will print here.")))
    [:sent id]))

(defn claude
  "Ask Claude PROMPT from the REPL. With VALUE, its printed form goes along too.
  Returns at once ([:sent id]); Claude's reply is printed to this REPL's output
  when it arrives."
  ([prompt] (ask prompt ""))
  ([prompt value]
   (ask prompt (truncated (binding [*print-length* 50 *print-level* 6] (pr-str value)) 4000))))

(defn take-outbox
  "Print the pending CLAUDE calls as JSON, waiting up to TIMEOUT seconds for one."
  [timeout]
  (let [first-one (.poll outbox (long timeout) TimeUnit/SECONDS)
        more (java.util.ArrayList.)]
    (when first-one (.drainTo outbox more))
    (print-json (if first-one (into [first-one] more) []))))

(defn deliver
  "Print Claude's reply TEXT for request ID where the CLAUDE call was made.
  Prints true when there was such a place (an editor REPL), false otherwise."
  [id text]
  (let [^Writer w (.remove reply-writers id)]
    (when w
      (try
        (binding [*out* w]
          (println (str ";; claude (" id "):"))
          (doseq [line (str/split-lines text)]
            (println (str ";;   " line)))
          (flush))
        (catch Throwable _)))
    (print-json (boolean w))))

;;; ------------------------------------------------------------------
;;; Sessions

(defn start-session
  "Called once in each new pAIrens session: like a Clojure REPL, refer doc,
  source, dir, pst and friends into user."
  []
  (when (= 'user (ns-name *ns*))
    (apply require clojure.main/repl-requires))
  nil)

;;; ------------------------------------------------------------------
;;; Read-only mode: code made only of inspection calls.

(def ^:private read-only-vars
  '#{clojure.repl/doc clojure.repl/source clojure.repl/dir clojure.repl/apropos
     clojure.repl/find-doc clojure.repl/source-fn clojure.repl/dir-fn
     clojure.core/meta clojure.core/type clojure.core/class clojure.core/supers
     clojure.core/bases clojure.core/instance? clojure.core/ancestors
     clojure.core/all-ns clojure.core/find-ns clojure.core/the-ns clojure.core/ns-name
     clojure.core/ns-publics clojure.core/ns-interns clojure.core/ns-refers
     clojure.core/ns-aliases clojure.core/ns-imports clojure.core/ns-map
     clojure.core/resolve clojure.core/ns-resolve clojure.core/find-var
     clojure.core/var? clojure.core/fn? clojure.core/ifn? clojure.core/bound?
     clojure.core/symbol clojure.core/keyword clojure.core/name clojure.core/namespace
     clojure.core/count clojure.core/first clojure.core/second clojure.core/rest
     clojure.core/next clojure.core/last clojure.core/nth clojure.core/take
     clojure.core/keys clojure.core/vals clojure.core/get clojure.core/get-in
     clojure.core/contains? clojure.core/find clojure.core/select-keys
     clojure.core/nil? clojure.core/some? clojure.core/empty? clojure.core/seq
     clojure.core/vec clojure.core/list clojure.core/vector clojure.core/hash-map
     clojure.core/set clojure.core/identity clojure.core/not clojure.core/str
     clojure.core/= clojure.core/not= clojure.core/< clojure.core/> clojure.core/<=
     clojure.core/>= clojure.core/+ clojure.core/- clojure.core/* clojure.core/inc
     clojure.core/dec clojure.core/pr-str clojure.core/prn-str
     clojure.core/string? clojure.core/number? clojure.core/keyword?
     clojure.core/symbol? clojure.core/map? clojure.core/vector? clojure.core/seq?
     clojure.core/coll? clojure.core/sequential?
     clojure.core/clojure-version})

(def ^:private read-only-specials '#{quote var if do})

(defn- var-symbol [^clojure.lang.Var v]
  (symbol (str (.-ns v)) (str (.-sym v))))

(defn- read-only-form? [ns form]
  (cond
    (seq? form)
    (let [op (first form)]
      (cond (= op 'quote) true
            (contains? read-only-specials op) (every? #(read-only-form? ns %) (rest form))
            (symbol? op) (let [v (try (or (ns-resolve ns op)
                                          ;; doc, source, dir: the REPL refers them, a bare ns may not
                                          (when-not (namespace op)
                                            (when (find-ns 'clojure.repl)
                                              (ns-resolve (find-ns 'clojure.repl) op))))
                                      (catch Throwable _ nil))]
                           (and (var? v)
                                (contains? read-only-vars (var-symbol v))
                                ;; macros (doc, source, dir) take their arguments unevaluated
                                (or (:macro (meta v))
                                    (every? #(read-only-form? ns %) (rest form)))))
            :else false))
    (map? form) (every? #(read-only-form? ns %) (concat (keys form) (vals form)))
    (coll? form) (every? #(read-only-form? ns %) form)
    :else true))

(defn read-only-code?
  "Print true when every form in CODE, read in namespace NS-NAME, only inspects."
  [code ns-name]
  (print-json
   (try
     (let [ns (or (find-ns (symbol (str ns-name))) (find-ns 'user) *ns*)
           eof (Object.)
           r (PushbackReader. (StringReader. code))]
       (binding [*read-eval* false
                 *ns* ns]
         (loop []
           (let [form (read {:eof eof} r)]
             (cond (identical? form eof) true
                   (read-only-form? ns form) (recur)
                   :else false)))))
     (catch Throwable _ false))))

(defn implementation
  "Print the Clojure version as JSON for the helper's status line."
  []
  (print-json (str "Clojure " (clojure-version))))

(def ^:private read-only-cljs-names
  "Read-only for ClojureScript, by name: cljs code can't be resolved from the
  JVM, so the check goes by the names of read-only-vars (and cljs.core/...)."
  (into #{} (map (comp symbol name)) read-only-vars))

(defn- read-only-cljs-form? [form]
  (cond
    (seq? form)
    (let [op (first form)]
      (cond (= op 'quote) true
            (contains? read-only-specials op) (every? read-only-cljs-form? (rest form))
            (symbol? op) (and (contains? #{nil "cljs.core" "cljs.repl" "clojure.core" "clojure.repl"} (namespace op))
                              (contains? read-only-cljs-names (symbol (name op)))
                              (or (contains? '#{doc source dir} (symbol (name op)))
                                  (every? read-only-cljs-form? (rest form))))
            :else false))
    (map? form) (every? read-only-cljs-form? (concat (keys form) (vals form)))
    (coll? form) (every? read-only-cljs-form? form)
    :else true))

(defn read-only-cljs-code?
  "Print true when every form in CODE (ClojureScript) only inspects."
  [code]
  (print-json
   (try
     (let [eof (Object.)
           r (PushbackReader. (StringReader. code))]
       (binding [*read-eval* false
                 *default-data-reader-fn* (fn [_tag value] value)]
         (loop []
           (let [form (read {:eof eof :read-cond :allow :features #{:cljs}} r)]
             (cond (identical? form eof) true
                   (read-only-cljs-form? form) (recur)
                   :else false)))))
     (catch Throwable _ false))))

;;; ------------------------------------------------------------------
;;; ClojureScript through shadow-cljs (when the process is a shadow-cljs server)

(defn- shadow-fn [sym]
  (some-> (try (requiring-resolve sym) (catch Throwable _ nil)) deref))

(defn shadow-info
  "Print JSON: whether this is a shadow-cljs server, its builds, which are
  being watched, and how many JS runtimes each watched build has connected."
  []
  (print-json
   (if-let [load-config (shadow-fn 'shadow.cljs.devtools.config/load-cljs-edn)]
     (let [active (set (or (some-> (shadow-fn 'shadow.cljs.devtools.api/active-builds) (apply [])) #{}))
           runtimes (shadow-fn 'shadow.cljs.devtools.api/repl-runtimes)
           builds (->> (:builds (load-config))
                       (remove (fn [[id cfg]] (and (= id :npm) (= :npm-module (:target cfg)))))
                       (map key)
                       sort)]
       {:shadow true
        :builds (map name builds)
        :watching (map name (filter active builds))
        :runtimes (into {} (for [b builds :when (active b)]
                             [(name b) (count (try (runtimes b) (catch Throwable _ nil)))]))})
     {:shadow false})))

(defn shadow-watch
  "Start watching BUILD (a name) unless it already is. Prints true."
  [build]
  (let [b (keyword build)
        active (set ((shadow-fn 'shadow.cljs.devtools.api/active-builds)))]
    (when-not (active b)
      ((shadow-fn 'shadow.cljs.devtools.api/watch) b))
    (print-json true)))
