# Architecture

CompilerLab is an npm workspaces monorepo. It runs entirely on the student's computer.

```text
compilerlab/
  apps/web/          React app: shell, routes, design system
  apps/server/       Fastify API and SQLite storage
  packages/engine/   Compiler-theory engine: pure TypeScript, no DOM or Node APIs
  packages/content/  Course content as data
  packages/shared/   Types, Zod schemas and constants
  scripts/           setup, doctor, start, build, backup, reset
  e2e/               Playwright and axe tests
  data/              Local database and backups (created at runtime, never committed)
```

## How the pieces run

```text
Development (npm start)

  scripts/start.mjs
    ├─ tsx watch   → API server   127.0.0.1:4317
    └─ vite        → web app      127.0.0.1:5173 ── proxies /api ──▶ API server

Production (npm run build && npm run start:prod)

  Fastify          → API and built web app on 127.0.0.1:4317
```

`scripts/start.mjs` checks the ports first, waits until both servers answer, reports the cold-start time and opens the browser. Workspace packages export TypeScript source directly, so development needs no build step. `scripts/build-server.mjs` bundles the server and workspace packages for production, leaving third-party packages in `node_modules`.

## Server

`apps/server/src/app.ts` builds the Fastify app from its dependencies, so tests can run it with an in-memory database and a fake tool probe.

| Route                               | Purpose                                                               |
| ----------------------------------- | --------------------------------------------------------------------- |
| `GET /api/health`                   | Liveness, version and database driver                                 |
| `GET, PATCH /api/settings`          | Read and update settings                                              |
| `POST /api/settings/reset`          | Restore default settings                                              |
| `GET /api/content/modules[/:id]`    | The course outline                                                    |
| `GET /api/system/status`            | Node, lab tools, lab mode, whether a Gemini key exists, data location |
| `GET /api/content/lessons`          | Every lesson's frontmatter                                            |
| `GET /api/content/lessons/:id/bank` | A topic's questions, summary and flashcards                           |
| `GET /api/progress`                 | Progress on all topics                                                |
| `PATCH /api/progress/:id`           | Records that a topic was read, explored, or a quiz score              |

A later milestone adds `/api/export`. The lab's routes are described under Lab below, and the tutor's under AI tutor.

**Errors.** `plugins/errors.ts` turns every failure into `{ error: { code, message, details? } }`. Messages are written for students, and internals stay in the server log.

**Local-only guard.** Binding to `127.0.0.1` does not stop a website open in the student's browser from calling the server, and later milestones compile and run code here. So `plugins/local-only.ts` checks every request:

- The `Host` header must be a loopback name, which blocks DNS rebinding.
- Any `Origin` header must match the `Host` exactly, which blocks cross-site requests, including WebSocket upgrades. The server sends no CORS headers.

**Content security policy.** In production `plugins/web-app.ts` sends a policy limiting the page to its own origin, so the browser itself enforces that the app makes no other network calls.

## Storage

The database is `data/compilerlab.db`, in WAL mode. `db/migrate.ts` applies pending migrations on every boot, each in its own transaction, and refuses a database created by a newer version of the app.

`db/driver.ts` is a small interface over two interchangeable SQLite drivers:

1. **better-sqlite3** ships prebuilt binaries inside its package, and `.npmrc` turns install scripts off, so nothing compiles during install.
2. **`node:sqlite`**, built into Node, is the automatic fallback if that binary cannot load. Set `SQLITE_DRIVER` in `.env` to force either one.

Settings are stored one key per row and validated field by field on read. A corrupt value falls back to its default and does not affect the others.

## Web app

| Library         | Used for                                               |
| --------------- | ------------------------------------------------------ |
| React Router    | Routes, each lazy-loaded as its own chunk              |
| TanStack Query  | Server state: settings, modules, system status, health |
| Zustand         | Client state: sidebar layout and toasts                |
| Tailwind CSS    | Styling, restricted to the design tokens               |
| shadcn/ui style | Local component primitives in `components/ui`          |

**Speed.** After the first page loads, `preloadPages()` fetches the other small route chunks when the browser is idle, which keeps route changes under 100 ms. `scripts/check-bundle.mjs` fails the build if initial JavaScript reaches 300 KB gzipped.

**Settings flow.** The server's SQLite database is the source of truth. A change updates the screen immediately, then saves. Saves run one at a time, and a failed save rolls back and shows an error. `apps/web/public/theme-init.js` applies a cached theme and font size before first paint so the page never flashes.

**Design system.** `styles/tokens.css` defines every color for both themes, including one color per course module and the token-type and diff colors later milestones use. `tokens.test.ts` checks them against WCAG AA.

**Accessibility.** The shell has a skip link, moves focus to the page and announces it on navigation, and honors `prefers-reduced-motion`. Primitives use native controls where possible, and the split pane resizes with the keyboard.

**Failure states.** `ErrorPanel`, `RouteError` and error toasts always give a readable message and an Ask AI button. A polled health check shows a banner if the server stops.

## Engine

`packages/engine` runs in browser workers and on the server, and every algorithm returns a **trace**: an array of frozen snapshots, each with a title and a plain-language explanation. Bad input throws an `EngineError` holding a readable message, a position and a hint, and `attempt` turns that into a `Result`.

| Folder     | Contains                                                                                                                       |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `core`     | `Result`, `EngineError` and `TraceRecorder`                                                                                    |
| `regex`    | Character sets and the regex parser, which keeps source positions                                                              |
| `automata` | Thompson, subset construction, Hopcroft, followpos, simulation and an equivalence check that gives the shortest counterexample |
| `lexer`    | The mini-Lex generator and scanner, the rule format, and the input buffer demo                                                 |
| `grammar`  | Grammars, top-down and bottom-up parsers and their tables. See Grammars and parsing below                                      |
| `semantic` | Attribute grammars, translation schemes, symbol tables, types, type checking and inference. See Semantic analysis and IR below |
| `ir`       | The IR language, three-address code and its tables, DAGs, backpatching, basic blocks, dominators and SSA                       |
| `optimize` | Optimization passes, the pipeline, data-flow analyses and loop detection. See Optimization, code generation and TinyC below    |
| `codegen`  | The teaching ISA, stack code, instruction selection, next-use, getReg, graph coloring and Sethi-Ullman numbering               |
| `vm`       | The assembler and the teaching VM                                                                                              |
| `runtime`  | Models of activation records, garbage collection and parameter passing                                                         |
| `tinyc`    | The TinyC compiler, one function per stage, which powers the capstone                                                          |

Character classes stay practical because of **alphabet atoms**: `alphabetAtoms` splits every character set an automaton mentions into groups it cannot tell apart, and table construction runs per group rather than per code point.

## Visualizers

```text
Visualizer component  ── useEngineJob ──▶ Web Worker: runJob ──▶ engine
        │                 (cached by input)
        ▼
     Player  ── renderStage(step) ──▶ AutomatonGraph, tables, tape...
        └──── stageExport.render(step) ──▶ the same drawing, static, as an image
```

- **`visualizers/engine`**: jobs run in a worker and always resolve, with a readable failure if the input is bad or takes over 10 seconds. Results are cached by input with TanStack Query.
- **`visualizers/player`**: play, pause, step, scrub, speed, captions, keyboard shortcuts and export. Every visualizer gets all of these by passing a trace.
- **`visualizers/graph`**: a layered layout and edge routing, computed from the finished automaton, so states stay put while it grows.
- **`visualizers/registry.ts`**: the list of visualizers. Each is its own chunk, and `VisualizerHost` loads it on demand and contains any failure to its own panel.

Exports are drawn by `renderToStaticMarkup`, with CSS variables written in as real colors. `react-dom/server` and `gifenc` load only when an export is requested.

## Grammars and parsing

`packages/engine/src/grammar` holds the Module 2 engine. The public API is listed at the top of its `index.ts`, and names are prefixed (`grammar…`, `ll1…`, `lr…`, `opPrecedence…`) because the engine's index re-exports everything.

| File                                             | Contains                                                                            |
| ------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `cfg.ts`                                         | The grammar text format (documented at its top), sentence tokens, `%left` lines     |
| `sets.ts`, `diagnostics.ts`, `transform.ts`      | Nullable, FIRST and FOLLOW; warnings; left recursion elimination and left factoring |
| `chart.ts`, `ambiguity.ts`, `derivation.ts`      | A general parser for any CFG, the bounded ambiguity search, and derivations         |
| `recursive-descent.ts`, `ll1.ts`, `ll1-parse.ts` | The top-down parsers                                                                |
| `lr-items.ts`, `lr-table.ts`, `lr-parse.ts`      | LR(0) and LR(1) items, the four table kinds, and the one driver they all share      |
| `op-precedence.ts`                               | LEADING, TRAILING, precedence relations and the operator-precedence parser          |

Every driver returns the same `GrammarParserRun`, so one set of views can draw any of them. A step records only how many tree nodes exist so far, not the tree itself, which keeps long traces small. Backtracking is the exception: its tree can shrink, so each of its steps carries its own node array.

The eight visualizers are in `apps/web/src/visualizers/parsing`. Their jobs are in `parsing/jobs.ts`, which `engine/jobs.ts` spreads into its own table, and they share the tree (`parse-forest.tsx`, using `d3-hierarchy`), the stack and tape (`parser-views.tsx`) and the tables (`tables.tsx`). `@xyflow/react` is only imported by `lr-graph.tsx`, inside the `lr-automaton` chunk.

The LR automaton's React Flow canvas sits outside the Player and follows it through `onStep`, the same way the automata builder does, because the Player's arrow keys would otherwise clash with moving a selected node. Its exports are drawn by a separate plain SVG from the same layout, since a canvas cannot be exported.

**Linking to a spot in the automaton.** The `lr-automaton` visualizer reads `grammar`, `kind`, `precedence`, `state` and `conflict` (as `state:terminal`) from its `initial` props, and `/visualize/:id` turns its query string into `initial` for any visualizer. A link with a state or conflict opens on the finished automaton with that spot selected, for example `/visualize/lr-automaton?kind=lalr&conflict=4:else&grammar=...`.

## Semantic analysis and IR

`packages/engine/src/semantic` and `packages/engine/src/ir` hold the engines for Modules 3 and 4. The public API, with an example call for each major function, is at the top of each folder's `index.ts`. Names are prefixed (`sdd…`, `sdt…`, `symtab…`, `type…`, `tc…`, `ir…`) because the engine's index re-exports everything.

| File                                                                   | Contains                                                                                                           |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `semantic/sdd-spec.ts`, `sdd-expr.ts`, `sdd-classify.ts`               | The text format for an SDD or SDT, the rule language, and the S-attributed and L-attributed check with its reasons |
| `semantic/sdd-parse.ts`, `sdd-eval.ts`, `sdt.ts`                       | An Earley parser for any grammar a student writes, the dependency graph and evaluation, and embedded actions       |
| `semantic/symbol-table.ts`                                             | Hash, tree and scoped-stack tables, all running the same operations, with a comparison of the work each does       |
| `semantic/type-expr.ts`, `type-relations.ts`                           | Type expressions, structural and name equivalence, and the widening hierarchy                                      |
| `semantic/tc-parser.ts`, `type-checker.ts`, `unify.ts`, `inference.ts` | The mini-language and its checker, unification, and inference on a small functional language                       |
| `ir/parser.ts`, `symbols.ts`, `tac-gen.ts`, `postfix.ts`               | The IR language's AST, widths and offsets, and translation to three-address code and postfix                       |
| `ir/tables.ts`, `dag.ts`, `backpatch.ts`                               | Quadruples, triples and indirect triples, the value-number DAG, and backpatching                                   |
| `ir/cfg.ts`, `dominators.ts`, `ssa.ts`                                 | Basic blocks and the flow graph, dominators and frontiers, and SSA with phi placement and renaming                 |

Results and traces are plain data, so they can cross the Web Worker boundary. A step that grows a list, like the SDD's dependency graph or the code from `irToTac`, records how much of the result's list exists so far, instead of carrying its own copy. Where a step does carry a snapshot, rows that did not change are shared between steps.

`irToTac` produces the shared `TacInstr` from `ir/types.ts`, so its output goes straight into the optimizer and code generator. Its conditional jump tests one value, so a comparison goes in a temporary first. `irBackpatch` has its own instruction type, because the book's `if a < b goto _` with a blank target is the point of that lesson. See [DECISIONS.md](DECISIONS.md).

## Optimization, code generation and TinyC

Each of `optimize`, `codegen`, `vm`, `runtime` and `tinyc` lists its public API, with an example call, at the top of its `index.ts`. Names are prefixed (`opt…`, `dataflow…`, `loop…`, `codegen…`, `isa…`, `vm…`, `rt…`, `tinyc…`). Every trace step is plain data, so traces can cross the worker boundary.

- **Input.** Optimizer and code generation functions take either text, read by `optParseTac`, or `TacInstr[]`. So a student can type three-address code, and TinyC can pass in what it generated. `optimize/cfg.ts` keeps its own blocks with ENTRY and EXIT, so these folders do not depend on the rest of `ir`.
- **One set of assumptions.** A call changes only its own result and array contents, because TinyC has no globals. Arrays can alias through reference parameters, so a store or a call invalidates every remembered array read. Loop-invariant code motion moves neither array reads nor divisions by an unknown divisor, because either could then fail in a loop that would have run zero times. Dead code elimination likewise keeps such a division.
- **One set of arithmetic.** `vm/arith.ts` defines 32-bit wrapping arithmetic. Both the VM and constant folding use it, so folding cannot change what a program prints.
- **One ISA.** `codegen/isa.ts` defines the instructions, and everything generated is text the VM's assembler accepts. Opcodes without operands are the stack-machine form of the same operation.
- **Register allocators.** `codegen/get-reg.ts` and `codegen/coloring.ts` are teaching demos with traces. TinyC's own code generator does not use them: it keeps every name in a frame slot and reloads around each statement, which keeps its output easy to follow and hard to get wrong.
- **Runtime errors in TinyC.** Optimized code loses its link to the source. When a program fails, `tinyc/pipeline.ts` reruns the unoptimized code, which keeps a source range per instruction, to find the position to report.

```text
source ─ tinycLex ─ tinycParse ─ tinycAstTree ─ tinycCheck ─ tinycGenerateIr ─ tinycOptimize ─ tinycCodegen ─ vmAssemble ─ vmExecute
                                                                                     │
                                                                               optRunPipeline
```

## Lessons

A topic is two files: an MDX lesson and a JSON question bank (see [CONTENT_GUIDE.md](CONTENT_GUIDE.md)).

- The server reads frontmatter and banks from disk on each request, so a new topic needs no restart. A broken file is skipped and logged, and `npm test` fails on it.
- The web app compiles MDX through Vite and loads each lesson as its own chunk. Math is rendered at build time.
- `routes/lesson.tsx` lays out the template in a split pane: the lesson on the left, with practice, quiz, summary and flashcards below it, and the visualizers on the right.
- Lab work lives in the `lab_workspaces` and `lab_progress` tables.
- Progress lives in the `topic_progress` table and only moves forward. `@compilerlab/shared/progress` holds the completion rule and mastery formula.

## Environment checks

`scripts/lib/checks.mjs` holds the checks and the per-OS install commands. `npm run doctor` and `GET /api/system/status` both use it, so the terminal and the Settings page always agree. It uses only Node built-ins because it has to work before `npm install`.

## Lab

The lab runs a student's code with the real tools, or in the teaching engine if they are missing.

| Route                                          | Purpose                                               |
| ---------------------------------------------- | ----------------------------------------------------- |
| `GET /api/lab/exercises`                       | Exercises, without solutions or hidden tests          |
| `GET /api/lab/exercises/:id/solution`          | One solution, when a student asks for it              |
| `GET /api/lab/progress`                        | Which exercises have passed                           |
| `GET`, `PUT`, `DELETE /api/lab/workspaces/:id` | A student's saved files, by exercise id or `scratch`  |
| `GET /api/lab/ws`                              | The WebSocket that runs jobs and streams their events |

A job goes through `apps/server/src/lab`:

1. `routes/lab.ts` validates each message with the schemas in `@compilerlab/shared`. Bad file names, flags and standards stop here.
2. `job.ts` decides between real tools and Simulated mode. Lex falls back to Simulated. C and C++ show install commands instead.
3. For real tools, `runs.ts` makes a new folder under `data/runs` and writes the files, and `process.ts` runs each step with its limits. Old runs are swept when a job starts: anything over an hour old, and all but the latest 20.
4. For Simulated mode, `compileScanner` and `runScanner` in `packages/engine/src/flex` do the same work in-process, in small slices.
5. `diagnostics.ts` turns tool output into structured errors with plain-English explanations. `flex-trace.ts` pulls the token stream out of the scanner's `-d` output.

Both engines send the same events, listed as `LabEvent` in `packages/shared/src/lab.ts`, so the page does not care which one ran. `check` runs every test against one build and records a pass in `lab_progress`.

In the browser, `apps/web/src/lab/lab-run.ts` holds the job's state in a reducer. `routes/lab-workspace.tsx` is a small chunk, and Monaco and xterm are lazy chunks behind it, so they load only when a workspace opens. Monaco is about 1 MB gzipped, and initial JS does not grow.

## AI tutor

Every AI call goes through the local server. The key stays in the server's `.env`, the browser never sees it, and Gemini is the only outside service the app ever calls. With a blank key, every AI feature shows a friendly notice, and the rest of the app works as usual.

| Route                     | Purpose                                                               |
| ------------------------- | --------------------------------------------------------------------- |
| `POST /api/ai/chat`       | Streams an answer as server-sent events                               |
| `POST /api/ai/structured` | Runs a named task and returns JSON that passed a Zod schema           |
| `POST /api/ai/feedback`   | Saves a Report wrong answer in the local `ai_feedback` table          |
| `GET /api/ai/status`      | Ready, no key, offline or rate limited, with the remaining-quota hint |

```text
Browser page ── adds the page's context ──▶ routes/ai.ts ──▶ service.ts
                                                               │
              MiniSearch finds lesson chunks (lesson-search.ts)┤
              The prompt is built around them (prompts.ts)     │
              An identical earlier request? (store.ts) ────────┼──▶ the saved answer
                                                               ▼
                      queue.ts: per-minute limit, backoff ──▶ AiClient ──▶ Gemini
```

Files in `apps/server/src/ai`:

| File               | Purpose                                                                                      |
| ------------------ | -------------------------------------------------------------------------------------------- |
| `client.ts`        | The `AiClient` interface: `available`, `generate` and `stream`                               |
| `gemini-client.ts` | The real client, wrapping `@google/genai`. The SDK loads on the first request                |
| `errors.ts`        | Turns any failure into an `AiFailure` with a readable message, and decides whether to retry  |
| `queue.ts`         | Runs requests in order, inside the per-minute limit, retrying 429 and 5xx with backoff       |
| `store.ts`         | The SQLite cache, the daily request count and saved feedback                                 |
| `lesson-search.ts` | The MiniSearch index of lesson chunks, kept in memory and rebuilt when a lesson file changes |
| `mdx-text.ts`      | Strips a lesson to plain Markdown and splits it at its headings                              |
| `prompts.ts`       | The Part 8 system prompt, and the context, engine and course blocks around each question     |
| `json-reply.ts`    | Converts a Zod schema for Gemini, and reads JSON from a reply                                |
| `tasks.ts`         | Each structured task's prompt, temperature and extra checks                                  |
| `service.ts`       | Puts these together: `status`, `chat` and `runTask`                                          |

To run without Gemini, pass a fake to `buildApp({ aiClient })`. It only needs the three members of `AiClient`, and it can fail by throwing anything with a numeric `status`, like `{ status: 429 }`.

**The model** comes from Settings, then `GEMINI_MODEL`. **The limits** come from `GEMINI_REQUESTS_PER_MINUTE`, which the queue enforces, and `GEMINI_REQUESTS_PER_DAY`, which only sets the hint.

**The cache** is keyed by a hash of the model, system prompt and messages. The context is part of the messages, so the same question about different code is a different request. Passing `fresh: true` skips it, and tasks that should give something new each time, like `quiz-generate`, never use it.

### Context

`apps/web/src/ai/context-store.ts` attaches the current context to every call, so a page only says what it knows:

```tsx
// In a lesson, the lab or anywhere else: this is read at the moment a question is sent.
useAiContextSection('quiz', () => ({ question, studentAnswer, correctAnswer }));

// In a visualizer: what the student typed. The Player adds the step number and the step's state.
useAiVisualizerInput(grammarText);
```

When the engine can compute an answer, pass it, and the model is told to use it and never to work out a different one:

```ts
stream.send({
  question: 'Why is this grammar not LL(1)?',
  context: { engine: [{ label: 'FIRST and FOLLOW', result: JSON.stringify(sets) }] },
});
```

### Calling a structured task

From the browser, `useAiTask` handles cancelling and errors. Every name, input and output is typed from `AI_TASK_SCHEMAS` in `packages/shared/src/ai-schemas.ts`, and the names are in `AI_TASK_NAMES` in `packages/shared/src/ai.ts`.

```tsx
const plan = useAiTask('study-plan');
await plan.run({ examDate, today, hoursPerDay: 2, weakTopics });
// plan.status is 'idle', 'running', 'done' or 'error'
// plan.response.data has passed the schema. plan.error has a readable message.
```

Without the hook, use `api.aiTask('study-plan', input, { context, level, fresh, signal })`. Over HTTP, send `POST /api/ai/structured` with `{ task, input, context?, level?, fresh? }`. The reply is `{ task, data, aiGenerated: true, label: 'AI-generated', model, cached, truncated, sources, quota }`. A failure is the usual `{ error: { code, message } }`, and a page should show codes that `isAiUnavailable` accepts with `AiOfflineNotice`. Show AI output inside `AiResultFrame`, which adds the label and the Report wrong answer button.

The model is given the JSON schema, and Zod checks each reply. An invalid reply is sent back with what was wrong, up to three tries in all.

| Task                    | Input                                                                         | `data`                                                                 |
| ----------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `quiz-generate`         | `topicId`, `difficulty`, `count`, `kinds`, `avoid`                            | `questions`, in the same shape as the course's own questions           |
| `wrong-answer-explain`  | `question`, `options`, `correctAnswer`, `studentAnswer`                       | `whyWrong`, `whyCorrect`, `misconception`, `tryThis`                   |
| `short-answer-grade`    | `question`, `studentAnswer`, `modelAnswer`, `rubric`, `maxMarks`              | `marks`, `maxMarks`, `verdict`, `rubric`, `feedback`, `improvedAnswer` |
| `study-plan`            | `examDate`, `today`, `hoursPerDay`, `weakTopics`, `goal`                      | `summary`, `days`, `tips`                                              |
| `important-questions`   | `topicIds`, `exam`, `count`                                                   | `questions`, each with `why` and `answerOutline`                       |
| `mock-paper`            | `topicIds`, `exam`, `durationMinutes`, `totalMarks`, `mix`, `negativeMarking` | `title`, `instructions`, `durationMinutes`, `totalMarks`, `sections`   |
| `viva-turn`             | `topicId`, `difficulty`, `transcript`, `currentQuestion`, `answer`            | `evaluation`, `nextQuestion`, `done`                                   |
| `revision-sheet`        | `topicIds`, `minutes`, `exam`                                                 | `title`, `sections`, `formulas`, `traps`                               |
| `mnemonic-sheet`        | `topicIds`, `focus`                                                           | `title`, `mnemonics`, `cheatSheet`                                     |
| `topic-summary`         | `topicId`, `length`                                                           | `title`, `summary`, `keyPoints`, `terms`, `commonMistakes`             |
| `notes-to-flashcards`   | `notes`, `topicId`, `count`                                                   | `flashcards`                                                           |
| `mind-map`              | `topicId`                                                                     | `title`, and `nodes` as a flat list with `id` and `parent`             |
| `project-design-review` | `description`, `stage`, `goals`, `files`                                      | `overall`, `strengths`, `risks`, `nextSteps`, `questions`              |
| `task-breakdown`        | `goal`, `stage`, `currentState`, `hoursAvailable`                             | `summary`, `tasks`                                                     |
| `code-review`           | `files`, `goal`, `focus`                                                      | `summary`, `issues`, `strengths`, `complexity`                         |
| `fix-suggestions`       | `mode` (`hints` or `full`), `problem`. Reads the lab context                  | `summary`, `hints`, `edits`                                            |
| `code-cross-check`      | `exerciseId`, `expectedBehavior`. Reads the lab context                       | `matchesExpected`, `mismatches`, `testInputs`, and more                |
| `predict-check`         | `guess`, `current`, `actual`                                                  | `verdict`, `feedback`                                                  |
| `formal-check-explain`  | `kind`, `submission`, `goal`, `engine`                                        | `headline`, `explanation`, `mistakes`, `nextStep`                      |

### Web pieces

Everything is in `apps/web/src/ai`. `command-palette-host.tsx`, `palette-store.ts` and `context-store.ts` are the only parts in the initial bundle. The rest load with the pages that use them, and `react-markdown` is a separate chunk that loads when there is an answer to show.

| Piece                                  | Purpose                                                                         |
| -------------------------------------- | ------------------------------------------------------------------------------- |
| `useAiStream`                          | Streams an answer. It has `send`, `cancel` and `reset`, and cancels on unmount  |
| `useAiTask`                            | Runs a structured task                                                          |
| `useAiStatus`, `AiOfflineNotice`       | Whether AI can answer now, and the calm message when it cannot                  |
| `AskAiPanel`                           | The chat: question box, levels, follow-ups and rolling history                  |
| `AiAnswer`, `AiResultFrame`, `AiLabel` | Labels AI output, with its sources and the report button                        |
| `AiMarkdown`                           | Renders AI text as Markdown. Images are removed                                 |
| `ReportWrongAnswer`                    | Part 8's report button                                                          |
| `FormalChecker`, `FormalCheckExplain`  | Shows the engine's verdict on a grammar or automaton, and has the AI explain it |
| `DiffView`                             | A line diff in the diff colors, with + and - as well                            |

Where AI appears: `routes/tutor.tsx`, which honors `location.state.ask` and `location.state.context`; `lesson-ask-ai.tsx`, the floating panel with selection actions on every lesson; `step-companion.tsx` in the Player; `lab-help.tsx`, the lab's AI help tab; and `command-palette.tsx`, on Ctrl+K. A grammar visualizer checks the work in the engine, then mounts it like this:

```tsx
<FormalChecker kind="grammar" submission={text} check={{ correct, summary, findings }} />
```
