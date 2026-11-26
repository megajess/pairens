;;;; pairens.lisp — the Lisp side of pAIrens.
;;;;
;;;; Loaded into the running image by the pAIrens helper over Swank. It gives
;;;; the image:
;;;;
;;;;   (pairens:claude "why is this nil?")          ; ask Claude, reply prints later
;;;;   (pairens:claude "explain" (my-fn 3))         ; ...with a value attached
;;;;
;;;; (In the pAIrens pane or browser page you can also just type
;;;;  `pairens: why is this nil?` -- no quotes; the page sends it, not Lisp.)
;;;;
;;;; plus the entry points the helper calls: REX-EVAL (evaluate in a named
;;;; pAIrens session), READ-ONLY-CODE-P (the read-only mode's check),
;;;; TAKE-OUTBOX (the helper's long poll for CLAUDE calls), DELIVER (print
;;;; Claude's reply where the CLAUDE call came from) and COMPLETIONS (what the
;;;; REPL's Tab offers).

(defpackage #:pairens
  (:use #:cl)
  (:export #:claude))

(in-package #:pairens)

;;; ------------------------------------------------------------------
;;; Locking (SBCL threads; other implementations fall back to polling)

(defvar *lock* #+sbcl (sb-thread:make-mutex :name "pairens") #-sbcl nil)
(defvar *outbox-ready* #+sbcl (sb-thread:make-waitqueue :name "pairens outbox") #-sbcl nil)

(defmacro with-lock (&body body)
  #+sbcl `(sb-thread:with-recursive-lock (*lock*) ,@body)
  #-sbcl `(progn ,@body))

;;; ------------------------------------------------------------------
;;; Asking Claude

(defvar *outbox* '()
  "CLAUDE calls the helper has not collected yet, oldest first.")
(defvar *reply-streams* (make-hash-table :test 'equal)
  "Request id -> the stream Claude's reply is printed to.")
(defvar *counter* 0)
(defvar *in-pane* nil
  "The pAIrens session name while the helper evaluates code from the pane or
for Claude; NIL when the code came from somewhere else (an editor's REPL).")

(defun truncated (string limit)
  (if (> (length string) limit)
      (concatenate 'string (subseq string 0 limit) "...")
      string))

(defun claude (prompt &optional (value nil value-p))
  "Ask Claude PROMPT from the REPL. With VALUE, its printed form goes along too.
Returns at once (:SENT and the request id); Claude's reply is printed to this
REPL's output when it arrives."
  (let* ((id (with-lock (format nil "cl-~D" (incf *counter*))))
         (request (list id
                        (princ-to-string prompt)
                        (if value-p
                            (truncated (let ((*print-length* 50) (*print-level* 6))
                                         (prin1-to-string value))
                                       4000)
                            "")
                        (package-name *package*)
                        (or *in-pane* "editor"))))
    (with-lock
      (unless *in-pane*
        (setf (gethash id *reply-streams*) *standard-output*))
      (setf *outbox* (append *outbox* (list request)))
      #+sbcl (sb-thread:condition-broadcast *outbox-ready*))
    (unless *in-pane*
      (format t "~&;; pAIrens: sent to Claude as ~A; the reply will print here.~%" id))
    (values :sent id)))

(defun take-outbox (&optional (timeout 20))
  "Collect pending CLAUDE calls, waiting up to TIMEOUT seconds for one."
  (with-lock
    #+sbcl (unless *outbox*
             (sb-thread:condition-wait *outbox-ready* *lock* :timeout timeout))
    #-sbcl (declare (ignore timeout))
    (prog1 *outbox* (setf *outbox* '()))))

(defun deliver (id text)
  "Print Claude's reply TEXT for request ID where the CLAUDE call was made.
Returns T when there was such a place (an editor REPL), NIL otherwise."
  (let ((stream (with-lock
                  (prog1 (gethash id *reply-streams*)
                    (remhash id *reply-streams*)))))
    (when stream
      (ignore-errors
       (fresh-line stream)
       (format stream ";; claude (~A):~%" id)
       (with-input-from-string (in text)
         (loop for line = (read-line in nil) while line
               do (format stream ";;   ~A~%" line)))
       (force-output stream)
       t))))

;;; ------------------------------------------------------------------
;;; Sessions: each has its own current package and *, **, ***.

(defvar *sessions* (make-hash-table :test 'equal))

(defun session (name)
  (with-lock
    (or (gethash name *sessions*)
        (setf (gethash name *sessions*)
              (list :package "COMMON-LISP-USER" :stars (list nil nil nil))))))

(defun session-package (s)
  (or (find-package (getf s :package)) (find-package "COMMON-LISP-USER")))

(defun print-value (value)
  (truncated (let ((*print-length* 200) (*print-level* 10) (*print-circle* t))
               (prin1-to-string value))
             20000))

(defun rex-eval (session-name code)
  "Read and evaluate every form in CODE in session SESSION-NAME.
Returns (:ok OUTPUT VALUES PACKAGE) or (:error MESSAGE OUTPUT PACKAGE TYPE)."
  (let* ((s (session session-name))
         (out (make-string-output-stream))
         (results '())
         (*package* (session-package s))
         (*in-pane* session-name)
         (* (first (getf s :stars)))
         (** (second (getf s :stars)))
         (*** (third (getf s :stars))))
    (flet ((save ()
             (with-lock
               (setf (getf (gethash session-name *sessions*) :package) (package-name *package*)
                     (getf (gethash session-name *sessions*) :stars) (list * ** ***))))
           (output () (truncated (get-output-stream-string out) 50000)))
      (handler-case
          (let ((*standard-output* out)
                (*error-output* out)
                (*trace-output* out))
            (with-input-from-string (in code)
              (loop with eof = (gensym "EOF")
                    for form = (read in nil eof)
                    until (eq form eof)
                    do (setf results (multiple-value-list (eval form)))
                       (setf *** ** ** * * (first results)))))
        (serious-condition (c)
          (save)
          (return-from rex-eval
            (list :error
                  (truncated (handler-case (princ-to-string c)
                               (error () (format nil "~S" (type-of c))))
                             10000)
                  (output)
                  (package-name *package*)
                  (prin1-to-string (type-of c))))))
      (save)
      (list :ok (output) (mapcar #'print-value results) (package-name *package*)))))

(defun session-info ()
  "Each session's name and current package."
  (with-lock
    (loop for name being the hash-keys of *sessions* using (hash-value s)
          collect (list name (getf s :package)))))

;;; ------------------------------------------------------------------
;;; Read-only mode: code made only of inspection calls.

(defparameter *read-only-operators*
  '(describe documentation apropos apropos-list
    find-symbol find-package find-class list-all-packages
    package-name package-nicknames package-use-list package-used-by-list
    package-shadowing-symbols
    type-of class-of class-name symbol-package symbol-name symbol-value
    symbol-function symbol-plist boundp fboundp macro-function
    special-operator-p constantp compiled-function-p functionp
    macroexpand macroexpand-1 function-lambda-expression
    typep subtypep length list-length
    car cdr first second third fourth fifth rest last nth nthcdr elt aref
    gethash hash-table-count hash-table-test
    values list identity not null
    + - * / = /= < > <= >= eq eql equal equalp
    string string= string-equal string-upcase string-downcase
    lisp-implementation-type lisp-implementation-version
    software-type software-version machine-type machine-version
    room))

(defun read-only-form-p (form)
  (cond ((atom form) t)
        ((eq (car form) 'quote) t)
        ((eq (car form) 'function) (symbolp (second form)))
        ((and (symbolp (car form))
              (member (car form) *read-only-operators*))
         (every #'read-only-form-p (cdr form)))
        (t nil)))

(defun read-only-code-p (session-name code)
  "True when every form in CODE only inspects the image."
  (handler-case
      (let ((*read-eval* nil)
            (*package* (session-package (session session-name))))
        (with-input-from-string (in code)
          (loop with eof = (gensym "EOF")
                for form = (read in nil eof)
                until (eq form eof)
                always (read-only-form-p form))))
    (serious-condition () nil)))

;;; ------------------------------------------------------------------
;;; Completion: what the REPL's Tab offers

(defun symbol-text (symbol)
  "SYMBOL's name as typed at the REPL: lower case unless it has lower-case letters."
  (let ((name (symbol-name symbol)))
    (if (string= name (string-upcase name)) (string-downcase name) name)))

(defun lambda-list-text (symbol)
  "SYMBOL's function's lambda list, printed short, or NIL."
  (let ((reader #+sbcl (find-symbol "FUNCTION-LAMBDA-LIST" "SB-INTROSPECT") #-sbcl nil))
    (when (and reader (fboundp reader) (fboundp symbol) (not (special-operator-p symbol)))
      (ignore-errors
       (let ((list (funcall reader (or (macro-function symbol) (fdefinition symbol))))
             (*package* (or (symbol-package symbol) *package*))
             (*print-case* :downcase)
             (*print-pretty* nil)
             (*print-length* 12))
         (if list (truncated (princ-to-string list) 80) "()"))))))

(defun symbol-kind (symbol)
  (cond ((special-operator-p symbol) "special")
        ((macro-function symbol) "macro")
        ((fboundp symbol) "function")
        ((keywordp symbol) "keyword")
        ((boundp symbol) "variable")
        ((find-class symbol nil) "class")
        (t "symbol")))

(defun completions (session-name prefix &optional (limit 60))
  "The symbols PREFIX could complete to in the session's package: a list of
(TEXT KIND ARGLIST) with TEXT the whole token to insert, shortest and then
alphabetical first, at most LIMIT. PREFIX may be `pkg:name`, `pkg::name` or
`:keyword`. Matching ignores case."
  (handler-case
      (let* ((*package* (session-package (session session-name)))
             (colon (position #\: prefix :from-end t))
             (qualifier (if colon (subseq prefix 0 (1+ colon)) ""))
             (stem (if colon (subseq prefix (1+ colon)) prefix))
             (package-name (and colon (string-right-trim ":" qualifier)))
             (internal (search "::" qualifier))
             (package (cond ((null colon) *package*)
                            ((string= package-name "") (find-package "KEYWORD"))
                            (t (find-package (string-upcase package-name)))))
             (seen (make-hash-table :test 'equal))
             (found '()))
        (when package
          (flet ((consider (symbol)
                   (let ((name (symbol-name symbol)))
                     (when (and (<= (length stem) (length name))
                                (string-equal stem name :end2 (length stem))
                                (not (gethash name seen)))
                       (setf (gethash name seen) t)
                       (push (list (concatenate 'string qualifier (symbol-text symbol))
                                   (symbol-kind symbol)
                                   (or (lambda-list-text symbol) ""))
                             found)))))
            (cond ((or (null colon) internal (eq package (find-package "KEYWORD")))
                   (do-symbols (symbol package) (consider symbol)))
                  (t (do-external-symbols (symbol package) (consider symbol))))))
        (let ((sorted (sort found (lambda (a b)
                                    (let ((la (length (first a))) (lb (length (first b))))
                                      (if (= la lb) (string< (first a) (first b)) (< la lb)))))))
          (subseq sorted 0 (min limit (length sorted)))))
    (serious-condition () nil)))

;;; ------------------------------------------------------------------
;;; Describing a symbol: what the REPL's Option-click shows

(defun describe-symbol (session-name token)
  "TOKEN as the session's package reads it (`name`, `pkg:name`, `pkg::name`,
`:keyword`), described for the REPL: (NAME KIND ARGLIST DOCUMENTATION), or NIL
when no such symbol exists. Nothing is interned."
  (handler-case
      (let* ((*package* (session-package (session session-name)))
             (token (string-left-trim "'#`," token))
             (colon (position #\: token :from-end t))
             (stem (if colon (subseq token (1+ colon)) token))
             (package-name (and colon (string-right-trim ":" (subseq token 0 (1+ colon)))))
             (package (cond ((null colon) *package*)
                            ((string= package-name "") (find-package "KEYWORD"))
                            (t (find-package (string-upcase package-name)))))
             (symbol (and package
                          (plusp (length stem))
                          (or (find-symbol (string-upcase stem) package)
                              (find-symbol stem package)))))
        (when (and symbol (or (fboundp symbol) (boundp symbol) (find-class symbol nil)
                              (documentation symbol 'function) (documentation symbol 'variable)))
          (let ((*print-case* :downcase))
            (list (if (or (null (symbol-package symbol))
                          (keywordp symbol)
                          (eq (find-symbol (symbol-name symbol) *package*) symbol))
                      (if (keywordp symbol) (format nil ":~a" (symbol-text symbol)) (symbol-text symbol))
                      (format nil "~(~a~):~a" (package-name (symbol-package symbol)) (symbol-text symbol)))
                  (symbol-kind symbol)
                  (or (lambda-list-text symbol) "")
                  (or (and (fboundp symbol) (documentation symbol 'function))
                      (documentation symbol 'variable)
                      (and (find-class symbol nil) (documentation (find-class symbol) t))
                      "")))))
    (serious-condition () nil)))
