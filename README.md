# Questline

A local-first desktop companion for earning Discord quest progress without installing the full game.

Questline searches Discord's detectable-game catalog and launches a tiny session runner under a game's real executable name. Discord's own game detection sees the activity while the quest timer runs. No game downloads, account login, or Discord tokens.

![Questline quest board](screenshots/questline-session.png)

## Features

- 10,000+ game catalog with search, aliases, and Discord icons
- Personal library with pinned games and one-click sessions
- Live session monitor with elapsed time and stop controls
- Local activity log for launches, stops, syncs, and errors
- Catalog refresh from Discord's public API, with bundled and cached fallbacks
- Dark, light, and system themes
- Optional Rich Presence preview (cosmetic only; does not count toward quests)

## Requirements

- Windows 10 or 11 (x64)
- Discord desktop app, open and signed in
- Node.js 22.12+ (only for running or building from source)

## Download

Get the latest portable Windows build from [Releases](https://github.com/ibrahimarchive/questline/releases/latest). Run the EXE directly — no installation needed. The build is unsigned, so Windows SmartScreen may show an unknown-publisher warning.

## Run from source

```powershell
npm install
npm run dev
```

`npm run dev` starts the Vite dev server and launches Electron against it. Build the portable EXE with:

```powershell
npm run dist
```

The output is written to `release/`.

## How it works

1. Add a game from the catalog to your library.
2. Questline copies `resources/runner.exe` into a game-shaped folder:

   ```text
   <games directory>/<game ID>/<executable path>
   ```

3. Launch the session. Discord sees the expected executable while it runs.
4. Keep Discord open until the quest timer finishes, then stop the session.

Sessions are tracked through Windows CIM and stopped with `taskkill`. Questline never downloads or modifies a real game installation.

### Safety model

- The renderer runs with `contextIsolation`, `sandbox`, and no Node.js integration.
- Navigation and new windows are restricted to the app's own pages and external HTTP(S) links.
- Executable paths are validated and confined to the games directory.
- Questline refuses to overwrite an existing file unless it carries the runner's signature.
- State writes are queued and written atomically, so a crash cannot leave a half-written JSON file.

## Project structure

```text
electron/
  main.mjs             Electron window, state persistence, IPC, and shutdown cleanup
  game-data.mjs        Bundled/cache/Discord catalog loading and refresh
  runner-service.mjs   Runner install, launch, discovery, and stop logic
  discord-rpc.mjs      Optional local Discord Rich Presence client
  preload.cjs          Sandboxed bridge exposed to the renderer
src/
  store.ts             Reactive application state and actions
  utils.ts             Formatting, path, search, and platform helpers
  components/          Reusable UI pieces
  views/               Quest board, activity, and settings pages
resources/
  runner.exe           Tiny Windows session runner
  gamelist.json        Bundled Discord game snapshot
scripts/               Development, build, screenshot, and smoke-test scripts
tools/runner/          C source for the session runner
tools/icon/            Icon generation helper
```

The renderer never talks to the operating system directly. It calls the typed bridge in `preload.cjs`, which forwards requests to handlers in `main.mjs`; those handlers return either `{ data }` or `{ error }` envelopes.

## Development commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start Vite and Electron in development mode |
| `npm run typecheck` | Run `vue-tsc` without emitting files |
| `npm run build` | Type-check and build the renderer into `dist/` |
| `npm run preview` | Build and run the production renderer |
| `npm run test:runner` | Install, launch, discover, and stop a real runner |
| `npm run test:ui` | Build and run the scripted UI smoke test |
| `npm run screenshot` | Capture a single screenshot into `screenshots/` |
| `npm run runner:build` | Rebuild `resources/runner.exe` with Zig |
| `npm run icon:build` | Regenerate `build/icon.ico` and `build/icon.png` |
| `npm run pack` | Build an unpacked application directory |
| `npm run dist` | Build the portable Windows executable |

The UI smoke test uses an isolated `QUESTLINE_USER_DATA` profile, adds two games, starts and stops a session, checks the activity log, and exercises both themes. It rewrites the screenshots in `screenshots/` as a side effect.

### Rebuilding the runner

The session runner is a small C program compiled with Zig:

```powershell
npm run runner:build
```

Install Zig and either put `zig` on `PATH` or set the `ZIG` environment variable. If Zig is unavailable but `resources/runner.exe` already exists, the script leaves the existing binary untouched.

## Data and privacy

- App state: `%APPDATA%\Questline\questline-state.json`
- Catalog cache: `<userData>\gamelist-cache.json`
- Runner copies: `<userData>\games\<game ID>\<executable path>`

The games folder can be changed in **Settings → Storage**. Set `QUESTLINE_USER_DATA` to redirect all app state for an isolated run.

Questline does not read Discord tokens, credentials, messages, or game files. Network access is limited to the public detectable-game catalog and Discord's app-icon CDN. Rich Presence uses Discord's local IPC socket and is opt-in.

## Troubleshooting

**Discord shows as offline**

Make sure the Discord desktop app is running and signed in. Questline looks for `Discord.exe`, `DiscordCanary.exe`, and `DiscordPTB.exe`; the status pill refreshes automatically.

**The game list will not refresh**

Questline keeps working from the cached or bundled catalog when Discord's API is unreachable. Check your connection and try **Sync games** again; the activity log includes the underlying error.

**A session will not stop**

Use **Stop** on the session card or **Stop all sessions** in Settings. If a runner still survives, close it from Task Manager and check that the configured games folder points at the folder Questline created.

**The runner executable is missing**

Run `npm run runner:build` from a source checkout. Packaged builds load it from the app's `resources` directory.

**Start over with clean data**

Close Questline, then delete `%APPDATA%\Questline\questline-state.json` and `gamelist-cache.json`. For a completely isolated run, set `QUESTLINE_USER_DATA` to a temporary directory before launching.

**Windows SmartScreen blocks the app**

The portable build is unsigned. Choose **More info → Run anyway**, or build from source with `npm run dist`.

## Disclaimer

Questline is an unofficial tool. Automated game detection may conflict with Discord's Terms of Service, and quest credit is always decided by Discord. Use at your own risk.

## License

MIT © Ibrahim Chowdhury
