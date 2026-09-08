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
| `execution` | implemented for **lineup/captain/transfers/chips** — `ExecutionService`, using `FplAuthClient` from `AuthModule`. Transfers verified live 2026-09-08; chips still unverified — see below |
| `auth` | implemented (2026-09-08) — holds `FplAuthClient`/the authenticated session (moved out of `ExecutionModule`, see "Execution auth" below); `AuthService.isAuthenticated()`/`assertAuthenticated()` let other modules check/gate on login state; `POST /auth/token` (shared-secret guarded) applies a freshly-captured refresh token to the running instance — the landing spot for `pnpm run auth:login`'s Playwright-assisted capture (`scripts/auth-login.ts`) |
| `scheduler` | implemented — hourly deadline-watcher, dynamic (no fixed weekday); also gates on `AuthService.isAuthenticated()` before generating a proposal — see "Execution auth" below |
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

**Triple Captain remains unverified** — blocked behind the above finding:
this account already spent its only "team"-type chip slot for GW4 on Bench
Boost, so Triple Captain won't show `available` again until whatever
gameweek FPL opens next for this account/chip instance. Still unconfirmed:
whether the tripling is signalled purely via the `chip` field server-side
while picks stay at `multiplier: 2`, not `3` — needs live confirmation
the next time this account (or a fresh one) has that chip available, same
`POST /proposal/chip-manual` approach used for Bench Boost above.

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

**Also needs doing at that point, raised 2026-09-08, not started:**
`FplAuthClient.persistRefreshTokenToEnv()` (see "Execution auth" above)
only writes to a local `.env` file on disk — fine on a machine that runs
continuously, but most PaaS hosts (Fly.io included) give the app an
*ephemeral* filesystem, so that write is lost on the next restart/redeploy
and the app would silently fall back to a stale token. `auth:login` itself
doesn't need to change (still runs on your own machine, still pushes to
`POST /auth/token`, just pointed at the deployed `AUTH_TARGET_URL` instead
of `localhost:3000`) — only where the *received* token gets persisted
server-side needs fixing. Two options discussed, neither built yet:
1. **Mount a small persistent volume** (Fly.io supports these) and point
   the existing file-write at a path on it instead of the ephemeral
   container root. Same code, just a durable location — the cheaper fix,
   and the one to reach for first.
2. **Write through to the platform's own secrets API** (e.g. Fly's) so a
   restart picks up the token as a real secret. More "correct" but needs
   its own credential (a Fly API token, itself another secret to manage)
   and real platform-specific integration code — not worth building
   speculatively before there's an actual account/target to test against.

## Build order (ARCHITECTURE.md §11)

1. ✅ Ingestion + prediction + optimization, recommend-only
2. ✅ Approval state machine + alert loop
3. ✅ Execution for lineup/captain only — verified live end-to-end
4. ✅ Extend execution to transfers + chips — built 2026-09-08; transfers
   verified live the same day against a disposable test account (see
   "Execution auth" above), fixing two real bugs the community-derived
   contract had baked in. Bench Boost verified live the same day too (see
   "Execution auth" above) — Triple Captain and Wildcard/Free Hit still
   unverified
5. ⬜ Iterate the prediction model once there's backtestable history

Currently at: **step 4's transfer path and Bench Boost verified**, Triple
Captain/Wildcard/Free Hit still pending (see "Execution auth" above for
what's blocking each), plus the weekly team-status report, the
transfer-hit policy fix, and the post-deadline applied-manually check-in
(all 2026-09-08, see above) on top of persistence. Next: step 5 needs a few
gameweeks of `PlayerSnapshot` history to accumulate.

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
