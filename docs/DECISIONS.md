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

- Milestone 2: Framer Motion, React Flow, D3, KaTeX, MDX
- Milestone 3: Monaco, xterm.js, `@fastify/websocket`
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
