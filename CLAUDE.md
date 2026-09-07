# fpl-bot — project context

FPL assistant bot. NestJS service that ingests gameweek data, predicts a squad,
alerts the owner over Telegram, and **only ever writes to the FPL account after
an explicit approval reply**. See `ARCHITECTURE.md` for the full design — this
file is the short version for whichever session picks this repo up next.

## Hard constraints (do not relax these while building)

- **Alert → wait for explicit OK → apply.** No autonomous execution. Silence
  before deadline resolves to "do nothing," never "apply anyway."
- **No official FPL write API.** `ExecutionModule` talks to undocumented
  endpoints (`users.premierleague.com` login, `/api/my-team/`, `/api/transfers/`).
  Keep it the most isolated module in the app — nothing else should reach these
  endpoints or hold the authenticated session.
- **Never hardcode a deadline day/time.** Gameweek deadlines shift (blank/double
  gameweeks). Always read the real deadline from `bootstrap-static`.
- **Trend data is a curated whitelist, not open-ended scraping.** See
  `src/trends/trend-sources.config.ts`.

## Stack decided so far (from package.json)

- NestJS + TypeScript, pnpm
- `@nestjs/schedule` for cron, `@nestjs/axios` for HTTP, `@nestjs/config` for env
- `javascript-lp-solver` for the squad/transfer ILP (in-process, no separate
  Python optimizer service)
- `telegraf` for the Telegram bot (alert + two-way approval channel)
- Persistence layer (Postgres/Prisma/TypeORM per ARCHITECTURE.md §6) not chosen
  yet — no ORM installed. Domain shapes live as plain interfaces in
  `src/common/types/domain.types.ts` until that decision is made.

## Module map

| Module | Status |
|---|---|
| `ingestion` | implemented — bootstrap-static, fixtures, element-summary, live-gameweek, current-squad |
| `trends` | scaffolded — curated source whitelist, not consumed yet |
| `prediction` | implemented (v1) — `HeuristicStrategy`; `TrainedModelStrategy` (v2) still a placeholder |
| `optimization` | implemented — squad optimizer (ILP) + chip evaluator |
| `proposal` | implemented — optimizer-driven, plus a manual captain-swap override (`POST /proposal/captain-swap`) for low-risk execution testing |
| `alert` | implemented — Telegram adapter, proposal alerts + execution-result alerts |
| `approval` | implemented — state machine (`PENDING → APPROVED/REJECTED/EXPIRED`) + webhook controller; triggers execution on `APPROVED` |
| `execution` | implemented for **lineup/captain only** — `FplAuthClient` (OAuth refresh-token flow, see below) + `ExecutionService`; transfers/chips not built |
| `scheduler` | implemented — hourly deadline-watcher, dynamic (no fixed weekday) |

### Execution auth — read before touching `FplAuthClient`

FPL's write auth is OIDC via a hosted identity provider (PingOne DaVinci), not
the old email/password login most third-party writeups describe. The
interactive login step is bot-guarded (DataDome) and deliberately **not**
scripted — instead, a long-lived refresh token is captured **manually once**
from a logged-in browser (`FPL_REFRESH_TOKEN` in `.env`), and
`FplAuthClient` only ever exchanges it for short-lived access tokens.

**The refresh token goes stale routinely, by design, not as a bug**: FPL's
identity provider keeps only one active session per account, so any other
logged-in client (the official mobile app included) refreshing in the
background invalidates whatever this bot is holding. When that happens,
`FplAuthClient`/`ExecutionService` fail loudly (a Telegram alert, never
silently) — the fix is repeating the manual browser capture, not automated
re-login. Full capture steps and the underlying HTTP contracts are in
Claude's persistent memory (`fpl-write-api-contract`), not duplicated here.

For local webhook testing (tapping Approve/Reject against a real Telegram
callback), `pnpm run dev:webhook` automates the tunnel + webhook wiring —
see `scripts/dev-webhook.ts`.

## Build order (ARCHITECTURE.md §11)

1. ✅ Ingestion + prediction + optimization, recommend-only
2. ✅ Approval state machine + alert loop
3. ✅ Execution for lineup/captain only — verified live end-to-end
4. ⬜ Extend execution to transfers + chips
5. ⬜ Iterate the prediction model once there's backtestable history

Currently at: **step 3 done**, verified against a real FPL account and a
real Telegram bot — not just unit tests. Next up is step 4.
