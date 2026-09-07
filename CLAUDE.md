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
real Telegram bot — not just unit tests. Next up is step 4 — **but read the
open question below before starting it**, since it might make step 4 moot.

## Open question: keep auto-execution, or go notification-only? (not decided)

Raised 2026-09-07, right after step 3 shipped — deliberately deferred,
**revisit once other features are done**, don't start on it speculatively.

The FPL auth story (see above) has been the most fragile, highest-maintenance
part of this whole system, and that fragility is external — nothing on our
side fixes FPL's session model. Under consideration: drop auto-execution
entirely. Keep `ExecutionModule`'s code as-is but never call it; run purely
as a notification bot — propose, alert, and the user applies changes
manually in the FPL app. If this happens, extending execution to
transfers/chips (step 4) would likely be skipped rather than built first.

Two companion features raised alongside this idea:

- **Ask the user for current free transfers and available chips before each
  week's proposal**, instead of an authenticated lookup — `CurrentSquad`'s
  doc comment in `domain.types.ts` already notes free transfers aren't
  exposed by the public API, and available (unplayed) chips have the same
  gap. A weekly Telegram prompt sidesteps needing auth for this at all.
- **After each deadline passes, ask "did you apply what was suggested?"**
  and record the answer. In a notification-only model this is the *only*
  way the bot ever finds out whether advice was followed — without it, a
  bad outcome next gameweek can't be distinguished between "model was
  wrong" and "advice wasn't followed," which breaks step 5's backtesting.
  This is naturally blocked on the persistence-layer decision
  (ARCHITECTURE.md §6), not something to build against the current
  in-memory `ProposalService`.

Full writeup: Claude's persistent memory,
`notification-only-pivot-under-consideration`.
