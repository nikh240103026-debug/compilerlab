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
| `content` | The course outline                                                                                   |
| `scripts` | `.env` creation, version and tool checks, per-OS fix instructions                                    |
| `server`  | Both SQLite drivers, migrations, backup and reset, every route, the local-only guard, static serving |
| `web`     | WCAG contrast of every token, API client, split pane, error panel, toasts, route modules             |

The engine's textbook fixtures and the 90% coverage target begin with the first algorithms in Milestone 2. To measure coverage:

```bash
npm run test:coverage
```

## Browser and accessibility tests

These run the production build in a real browser with a throwaway data folder. They cover every route, axe checks in both themes, route-change speed, keyboard use, tablet width, reduced motion, error handling and the server-down banner.

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
