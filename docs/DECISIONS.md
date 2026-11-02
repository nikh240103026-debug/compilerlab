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
