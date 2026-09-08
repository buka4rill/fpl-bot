# fpl-bot — project context

FPL assistant bot. NestJS service that ingests gameweek data, predicts a squad,
alerts the owner over Telegram, and **only ever writes to the FPL account after
an explicit approval reply**. See `ARCHITECTURE.md` for the full design — this
file is the short version for whichever session picks this repo up next.

## Hard constraints (do not relax these while building)

- **Alert → wait for explicit OK → apply.** No autonomous execution. Silence
  before deadline resolves to "do nothing," never "apply anyway."
- **No official FPL write API.** `AuthModule` (holds `FplAuthClient` and the
  authenticated session — moved out of `ExecutionModule` 2026-09-08, see
  "Execution auth" below) and `ExecutionModule` (the one other module allowed
  to use it directly, for the actual write calls) talk to undocumented
  endpoints (OIDC login, `/api/my-team/`, `/api/transfers/`). Keep both the
  most isolated modules in the app — nothing else should reach these
  endpoints or hold the authenticated session directly; everything else goes
  through `AuthService`'s narrow status-check surface instead.
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
| `optimization` | implemented — squad optimizer (ILP) + chip evaluator. Transfer-hit recommendations are deliberately conservative (2026-09-08): capped at `OPTIMIZER_MAX_HITS_PER_WEEK` hits/week (default 1) and gated by a risk-adjusted internal threshold (`OPTIMIZER_HIT_RISK_PREMIUM` on top of the real 4-pt cost, default 4, so effective threshold 8) — see "Transfer-hit policy" below |
| `team-state` | implemented (2026-09-08, rebuilt same day) — reads free transfers + chip availability live from FPL's authenticated my-team endpoint (via `ExecutionService`) and sends it as an informational Telegram report before each week's proposal; no persistence, never blocks; `POST /team-state/report` manually re-triggers it for testing — see "Weekly team-status report" below |
| `proposal` | implemented — optimizer-driven (`POST /proposal/generate` manually triggers it now, live team state), plus manual overrides: `POST /proposal/captain-swap` (low-risk execution testing), `POST /proposal/manual-transfer` (propose exactly one transfer, built from live my-team data — used to verify `/api/transfers/`, see "Execution auth" below), `POST /proposal/chip` (declare a chip for this week's proposal, goes through the real optimizer), and `POST /proposal/chip-manual` (declare a chip on the current live squad unchanged, bypassing the optimizer — used to verify Bench Boost live, see "Execution auth" below) |
| `alert` | implemented — Telegram adapter, proposal alerts + execution-result alerts |
| `approval` | implemented — state machine (`PENDING → APPROVED/REJECTED/EXPIRED`) + webhook controller (`approve:`/`reject:`, plus `appliedyes:`/`appliedno:` — see "Post-deadline applied-manually check-in" below); triggers execution on `APPROVED` |
| `execution` | implemented for **lineup/captain/transfers/chips** — `ExecutionService`, using `FplAuthClient` from `AuthModule`. Transfers, Bench Boost, and Triple Captain all verified live 2026-09-08; Wildcard/Free Hit still unverified — see below |
| `auth` | implemented (2026-09-08) — holds `FplAuthClient`/the authenticated session (moved out of `ExecutionModule`, see "Execution auth" below); `AuthService.isAuthenticated()`/`assertAuthenticated()` let other modules check/gate on login state; `POST /auth/token` (shared-secret guarded) applies a freshly-captured refresh token to the running instance — the landing spot for `pnpm run auth:login`'s Playwright-assisted capture (`scripts/auth-login.ts`) |
| `scheduler` | implemented — hourly deadline-watcher, dynamic (no fixed weekday); also gates on `AuthService.isAuthenticated()` before generating a proposal — see "Execution auth" below |
| `results` | implemented (2026-09-08) — `ResultsService` (own hourly poll, public-API only) reports "how did my suggestion actually score" for every terminal proposal (APPROVED/REJECTED/EXPIRED) once its gameweek finishes — full autosub/chip-accurate simulation, not an approximation; `POST /results/report` manually re-triggers it — see "Post-gameweek results report" below |
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

`ProposalService.findBySeasonAndGameweekId` backs `DeadlineWatcherService`'s
restart-safe "already proposed this gameweek" check — replacing what used
to be an in-memory flag that forgot on every restart. (An in-process-only
synchronous claim still exists alongside it, for the unrelated race between
two overlapping checks in the same running process — see the comments on
`lastClaimedGameweekId`.)

**Season-scoped gameweek identity (2026-09-08).** FPL's gameweek `id`
resets to 1 every season (verified live — `bootstrap-static` has no season
field anywhere in the payload), so anything keyed on `gameweekId` alone
silently collides across a season rollover — most seriously,
`findBySeasonAndGameweekId` (nee `findByGameweekId`) would find last
season's GW-whatever proposal and skip generating a new one for the entire
gameweek, silently. `Gameweek.season` (domain type) is derived from the
gameweek's own `deadlineAt` via `computeSeason()` in
`src/common/utils/season.util.ts` (Aug–May season, July cutover) —
`Gameweek.id` itself is left alone since it's the real FPL event id needed
for API calls (`fixtures(gameweek)`, `liveGameweek(gameweek)`, etc.), only
its *uniqueness* needed fixing. `GameweekEntity` and `PlayerSnapshotEntity`
both got `season` added to their primary key; `ProposalEntity` got a
`season` column + composite `(season, gameweekId)` index.
`PlayerSnapshot`/`Proposal` domain interfaces: `Proposal.season` is
required (every proposal is for a real gameweek); `PlayerSnapshot.season`
is deliberately *not* on the domain interface — same "persistence-only
extra field" pattern as `PlayerSnapshotEntity.capturedAt` — since
`PredictionService.recordSnapshotHistory` is the only place season is
actually known when a snapshot entity is created.

**Adjacent bug found and fixed in the same pass**: `PlayerSnapshotEntity`
rows were being stamped with whichever gameweek was *currently live* at
ingestion time (`IngestionService`'s `currentGameweek.id`, since a fresh
snapshot is "as-of-now" player data), not the gameweek actually being
*predicted for* — so a snapshot recorded while proposing for next week's
GW4 (while GW3 is still live) was filed under `gameweekId: 3`, unable to
ever join back to `GameweekEntity`'s GW4 row. Same "silently keyed under
the wrong gameweek" hazard the season fix addresses, just within a season
rather than across one. Fixed by having `recordSnapshotHistory` override
`gameweekId`/`season` from `targetGameweek` at persistence time, same
pattern as the season stamp. Pre-fix rows (this bot's very first batch of
history, ~654 rows) are stuck with the wrong `gameweekId` — not worth
correcting retroactively at this scale/stage; the migration only backfills
their `season` column (falls back to "any known season" for rows the
`gameweekId` join can't match, safe since only one season of data existed
pre-fix).

**Pinned versions matter here**: `@nestjs/typeorm@12.x` is ESM-only and
won't load under this project's CommonJS setup on Node 20 (breaks Jest and
`ts-node` alike) — use `@nestjs/typeorm@^11.0.3` with `typeorm@^0.3.x`.
Also: if you see `Nest can't resolve dependencies of the TypeOrmCoreModule
(... ModuleRef ...)` after touching these packages, it's very likely a
stale `node_modules` from a mid-session version swap, not a real
incompatibility — `rm -rf node_modules && pnpm install` fixed it here.

### Execution auth — read before touching `FplAuthClient`/`AuthModule`

FPL's write auth is OIDC via a hosted identity provider (PingOne DaVinci), not
the old email/password login most third-party writeups describe. The
interactive login step is bot-guarded (DataDome) and deliberately **not**
scripted — instead, a long-lived refresh token is obtained from a real,
human-driven browser login, and `FplAuthClient` only ever exchanges it for
short-lived access tokens.

**The refresh token goes stale routinely, by design, not as a bug**: FPL's
identity provider keeps only one active session per account, so any other
logged-in client (the official mobile app included) refreshing in the
background invalidates whatever this bot is holding. When that happens,
`FplAuthClient` fails loudly, and (2026-09-08) the app now actively surfaces
it rather than just erroring on the next attempted call:
`DeadlineWatcherService` checks `AuthService.isAuthenticated()` before
generating a proposal and sends a Telegram prompt if it's not (once per
outage, not every hourly poll); the manual endpoints
(`/proposal/generate`, `/team-state/report`, etc.) call
`AuthService.assertAuthenticated()` up front and return a clear "log back
in" message instead of a raw error. The fix is always a fresh login, never
automated re-login (still deliberately unscripted — DataDome).

**Getting a fresh token (2026-09-08 — now semi-automated).** Run `pnpm run
auth:login` **from your own terminal, not through an agent's shell** — it
opens a real (headful) browser via Playwright, you log into FPL yourself
(nothing about the login itself is scripted, so DataDome has no reason to
care), and once `localStorage` shows the OIDC token the script reads it and
`POST`s it to the running app's `POST /auth/token` (guarded by a shared
`AUTH_PUSH_SECRET` — must match between `.env` and the script's own `.env`
read). `AuthController` applies it via `AuthService.applyRefreshToken()`,
which also persists it to `.env` immediately (as does every routine
rotation now — `FplAuthClient.ensureAccessToken()` used to only log a
warning and lose the rotated token on restart; fixed same day). Verified
live end-to-end 2026-09-08: script → push → applied → confirmed via both a
"✅ FPL login updated" Telegram message and a live `/team-state/report`
call succeeding right after. Falls back to the pre-existing fully-manual
DevTools capture (`JSON.parse(localStorage.getItem('oidc.user:...')).refresh_token`,
paste into `.env` by hand) if Playwright isn't available. Full capture
steps and the underlying HTTP contracts are in Claude's persistent memory
(`fpl-write-api-contract`), not duplicated here.

**Known limitation — local machine only, revisit at deploy time.**
`auth:login`'s browser has to run somewhere with a real display, so this
only works because the bot currently runs on the same machine you're
sitting at. It will **not** work unmodified once this moves to a headless
cloud server (CLAUDE.md's deploy TODO, not started) — there's no screen
there for you to log into. The `/auth/token` push design should still
work then (point `AUTH_TARGET_URL` at the deployed URL, run the script
locally, same as today), but this needs re-confirming once a real deploy
target exists.

**Transfers (step 4) — verified live 2026-09-08 against a disposable test
account, and the community-library-derived contract was wrong.**
`FplAuthClient.submitTransfers` originally mirrored `amosbastian/fpl`'s
assumed dry-run-then-commit pattern (`confirmed: false` validates without
applying, a second `confirmed: true` call actually submits). **Live testing
disproved this**: a single `confirmed: false` call already applied the
transfer for real (confirmed by checking the test account's actual squad
afterward — the "failure" it threw was itself a second bug, see below).
Fixed same day: `submitTransfers` now sends exactly one request,
`confirmed: true` directly — sending a second call on top of an
already-applied transfer is untested and deliberately not risked. Also
fixed: a clean response was assumed to be `{}`; it's actually an
empty-body 200 that axios hands back as `''`, which the original
`hasErrors` check treated as an error (a false-positive rejection on every
clean submission, is what surfaced the dry-run/commit issue in the first
place — the "failed" first live attempt had actually already applied the
transfer). Verified end-to-end via the new `POST /proposal/manual-transfer`
override (below): propose → Telegram approve → `execution_logs` row with
`success: true` and the new player in the returned `picks`.

**Bench Boost — verified live 2026-09-08 against the disposable test
account.** `POST /proposal/chip` (the optimizer-driven path) can't be used
for this: it goes through `PredictionService.predictGameweek()`, which
calls `IngestionService.getCurrentSquad()` — the *public* entry/picks
endpoint — and that 404s for this account (`entry.current_event` is 3, but
`/event/3/picks/` 404s; no saved picks history for its own current
gameweek — the same gap `manual-transfer`'s doc comment already flagged for
`SquadOptimizerService`). Added `POST /proposal/chip-manual` instead — same
"manual override built from `ExecutionService.getCurrentSquadShape()`
(authenticated), not the public endpoint" pattern as captain-swap/
manual-transfer, chip declared with lineup/bench/captaincy otherwise
unchanged. Only makes sense for a chip that doesn't need the transfer
endpoint (Bench Boost/Triple Captain) — Wildcard/Free Hit still go through
`/proposal/chip`'s real optimizer since they're meant to accompany
transfers. Verified end-to-end: propose → Telegram approve → `setLineup`'s
response showed `chips: [{name: "bboost", status_for_entry: "active",
played_by_entry: [4]}]`, confirmed independently moments later via a fresh
`/team-state/report` call (not just the cached execution-log response).
Also observed: playing `bboost` immediately flipped `3xc`'s
`status_for_entry` from `available` to `unavailable` for this gameweek —
FPL allows only one "team"-type chip (`chip_type: 'team'`, i.e. Bench
Boost/Triple Captain) active per gameweek, confirmed live rather than
assumed.

**Triple Captain — verified live 2026-09-08, same session.** Owner
cancelled Bench Boost via the FPL web app to free the "team"-chip slot
back up, then the same `POST /proposal/chip-manual` → Telegram approve →
execute cycle was run with `chip: '3xc'`. This resolves the open
multiplier question: `ExecutionService.buildPicks` always sends the
captain at `multiplier: 2` (it has no Triple-Captain-specific logic at
all) — the *request* payload confirmed this — but the `setLineup`
*response* came back with the same captain pick at `multiplier: 3`. FPL's
server derives and overrides the tripled multiplier itself from the `chip`
field; the client never needs to send `3`. No code change needed —
`ExecutionService`'s existing behavior was already correct. Confirmed
independently via a fresh `/team-state/report` call showing `3xc` at
`status_for_entry: "active"`. Both Bench Boost and Triple Captain are now
fully verified live — only Wildcard/Free Hit remain, per below.

**`wildcard`/`freehit` on `/api/transfers/` remain unverified** — this
account's Wildcard/Free Hit still show `unavailable` (see the correction
below).

**Telegram webhook infra note (2026-09-08, unrelated to the chip work
above but hit while testing it)**: at the moment Bench Boost was approved,
`pnpm run dev:webhook`'s Cloudflare quick tunnel failed all 4 fresh
attempts (`Bad Request: bad webhook: Failed to resolve host` from
Telegram, immediately after cloudflared itself reported a successful
`Registered tunnel connection`) — the same flakiness the deploy TODO below
already documents, just newly reproduced. Telegram's `getWebhookInfo` had a
stale tunnel URL registered from an earlier, already-dead session with 4
undelivered updates queued (`last_error_message: "Wrong response from the
webhook: 530"`) — so a real Approve tap in Telegram silently went nowhere.
Worked around by POSTing the same `callback_query` JSON shape directly to
`localhost:3000/approval/telegram-callback` (the controller just parses the
body, no Telegram-side signature to fake) rather than fighting the tunnel —
fine for one-off local verification, but the webhook is **not currently
live**; a real Approve/Reject tap won't reach the app again until either a
fresh `pnpm run dev:webhook` succeeds or the eventual real deploy removes
the tunnel dependency entirely.

**Two Telegram messages found misleading during this same test, both
fixed 2026-09-08 (`AlertService`).** The Bench Boost proposal alert never
mentioned the chip anywhere in its text — the owner approved it without
realizing a chip was involved at all. Fixed by surfacing `🃏 Chip: <label>`
right after the header, *before* the transfer/lineup section (playing a
chip changes how the rest of the message should be read, and this is
exactly the kind of fact an approval decision needs up front, not buried).
Separately, the post-execution success message
(`AlertService.sendExecutionResult`) hardcoded `"captain/lineup changes
are live"` regardless of what was actually applied — accurate for the
original captain-swap-only use case (step 3), misleading once transfers
and chips existed too: the Bench Boost confirmation said "captain/lineup
changes are live" when neither had changed. Fixed by describing what the
proposal actually contained (transfer count / chip label), shared via a
new `summarizeChanges()` helper also used by `sendAppliedCheckIn` (which
had the same shape of summary already, just inline and using the raw chip
enum value like `wildcard` instead of a human label) — falls back to the
old "lineup/captain changes" phrasing only when there's genuinely nothing
else to report (still accurate then, since `setLineup` runs on every
execution regardless).

**Both message fixes re-verified live, same day**: owner cancelled the
first Bench Boost via the FPL web app, then re-ran the full
`/proposal/chip-manual` → Telegram approve → execute cycle end to end.
Confirmed both fixes actually landed as intended — the alert showed `🃏
Chip: Bench Boost` up front this time, and the confirmation read `✅ GW4
applied — Bench Boost now live...` instead of the old misleading text.
Bench Boost itself re-confirmed `active` again both via the execution log
and an independent fresh `/team-state/report` call.

**Correction 2026-09-08 — not blocked on "preseason" the way it looked.**
A live `POST /team-state/report` against the disposable test account
(currently `gameweekId: 4`) came back with `bboost`/`3xc` both already
`status_for_entry: 'available'` (`start_event: 1`) — only `wildcard`/
`freehit` are `unavailable` (`start_event: 2`). Combined with
`transfers.status` still reporting `'unlimited'` at gameweek 4 (expected
only preseason, see "Weekly team-status report" below), this looks less
like "the account is in preseason" and more like "this account's team has
no saved picks/gameweek history yet" — FPL evidently gates transfer-type
chips behind that, independent of the live gameweek clock. Practical
upshot: **Bench Boost/Triple Captain look testable against this account
right now**; Wildcard/Free Hit likely need the account to get through a
real deadline with a saved squad first. Re-check via `/team-state/report`
before assuming either way — this has only been observed once.

`ChipEvaluatorService` remains a deliberate stub — nothing decides *when*
a chip is automatically worth playing (a prediction/strategy problem, not
execution). `POST /proposal/chip` is the manual substitute: "I've decided
to play chip X this week," runs the full optimizer with that chip factored
in (Wildcard/Free Hit zero out hit cost, including in the ILP itself, not
just the reported number — see `SquadOptimizerService.optimizeSquad`).

## Open question: single-strategy optimizer vs. weighing strategies against each other (raised 2026-09-08, not decided)

Even with the transfer-hit policy fix above, `SquadOptimizerService` still
only ever answers one question: "given N free transfers, what's the best
squad?" It treats free transfers as a budget to spend, not a decision —
any swap that clears the profitability bar gets taken, up to
`maxHitsPerWeek`/`freeTransfers`, with no option to deliberately use fewer
than all of them (banking transfers has real future value FPL rewards, up
to its own cap, which the optimizer doesn't model at all). And chips are
never in the running unless manually declared via `POST /proposal/chip` —
the optimizer never compares "N transfers with the current chip-free plan"
against "play Wildcard and rebuild," "play Bench Boost with this bench,"
or "play Triple Captain on this pick" as competing strategies for the same
gameweek and recommends whichever is actually best.

What's really being asked for: evaluate multiple candidate strategies per
gameweek (no transfers / partial transfers / full free transfers / a hit /
each available chip) on predicted point outcomes — including hold value for
banked transfers, and ideally informed by `TrendsModule` data (still not
consumed anywhere) for things like upcoming fixture swings or double/blank
gameweeks that change a chip's timing value — and surface the best one,
not just the single plan the ILP happens to produce today.

This is a genuinely bigger feature than a tuning fix: it touches
`SquadOptimizerService`, `ChipEvaluatorService` (this is likely what it was
always meant to grow into, scoped wider — not just "when to auto-play a
chip" but "which whole strategy, chip included, wins this week"),
`TrendsModule`, and probably `ProposalService`/`AlertService` if the answer
is "show the top strategy, not silently discard the runners-up." Not
started — needs its own design pass (probably its own plan-mode session)
rather than a quick change, given how many modules it touches and how many
real modeling decisions it involves (how to price "hold value," how to
compare a chip's one-time payoff against an ongoing transfer plan, etc.).

For local webhook testing (tapping Approve/Reject against a real Telegram
callback), `pnpm run dev:webhook` automates the tunnel + webhook wiring —
see `scripts/dev-webhook.ts`.

## Transfer-hit policy (2026-09-08)

The ILP's real hit cost (`POINTS_PER_TRANSFER_HIT = 4` in
`squad-optimizer.service.ts`) is a bare FPL breakeven — the solver used to recommend a hit
any time predicted gain was a hair above 4, with no cap on how many it
stacked in one week. A real proposal once took 6 hits (-24 pts) chasing
marginal, individually-thin edges — a bad trade in a mini-league (rank-
relative, variance-punishing), even when each swap is technically EV-
positive by a sliver. Fixed with two config-driven (not hardcoded — this is
risk tolerance, not a fixed game rule) levers in `SquadOptimizerService`:
`OPTIMIZER_MAX_HITS_PER_WEEK` (default 1) hard-caps hits per week via an
ILP constraint (`MAX_HITS_CONSTRAINT`), and `OPTIMIZER_HIT_RISK_PREMIUM`
(default 4) is added to the *internal* objective penalty only — the
solver's effective threshold becomes 8, not 4 — while the real, reported
`hitCost` shown to the user and actually deducted by FPL stays exactly
`4 × hits taken`. Both inert under Wildcard/Free Hit (transfers are already
free that week). See the regression tests in
`squad-optimizer.service.spec.ts` for the exact before/after behavior.

## Weekly team-status report (2026-09-08, replaced same-day)

Originally built as a Telegram Q&A (see git history / the memory this
section used to describe): the working assumption was that free-transfer
count and chip availability weren't obtainable without asking the owner
directly every week, since the *public* entry API doesn't expose either.
**That assumption was wrong for the authenticated my-team endpoint.**
Discovered live 2026-09-08 while capturing a fresh test account's team id:
`GET /api/my-team/{teamId}/` — the same endpoint `ExecutionService` already
calls to apply changes — returns `transfers` (`limit`/`made`/`cost`/`bank`/
`value`) and `chips` (`status_for_entry`/`start_event`/`stop_event` per
chip) directly. `FplAuthClient`/`ExecutionService` were already fetching
this on every call; the fields were just typed `unknown` and discarded
(see `fpl-auth.types.ts`'s `FplChipStatus`/`FplTransfersState`, now typed).

Replaced same-day with a read-only report: `TeamStateService.getTeamState()`
calls `ExecutionService.getTeamState(teamId)` (a thin passthrough to
`FplAuthClient.getMyTeam` — keeps the authenticated session isolated to
`ExecutionModule`, same principle as `getCurrentSquadShape`, per this
file's hard-constraints section) and derives a plain free-transfer number
(`transfers.status === 'unlimited'`, seen preseason, is treated the same as
an active Wildcard/Free Hit — 15, i.e. no plan can exceed it — anything
else with no numeric `limit` throws rather than guessing). No more DB-backed
prompt state machine — `TeamStateEntity`/`team_state` table is gone
(migration `DropTeamState...`), and `ApprovalController` no longer routes
`chipavail:`/plain-text replies at all, only `approve:`/`reject:`.

`DeadlineWatcherService.checkDeadline()` no longer blocks on anything here —
right where it used to gate on an answered prompt, it now calls
`teamStateService.reportTeamState(gameweekId)`, which fetches the live state,
sends it as an informational Telegram message (free transfers, bank/value,
one line per chip with an emoji per `status_for_entry`), and returns it —
that `freeTransfers` feeds straight into `generateProposal`. `POST
/team-state/report` manually triggers the same report for testing (same
idea as `POST /proposal/captain-swap`), replacing the old `/team-state/prompt`.

Still unverified beyond what's been observed live so far (one preseason
capture, `status: 'unlimited'`): the exact `status` values in a normal
in-season week (expected something like `'limited'`/`'cost'` with a real
numeric `limit`), and whether `chips[]` ever lists a second-half instance
(`number: 2`) before it unlocks, or only appends it once it does. Worth a
sanity check against the report the first time this runs past Gameweek 1.

For testing without waiting on the automatic trigger window, `POST
/team-state/prompt` (`TeamStateController`) fires the prompt for the
upcoming gameweek on demand — same idea as `POST /proposal/captain-swap`.
If that week's prompt was already fully answered, it deliberately restarts
the sequence rather than no-op'ing, so you can re-confirm on demand.

## Post-deadline applied-manually check-in (2026-09-08, implemented)

Scoped narrower than the original "ask after every deadline" idea (see the
open question below) once it was clear the state machine already answers
most of the question: `APPROVED` means the bot itself applied it
(`ExecutionLogEntity` has success/failure); `REJECTED` means the owner
explicitly declined, intent already known. The only genuinely unknown case
is **`EXPIRED`** — silence (or a too-late reply) before the deadline, where
the hard "silence means do nothing" constraint means the bot never touched
FPL, but the owner might still have made the change by hand in the app.
Without knowing which, a bad outcome next gameweek can't be told apart from
"model was wrong" vs. "advice wasn't followed" — which is exactly what step
5's backtesting needs to distinguish.

`ApprovalService.expire()` (called from both `expireOverdue()`'s sweep and
a too-late `decide()`) now sends a Telegram Yes/No check-in
(`AlertService.sendAppliedCheckIn` → `TelegramAdapter.sendAppliedCheckIn`)
right after transitioning a proposal to `EXPIRED`, summarizing what the
plan was (transfer count + chip, if any). Best-effort and wrapped in its
own try/catch inside `expire()` — a Telegram hiccup here must never break
`DeadlineWatcherService.checkDeadline()`, which calls `expireOverdue()`
before generating the *current* gameweek's proposal on the same poll.

The reply lands on a separate `appliedyes:<id>`/`appliedno:<id>` callback
namespace (not `approve:`/`reject:` — this labels an already-terminal
proposal, it's not a state transition) and is recorded via
`ApprovalService.recordAppliedManually` → `ProposalService
.recordAppliedManually`, which sets a new nullable `appliedManually:
boolean | null` column on `ProposalEntity`/`Proposal`
(migration `AddAppliedManuallyToProposals...`). Purely a label for future
backtesting — never gates or re-triggers execution, and answering twice
(a duplicate tap) just overwrites the same field rather than erroring.

**Wording tweak (2026-09-08, later same day)**: the question itself is now
"Did you apply my suggestion?" — was "Did you end up making that change
yourself in the FPL app?" User feedback: more natural, and reads better
now that the post-gameweek results report (below) sometimes echoes the
same answer back for context.

## Post-gameweek results report (2026-09-08, implemented)

Raised alongside the check-in above — "how many points would I have gotten
had I approved the predicted strategy," connected to (but temporally
**separate** from) that check-in: the check-in fires immediately once a
proposal's deadline passes, days before the gameweek's matches are even
played, so it can never itself carry a score. This is the second half —
`ResultsService` runs its own hourly poll (public-API only, no auth
needed) and, once a proposal's gameweek is marked `finished: true` in
bootstrap-static, sends a `📊 GW{n} Result` report for **every terminal
proposal** (APPROVED/REJECTED/EXPIRED — deliberately not just EXPIRED,
unlike the check-in above: this is a model-accuracy signal for step 5
regardless of what happened, not only a backtesting label for the unknown
case) comparing:
- **Predicted**: what the exact proposed lineup/captain/chip would have
  scored, computed by `gameweek-scoring.util.ts`'s
  `computeProposalActualScore` — a full simulation, not an approximation,
  chosen deliberately over a cheaper "sum the starting XI" shortcut. It
  replicates three real FPL scoring rules: (1) autosubs — a non-playing
  starter is replaced by the highest-priority bench player who did play,
  constrained by each position's starting min/max (formation-aware, and
  confirmed live-rule-accurate that FPL allows a cross-position sub, e.g. a
  bench defender covering for a missing midfielder, as long as the
  resulting formation stays legal — this surprised the first draft of the
  test suite, see the spec file's comments); (2) captaincy transfers to the
  vice-captain if the captain didn't play; (3) chip effects — Bench Boost
  sums all 15 (no autosubs needed, everyone already counts), Triple
  Captain only triples if the actual captain themselves played (does not
  carry over as a triple to the vice). One acknowledged gap: if the
  vice-captain is a benched player who played but wasn't actually
  autosubbed in, FPL's precise behavior for the captaincy-bonus transfer in
  that specific double-edge-case isn't publicly documented — this treats
  "played" as sufficient on its own.
- **Actual**: the real points the account scored that gameweek, from the
  public entry/picks endpoint's `entry_history.points` (newly typed on
  `RawEntryHistory` — was missing, only `event`/`bank`/`value` were
  captured before).

New `IngestionService` methods: `getGameweekPlayerStats(gameweekId)`
(normalizes `liveGameweek()` into `Map<playerId, PlayerGameweekStats>` —
`{totalPoints, minutes, played}`, the first real normalization of that
endpoint, previously left raw with no consumer) and
`getGameweekResult(teamId, gameweekId)`. New `Proposal.resultReportedAt:
string | null` column (migration `AddResultReportedAtToProposals...`) is a
one-time-send guard, same idea as `appliedManually`; `ProposalService
.findUnreportedTerminal()`/`.markResultReported()` back it. Best-effort per
proposal (one failure doesn't block the rest of the batch or leave a
false-negative "already reported" state — only marked once the report
actually sends). Season-scoped throughout (`(season, gameweekId)`, not
just `gameweekId`) for the same cross-season-collision reason as
everything else touching gameweek identity — see the season-scoping fix
above.

`AlertService.sendResultReport` renders the comparison plus a delta line
(who beat whom, or a tie), with one line of context on the proposal's fate
— skipped for APPROVED (self-evident, this is really an accuracy check on
the model, not a "what if"), otherwise noting REJECTED or, for EXPIRED,
echoing back whatever the check-in's `appliedManually` answer was (or that
none came in).

## Deploy (Fly.io) + CI/CD (2026-09-08 — live)

Raised 2026-09-07: `dev:webhook`'s Cloudflare *quick* tunnel
(`trycloudflare.com`) failed 8/8 fresh attempts in one session (and failed
again, twice, on 2026-09-08 while testing chips) — Telegram couldn't
resolve the tunnel hostname each time, even though cloudflared registered
the tunnel successfully every time locally. Quick tunnels are explicitly
disclaimed by Cloudflare as "no uptime guarantee, experiment only," so
this isn't shocking, but it's also a symptom of a deeper gap: the bot's
actual job (hourly deadline polling, an always-reachable Telegram webhook)
needs a host that's on 24/7 with a stable public endpoint — something a
personal machine + ephemeral tunnel was never going to provide long-term.
`dev:webhook` stays exactly what it is (a *local dev* convenience for
testing the webhook-receiving side), not the deployment story.

**Fly.io**, as recommended here previously — a permanent `https://*.fly.dev`
domain out of the box (webhook set once, no tunnel ever again), deploys
from a Dockerfile, Postgres as its own Fly app. **Live as of 2026-09-08**:
app `fpl-bot-buka4rill` at https://fpl-bot-buka4rill.fly.dev, Postgres
cluster `fpl-bot-buka4rill-db` attached (`DATABASE_URL`), 1GB volume
`fpl_bot_data` mounted at `/data` for the refresh-token store, all 6
secrets deployed (`DATABASE_URL`, `FPL_TEAM_ID`, `FPL_REFRESH_TOKEN`,
`AUTH_PUSH_SECRET`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`). Verified
live end-to-end, not just "booted": `POST /team-state/report` against the
deployed instance returned real, correct FPL data (chip
statuses matching what local testing had just shown) — confirms secrets,
DB, and the FPL auth flow all actually work in production, not just
locally. The Telegram webhook is now registered at the permanent URL
(`getWebhookInfo` confirmed, zero pending updates) — **the tunnel saga
from earlier this session is over**; a real Approve/Reject tap should
reach the app directly from here on, no more manual callback replay.
Billing: Fly requires a payment method for any usage (no free tier since
2023) — this setup (2 always-on `shared-cpu-1x`/256MB VMs + two 1GB
volumes) runs an estimated **~$4-5/month**, confirmed against Fly's own
pricing page before committing to it. `auth:login` hasn't been re-run
against the deployed `AUTH_TARGET_URL` yet — not urgent, since the token
already on the server (pushed as a secret from the local session) is
still valid and working; do it the next time the token actually goes
stale (see "Execution auth" above for why that happens routinely).

**Separate Telegram bots for dev vs. prod (2026-09-08, same day).** Local
dev and the deployed instance originally shared one bot/chat, which meant
(a) no way to tell which environment sent a given alert, and (b) only one
of them could hold the webhook at a time — right after the first deploy,
the *dev* bot's webhook was still pointed at the *prod* Fly URL, so a
button tap in the dev chat would have hit production. Fixed by creating a
second bot (`@FplProdBot`) via BotFather, used **only** by the deployed
app: `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` on Fly now point at it
(`fly secrets set` — triggers an automatic rolling restart), its webhook
is registered at the permanent Fly URL, and the original (dev) bot's
webhook was explicitly cleared (`deleteWebhook`) so it's purely a
`dev:webhook`/manual-testing target again, never silently pointed at
prod. Local `.env` is unchanged — still the original/dev bot. Both bots
message the *same* Telegram chat (chat id is tied to your account, not
the bot), so alerts are told apart by which bot sent them, not which chat
they land in. Verified live: triggered `POST /team-state/report` against
the deployed app, confirmed the message arrived from `@FplProdBot`, not
the dev bot.

**Decided 2026-09-08: prod stays on the disposable test account for
now, deliberately** — both environments point at the same account (the
one used throughout this session's testing, not the real one), and that's
staying that way rather than switching prod over to the real account
immediately. Two reasons: it's the safer state (nothing prod does can
touch the real squad until this is deliberately changed), and — the
actual driver — running prod 24/7 against the test account starts
genuinely accumulating the `PlayerSnapshot`/results-report history step 5
needs, without any risk to the real account while that data builds up.
Revisit switching prod to the real account once there's enough history to
start step 5 for real, or whenever the test-account approach stops being
useful.

**A few real bugs surfaced getting the Docker build working, all fixed
2026-09-08:**
- `package.json`'s `start:prod` script pointed at `node dist/main` — the
  real build output is `dist/src/main.js` (tsconfig's rootDir spans both
  `src/` and `scripts/`, so `nest build` preserves that prefix). This had
  never actually been run before — would have crash-looped on the very
  first deploy attempt. Fixed; the Dockerfile's `CMD` uses the corrected
  path directly.
- pnpm 10's newer default-deny policy on native `postinstall`/`install`
  scripts (`ERR_PNPM_IGNORED_BUILDS`, flagging `@parcel/watcher` and
  `unrs-resolver`, both transitive eslint-tooling deps) blocked a fresh
  `pnpm install --frozen-lockfile` in Docker even after allowlisting them
  in `pnpm-workspace.yaml`'s `onlyBuiltDependencies` — confirmed live that
  the *exact* same config passes locally (a real TTY to fall back to) but
  fails in a `docker build` (no TTY) unless `CI=true` is also set, which
  tells pnpm to trust the config non-interactively. Both Dockerfile stages
  set `ENV CI=true` before installing.
- `TypeOrmModule.forRootAsync` (`app.module.ts`) and the standalone CLI
  datasource (`data-source.ts`) only supported discrete
  `DATABASE_HOST`/`PORT`/`NAME`/`USER`/`PASSWORD` fields — Fly's Postgres
  (`fly postgres attach`) instead injects one `DATABASE_URL` connection
  string. Both now accept `DATABASE_URL` when set, taking priority over
  the discrete fields, which local dev's docker-compose Postgres still
  uses unchanged.

**`FplAuthClient`'s refresh-token persistence (raised 2026-09-08, also
fixed same day):** it used to only write to a local `.env` file — fine on
a machine that runs continuously, but Fly's filesystem is ephemeral, so
that write would've been lost on every restart/redeploy and the app would
silently fall back to a stale token. Fixed with `TOKEN_STORE_PATH` (see
`FplAuthClient.readStoredRefreshToken`/`persistRefreshToken`): when set, a
previously-rotated token is read from/written to a file at that path
instead of `.env`, and `fly.toml` points it at `/data/fpl-refresh-token.txt`
on a mounted persistent volume. Local dev leaves `TOKEN_STORE_PATH` unset
and keeps rewriting `.env` exactly as before — no behavior change there.
`auth:login` itself doesn't need to change either way (still runs on your
own machine, still pushes to `POST /auth/token`, just pointed at the
deployed `AUTH_TARGET_URL` instead of `localhost:3000`).

**CI** (`.github/workflows/ci.yml`): type-check + lint + unit tests on
every push to `main` and every PR. No Postgres service container — the
unit suite is fully mocked-repository-based, no live DB needed. `test:e2e`
(`test/app.e2e-spec.ts`) is deliberately *not* run here: it boots the
full `AppModule` including real `TypeOrmModule`, needs a live Postgres,
and is unmodified `@nestjs/cli` boilerplate not exercised anywhere else in
this project — revisit if it's ever actually used for something specific.

**CD** (`.github/workflows/deploy.yml`): `workflow_dispatch` only, not
automatic on merge — a deliberate choice, since a bad deploy here means an
autonomous bot pushing bad changes to a real FPL account, not just a
broken staging site. Run it from the Actions tab once CI is green on the
commit you want live. `FLY_API_TOKEN` is already set as a GitHub repo
secret — `fly launch` did this automatically (detected the GitHub remote
and pushed it via `gh`) as part of the first launch below, not something
that needed doing by hand.

**`fly launch` gotcha, hit live during the actual launch — watch for this
if the app is ever relaunched or launched fresh elsewhere:** even with
`--copy-config` (meant to respect the existing `fly.toml`/`Dockerfile`
as-is), it still silently ran `pnpm add -w -D @flydotio/dockerfile` (an
unwanted devDependency + lockfile churn — it correctly decided to *skip*
regenerating the Dockerfile itself, but added the package regardless) and
generated its own `.github/workflows/fly-deploy.yml`, defaulting to
**deploy on every push to `main`** — directly contradicting the
manual-trigger-only decision this project already made. Both were caught
and reverted before committing (`git checkout -- package.json
pnpm-lock.yaml`, delete the generated workflow) — this project's own
hand-written `deploy.yml` is the one that should exist. Always diff
everything `fly launch`/`fly deploy` touch before trusting them blindly.

### How it was actually set up (2026-09-08) — reference for next time

1. Signed up at fly.io via GitHub SSO; installed `flyctl`
   (`iwr https://fly.io/install.ps1 -useb | iex` on Windows).
2. `fly auth login` — browser-based, one-time (had to be run from the
   user's own terminal — an agent's sandboxed shell can't drive the
   browser flow).
3. First `fly launch --no-deploy --copy-config --name fpl-bot-buka4rill
   --region lhr --yes` attempt failed with "requested machine count
   exceeds organization limit" — Fly blocks *any* machine creation
   without a payment method on file, even within free-usage bounds (no
   free tier exists as of 2023). Added a card at
   `fly.io/dashboard/personal/billing`, then the same command succeeded —
   see the gotcha above for what it changed that had to be reverted.
4. `fly volumes create fpl_bot_data --app fpl-bot-buka4rill --region lhr
   --size 1 --yes`.
5. `fly secrets set -a fpl-bot-buka4rill FPL_TEAM_ID=... FPL_REFRESH_TOKEN=...
   AUTH_PUSH_SECRET=... TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=... --stage`
   (`DATABASE_URL` was already set automatically by `fly postgres attach`,
   which `fly launch` also ran as part of step 3).
6. `fly deploy --app fpl-bot-buka4rill` — real first deploy, verified via
   `fly logs` (clean boot, all modules initialized) and a live
   `POST /team-state/report` call against the deployed URL.
7. Re-registered the Telegram webhook at the permanent URL via a direct
   `setWebhook` call (`https://api.telegram.org/bot<TOKEN>/setWebhook?url=
   https://fpl-bot-buka4rill.fly.dev/approval/telegram-callback`) —
   confirmed via `getWebhookInfo`.

Revisit the deferred **auto-execution vs. notification-only** question
below now that there's a real production deploy to gather data from,
per that section's own note.

## Build order (ARCHITECTURE.md §11)

1. ✅ Ingestion + prediction + optimization, recommend-only
2. ✅ Approval state machine + alert loop
3. ✅ Execution for lineup/captain only — verified live end-to-end
4. ✅ Extend execution to transfers + chips — built 2026-09-08; transfers,
   Bench Boost, and Triple Captain all verified live the same day against a
   disposable test account (see "Execution auth" above), fixing two real
   transfer bugs and resolving the Triple Captain multiplier question the
   community-derived contract had left open. Only Wildcard/Free Hit remain
   unverified
5. ⬜ Iterate the prediction model once there's backtestable history

Currently at: **step 4's transfer path, Bench Boost, and Triple Captain all
verified**, only Wildcard/Free Hit still pending (see "Execution auth"
above for what's blocking it), plus the weekly team-status report, the
transfer-hit policy fix, and the post-deadline applied-manually check-in
(all 2026-09-08, see above) on top of persistence. Next: step 5 needs a
few gameweeks of `PlayerSnapshot` history to accumulate — now actually
happening on its own, since prod runs 24/7 on Fly against the disposable
test account (see "Deploy" above) rather than only when a local machine
happened to be running.

## Open question: keep auto-execution, or go notification-only? (deferred, not decided)

Raised 2026-09-07, right after step 3 shipped. **Decided 2026-09-08: keep
auto-execution for now** — step 4 (transfers + chips) was built rather than
skipped. This isn't a final "no" to notification-only, though: the plan is
to stress-test the FPL auth story for real once the bot runs on a cloud
server (see the deploy TODO below — not started yet), and revisit this
question with that real data in hand, rather than deciding on a hunch now.

The FPL auth story (see above) has been the most fragile, highest-maintenance
part of this whole system, and that fragility is external — nothing on our
side fixes FPL's session model. Still under consideration for later: drop
auto-execution entirely. Keep `ExecutionModule`'s code as-is but never call
it; run purely as a notification bot — propose, alert, and the user applies
changes manually in the FPL app.

**Correction 2026-09-07**: extending execution to transfers/chips (step 4)
is *not* automatically moot under notification-only — that was conflating
two separate things. "Execution" (writing transfers/chips to FPL) is what's
in question; "knowing what transfers/chips are available so the proposal
accounts for them" is a proposal-quality problem that exists either way,
since the *public* entry API doesn't expose free-transfer count or unplayed
chips — the authenticated my-team endpoint does, see the correction below —
regardless of which way this decision goes. See "Weekly team-status report"
above — it's decoupled from this open question and not blocked by it.

Companion feature, independent of the decision above — **built 2026-09-08,
rebuilt same day**: reports current free transfers and available chips
before each week's proposal, read live from FPL rather than asked for (see
"Weekly team-status report" above for why the original Q&A version turned
out to be solving a problem that didn't exist). Doesn't block proposal
generation — there was never anything to wait on once it stopped asking.

Companion feature, unblocked now that persistence has landed — **built
2026-09-08, scoped narrower than originally sketched here**: rather than
asking after *every* deadline, only `EXPIRED` proposals get a post-deadline
"did you end up applying it yourself?" check-in — `APPROVED`/`REJECTED`
already tell the bot what happened without asking. See "Post-deadline
applied-manually check-in" above for the full design.

Full writeup: Claude's persistent memory,
`notification-only-pivot-under-consideration`.
