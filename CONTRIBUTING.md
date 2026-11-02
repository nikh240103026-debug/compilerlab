# Contributing

## Getting started

```bash
npm run setup
```

```bash
npm start
```

## Before you commit

The pre-commit hook runs lint and typecheck. Before calling work done, run the full check:

```bash
npm run check
```

If you changed anything a browser would notice, also run the browser tests described in [docs/TESTING.md](docs/TESTING.md).

## House rules

These come from [Part 15 of the spec](docs/SPEC.md#part-15-working-rules-for-claude-code).

- Prefer simple, readable, well-typed code. Keep files small and focused.
- Give every new dependency a one-line justification, and prefer ones that install cleanly on Windows, macOS and Linux. Record it in [docs/DECISIONS.md](docs/DECISIONS.md) if it is not obvious.
- Never hardcode or log secrets. The Gemini key stays on the server.
- The server binds to `127.0.0.1` only, unless LAN mode is explicitly enabled.
- Run child processes with `spawn` and argument arrays, never shell strings.
- Check a library's installed types or docs instead of guessing at its API.
- Never crash on bad input. Show a readable explanation and an Ask AI button.

## Code conventions

- **Colors:** use the design tokens in `apps/web/src/styles/tokens.css`. Tailwind's default palette is switched off, so a raw color class will not work. A new text or control color needs an entry in `tokens.test.ts`, which checks WCAG AA in both themes.
- **Components:** `apps/web/src/components/ui` holds shadcn/ui-style primitives. `apps/web/components.json` is configured for the shadcn CLI.
- **Web bundle:** import values from `@compilerlab/shared/constants` and `@compilerlab/shared/settings-patch`, and only types from `@compilerlab/shared`. The package root pulls in Zod.
- **Database:** add a migration to the end of `apps/server/src/db/migrate.ts`. Never edit one that has shipped.
- **Scripts:** files in `scripts/` that run before `npm install` are `.mjs` with `// @ts-check` and use only Node built-ins.
- **Course content:** see [docs/CONTENT_GUIDE.md](docs/CONTENT_GUIDE.md).
