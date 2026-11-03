## PART 0: Role and goal

You are a principal engineer and instructional designer at an education-software company. Build CompilerLab, a polished, offline-first desktop-class web app that teaches Compiler Design from theory to practice. It must be suitable for self-learners and for adoption by universities (students and instructors).

Product promise: a student can learn all seven compiler phases through lessons, interactive diagrams, step-by-step simulations, real Lex/Yacc/C/C++ lab execution, quizzes, exam preparation, and an AI tutor, all on one PC, with one setup command.

## PART 1: Non-negotiable requirements

1. Local only. Everything runs on the user's PC. The only external network call is to the Gemini API, and the app must be fully usable when that is unavailable (AI features show a friendly offline state).

2. Zero-struggle setup. npm run setup then npm start is all that is needed. Include

npm run doctor , which checks Node version, flex, bison, gcc, g++, make, and the Gemini key, and prints exact fix instructions per OS (Windows via WSL2 or MSYS2, macOS via Homebrew, Ubuntu via apt). Auto-create .env from .env.example . Pin

Node 22 LTS with .nvmrc and engines . Avoid dependencies that need native compilation where a pure-JS option exists; if a native one is unavoidable, use packages with prebuilt binaries and a documented fallback.

3. Fast. Cold start under 3 seconds, route changes under 100 ms, 60 fps animations. Use code splitting per route, lazy-load Three.js and Monaco, memoize heavy visualizers, run heavy algorithms in Web Workers, virtualize long lists/tables.

4. Real tools. The lab runs real flex, bison, gcc and g++. If they are missing, fall back to the built-in TypeScript teaching engine and clearly label results "Simulated".

5. Correctness. All algorithms in the shared engine (Part 4) are unit-tested against known textbook answers (Aho/Lam/Sethi/Ullman, Dragon Book).

6. Accessible and polished. Keyboard navigation, WCAG AA contrast, dark and light themes, reduced-motion support, responsive down to 1280x720 and usable on tablet widths.

7. Resilient. Never crash on bad input; every error is shown with a human-readable explanation and an "Ask AI" button.

## PART 2: Tech stack (use exactly this unless a blocker is found; explain any change)

Language: TypeScript (strict) everywhere.

Monorepo: npm workspaces: apps/web , apps/server , packages/engine ,

packages/content , packages/shared .

Frontend: React 18, Vite, React Router, Zustand (state), TanStack Query, Tailwind CSS + shadcn/ui, Framer Motion, React Flow (graphs), D3 (layouts, scales), React Three Fiber + drei (3D), Monaco Editor (code), xterm.js (terminal output), KaTeX (math), MDX (lessons), Recharts (analytics).

Backend: Node + Fastify, WebSocket for streaming lab output, Zod for validation,

better-sqlite3 for SQLite (progress, notes, AI cache), pino logging.

AI: official Google GenAI SDK ( @google/genai ), model name from env GEMINI_MODEL

(default to a current fast free-tier model after checking docs).

Testing: Vitest (unit), Playwright (end-to-end), axe (accessibility).

Quality: ESLint, Prettier, Husky pre-commit, strict tsc .

## PART 3: Architecture

```text
compilerlab/
  apps/web/            React app (routes: dashboard, learn, visualize, lab,
practice, exam, tutor, projects, settings)
  apps/server/         Fastify: /api/lab, /api/ai, /api/progress,
/api/content, /api/export
  packages/engine/     Pure TS compiler-theory engine (no DOM, runs in
browser workers and Node)
  packages/content/    MDX lessons, quiz banks (JSON), lab exercises,
glossary, flashcards
  packages/shared/     Types, Zod schemas, constants
  scripts/             setup, doctor, seed, export
  docs/                SPEC.md, ARCHITECTURE.md, CONTENT_GUIDE.md, TESTING.md
```

Single process start: npm start builds nothing heavy in dev; it launches server and web together and opens the browser. npm run build && npm run start:prod serves

the built app from Fastify on one port.

Data: SQLite file in ./data/ . Auto-migrate on boot. Add npm run backup and npm

run reset .

Content is data, not code: lessons are MDX with frontmatter (phase, topic id, prerequisites, estimated time, learning outcomes). Adding a new topic requires no code change.

## PART 4: Shared compiler engine ( packages/engine )

Every visualizer is driven by this engine, which must emit a step trace (array of immutable snapshots with a human-readable explanation per step) so the UI can play, pause, step forward/back, scrub, and change speed.

Implement and test:

Regex: parser (union, concat, star, plus, optional, classes, escapes) to AST; Thompson construction to NFA; subset construction to DFA; Hopcroft minimization; DFA/NFA simulation with trace; regex to DFA direct method (followpos).

Lexer generator (mini-Lex): token rules with priority and longest-match, line/column tracking, error recovery.

Grammar tools: CFG parser from text; ambiguity detection (bounded search); left- recursion elimination; left factoring; nullable, FIRST, FOLLOW with iteration traces.

Top-down: recursive descent trace; LL(1) table builder with conflict detection; table- driven predictive parser with trace.

Bottom-up: LR(0) items, closure and goto; SLR(1), canonical LR(1), LALR(1) table builders with conflict reports (shift/reduce, reduce/reduce) and trace; operator- precedence parsing; shift-reduce parser trace with stack, input and action.

Semantic: attribute grammars (synthesized and inherited), SDD dependency graph, SDT with embedded actions, annotated parse tree evaluation.

Types and symbols: symbol table with scopes, type checker for a mini-language, type expressions, coercion and equivalence.

IR: AST to three-address code, quadruples, triples, indirect triples, SSA conversion (with phi placement), basic block partition, control-flow graph, DAG for expressions.

Optimization: constant folding and propagation, copy propagation, common subexpression elimination, dead code elimination, strength reduction, loop-invariant code motion, peephole; data-flow analyses (reaching definitions, live variables, available expressions) with iterative worklist trace.

Code generation: stack-machine codegen, simple register allocation (next-use, graph coloring with trace), instruction selection for a teaching ISA, runtime activation records.

Teaching VM: a small stack/register VM with assembler, step execution, registers, memory and call-stack view.

Mini language "TinyC": lexer, parser, type checker, IR, optimizer, codegen, VM. This powers the capstone project.

## PART 5: Curriculum (all seven phases plus foundations)

Each topic page follows one template: Hook (why it matters) → Concept (text + diagrams) → Interactive visualizer → Worked example → Common mistakes → Practice (3-10 problems) → Lab link → Quiz (5-10 MCQ + short answers) → Summary and flashcards → "Ask AI" panel. Show estimated time, prerequisites, and a mastery meter.

Module 0: Foundations. Compiler vs interpreter vs assembler vs linker/loader, compiler structure and the phases pipeline, bootstrapping and cross-compilers, language processing system, compiler-construction tools. 3D scene: an animated "source to executable" pipeline you can fly through, clicking each phase to open its lesson.

Module 1: Lexical analysis. Role of the lexer, tokens/lexemes/patterns, input buffering, regular expressions, finite automata (NFA, DFA, epsilon-NFA), regex to NFA to DFA to minimal DFA, lexer design, error handling, Lex/Flex (structure, regex syntax, yytext, yylex, yylval, start conditions). Visualizers: automata builder (drag/drop states), regex-to-NFA animation, subset-construction table, DFA minimization partition view, token-stream player on real code.

Module 2: Syntax analysis. CFG, derivations, parse trees, ambiguity, grammar transformations; top-down (recursive descent, backtracking, LL(1), FIRST/FOLLOW); bottom-up (handles, shift-reduce, operator precedence, LR(0), SLR, CLR, LALR); error recovery (panic mode, phrase level); Yacc/Bison (structure, precedence, %union, conflicts, mid-rule actions, yyerror). Visualizers: grammar workbench, FIRST/FOLLOW fill- in, LL(1) table with conflict highlighting, LR automaton graph with item sets, parser stack animator with input tape, parse tree and derivation side by side, ambiguity explorer.

Module 3: Semantic analysis. SDD, SDT, attributes, dependency graphs, L- and S- attributed definitions, type systems, type checking and inference basics, scope and binding, symbol table organization (hash, tree, scoped stacks), declarations processing. Visualizers: annotated parse tree evaluator, dependency graph, scope stack animation, type-checker stepper.

Module 4: Intermediate code generation. Syntax trees, DAGs, postfix, three-address code, quadruples/triples/indirect triples, SSA, control-flow translation (boolean expressions, backpatching), arrays, procedures, switch. Visualizers: AST to TAC animator, backpatching stepper, DAG builder, SSA phi explorer.

Module 5: Code optimization. Basic blocks and flow graphs, local optimizations, global data-flow analysis, loop optimization, peephole, machine-independent vs dependent. Visualizers: before/after diff with highlighted transformations, data-flow solver with IN/OUT sets per iteration, CFG with loop detection (dominators, natural loops), optimization pipeline toggles.

Module 6: Code generation. Target machine models, instruction selection, register allocation and assignment, graph coloring, next-use information, getReg algorithm, basic block codegen, DAG-based generation, optimal ordering. Visualizers: register allocator stepper, interference graph coloring, codegen table, VM execution.

Module 7: Runtime environments and supporting phases. Storage organization, activation records, stack and heap, parameter passing, access links, garbage collection overview, symbol table management, error handling across all phases (lexical, syntactic, semantic, logical), linking and loading. Visualizers: call-stack and activation record animation, heap/GC demo, parameter-passing comparison (value, reference, name, copy- restore).

Module 8: Advanced (optional tracks). LLVM IR overview, JIT, interpreters and bytecode VMs, parser generators (ANTLR, PEG), incremental parsing, static analysis basics.

Content volume targets: around 70 topics, 600+ quiz questions, 150+ practice problems, 60+ lab exercises, glossary of 300+ terms, 400+ flashcards. Every question has a hint, solution and explanation. Mark each item with difficulty and tags. Tag items to common exam patterns (GATE, university end-semester style).
