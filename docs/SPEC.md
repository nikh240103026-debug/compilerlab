CompilerLab: Master Build Prompt for Claude Code

A complete, staged specification for a local-first, university-grade Compiler Design learning platform.

How to use this document

1. Create an empty folder compilerlab/ , open it in Claude Code, and save Part 0 and Parts 1-5 as CLAUDE.md (the project rules Claude Code re-reads every session).

2. Put the rest in docs/SPEC.md . Then give Claude Code one milestone at a time from Part 14: "Read CLAUDE.md and docs/SPEC.md. Implement Milestone N only. Run tests. Report what is done and what is left."

3. Never ask for the whole app in one prompt. Finish, run and commit each milestone before starting the next.

4. Create a Gemini key at Google AI Studio and put it in .env as GEMINI_API_KEY . Check

Google's current docs for free-tier models and limits, because they change.

## PART 6: Visualization system

A common Player component: play, pause, step, step-back, speed slider, scrub bar, "explain this step" caption, keyboard shortcuts, and "export as PNG/SVG/GIF".

A Playground per visualizer: user enters their own regex, grammar, or code; the engine runs it; shows errors clearly.

Consistent visual language: states as circles, accepting states double-ringed, active elements glow, color-coded token types, diffs in green/red.

3D scenes (use only where they add understanding): (1) full compilation pipeline fly- through, (2) parse tree growing in 3D with depth layers, (3) CFG with loops as orbiting structures, (4) call stack as a physical stack of frames, (5) register allocation interference graph in 3D with force layout. Each 3D scene has a 2D fallback toggle and auto-degrades on low-end GPUs.

Optional: support embedding pre-rendered intro videos ( packages/content/videos/phase-N.mp4 ) at the top of each module when files exist.

The app must work without them.

## PART 7: Lab system (real execution)

Lab workspace: Monaco multi-file editor ( .l , .y , .c , .cpp , .h , input file), file tree, templates, terminal pane (xterm.js), input/stdin pane, and tabs for Build log, Output, Generated files, and Visual trace.

Pipelines (one click each):

Lex only: flex then gcc then run on sample input; shows token stream.

Lex + Yacc: bison -d , flex , gcc then run; shows the parse.

C and C++ programs: compile with selectable standard and flags, run with stdin.

Show intermediate generated files ( lex.yy.c , y.tab.c , y.output state report) in read-only tabs.

Backend safety (local but still responsible): bind to 127.0.0.1 only; run each job in a

fresh temp directory under ./data/runs/ ; use spawn with argument arrays (never shell strings); enforce wall-clock timeout (default 5 s), output cap (1 MB), memory limit where the OS allows it, process-tree kill on timeout; auto-clean old runs; block path traversal in file names. Stream output via WebSocket. Support Stop button.

Smart diagnostics: parse compiler/bison output into structured errors with line markers in the editor (squiggles) and a plain-English explanation. Detect bison conflicts and open the conflict explorer linked to the LR automaton visual.

Visual trace link: after a lab run, "Visualize" re-runs the same grammar/input through the engine and opens the parse animation so students connect real tools with theory.

Lab curriculum: guided exercises with starter code, auto-checkers (expected output tests, hidden test cases), hints, and solutions. Examples: word counter, token recognizer, comment stripper, calculator (Lex+Yacc), expression evaluator with precedence, symbol table builder, simple type checker, three-address code generator, infix to postfix, mini- interpreter, error recovery grammar. Provide at least 8 per module where applicable.

Fallback mode: if tools are missing, the Simulated engine runs the mini-Lex and mini-Yacc subset and says so.

## PART 8: AI tutor (Gemini) — available everywhere

Backend proxy: the key lives only in the server .env ; the browser never sees it. Add a

request queue with exponential backoff on 429/5xx, per-minute rate limiting to respect the free tier, response streaming (SSE), cancellation, and a local cache of identical prompts in SQLite. Show remaining-quota hints and a graceful message when offline or rate-limited.

Context-aware by design: every AI call automatically includes the current context: topic ID and text excerpt, the visualizer state (grammar, step number), the lab files and last build/run output, the quiz question and the student's answer, plus a short rolling chat history. Use a strong system prompt: act as a patient compiler-design professor, be accurate, follow the course's notation, say "I'm not sure" when uncertain, and never invent flag names or tool behavior.

Where AI appears (must all be implemented):

1. Topic doubt clearing: floating "Ask AI" panel on every lesson; select any text and choose Explain simply / Give an example / Why?; level selector (beginner, intermediate, exam-focused); "explain like I'm new" and "go deeper" buttons.

2. Visualizer companion: "Why did this step happen?" on any step; "Predict the next step" mode where the student guesses and the AI checks.

3. Program debugging: "Explain this error", "Fix suggestions" with a diff view the student can accept or reject, Lex/Yacc conflict explanations, segfault and undefined-reference help. A Socratic mode gives hints first and the full fix only after the student asks.

4. Code cross-check: compare the student's solution against expected behavior, generate extra test inputs and edge cases, review style and complexity, and explain differences from the reference solution without just revealing it.

5. Grammar and automata checker: student submits a grammar or DFA; the engine verifies correctness formally, then the AI explains mistakes in words (the engine is the source of truth, the AI only explains).

6. Quizzes and tests: generate new questions per topic and difficulty (strict JSON schema validated with Zod, retry on invalid output), explain wrong answers, and mark them "AI-generated" until reviewed. Short-answer grading with rubric and feedback.

7. Exam preparation: personalized study plan from weak topics and exam date, important-questions list, previous-year style paper generation, viva/interview simulator (AI asks questions, evaluates spoken or typed answers), last-minute revision sheets, and mnemonic/cheat-sheet creation.

8. Notes and flashcards: summarize a topic, convert notes into flashcards, build a mind map from a lesson.

9. Project mentor: design review for the capstone compiler, task breakdown, and code review.

10. Global command palette (Ctrl+K): ask anything, jump to topics, run actions.

Safety and quality: label AI output, add a "Report wrong answer" button that stores feedback locally, ground answers on the course content (retrieve relevant lesson chunks using a local lightweight search such as MiniSearch before calling the model), and when the engine can compute the answer (FIRST/FOLLOW, tables), supply the computed result to the model so it never guesses.

## PART 9: Assessment and exam preparation

Quiz types: MCQ, multi-select, fill-in-the-blank, match-the-following, drag-and-drop ordering (for derivation/parsing steps), table completion (FIRST/FOLLOW, parsing tables), DFA/NFA drawing, grammar writing, trace-the-parser, and code output prediction. Auto-graded by the engine wherever possible.

Modes: practice (instant feedback), timed test, topic test, phase test, full mock exam (configurable duration, marks, question mix, negative marking), adaptive difficulty, and spaced repetition for flashcards (SM-2).

Results: score, time per question, topic-wise breakdown, weak-area detection, review mode with explanations and AI help, retry-only-mistakes mode.

Exam prep center: syllabus mapper (pick GATE, a university, or custom syllabus and see coverage), formula and algorithm cheat sheets, "top 50 questions", step-by-step worked solutions for classic problems (LR table construction, minimization, etc.), and a printable PDF export.

Offline-first: all non-AI assessment works without internet.

## PART 10: Capstone and projects

Guided TinyC Compiler Project in 8 stages (lexer, parser, AST, semantic checks, IR, optimizer, codegen, VM) with tests at each stage, plus an optional "build a compiler in C with Lex/Yacc" track. Provide a milestone checklist, automated tests, and a final demo runner. Add 5 smaller mini-projects (calculator, JSON parser, config-file language, SQL subset parser, regex engine).

## PART 11: Learner and university features

Dashboard: continue-learning card, daily streak, mastery per phase (radar chart), time spent, recent activity, recommended next step, upcoming exam countdown.

Progress engine: topic completion rules (read + visualizer used + quiz ≥ 70%), badges, and optional gentle gamification (XP, levels). It must be dismissible.

Notes and bookmarks: per-topic notes (Markdown), highlights, global search across lessons, glossary, notes and questions.

Instructor mode (offline): import a Course Pack (JSON/zip with syllabus, custom quizzes, assignments, lab exercises); create and edit assignments; export student reports as CSV/PDF; export and import a student progress file so a lecturer can collect results without a server. Optional LAN mode toggle to serve the app to a classroom on the local network, protected by a PIN.

Customization: university branding (logo, colors, name via a config file), language- ready i18n structure (English first), exam-board syllabus presets, and printable lesson PDFs.

Privacy: all data stays local; clear "export my data" and "delete everything" controls.

## PART 12: UI and UX direction

Professional product feel (think modern IDE meets learning platform): left navigation by module, breadcrumb, split-pane layouts (lesson and visualizer side by side, resizable), command palette, toasts, skeleton loaders, empty states with guidance, onboarding tour (first run: 60-second walkthrough and a short diagnostic placement quiz), settings (theme, font size, animation speed, editor keymap, Gemini model, tool paths). A consistent design system with tokens; no placeholder text or lorem ipsum in the final product.

## PART 13: Quality, testing and performance

Unit tests for every engine algorithm with textbook fixtures (target ≥ 90% coverage on

packages/engine ). Property tests for DFA minimization and conversion equivalence.

Server tests for the lab runner (timeouts, infinite loop, huge output, path traversal, missing tools).

Playwright end-to-end tests: onboarding, a lesson with a visualizer, a Lex+Yacc lab run, a quiz, an AI call using a mocked Gemini.

Accessibility checks with axe in CI scripts. Bundle budget: initial JS under 300 KB gzipped; lazy chunks for 3D and editor.

npm run check runs lint, typecheck, tests and build, and must pass before any

milestone is called done.

Documentation: README with a screenshot-ready quick start, troubleshooting per OS, architecture doc, content-authoring guide, and a contributing guide.

## PART 14: Milestones (give these to Claude Code one at a time)

1. Foundation: monorepo, tooling, setup / doctor / start , design system, layout shell,

routing, SQLite, settings, theme. Done when: a fresh clone runs with two commands.

2. Engine I: regex/NFA/DFA/minimization, lexer generator, tests. Module 1 content, automata visualizers, Player component.

3. Lab runner: server sandbox, Monaco workspace, flex/gcc/g++ pipelines, diagnostics, Module 1 lab exercises.

4. AI layer: Gemini proxy, caching, rate limiting, context builder, tutor panel, command palette, "Ask AI" in lessons and lab errors.

5. Engine II: CFG tools, FIRST/FOLLOW, LL(1), LR family, parser visualizers, Module 2 content, bison pipeline and conflict explorer.

6. Assessment: question engine, all quiz types, timed/mock exams, spaced repetition, results analytics, AI question generation and grading.

7. Modules 3-4: semantic analysis and IR engines, visualizers, content, labs.

8. Modules 5-6: optimization, data-flow, register allocation, VM, visualizers, content, labs.

9. Module 7-8 and runtime visuals, then 3D scenes: with 2D fallbacks.

10. Capstone and instructor mode: TinyC project, course packs, exports, LAN mode, branding.

11. Exam prep center, dashboard polish, onboarding, accessibility and performance pass.

12. Hardening: full test suite, docs, content review checklist, release build, final npm run

check .

For each milestone Claude Code must: restate the plan briefly, implement, run npm run

check , fix failures, write or update docs, and list what remains.

## PART 15: Working rules for Claude Code

Prefer simple, readable, well-typed code over clever code; keep files focused and small.

Do not add a dependency without a one-line justification; prefer ones that install cleanly on Windows, macOS and Linux.

Never hardcode secrets; never log the API key; never expose server ports beyond localhost unless LAN mode is explicitly enabled.

When unsure about a library API (especially the Gemini SDK, React Three Fiber, Fastify), read the installed package's types or docs before coding rather than guessing.

Write course content accurately; where a point is subtle or contested, add a "Check against the textbook" note and list it in docs/CONTENT_REVIEW.md for human review.

If a requirement is too large for one session, split it, finish the first part completely, and say clearly what is left.

Ask me a question only when a decision truly blocks progress; otherwise choose a sensible default, record it in docs/DECISIONS.md , and continue.

Begin with Milestone 1 now.
