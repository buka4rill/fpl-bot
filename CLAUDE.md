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
- **Postgres + TypeORM** for persistence (ARCHITECTURE.md §6), run locally via
  Docker — see "Persistence" below. Domain shapes in
  `src/common/types/domain.types.ts` are still the source of truth for
  application code; entities in `src/persistence/entities/` each `implements`
  the matching interface rather than duplicating the shape.

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
| persistence | implemented — Postgres + TypeORM, see "Persistence" below |

## Persistence

Postgres, run locally via Docker (`pnpm db:up` / `pnpm db:down`,
`docker-compose.yml`). TypeORM with **explicit migrations** (`synchronize:
false`), auto-applied on boot (`migrationsRun: true`) — write a migration
with `pnpm migration:generate src/persistence/migrations/<Name>` after
changing an entity, review the generated SQL, commit it.
`src/persistence/data-source.ts` is the standalone CLI datasource (loads
`.env` directly — runs outside Nest DI, used only by the migration scripts,
not by the running app).

Entities live in `src/persistence/entities/` — one place for the whole
schema (ARCHITECTURE.md §6), each `implements` the matching
`domain.types.ts` interface rather than a separate mapper/DTO layer:
`ProposalEntity`, `ApprovalEntity` (this is new — approvals were previously
built and discarded, never actually stored), `ExecutionLogEntity`, plus
`GameweekEntity`/`PlayerSnapshotEntity` for backtesting history (written
best-effort — a failure there must never block generating/alerting a
proposal, unlike the other three, which are the app's actual state).

`ProposalService.findByGameweekId` backs `DeadlineWatcherService`'s
restart-safe "already proposed this gameweek" check — replacing what used
to be an in-memory flag that forgot on every restart. (An in-process-only
synchronous claim still exists alongside it, for the unrelated race between
two overlapping checks in the same running process — see the comments on
`lastClaimedGameweekId`.)

**Pinned versions matter here**: `@nestjs/typeorm@12.x` is ESM-only and
won't load under this project's CommonJS setup on Node 20 (breaks Jest and
`ts-node` alike) — use `@nestjs/typeorm@^11.0.3` with `typeorm@^0.3.x`.
Also: if you see `Nest can't resolve dependencies of the TypeOrmCoreModule
(... ModuleRef ...)` after touching these packages, it's very likely a
stale `node_modules` from a mid-session version swap, not a real
incompatibility — `rm -rf node_modules && pnpm install` fixed it here.

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

## TODO: deploy off the local machine + quick tunnel (not started)

Raised 2026-09-07: `dev:webhook`'s Cloudflare *quick* tunnel
(`trycloudflare.com`) failed 8/8 fresh attempts in one session — Telegram
couldn't resolve the tunnel hostname each time, even though cloudflared
registered the tunnel successfully every time locally. Quick tunnels are
explicitly disclaimed by Cloudflare as "no uptime guarantee, experiment
only," so this isn't shocking, but it's also a symptom of a deeper gap:
the bot's actual job (hourly deadline polling, an always-reachable Telegram
webhook) needs a host that's on 24/7 with a stable public endpoint —
something a personal machine + ephemeral tunnel was never going to provide
long-term. `dev:webhook` should stay exactly what it is (a *local dev*
convenience for testing the webhook-receiving side), not the deployment
story.

**Recommendation: Fly.io** over GCP/AWS — a permanent `https://*.fly.dev`
domain out of the box (webhook set once, no tunnel ever again), deploys
from a Dockerfile, and has a Postgres add-on so this session's persistence
work carries over with little change. GCP Cloud Run and AWS (ECS/Lightsail
+ RDS) can do this too but are built for request-driven or enterprise
workloads — Cloud Run needs `min-instances=1` to act always-on plus a VPC
connector for Cloud SQL, AWS needs a VPC/security-groups/task-definitions
setup — real ops overhead for a bot serving exactly one user. Railway is a
close second to Fly if comparing options. Not started — no Dockerfile or
deploy config exists yet.

## Build order (ARCHITECTURE.md §11)

1. ✅ Ingestion + prediction + optimization, recommend-only
2. ✅ Approval state machine + alert loop
3. ✅ Execution for lineup/captain only — verified live end-to-end
4. ⬜ Extend execution to transfers + chips
5. ⬜ Iterate the prediction model once there's backtestable history

Currently at: **step 3 done**, verified against a real FPL account and a
real Telegram bot — not just unit tests. Persistence (below) is also done
now. Next: revisit the open question below before starting step 4.

## Open question: keep auto-execution, or go notification-only? (not decided)

Raised 2026-09-07, right after step 3 shipped — deliberately deferred,
**revisit once other features are done**, don't start on it speculatively.

The FPL auth story (see above) has been the most fragile, highest-maintenance
part of this whole system, and that fragility is external — nothing on our
side fixes FPL's session model. Under consideration: drop auto-execution
entirely. Keep `ExecutionModule`'s code as-is but never call it; run purely
as a notification bot — propose, alert, and the user applies changes
manually in the FPL app.

**Correction 2026-09-07**: extending execution to transfers/chips (step 4)
is *not* automatically moot under notification-only — that was conflating
two separate things. "Execution" (writing transfers/chips to FPL) is what's
in question; "knowing what transfers/chips are available so the proposal
accounts for them" is a proposal-quality problem that exists either way,
since the public API doesn't expose free-transfer count or unplayed chips
regardless of which way this decision goes. See the weekly prompt feature
below — it's decoupled from this open question and not blocked by it.

Companion feature, unblocked and independent of the decision above:

- **Ask the user for current free transfers and available chips before each
  week's proposal**, instead of an authenticated lookup — `CurrentSquad`'s
  doc comment in `domain.types.ts` already notes free transfers aren't
  exposed by the public API, and available (unplayed) chips have the same
  gap. A weekly Telegram prompt (right before deadline, alongside the
  proposal alert) sidesteps needing auth for this entirely: "how many free
  transfers?", then one yes/no per chip. **Since the 2025/26 rules change,
  all four chips — Wildcard, Free Hit, Bench Boost, Triple Captain — are
  guaranteed twice per season, not just Wildcard**: one set for the first
  half (must be played before the Gameweek 19 deadline, doesn't carry over)
  and a fresh second set unlocked from Gameweek 20. So track all eight as
  separate flags (`wildcard1`/`wildcard2`, `freeHit1`/`freeHit2`, etc.), not
  four. Any chip answered "no" isn't asked again. Needs a handful of
  persisted fields (current free transfers, per-chip used/available) — the
  persistence layer this needed to survive restarts is now in place (see
  below), so this is unblocked and ready to build whenever it's picked up.

Companion feature, unblocked now that persistence has landed (see below):

- **After each deadline passes, ask "did you apply what was suggested?"**
  and record the answer. In a notification-only model this is the *only*
  way the bot ever finds out whether advice was followed — without it, a
  bad outcome next gameweek can't be distinguished between "model was
  wrong" and "advice wasn't followed," which breaks step 5's backtesting.

Full writeup: Claude's persistent memory,
`notification-only-pivot-under-consideration`.
