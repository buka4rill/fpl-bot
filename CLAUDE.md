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

## Module map (scaffolded, no business logic yet)

| Module | Status |
|---|---|
| `ingestion` | scaffolded — FPL public API + external stats clients |
| `trends` | scaffolded — curated source whitelist |
| `prediction` | scaffolded — `PredictionStrategy` interface + heuristic (v1) + trained-model (v2, later) |
| `optimization` | scaffolded — squad optimizer + chip evaluator |
| `proposal` | scaffolded |
| `alert` | scaffolded — Telegram adapter |
| `approval` | scaffolded — state machine (`PENDING → APPROVED/REJECTED/EXPIRED`) + webhook controller |
| `execution` | scaffolded — isolated FPL-authenticated client |
| `scheduler` | scaffolded — deadline watcher, dynamic (no fixed weekday) |

## Build order (ARCHITECTURE.md §11)

1. Ingestion + prediction + optimization, recommend-only (no execution module wired in)
2. Add approval state machine + alert loop, still no execution
3. Wire execution for lineup/captain only
4. Extend execution to transfers + chips
5. Iterate the prediction model once there's backtestable history

Currently at: **scaffold only** — every module compiles, nothing does anything yet.
