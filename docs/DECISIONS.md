# Decisions

Choices that interpret or change the spec, with the reason for each.

## Milestone 1

### Versions held back from latest

The spec names React 18 and asks for packages that install cleanly, which limits a few versions:

| Package      | Using | Latest | Why                                                      |
| ------------ | ----- | ------ | -------------------------------------------------------- |
| React Router | 7     | 8      | Version 8 requires React 19. The spec requires React 18. |
| TypeScript   | 6.0   | 7      | `typescript-eslint` supports TypeScript below 6.1.       |
| ESLint       | 9     | 10     | `eslint-plugin-jsx-a11y` supports up to ESLint 9.        |

### Node version

`.nvmrc` pins 22 and `engines` requires 22.22.2 or later within 22, the floor set by jsdom. `doctor` and `setup` treat newer majors as a warning, not a failure, so a student on a newer Node is not blocked. Older majors fail with exact instructions.

### Scripts are JavaScript, not TypeScript

The spec says TypeScript everywhere, but `npm run setup` has to run on a fresh clone with no dependencies installed. So everything `setup`, `doctor` and `start` use is `.mjs` with `// @ts-check` and JSDoc types, and `tsc` still checks it. `backup` and `reset` run after install, so they are TypeScript.

### `npm start` is one command that runs two processes

Part 3 says "single process start". I read this as one command. It starts the Vite dev server and the API server, which keeps hot reload and API restarts independent. The production build really is one process on one port.

### Dependencies arrive with the milestone that uses them

Part 2 lists the whole stack, and Part 15 asks for a justification for each dependency. These are installed when first used, not in Milestone 1:

- Milestone 2: Framer Motion, React Flow, KaTeX, MDX
- Milestone 3: Monaco, xterm.js, `@fastify/websocket`
- Milestone 5: D3, for parse tree layout. Automata use a small layered layout written for them, and the syntax tree in Milestone 2 does not need D3 either.
- Milestone 4: `@google/genai`, MiniSearch
- Milestone 6: Recharts
- Milestone 9: React Three Fiber, drei

`scripts/seed` and `scripts/export` from Part 3 also wait until there is data to seed or export.

### Dependencies added beyond the spec

| Package                                                                                      | Justification                                                      |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `@fontsource-variable/geist`, `-mono`                                                        | Bundles the fonts locally, because the app may not call font CDNs. |
| `@fastify/static`                                                                            | Serves the built web app in production.                            |
| `esbuild`                                                                                    | Bundles the server for production.                                 |
| `tsx`                                                                                        | Runs the TypeScript server and scripts without a build step.       |
| `class-variance-authority`, `clsx`, `tailwind-merge`, `@radix-ui/react-slot`, `lucide-react` | The standard shadcn/ui component dependencies.                     |
| `jsdom`, `@testing-library/*`                                                                | Component tests in Vitest.                                         |
| `@axe-core/playwright`                                                                       | The axe checks that Part 13 requires.                              |
| `globals`, `eslint-config-prettier`, `eslint-plugin-*`                                       | ESLint configuration, including hook and accessibility rules.      |

### shadcn/ui components are written by hand

Components follow shadcn/ui's conventions (`cva`, `cn`, local source, `components.json`), but use native `<select>` and `<input type="range">` where those are enough. They are accessible by default and keep the initial bundle small. Later milestones can add components with the shadcn CLI.

### SQLite driver and fallback

`better-sqlite3` 13 ships prebuilt binaries for Windows, macOS and Linux inside its package. The documented fallback that Part 1 asks for is Node's built-in `node:sqlite`. It is selected automatically and tested against the same contract.

### Install scripts are off

`.npmrc` sets `ignore-scripts=true`. Without it, a fresh clone fails to install on any machine lacking a full C++ toolchain: npm's lockfile does not record `better-sqlite3`'s `gypfile: false`, so a lockfile install sees its `binding.gyp` and runs `node-gyp`. A first install with no lockfile does not show this, so only a real fresh clone reveals it (see [TESTING.md](TESTING.md)). No dependency needs an install script, and this also stops dependencies running code at install time. Because the root `prepare` script no longer runs on install either, `npm run setup` activates the git hooks itself.

### Default Gemini model

`GEMINI_MODEL` defaults to `gemini-3.5-flash-lite`, which Google's model page (checked 2026-11-03) lists as stable and describes as its fastest, most cost-effective 3.5 model. That documentation no longer lists free-tier limits per model; they appear only at <https://aistudio.google.com/rate-limit> when signed in, so free-tier availability of this model is **not confirmed**. Check this again in Milestone 4, when the first AI call is made.

### Security beyond the spec

The spec requires binding to `127.0.0.1`. That alone does not stop a website in the student's browser from reaching the server, and Milestone 3 will compile and run code there. So every request is also checked for a loopback `Host` and a matching `Origin`, and production pages send a content security policy. LAN mode in Milestone 10 will need to extend the guard deliberately.

### Lab mode needs flex, bison, gcc and g++, but not make

The Part 7 pipelines call the compilers directly. A missing `make` still shows as a warning in `doctor`, but does not switch the lab to Simulated.

### Module 0 lessons are scheduled with Milestone 2

Part 14 does not assign Module 0 to a milestone. It comes before Module 1 and its 3D scene is covered by Milestone 9, so its lessons are marked for Milestone 2.

### Sections from later milestones show what is planned

Routes for later milestones explain what they will do and which milestone delivers them, and show real status where it exists, such as the toolchain on the Lab page. Part 12's "no placeholder text" applies to the final product. These sections are replaced as each milestone lands.

### The command palette waits for Milestone 4

Part 12 lists it under the UI, but Part 14 assigns it to Milestone 4.

### Browser tests are separate from `npm run check`

Part 13 defines the check as lint, typecheck, tests and build. Playwright needs a browser that a fresh machine may not have, so it runs as `npm run test:e2e`.

### What the 3-second cold start covers

Measured from fresh clones on Windows 11, `npm start` reports ready in 1.0 to 1.4 seconds on both Node 22 and Node 24, and the production server answers in about 1 second. The very first start after installing took 7 to 13 seconds. The likely cause is the operating system and antivirus reading the new files for the first time, though that is not confirmed. I treat the target as applying to normal starts and have not added a warm-up step to `setup`.

## Milestone 2

### Most graphs are plain SVG, and React Flow is only in the builder

Part 2 lists React Flow for graphs. It is used where it earns its place: the automata builder, for dragging, connecting and zooming. The animated visualizers draw their own SVG, because Part 6 requires exporting any step as SVG, PNG or GIF. The same React component draws the screen and the export, and React Flow renders nodes as HTML, which cannot be exported that way. Both share one edge-routing function, so they look alike.

### Framer Motion does only entry and caption animation

States and edges fade in, and the step caption crossfades. Moving states use a CSS transition. All of it honors `prefers-reduced-motion` and the Animation speed setting. Exported frames are drawn with no animation.

### Regular expression syntax

The engine accepts union, concatenation, `*`, `+`, `?`, groups, classes and escapes, as Part 4 requires, plus three additions:

- `ε` means the empty string, so textbook expressions like `a|ε` can be typed directly. `\ε` is the literal character.
- `"quoted text"` is literal, as in Lex, because Module 1 teaches Lex.
- Class escapes `\d \w \s` and their negations work in and out of classes.

Repeat counts like `a{2,3}` are rejected with a hint, since Part 4 does not list them and in Lex braces also mean named definitions. Unknown escapes mean the character itself, as in Lex. `.` matches anything except a newline. Empty alternatives such as `a|` are errors with a hint to write `ε`, because they are usually typos.

### Thompson's construction keeps the book's numbering

State numbers are assigned before anything is drawn, using the order that reproduces the Dragon Book's numbering of `(a|b)*abb`, 0 to 10. To show a concatenation actually happening, the right-hand fragment's start state appears as a waiting copy, such as `7′`, which then merges into state 7.

### Minimization uses Hopcroft's algorithm

Part 4 asks for Hopcroft's algorithm. The Dragon Book's Algorithm 3.39 is the simpler partition refinement. They produce the same minimal DFA, and the lessons explain the idea in terms common to both. A dead state is added for missing moves and removed from the result. A state that can never reach acceptance is removed too, so diagrams stay readable.

### The lexer's error recovery groups adjacent bad characters

Panic mode deletes one character at a time, as the book describes, and adjacent bad characters are reported as one error, so `@#$` gives one message rather than three.

### The module and the phase are one field

Part 3 lists "phase" among a lesson's frontmatter. Each module is one phase, so the field is named `module` and its value is the module's id.

### A topic with no visualizer can still be completed

Part 11's rule requires using a visualizer, but some Module 0 topics have none until the 3D scenes arrive in Milestone 9. For those topics that requirement is skipped, and reading counts for more on the mastery meter.

### The mastery meter's weights

Part 5 asks for a meter but sets no formula. It is 20% for reading, 20% for using a visualizer and 60% for the best quiz score, because the quiz is the only part that tests recall. Completion follows Part 11's rule exactly. Reading is recorded when the end of the lesson text scrolls into view.

### Quizzes are practice mode for now

This milestone has multiple choice, self-marked short answers, and regex problems the engine grades by proving equivalence. Timed tests, other question types, spaced repetition and AI grading of short answers are Milestone 6, so flashcards only flip for now. The Lab section links to the lab page until Milestone 3, and Ask AI goes to the tutor page until Milestone 4.

### Limits that protect the page

All engine work runs in a Web Worker and stops after 10 seconds. Expressions are limited to 300 characters, DFAs to 300 states, the token player to 4000 characters, and the buffer demo to 400. Each limit gives a readable error. GIF export samples at most 60 frames, and runs on the main thread with pauses, since it needs a canvas.

### Fonts are never inlined

`assetsInlineLimit` is 0, because Vite otherwise turns small fonts into `data:` URLs, which the production content security policy correctly blocks.

### Dependencies added in this milestone

| Package                                                             | Justification                                                                                    |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `fast-check`                                                        | The property tests Part 13 requires. Pure JavaScript, and it shrinks failures to small examples. |
| `yaml`                                                              | Reads lesson frontmatter on the server.                                                          |
| `@mdx-js/rollup`, `@mdx-js/mdx`, `remark-frontmatter`, `remark-gfm` | Compiles MDX lessons, which Part 2 requires. The second is for validating lessons in tests.      |
| `remark-math`, `rehype-katex`, `katex`                              | Renders math at build time. Only KaTeX's CSS and fonts reach the browser.                        |
| `@xyflow/react`, `framer-motion`                                    | Named in Part 2.                                                                                 |
| `gifenc`                                                            | Encodes GIF exports. Small, pure JavaScript, and loaded only when used.                          |

## Milestone 3

### The spec files were empty, and are now restored

`CLAUDE.md` and `docs/SPEC.md` were committed empty in Milestone 1, so links to them went nowhere. They are now rebuilt from the original PDF, with Part 0 to 5 in `CLAUDE.md` and the rest in `docs/SPEC.md`, as the PDF instructs. A word count against the PDF found nothing missing. The PDF's layout puts a few paragraph breaks in odd places, and those are kept rather than rewritten.

### This is a set of limits, not a security sandbox

Part 7 calls this "local but still responsible". A student's program runs as the student, on their own computer, and it can read their files like anything else they run. The runner protects against accidents, like infinite loops and huge output. It is not safe for running code from someone else, and the docs say so.

What it does: a fresh folder for each job under `data/runs`, `spawn` with argument arrays and no shell, the limits below, a process-tree kill, a file name allow-list, a compiler flag allow-list, and an environment that passes only what tools need, so the Gemini key never reaches a program. The Host and Origin guard covers the WebSocket too.

### Time limits

The student's program gets the spec's 5 seconds. Compilers get 30, which is a deliberate difference: they are not the student's code, and g++ alone can take several seconds on a slow disk. A compile that hit the limit would look like a bug in the student's work.

### The memory limit is a watchdog

Part 7 asks for a memory limit "where the OS allows it". Node has no way to set one when starting a process, and a real one on Windows needs native code, which Part 1 asks to avoid. So the runner checks a program's memory four times a second with `tasklist` or `ps`, and stops it above 256 MB. A program that allocates very quickly can overshoot for a moment. This is one code path on every system, and a program that finishes within a quarter of a second never starts a check at all.

### Compiler flags are a short list

Part 7 asks for selectable flags. Free text would let a flag write outside the run folder (`-o`) or load code into the compiler (`-fplugin`), so the lab offers a fixed set of checkboxes instead.

### Real runs do not need libfl

`-lfl` provides `yywrap` and `main`, but libfl is awkward to install on some systems. When a `.l` file needs either, the pipeline writes a small `lab_defaults.c` with the same two functions and shows it under Generated files. Passing `--noyywrap` to flex would be simpler, but it turns `yywrap` into a macro, which breaks the many textbook files that define their own.

### The token stream comes from the scanner itself

"Shows token stream" could mean re-running the rules in the teaching engine, but that could disagree with what flex really did. So real runs pass `-d` to flex. The scanner then reports each rule it accepts on stderr, and the server collects those reports and removes them from what the student sees. If a future flex changed that format, the only effect would be extra lines on stderr and an empty token table. The Visual trace tab is separate, and is labeled as the teaching engine.

### What Simulated mode is

Part 7's fallback runs the mini-Lex subset, and exercises need the C in a rule's actions to run too. So `packages/engine` gained a flex file parser, a flex pattern parser and a small C interpreter.

- **Lex:** definitions, `%option`, start conditions, `^`, `$`, `/`, repeat counts, `<<EOF>>`, `REJECT`, `yymore`, `yyless`, `input`, `unput`, `yyterminate`, `yylineno`.
- **C:** ints, chars, floats, arrays, pointers, functions, enums, simple `#define`, control flow, and common functions from `stdio.h`, `string.h`, `ctype.h` and `stdlib.h`.
- **Not supported:** structs, unions, typedefs, `goto`, function pointers, `#if`, macros with arguments, and file I/O. Each gives a readable error that suggests installing the real tools.
- **C and C++ programs are not simulated.** Part 7's fallback is only for Lex and Yacc, and a C interpreter good enough to stand in for gcc would be a different project. Those pipelines show the install commands instead.

It reads bytes, as C does, so `yyleng` and character classes agree with real flex on non-ASCII text. It catches some things real C would not, such as an array index past the end, and explains them. Each rule gets its own DFA rather than sharing one as the mini-Lex visualizer does, because `^`, trailing context and `REJECT` all need to ask about one rule at a time. A rule that would match no text at all is skipped, where real flex would loop forever.

It runs on the server in small slices, between which it yields to the event loop. A Worker would be simpler to reason about, but it does not fit a single bundled server file. This way Stop works immediately, and a runaway program cannot block anything else.

### Hidden tests stay on the server

The browser never receives hidden test inputs or a solution until the student asks for one. This is a local app, so someone determined can read the files, and that is fine. The goal is to keep the answers from being one glance away.

### Other choices

- **One folder level.** The file tree is flat. Lab programs are small, and flat names make the path traversal rules very simple.
- **Input is given up front.** The input pane is sent to the program and then closed, so a program waiting for input gets end of file rather than hanging. The terminal only shows output.
- **One WebSocket per job.** It closes when the job ends, and closing the page stops the job.
- **Exercises are folders.** Each has `exercise.json`, `starter/` and `solution/`, so the code stays in real files that editors can highlight.
- **The bison pipeline is Milestone 5**, as Part 14 assigns it.

### Monaco is bundled locally, without its language services

Part 1 allows no network calls, so Monaco never loads from a CDN. `apps/web/src/lab/monaco.ts` imports the same editor features as Monaco's own `editor.main.js`, minus the diff editor and the TypeScript, CSS, HTML and JSON services, whose workers would add many megabytes the lab never uses. `monaco-vim` and `monaco-emacs` import Monaco by paths its current package map does not offer, so `vite.config.ts` has aliases for them, and a browser test checks that each key binding really attaches.

### Dependencies added in this milestone

| Package                            | Justification                                                                                    |
| ---------------------------------- | ------------------------------------------------------------------------------------------------ |
| `monaco-editor`                    | Named in Part 2. Loaded only by the lab workspace.                                               |
| `@xterm/xterm`, `@xterm/addon-fit` | Named in Part 2. The addon sizes the terminal to its pane.                                       |
| `@fastify/websocket`               | Part 2 requires WebSocket streaming, and this is Fastify's own plugin. Pure JavaScript.          |
| `monaco-vim`, `monaco-emacs`       | Settings has offered these key bindings since Milestone 1. Loaded only by those who choose them. |
