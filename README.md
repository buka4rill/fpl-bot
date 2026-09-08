# fpl-bot

FPL assistant bot: ingests gameweek data, predicts a squad, proposes
transfers/lineup/captain changes, and alerts the owner over Telegram — it
only ever writes to the FPL account after an explicit approval reply. See
[`CLAUDE.md`](CLAUDE.md) for hard constraints and current build status, and
[`ARCHITECTURE.md`](ARCHITECTURE.md) for the full design.

This README covers running it locally.

## Prerequisites

- Node.js 20+ (tested on v20.20.2) and [pnpm](https://pnpm.io)
- [Docker Desktop](https://www.docker.com/products/docker-desktop/) — runs
  Postgres locally
- A Telegram bot token and chat id (see [Telegram setup](#telegram-setup)
  below)
- An FPL account and team id (see [FPL account setup](#fpl-account-setup)
  below) — only needed if you want live proposals/execution against a real
  squad; the app still boots without it

## Setup

```bash
pnpm install
cp .env.example .env
```

Fill in `.env` (see the sections below for where each value comes from).
The `DATABASE_*` vars already default to match `docker-compose.yml`, so
they need no changes for local dev.

Start Postgres and apply migrations:

```bash
pnpm db:up          # starts Postgres via docker-compose, healthchecked
pnpm migration:run   # applies the schema (also runs automatically on app boot)
```

Start the app:

```bash
pnpm start:dev       # watch mode
```

The app listens on `http://localhost:3000` (override with `PORT`).

## Telegram setup

1. Create a bot with [@BotFather](https://t.me/BotFather) (`/newbot`) —
   this gives you `TELEGRAM_BOT_TOKEN`.
2. Send your new bot any message, then find your chat id — either hit
   `https://api.telegram.org/bot<token>/getUpdates` and read `chat.id`
   from the response, or forward a message through a helper bot like
   `@userinfobot`. That's `TELEGRAM_CHAT_ID`.

## FPL account setup

- `FPL_TEAM_ID` — your team id, found in the URL when viewing your team on
  the FPL site (`.../entry/<id>/...`), or from a `GET /api/my-team/<id>/`
  request in DevTools' Network tab while logged in.
- `FPL_REFRESH_TOKEN` — FPL's write auth is OIDC with a bot-guarded login
  step, so there's no scripted login. Two ways to get this:

  **Recommended: `pnpm run auth:login`** (with the app already running —
  see [Auth: capturing/refreshing the token](#auth-capturingrefreshing-the-token)
  below). Opens a real browser, you log in normally, it pushes the token to
  the app automatically. Needs `AUTH_PUSH_SECRET` set first (see below).

  **Manual fallback**: capture it yourself from a logged-in browser session
  on fantasy.premierleague.com, in DevTools console:

  ```js
  JSON.parse(localStorage.getItem('oidc.user:https://account.premierleague.com/as:bfcbaf69-aade-4c1b-8f00-c1cb8a193030')).refresh_token
  ```

  Paste the result into `.env` as `FPL_REFRESH_TOKEN` directly.

  Either way, this token goes stale routinely (FPL allows only one active
  session per account — logging into the official app elsewhere invalidates
  it) — see `CLAUDE.md`'s "Execution auth" section for the full story.

- `AUTH_PUSH_SECRET` — required for `pnpm run auth:login` to work; guards
  `POST /auth/token` (see below) since it's a public route once deployed.
  Generate one and put the same value in `.env`:

  ```bash
  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  ```

- `AUTH_TARGET_URL` — where `auth:login` pushes the captured token.
  Defaults to `http://localhost:3000`; only change this if you're pointing
  the script at a deployed instance instead of your local one.

## Database / migrations

- `pnpm db:up` / `pnpm db:down` — start/stop the local Postgres container
- `pnpm migration:generate src/persistence/migrations/<Name>` — after
  changing an entity in `src/persistence/entities/`; review the generated
  SQL before committing it
- `pnpm migration:run` / `pnpm migration:revert` — apply/undo migrations
  manually (the app also auto-applies pending migrations on boot)

Postgres only exists inside that container — there's nothing on
`localhost:5432` unless it's running (`docker compose ps` to check; `pnpm
db:up` if not). That applies whether you're connecting via `psql` or a GUI
client below, not just the app itself.

Data survives `pnpm db:down` / `docker compose down` (or just quitting
Docker Desktop) — it lives in the named volume `fpl-bot-postgres-data`, not
in the container, so stopping/removing the container doesn't touch it.
`pnpm db:up` reattaches the same volume next time. The only things that
actually delete it: `docker compose down -v` (the `-v` removes named
volumes), `docker volume rm fpl-bot-postgres-data`, or a full Docker
Desktop reset/uninstall.

### Inspecting the tables

Quick one-offs from the terminal (no client needed):

```bash
docker compose exec postgres psql -U fpl_bot -d fpl_bot -c "\dt"              # list tables
docker compose exec postgres psql -U fpl_bot -d fpl_bot -c "\d proposals"     # describe a table
docker compose exec postgres psql -U fpl_bot -d fpl_bot -c "SELECT * FROM proposals;"
```

Or drop into an interactive session: `docker compose exec postgres psql -U
fpl_bot -d fpl_bot`, then `\dt`, `\d <table>`, or any SQL; `\q` to exit.

For a GUI ([DBeaver](https://dbeaver.io/), TablePlus, pgAdmin, VS Code's
"PostgreSQL" extension, etc.) — the container publishes 5432 to the host, so
connect with:

| Field | Value |
|---|---|
| Host | `localhost` |
| Port | `5432` |
| Database | `fpl_bot` |
| Username | `fpl_bot` |
| Password | `fpl_bot` |

(matches `DATABASE_*` in `.env`/`docker-compose.yml`'s defaults — adjust if
you changed them).

## Testing

```bash
pnpm test          # unit tests
pnpm test:watch
pnpm test:cov
```

## Pre-commit hooks

`pnpm install` wires up a Husky `pre-commit` hook (via the `prepare`
script) that runs [lint-staged](https://github.com/okonet/lint-staged)
automatically on every `git commit`:

- staged `src/**/*.ts` files get `eslint --fix`, then `jest --bail
  --findRelatedTests` — only the tests related to what actually changed,
  not the full suite
- staged `scripts/**/*.ts` / `test/**/*.ts` files get `eslint --fix` only

A lint error that can't be auto-fixed, or a failing related test, blocks
the commit.

## Exercising the app locally

Manual trigger endpoints — all `POST`, all needing `FPL_TEAM_ID`/
`FPL_REFRESH_TOKEN` configured and the app running (`pnpm start` or
`pnpm start:dev`). Each sends its result as a normal Telegram message
through the same alert/approval flow a real automatic run would use.

| Endpoint | What it does |
|---|---|
| `POST /team-state/report` | Sends the free-transfers/chip-availability report for the upcoming gameweek right now, instead of waiting for the weekly automatic check. |
| `POST /proposal/generate` | Runs the real optimizer-driven flow (live team state → `SquadOptimizerService` → Telegram proposal) on demand. |
| `POST /proposal/captain-swap` | Low-risk manual proposal: swaps captain ↔ vice-captain on your current squad only, no transfers. Good for testing the approve → execute path without risking a real transfer. Shortcut: `pnpm run propose:captain-swap`. |
| `POST /proposal/manual-transfer` | Proposes exactly one transfer — body `{"playerOutId": <element id>, "playerInId": <element id>}`. Built from live `/api/my-team/` data, so it works even for a brand-new account with no gameweek history yet (unlike `/proposal/generate`, which needs the public entry/picks endpoint to have something to read). |
| `POST /proposal/chip` | Declares a chip for this week's proposal — body `{"chip": "wildcard" \| "freehit" \| "bboost" \| "3xc", "freeTransfers"?: number}`. Runs the full optimizer with that chip factored in. |

Example:

```bash
curl -X POST http://localhost:3000/proposal/manual-transfer \
  -H "Content-Type: application/json" \
  -d '{"playerOutId": 277, "playerInId": 175}'
```

### Webhook / push endpoints

These aren't triggered by you directly — something external calls them.
Both need your local server reachable from outside for real end-to-end
testing (a tunnel, or a real deploy); calling them from `curl` on
`localhost` still exercises the handler logic, just not the "external
caller can actually reach it" part.

| Endpoint | Called by | Purpose |
|---|---|---|
| `POST /approval/telegram-callback` | Telegram, when you tap Approve/Reject on a proposal alert | The only Telegram webhook this app registers (Telegram supports exactly one webhook URL per bot). Routes `approve:<id>`/`reject:<id>` callback data to `ApprovalService`. Use `pnpm run dev:webhook` (below) to point Telegram at your local server for testing. |
| `POST /auth/token` | `scripts/auth-login.ts` (`pnpm run auth:login`), after you log into FPL in the browser it opens | Applies a freshly-captured `FPL_REFRESH_TOKEN` to the running app. Guarded by `AUTH_PUSH_SECRET` — send it as `Authorization: Bearer <secret>`. Body: `{"refreshToken": "<token>"}`. Fails closed (rejects everything) if `AUTH_PUSH_SECRET` isn't set. |

- `pnpm run dev:webhook` — starts the app plus a Cloudflare quick tunnel
  and points the Telegram bot's webhook at it, so tapping Approve/Reject
  on a real Telegram message actually reaches your local server. Ctrl+C
  clears the webhook and stops both processes. This is dev-only — quick
  tunnels are unreliable by design (see `CLAUDE.md`'s deploy TODO); if it
  fails to register a few times in a row, that's the tunnel, not the app.

### Auth: capturing/refreshing the token

First time only, download the browser Playwright drives (a few hundred MB):

```bash
pnpm exec playwright install chromium
```

Then, whenever you need a fresh token:

```bash
pnpm run auth:login
```

Run this **from your own terminal**, not through an automation/agent shell
— it opens a real, visible browser window, which needs an actual desktop
session to render into. Log into FPL normally in the window that opens;
once it detects the login it closes automatically and pushes the token to
`POST /auth/token` above. You should get a "✅ FPL login updated" Telegram
message when it works. Needs `AUTH_PUSH_SECRET` set (see
[FPL account setup](#fpl-account-setup)) and the app already running.

If the refresh token goes stale while the app is running unattended (no
one at a terminal to run the above), it'll tell you: `DeadlineWatcherService`
checks login state before generating a proposal and sends a Telegram
message asking you to run `auth:login` rather than failing silently.

## CI / CD

- **CI** (`.github/workflows/ci.yml`) runs type-check, lint, and unit
  tests on every push to `main` and every pull request.
- **Deploy** (`.github/workflows/deploy.yml`) ships to Fly.io
  (`fpl-bot-buka4rill.fly.dev`) automatically after CI passes — it's
  triggered by CI's own completion (`workflow_run`), not a parallel push,
  so a commit that fails CI never races its way into production. A manual
  redeploy is still available from the Actions tab
  (`workflow_dispatch`).
- `main` is branch-protected: merging requires an approved pull request,
  but the repo admin can still push directly. See `CLAUDE.md`'s "Deploy
  (Fly.io) + CI/CD" section for the full history and reasoning.

## Production (Fly.io)

The deployed instance is app `fpl-bot-buka4rill`
(`https://fpl-bot-buka4rill.fly.dev`), Postgres cluster
`fpl-bot-buka4rill-db`. See `CLAUDE.md`'s "Deploy (Fly.io) + CI/CD" section
for the full setup history and reasoning — this is just the day-to-day
commands worth remembering.

**`flyctl` not found in your shell?** The Windows installer
(`iwr https://fly.io/install.ps1 -useb | iex`) puts it at
`~/.fly/bin/flyctl.exe` and updates the user `PATH`, but that only takes
effect in *new* shells — a terminal already open when you installed it
(or a different shell type than whichever one got updated) still won't
find it. Either open a new terminal, or call it directly:

```bash
"$HOME/.fly/bin/flyctl" version
```

**Checking on the app:**

```bash
fly status -a fpl-bot-buka4rill        # is it up, how many machines
fly logs -a fpl-bot-buka4rill          # tail live logs
fly secrets list -a fpl-bot-buka4rill  # secret names only, not values
```

**Querying the production database** (e.g. to check real backtesting
progress toward step 5's data checkpoint — see `CLAUDE.md`'s "Build
order"):

```bash
fly postgres connect -a fpl-bot-buka4rill-db
```

This drops you into the `postgres` database, **not** the app's own
`fpl_bot_buka4rill` — the app's tables (`proposals`, `player_snapshots`,
etc.) live there instead:

```sql
\l                        -- list databases, confirm the real name
\c fpl_bot_buka4rill      -- switch into it
\dt                       -- list tables
```

Then, e.g., to check how many gameweeks have a completed predicted-vs-actual
results report (the step-5 gate):

```sql
SELECT count(DISTINCT (season, "gameweekId")) FROM proposals WHERE "resultReportedAt" IS NOT NULL;
```

Or to see recent proposal activity:

```sql
SELECT season, "gameweekId", status, "createdAt" FROM proposals ORDER BY "createdAt" DESC LIMIT 10;
```

`\q` to exit.

**Manual redeploy** (normally automatic after CI passes on `main` — see
[CI / CD](#ci--cd) above):

```bash
fly deploy -a fpl-bot-buka4rill
```

**Re-authenticating the deployed instance** — same `pnpm run auth:login`
flow as local dev, just pointed at the deployed URL: set
`AUTH_TARGET_URL=https://fpl-bot-buka4rill.fly.dev` in your local `.env`
before running it (only needed when the deployed token actually goes
stale — see [Auth: capturing/refreshing the
token](#auth-capturingrefreshing-the-token) above for why that happens
routinely).

## Notes

- First `pnpm install` may print `Ignored build scripts: ...` — run
  `pnpm approve-builds` if you want those optional native deps (mainly
  affects file-watcher performance in `start:dev`, not correctness).
- Full module status, hard constraints, and open architectural questions
  live in [`CLAUDE.md`](CLAUDE.md) — read it before making non-trivial
  changes.
