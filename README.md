# CompilerLab

Learn Compiler Design from theory to practice on your own computer: lessons, step-by-step visualizers, real Lex, Yacc, C and C++ labs, exam practice and an AI tutor. Everything runs locally. The only network call the app will ever make is to the Gemini API, and it stays fully usable without one.

**Status:** Milestone 1 of 12 is complete, which covers the foundation: setup, the app shell, settings and storage. Lessons and visualizers start in Milestone 2. See [the milestones](docs/SPEC.md#part-14-milestones-give-these-to-claude-code-one-at-a-time).

## Quick start

You need [Node 22 LTS](https://nodejs.org). Then:

```bash
npm run setup
```

```bash
npm start
```

Your browser opens at <http://127.0.0.1:5173>. Press Ctrl+C in the terminal to stop.

Setup creates `.env`, installs dependencies and checks your computer. It prints exact commands for anything that is missing. Two things are optional, and the app has a fallback for each:

- **flex, bison, gcc, g++, make:** without them, the lab labels its results Simulated.
- **A Gemini key:** without one, AI features show an offline state. To add one, [create a key](https://aistudio.google.com/apikey), put it in `.env` as `GEMINI_API_KEY=your-key`, and restart. The key stays on the local server and never reaches the browser.

## Commands

| Command                               | What it does                                                     |
| ------------------------------------- | ---------------------------------------------------------------- |
| `npm run setup`                       | First-time setup. Safe to run again.                             |
| `npm start`                           | Runs the app in development mode and opens the browser.          |
| `npm run doctor`                      | Checks Node, SQLite, the lab tools and the Gemini key.           |
| `npm run build && npm run start:prod` | Serves the built app from one port (<http://127.0.0.1:4317>).    |
| `npm run backup`                      | Saves a copy of your data in `data/backups`.                     |
| `npm run reset`                       | Asks first, saves a backup, then deletes your data.              |
| `npm run check`                       | Lint, typecheck, unit tests and build. Must pass for any merge.  |
| `npm run test:e2e`                    | Browser and accessibility tests. See [Testing](docs/TESTING.md). |

## Troubleshooting

Run `npm run doctor` first. It gives exact fixes for your operating system.

### Any operating system

| Problem                              | Fix                                                                                                                                  |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| "Port 4317 is in use"                | CompilerLab may already be running. Close it, or set `PORT` or `WEB_PORT` in `.env`.                                                 |
| "The local server is not responding" | The terminal running `npm start` was closed or stopped. Start it again.                                                              |
| A database error at startup          | Run `npm run reset`. It keeps your backups in `data/backups`.                                                                        |
| "better-sqlite3 could not load"      | The app has switched to Node's built-in `node:sqlite` and still works. To restore it, delete `node_modules` and run `npm run setup`. |
| The wrong Node version               | Node 22 is the supported version. Newer versions get a warning; older ones cannot run.                                               |

### Windows

The lab tools can come from either place:

- **MSYS2** runs them directly from Windows. Run `winget install --id MSYS2.MSYS2 -e`, then in the "MSYS2 UCRT64" terminal run `pacman -S --needed flex bison make mingw-w64-ucrt-x86_64-gcc`. Add `C:\msys64\ucrt64\bin` and `C:\msys64\usr\bin` to PATH, or set each tool's path in Settings.
- **WSL2** means running all of CompilerLab inside Ubuntu, because Windows programs cannot see tools installed in WSL. Run `wsl --install -d Ubuntu`, then clone the project inside Ubuntu and follow the Ubuntu steps below.

Close and reopen your terminal after changing PATH.

### macOS

Run `xcode-select --install` for gcc, g++ and make, and `brew install flex bison` for the rest. Homebrew does not link flex and bison by default, so add this to `~/.zshrc`:

```bash
export PATH="$(brew --prefix)/opt/bison/bin:$(brew --prefix)/opt/flex/bin:$PATH"
```

### Ubuntu

```bash
sudo apt update && sudo apt install -y flex bison gcc g++ make
```

## Learn more

- [Architecture](docs/ARCHITECTURE.md)
- [Writing course content](docs/CONTENT_GUIDE.md)
- [Testing](docs/TESTING.md)
- [Contributing](CONTRIBUTING.md)
- [Decisions that interpret the spec](docs/DECISIONS.md)
- [Full specification](docs/SPEC.md)
