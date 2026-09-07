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
  the FPL site (`.../entry/<id>/...`).
- `FPL_REFRESH_TOKEN` — FPL's write auth is OIDC with a bot-guarded login
  step, so there's no scripted login. Capture it manually from a logged-in
  browser session on fantasy.premierleague.com, in DevTools console:

  ```js
  JSON.parse(localStorage.getItem('oidc.user:https://account.premierleague.com/as:bfcbaf69-aade-4c1b-8f00-c1cb8a193030')).refresh_token
  ```

  This token goes stale routinely — see `CLAUDE.md`'s "Execution auth"
  section before touching anything execution-related.

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

## Exercising the app locally

- `pnpm run propose:captain-swap` — hits
  `POST /proposal/captain-swap` on a running app: a low-risk manual
  proposal (captain/vice-captain swap only, no transfers) that still goes
  through the same Telegram approve/reject flow as a real optimizer
  proposal. Needs `FPL_TEAM_ID`/`FPL_REFRESH_TOKEN` configured.
- `pnpm run dev:webhook` — starts the app plus a Cloudflare quick tunnel
  and points the Telegram bot's webhook at it, so tapping Approve/Reject
  on a real Telegram message actually reaches your local server. Ctrl+C
  clears the webhook and stops both processes. This is dev-only — quick
  tunnels are unreliable by design (see `CLAUDE.md`'s deploy TODO); if it
  fails to register a few times in a row, that's the tunnel, not the app.

## Notes

- First `pnpm install` may print `Ignored build scripts: ...` — run
  `pnpm approve-builds` if you want those optional native deps (mainly
  affects file-watcher performance in `start:dev`, not correctness).
- Full module status, hard constraints, and open architectural questions
  live in [`CLAUDE.md`](CLAUDE.md) — read it before making non-trivial
  changes.
