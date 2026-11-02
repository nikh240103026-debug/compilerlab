# Testing

## The check

```bash
npm run check
```

This runs lint (ESLint and Prettier), strict typecheck, all unit tests and the production build, including the bundle budget. It must pass before any milestone is called done.

## Unit tests

```bash
npm test
```

Vitest runs one project per package. Test files sit next to the code they cover.

| Project   | Covers                                                                                               |
| --------- | ---------------------------------------------------------------------------------------------------- |
| `shared`  | Settings validation and recovery from bad stored values                                              |
| `engine`  | Every algorithm against Dragon Book fixtures, plus property tests                                    |
| `content` | The course outline and every lesson and bank (see below)                                             |
| `scripts` | `.env` creation, version and tool checks, per-OS fix instructions                                    |
| `server`  | Both SQLite drivers, migrations, backup and reset, every route, the local-only guard, static serving |
| `web`     | WCAG contrast of every token, API client, split pane, error panel, toasts, route modules             |

### The engine

`textbook.test.ts` checks exact results from the Dragon Book: the 11-state NFA for `(a|b)*abb` with the book's numbering, the five-state subset construction table, the four-state minimal DFA, and the followpos table. `lexer.test.ts` does the same for the rule set `a`, `abb`, `a*b+`.

`properties.test.ts` uses `fast-check` to generate random expressions, and requires every route to agree: Thompson's NFA, subset construction, minimization and the direct method. They must match JavaScript's own regex engine, which shares no code with ours, and must be proven equivalent to each other. It also checks that minimal DFAs have no two equivalent states, and that the parser only ever throws readable errors.

These tests were checked by deliberately breaking the algorithms: removing the star's loop, skipping followpos for repeats, and dropping a Hopcroft splitter each make them fail.

Coverage on `packages/engine` must stay at 90% or above, and the run fails below that:

```bash
npm run test:coverage
```

### Course content

`packages/content/src/lessons.test.ts` runs for every topic. It checks frontmatter, prerequisites, the template's headings, that the MDX and its math compile, that lessons use only known components, that every regex in a lesson parses, that question banks are valid, and that `regex` practice problems agree with the engine. It cannot check that the teaching is correct: see [CONTENT_REVIEW.md](CONTENT_REVIEW.md).

## Browser and accessibility tests

These run the production build in a real browser with a throwaway data folder.

| File                  | Covers                                                                                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `shell.spec.ts`       | Every route, axe in both themes, route-change speed, keyboard use, tablet width, reduced motion, error handling, the server-down banner          |
| `visualizers.spec.ts` | Every visualizer in a real worker, the Player, PNG, SVG and GIF files, playground errors, the builder including drag and drop, axe mid-animation |
| `lessons.spec.ts`     | Every lesson, math under the content security policy, Try it buttons, engine-graded practice, quiz to completion, progress surviving a reload    |

```bash
npm run build
```

Playwright needs a browser. Either download its Chromium once:

```bash
npx playwright install chromium
```

```bash
npm run test:e2e
```

Or use a browser you already have, by setting `PW_CHANNEL` to `msedge` or `chrome`. In PowerShell:

```powershell
$env:PW_CHANNEL = 'msedge'; npm run test:e2e
```

They are separate from `npm run check` so the check works without a browser installed.

## Fresh clone

A working copy can hide install problems, so test the two-command promise from a clean clone before releasing, and whenever dependencies or `.npmrc` change:

```bash
git clone . ../compilerlab-fresh
```

Then, in that folder, run `npm run setup` and `npm start`. Use Node 22 with the npm it ships with, on a machine without a C++ toolchain if you can.
