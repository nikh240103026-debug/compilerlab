# Architecture

CompilerLab is an npm workspaces monorepo. It runs entirely on the student's computer.

```text
compilerlab/
  apps/web/          React app: shell, routes, design system
  apps/server/       Fastify API and SQLite storage
  packages/engine/   Compiler-theory engine (starts in Milestone 2)
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

| Route                            | Purpose                                                               |
| -------------------------------- | --------------------------------------------------------------------- |
| `GET /api/health`                | Liveness, version and database driver                                 |
| `GET, PATCH /api/settings`       | Read and update settings                                              |
| `POST /api/settings/reset`       | Restore default settings                                              |
| `GET /api/content/modules[/:id]` | The course outline                                                    |
| `GET /api/system/status`         | Node, lab tools, lab mode, whether a Gemini key exists, data location |

Later milestones add `/api/lab`, `/api/ai`, `/api/progress` and `/api/export`.

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

## Environment checks

`scripts/lib/checks.mjs` holds the checks and the per-OS install commands. `npm run doctor` and `GET /api/system/status` both use it, so the terminal and the Settings page always agree. It uses only Node built-ins because it has to work before `npm install`.
