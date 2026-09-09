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
| `prediction` | implemented (v1) — `HeuristicStrategy`; `TrainedModelStrategy` (v2) still a placeholder. Now also models FPL's defensive-contribution rule (2026-09-08) — see "Defensive-contribution scoring" below |
| `optimization` | implemented — squad optimizer (ILP) + chip evaluator, the latter a real same-week multi-strategy comparison as of 2026-09-08 (was a stub before) — see "Open question: single-strategy optimizer..." below. Transfer-hit recommendations are deliberately conservative (2026-09-08): capped at `OPTIMIZER_MAX_HITS_PER_WEEK` hits/week (default 1) and gated by a risk-adjusted internal threshold (`OPTIMIZER_HIT_RISK_PREMIUM` on top of the real 4-pt cost, default 4, so effective threshold 8) — see "Transfer-hit policy" below |
| `team-state` | implemented (2026-09-08, rebuilt same day) — reads free transfers + chip availability live from FPL's authenticated my-team endpoint (via `ExecutionService`) and sends it as an informational Telegram report before each week's proposal; no persistence, never blocks; `POST /team-state/report` manually re-triggers it for testing — see "Weekly team-status report" below |
| `proposal` | implemented — optimizer-driven (`POST /proposal/generate` manually triggers it now, live team state), plus manual overrides: `POST /proposal/captain-swap` (low-risk execution testing), `POST /proposal/manual-transfer` (propose exactly one transfer, built from live my-team data — used to verify `/api/transfers/`, see "Execution auth" below), `POST /proposal/chip` (declare a chip for this week's proposal, goes through the real optimizer), and `POST /proposal/chip-manual` (declare a chip on the current live squad unchanged, bypassing the optimizer — used to verify Bench Boost live, see "Execution auth" below) |
| `alert` | implemented — Telegram adapter, proposal alerts + execution-result alerts |
| `approval` | implemented — state machine (`PENDING → APPROVED/REJECTED/EXPIRED`) + webhook controller (`approve:`/`reject:`/`approvenochip:` — see "Three-way approval when a chip is recommended" below — plus `appliedyes:`/`appliedno:`, see "Post-deadline applied-manually check-in" below); triggers execution on `APPROVED`. Also the single Telegram webhook entry point for plain-message slash commands — see `telegram-commands` below |
| `telegram-commands` | implemented (2026-09-08) — `/status`, `/propose`, `/login`, `/help` reachable from the Telegram chat itself, routed through `ApprovalController`'s webhook (the only Telegram entry point) to `TelegramCommandsService`; see "Telegram slash commands" below |
| `execution` | implemented for **lineup/captain/transfers/chips** — `ExecutionService`, using `FplAuthClient` from `AuthModule`. Transfers, Bench Boost, and Triple Captain all verified live 2026-09-08; Wildcard/Free Hit still unverified — see below |
| `auth` | implemented (2026-09-08) — holds `FplAuthClient`/the authenticated session (moved out of `ExecutionModule`, see "Execution auth" below); `AuthService.isAuthenticated()`/`assertAuthenticated()` let other modules check/gate on login state; `POST /auth/token` (shared-secret guarded) applies a freshly-captured refresh token to the running instance — the landing spot for `pnpm run auth:login`'s Playwright-assisted capture (`scripts/auth-login.ts`) |
| `scheduler` | implemented — hourly deadline-watcher, dynamic (no fixed weekday); also gates on `AuthService.isAuthenticated()` before generating a proposal — see "Execution auth" below |
| `results` | implemented (2026-09-08) — `ResultsService` (own hourly poll, public-API only) reports "how did my suggestion actually score" for every terminal proposal (APPROVED/REJECTED/EXPIRED) once its gameweek finishes — full autosub/chip-accurate simulation, not an approximation; `POST /results/report` manually re-triggers it — see "Post-gameweek results report" below. Also flags a post-approval manual edit in the FPL app (chip/captain/lineup) via a real picks-endpoint cross-check, 2026-09-09 — see "Divergence detection" below |
| persistence | implemented — Postgres + TypeORM, see "Persistence" below |

## Defensive-contribution scoring (2026-09-08)

The plan going in was to wire up `StatsProviderClient` (a no-op stub since
day one) against a third-party CSV source
(`olbauday/FPL-Core-Insights`, evaluated in Claude's memory as
`stats-provider-candidate-fpl-core-insights`) to close a real gap:
`HeuristicStrategy` didn't model FPL's 2025/26 "defensive contribution"
rule at all (2 pts for a defender reaching 10 combined
clearances/blocks/interceptions/tackles in a match, or a
midfielder/forward reaching 12 including recoveries).

**Turned out not to need the third-party source at all.** Live testing
against FPL's own `bootstrap-static` endpoint (already fetched by
`FplPublicClient` — just untyped) found it already returns
`defensive_contribution` per player, and it's *exactly* the raw
CBIT/CBIRT count the real rule uses — confirmed by cross-checking real
players (a defender with `clearances_blocks_interceptions: 36,
tackles: 5` shows `defensive_contribution: 41` = 36+5; a midfielder with
`clearances_blocks_interceptions: 18, tackles: 9, recoveries: 11` shows
`defensive_contribution: 38` = 18+9+11). So this shipped with **zero new
dependencies and no external CSV source** — `StatsProviderClient` is
still a stub. `RawElement` (`fpl-api.types.ts`) gained the one field;
`PlayerSnapshot` gained `position` (duplicated from `Player` so
backtesting history is self-contained without a join) and
`defensiveContribution`, both set directly in
`IngestionService.normalizeBootstrap()` (no `PredictionService`
enrichment step needed — unlike `nextFixtureDifficulty`, which genuinely
needs a cross-endpoint join, position/defensive-contribution are already
per-element in the same `bootstrap-static` response). `HeuristicStrategy`
gained `defensiveContributionBonus()`: gated on the same
180-minute-sample threshold as the xG/xA bonus, position-aware threshold
lookup (`Position.DEF` → 10, `MID`/`FWD` → 12, `GKP` excluded entirely),
scaled `0..1` against that threshold and multiplied by
`DEFENSIVE_CONTRIBUTION_POINTS_CAP = 2` — anchored to FPL's real
per-match cap rather than an arbitrary weight, unlike the existing xG/xA
bonus's `* 2`. `PlayerSnapshotEntity` got matching nullable columns
(migration `AddDefensiveContributionToPlayerSnapshots`).

**Verified live** with a standalone script (`NestFactory
.createApplicationContext(IngestionModule)` + a bare `new
HeuristicStrategy()`, no Telegram/scheduler/auth involved, deleted after
use) against real `bootstrap-static` data: a defender and a midfielder
both well past their threshold each got exactly the capped `+2.00`
(cap holds precisely, no overshoot); a high-form forward got a smaller,
proportional `+0.84` (real defensive activity, just below threshold) —
confirms attackers aren't materially skewed by this while a genuinely
hard-pressing forward still isn't ignored outright.

**Deliberately deferred, not part of this change**: everything the
third-party source uniquely offers and FPL's own API genuinely doesn't —
team Elo ratings (better fixture-strength signal than FPL's blunt 1-5
`fixtureMultiplier`) and xGOT/big-chances (richer attacker-quality signal
than the existing per-90 xG/xA bonus). `StatsProviderClient` stays a stub
until that's picked up as its own task.

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

**AUTO/MANUAL source tagging (2026-09-09)** — `Proposal.source`/
`PlayerSnapshotEntity.source` (`TriggerSource`, `src/common/enums/trigger-source.enum.ts`)
tags every row with who created it: `AUTO` (`DeadlineWatcherService`'s own
hourly poll — the only real automatic weekly decision) or `MANUAL` (every
on-demand trigger: `/propose`, `/chip`, `/proposal/generate`, and the
testing-scaffolding endpoints — `captain-swap`/`manual-transfer`/`chip-manual`).
Threaded through the whole prediction/optimization chain
(`ProposalService.generateProposal`/`generateBestProposal` →
`SquadOptimizerService.optimizeSquad` / `ChipEvaluatorService.evaluateBestStrategy`
→ `PredictionService.predictGameweek` → `recordSnapshotHistory`), defaulting
to `MANUAL` everywhere except the one call site
(`DeadlineWatcherService.checkDeadline`) that explicitly passes `AUTO` — the
safe default, since a forgotten `source` argument should never silently
count as trustworthy backtesting signal. Migration
`AddSourceToProposalsAndPlayerSnapshots` backfills every pre-existing row to
`MANUAL` (accurate: the scheduler had never yet completed a clean automatic
run before this shipped).

Motivated directly by the GW4 incident this same file already documents
under "Step 5's data checkpoint": manual execution testing on 2026-09-08
left ~10 `proposals` rows (and a matching burst of `player_snapshots` rows —
every `predictGameweek()` call writes a fresh batch, testing or not) for a
gameweek the scheduler had never actually auto-proposed for. Two things
follow from the tag: (1) `ProposalService.findBySeasonAndGameweekId` — the
scheduler's restart-safe "already proposed this gameweek" dedupe — is now
scoped to `source: AUTO` only, so a MANUAL row can never again block the
real automatic proposal for that gameweek (this unblocks GW4 itself,
without deleting anything: the scheduler will now propose for it normally
once its trigger window opens); (2) step 5's eventual backtesting query
should filter `source = 'AUTO'` rather than needing to know which
gameweeks happened to get manually contaminated.

Deliberately *not* built in this pass (raised in discussion, tracked as
follow-up work, not a GitHub issue yet): detecting when an *executed*
AUTO proposal is later manually altered in the FPL app before kickoff
(chip un-activated, lineup edited by hand) — `source` only tags who
*generated* the proposal, not whether what actually happened at kickoff
still matches it. `ResultsService`'s predicted-vs-actual comparison has no
signal for that divergence today; it would need cross-checking the
finished gameweek's real `active_chip`/final picks (already available from
the same public picks endpoint `ResultsService` already calls) against the
stored proposal, and excluding a diverged week from whatever step 5
eventually trains on.

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

**Free Hit tested live via the new `/chip` command 2026-09-08 — still
blocked, and a real success-detection bug found in the process.** Running
`/chip freehit` reported `✅ GW4 applied — Free Hit now live on your FPL
team.`, but a follow-up `/team-state/report` showed `freehit` still
`status_for_entry: 'unavailable'`, `played_by_entry: []` — unchanged from
before. Confirmed via the execution log itself: the optimizer found no
beneficial swaps even with transfers free (`transfers: []`), so
`submitTransfers` was called with `freehit: true` and an empty transfer
list; FPL returned its usual empty-body 200 (no error), but the my-team
state `setLineup` returns straight after still showed the chip never
played. **FPL silently drops a chip flag it won't honor rather than
rejecting the request** — the account genuinely still can't play
Wildcard/Free Hit (consistent with the theory above), but the API gave no
error to catch, so `ExecutionService.apply` reported success anyway. Bank
(4.6) and team value (95.4) were unchanged — nothing harmful happened,
just a false-positive confirmation message.

Fixed same day: `ExecutionService.apply` now verifies a declared chip
actually landed by checking `played_by_entry` (on the my-team state
`setLineup` already returns) includes this team's own id, for *every*
chip — not just the ones that go through `setLineup`'s own `chip` param.
This is the same signal that already confirmed Bench Boost/Triple Captain
live (`played_by_entry: [4]`, see above) generalized to cover
Wildcard/Free Hit's silent-drop failure mode too. When unconfirmed, the
proposal is now marked failed and the Telegram alert says so explicitly
(`...doesn't show the "freehit" chip as actually played afterward — it
may be unavailable for this account right now (check /status)`) instead
of a false "now live". See the regression tests in
`execution.service.spec.ts` (`'reports failure when a declared chip is
not confirmed played afterward'` and the companion test confirming a
non-`'active'` status string still counts as success as long as
`played_by_entry` includes the team).

`POST /proposal/chip` remains the manual "I've decided to play chip X this
week" path — runs the full optimizer with that chip factored in (Wildcard/
Free Hit zero out hit cost, including in the ILP itself, not just the
reported number — see `SquadOptimizerService.optimizeSquad`).
`ChipEvaluatorService` itself is no longer a stub as of 2026-09-08 — see
"Open question: single-strategy optimizer..." below for the same-week
auto-comparison it now does.

**Chip-confirmation false negative found and fixed 2026-09-08 — the
opposite failure mode from the Free Hit case above.** The very first
proposal `generateBestProposal` ever picked (Bench Boost, against the
real disposable test account) was approved and executed, and the Telegram
alert reported `🚨 execution FAILED — ...doesn't show the "bboost" chip as
actually played afterward`. A fresh, independent `/team-state/report`
call moments later showed `bboost: status_for_entry: 'active',
played_by_entry: [4]` — the chip **had** actually landed; bank/team value
had shifted too, confirming the transfers went through as well. Root
cause: the `played_by_entry` check added for the Free Hit bug above reads
straight off `setLineup`'s own response body, in the same request/response
cycle as the call that submits the chip — and FPL's backend doesn't always
finish propagating the chip-active state by the time that response is
built, so the *immediate* response can still show a chip as unplayed even
though it genuinely landed. Not a new bug in this session's chip-
comparison work — `ChipEvaluatorService` picked correctly and submitted
correctly; the false negative was purely in this older verification
logic, just newly exposed because today's feature was the first thing to
trigger a real live chip execution through the auto-comparison path.

Fixed by retrying: if `played_by_entry` doesn't confirm the chip on
`setLineup`'s own response, `ExecutionService.apply` now waits
(`CHIP_CONFIRMATION_RETRY_DELAY_MS`, 2s) and re-checks via a fresh
`getMyTeam` call, up to `CHIP_CONFIRMATION_RETRIES` (3) times, before
concluding it actually failed — only marking the proposal failed if it's
still unconfirmed after every retry. See the regression tests in
`execution.service.spec.ts`: `'reports failure when a declared chip is
still not confirmed after retrying'` (the genuine-failure case, using fake
timers to skip the real delay) and `'retries and confirms success when a
chip that lagged setLineup's own response shows up played on a later
check'` (the false-negative case this was actually fixed for).

**Same false-negative failure mode recurred live, twice, 2026-09-09 — the
6-second retry budget above proved insufficient in practice.** The owner
tested "Approve (with chip)" on a real Bench Boost proposal and got the
same `execution FAILED — ...doesn't show the "bboost" chip as actually
played afterward` alert — but both `/status` and the FPL app confirmed
Bench Boost genuinely was active. Independently re-confirmed live via
`/team-state/report`: `bboost: status_for_entry: 'active', played_by_entry:
[4]`. Same root cause as the 2026-09-08 fix (FPL's propagation lag), just
worse than the `CHIP_CONFIRMATION_RETRIES` (3) × `CHIP_CONFIRMATION_RETRY_DELAY_MS`
(2s) = 6s budget assumed — apparently not a one-off, since this is now the
second real occurrence.

Fixed by widening the budget substantially rather than nudging it: both
constants moved to `config.execution.chipConfirmationRetries`/
`chipConfirmationRetryDelayMs` (`EXECUTION_CHIP_CONFIRMATION_RETRIES`/
`EXECUTION_CHIP_CONFIRMATION_RETRY_DELAY_MS`, same config-driven pattern as
`OPTIMIZER_HIT_RISK_PREMIUM`/`OPTIMIZER_CHIP_RISK_PREMIUM`), defaulting to
8 retries × 5s = 40s, up from 6s. Deliberately generous rather than
precisely tuned: the cost of waiting longer before reporting is low (the
deadline is always hours away), while a false negative causes real
confusion and sends an unnecessary "make this change manually" instruction
— confirmed twice now that erring toward a longer wait is the right
trade-off. See the regression test in `execution.service.spec.ts`:
`'confirms success on a retry beyond the old 3-retry budget'`, which
proves a chip confirming only on the 5th check (beyond what the old
3-retry budget would have caught) still reports success.

**Same false negative recurred a third time, same day, even at the 40s
budget — widened again, and (this time) actually instrumented instead of
guessing at another number.** The owner cancelled Bench Boost via the FPL
app and re-declared it through the bot; independently confirmed via
`/team-state/report` that it genuinely landed (`played_by_entry: [4]`), yet
execution still reported failure. Three real occurrences in two days, each
self-resolving to "it actually worked" when checked afterward, and *zero*
diagnostic trail from any of them — `ExecutionService` had no logger at
all, and the retry loop's own `getMyTeam` rechecks were never persisted
anywhere, only the original `setLineup` response. No way to tell from any
of the first three incidents whether this was "still just slow" or a real,
different bug.

Fixed on two fronts at once: (1) budget widened again to 15 retries × 8s =
120s (`chipConfirmationRetries`/`chipConfirmationRetryDelayMs` defaults in
`configuration.ts`); (2) actual observability added — every attempt (the
initial `setLineup`-response check plus every retry) is now logged via
`ExecutionService`'s new `Logger` (`fly logs` will show each attempt's
confirmed/not-confirmed outcome live) and persisted as
`chipConfirmationAttempts` (`{attempt, confirmed, chips}[]`) on the
execution log's own `responsePayload`, so a 4th occurrence — if the wider
budget still isn't enough — is actually diagnosable from stored data
instead of more guessing. Also softened the Telegram failure message
itself: it now says outright that this specific failure mode has been a
false alarm before and tells the owner to check `/status` before assuming
the worst, rather than flatly asserting the chip is unavailable.

**The instrumentation above found the real bug on the very next occurrence
— it was never timing at all.** A fourth test, same day, still failed even
at the 120s budget. This time the new `chipConfirmationAttempts` logging
(streamed live via `fly logs` while watching the test) showed the actual
contradiction directly: retry 15/15's own recorded data included
`{"name":"bboost","status_for_entry":"active","played_by_entry":[4]}` —
the chip was genuinely active — yet that exact same check still logged
`confirmed=false`. Every one of the first three "false negatives" was
never a timing problem at all; widening the retry budget twice was fixing
nothing.

Root cause: `isChipPlayed` checked `played_by_entry.includes(teamId)` —
but `played_by_entry` is FPL's list of **gameweek/event ids** this chip
was played in (`[4]` meaning "played in gameweek 4"), not a list of
team/entry ids. Confirmed live: this account's real `FPL_TEAM_ID` is
`10594985`, which can never appear in a small list of gameweek numbers —
so this confirmation check was structurally incapable of ever succeeding
for this account, no matter the retry budget or delay. It also explains
why the *initial* `setLineup`-response check (added 2026-09-08 for the
Free Hit bug) "worked" back then: an empty `played_by_entry: []` for a
genuinely-unplayed chip correctly read as unconfirmed either way (`[]`
never contains anything), so the emptiness case masked the wrong
comparison until a genuinely-active chip with a non-empty array was
actually checked against the real (large) team id.

Fixed by comparing against `proposal.gameweekId` instead of `teamId` — the
`/my-team/{teamId}/` response is already scoped to *your* team by the URL
itself, so there was never anything to disambiguate by team id in the
first place; the real question is always "was this chip played in the
gameweek I declared it for." `FplChipStatus.played_by_entry`'s doc comment
(`fpl-auth.types.ts`) corrected to match. Every existing test fixture using
`played_by_entry: [<mocked team id>]` was itself built on the same wrong
assumption (masking this from the test suite exactly like the two bugs
above) — fixed to use the proposal's own `gameweekId` instead, and
verified by temporarily reverting the fix locally: 5 of 17 tests fail (one
genuinely times out) against the old `teamId` comparison, confirming they
actually exercise the real bug now.

The retry budget and logging from the fix above are still worth keeping —
FPL's `setLineup` response genuinely can lag behind a `getMyTeam` recheck
(the original 2026-09-08 Bench Boost finding), just not anywhere near as
often as these four incidents suggested once the real matching bug is
gone.

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

**Same-week half implemented 2026-09-08 — `ChipEvaluatorService` is no
longer a stub.** Comparing "no chip" against every chip available for the
*single upcoming* gameweek (Wildcard/Free Hit/Bench Boost/Triple Captain)
is now real: `evaluateBestStrategy()` fetches predictions once, then runs
`SquadOptimizerService.evaluateStrategy()` (new — the pure, synchronous
half of `optimizeSquad()`, split out specifically so comparing several
candidates doesn't multiply live FPL calls, including the authenticated
my-team endpoint) once per candidate in-memory. Correctly reconstructs
each candidate's *real* expected total — `SquadOptimizationResult
.totalPredictedPoints` is XI-only with the captain counted once, so Bench
Boost (all 15 count) and Triple Captain (captain x3) had zero effect on it
before this; `ChipEvaluatorService.netExpectedPoints()` adds the captain
multiplier (every candidate, not just Triple Captain — plain captaincy
already doubles the captain every week, it's not a chip effect) and Bench
Boost's bench points on top. Candidates are restricted to whatever
`TeamState.chips` reports as `'available'` for the account (already
fetched at every relevant call site for `freeTransfers` — free to wire in,
no new API calls) so a chip the account can't actually play is never
proposed in the first place.
`ProposalService.generateBestProposal()` is the new "decide for me" path
— `DeadlineWatcherService`, `/proposal/generate`, and `/propose` all
switched to it; `generateProposal(freeTransfers, chip)` is untouched and
still backs the explicit-chip manual paths (`/proposal/chip`, `/chip`).
The Telegram alert shows a `📊 Considered: ...` line (all candidates +
their net expected points) whenever more than one was actually compared.

**Real flaw found and fixed same day, live: chips were getting
recommended on almost every proposal.** The owner noticed this
immediately after the feature shipped. Root cause: Bench Boost's
`netExpectedPoints` = *(no chip)* + (sum of bench players' predicted
points), and Triple Captain's = *(no chip)* + (captain's predicted points,
once more) — both bonus terms are essentially always ≥ 0, and nothing in
the model priced in that a chip is a scarce, once-or-twice-a-season
resource. So any available chip would structurally beat "no chip" almost
every week, exactly the "hold value not modeled" gap already flagged as
deferred scope — underestimated how visibly it would actually manifest
(constant recommendations, not just suboptimal timing). Fixed with a
`chipRiskPremium` (config-driven, `OPTIMIZER_CHIP_RISK_PREMIUM`, default
8 — same "internal decision threshold, not a real game rule" pattern as
`OPTIMIZER_HIT_RISK_PREMIUM`): subtracted only from the internal decision
score used to pick `best`, never from the `netExpectedPoints` actually
reported/stored as the proposal's `expectedGain` — a chip now has to
clearly clear a real bar, not just any positive number, to get
recommended. Explicitly **not** true hold-value modeling (that still
needs the multi-gameweek prediction work below) — just a blunt guardrail
against the worst symptom. See the regression tests in
`chip-evaluator.service.spec.ts` (`'does not recommend a chip for a
marginal bonus that only ties the risk premium'` and the companion test
confirming a bonus that clearly exceeds it still wins).

**Three-way approval when a chip is recommended (2026-09-08).** Every
proposal alert used to show only Approve/Reject, even when the winning
plan included a chip — approving meant accepting the whole plan, chip
included, with no way to say "I like the transfer plan, just not the
chip" without rejecting everything and redoing it manually. Now, whenever
`generateBestProposal()`'s winner has a chip, the Telegram alert shows
three buttons instead: **Approve (with chip)**, **Approve (without
chip)**, **Reject**; when no chip is recommended, the flow is unchanged.
Deliberately scoped to the *automatic* recommendation only — the manual
`/proposal/chip` override still gets plain Approve/Reject, since the user
already explicitly chose that chip themselves there.

The mechanism leans on something `ChipEvaluatorService
.evaluateBestStrategy()` already computes and used to just discard: the
chip-free candidate it compared against the winner. `ProposalService
.generateBestProposal()` now persists that alternative as
`Proposal.noChipAlternative` (new nullable `jsonb` column, migration
`AddNoChipAlternativeToProposals`) whenever the winner has a chip — so
it's still there, execution-ready, whenever the Telegram reply actually
arrives (potentially hours later). `ApprovalController` recognizes a new
`approvenochip:<id>` callback action; `ApprovalService.decide()` gained an
optional `{ withoutChip: true }` 4th argument that — before the PENDING →
APPROVED transition — calls `ProposalService.applyNoChipAlternative()` to
swap the alternative's transfers/lineup/captain/etc. into the stored
proposal row and clear `chip`. Because that swap is persisted *before*
`updateStatus`'s own fresh re-read, every downstream consumer
(`ExecutionService.apply`, `sendExecutionResult`, `ResultsService`'s
later predicted-vs-actual report) sees the correct, already-decided plan
automatically — no "chip was declined" flag had to be threaded through
any of them.

One implementation gotcha worth flagging for next time: `decide()`'s new
4th parameter is only actually passed by `ApprovalController` when
`withoutChip` is true — passing an explicit `{withoutChip: undefined}` (or
any 4th argument at all) for plain approve/reject would have broken the
existing tests asserting `decide` was called with exactly 3 arguments,
since Jest's `toHaveBeenCalledWith` treats a trailing explicit `undefined`
as a real 4th argument, not the same as omitting it.

**Real bug found and fixed live, 2026-09-09: "Approve (without chip)" could
still play the chip.** The owner tested it against a real Bench Boost
proposal from `/propose` and got a loud `execution FAILED` alert saying FPL
didn't show `bboost` as played — right after `/status` had just confirmed
Bench Boost was genuinely available. Root cause, confirmed by directly
reproducing it against real local Postgres (not just reasoning about it):
`applyNoChipAlternative` cleared the chip by setting `chip: undefined` on
the entity before `save()` — but `Repository.save()` silently *ignores* an
`undefined` property rather than clearing the column (this is standard
TypeORM/Postgres behavior: `undefined` means "not specified, leave the
existing value," only an explicit `null` clears a nullable column). So the
DB kept the original with-chip proposal's `chip = 'bboost'` untouched, the
in-memory return value *looked* correct (JS doesn't distinguish a key set
to `undefined` from one that's genuinely gone), and `ExecutionService.apply`
read the stale value back and tried to declare Bench Boost for real —
directly against the owner's explicit choice. It only surfaced as a loud
failure rather than a silent wrong chip play because FPL itself never
confirmed the chip as played (the same `played_by_entry` check built for
the Free Hit silent-drop bug, above) — confirmed after the fact via
`/status` that Bench Boost genuinely never got played on the account, so no
real harm was done, but the *attempt* itself was the actual bug.

Every other nullable column on `ProposalEntity` (`appliedManually`,
`resultReportedAt`, `noChipAlternative`) was already correctly typed
`| null`; `chip` was the one column that got missed when the entity was
written, which is exactly why this went unnoticed until an actual
with-chip-then-cleared round trip was tested live. Fixed by widening
`ProposalEntity.chip` to `FplChip | null | undefined` (entity now
`implements Omit<Proposal, 'chip'>` rather than the full `Proposal`, since
the domain interface's `chip?: FplChip` stays `undefined`-only on purpose),
setting `chip: null` (not `undefined`) in `applyNoChipAlternative`, and
adding `ProposalService.toDomain()` — a private normalizer
(`chip: entity.chip ?? undefined`) applied at every method that hands a
repository read back to a caller — so nothing outside `ProposalService`
ever has to know about the null/undefined distinction; every other
module's existing `proposal.chip !== undefined` check (`ExecutionService`,
`AlertService`, etc.) keeps meaning exactly "no chip" without modification.

This also fixed a second, latent bug the same root cause implied but the
owner hadn't hit yet: TypeORM returns `null` (not `undefined`) for *any*
genuinely chip-free proposal read back from Postgres, not just ones that
went through `applyNoChipAlternative` — so `ExecutionService.apply`'s
`proposal.chip !== undefined` guard was `true` for `null` too, meaning
*every* approved chip-free proposal that had gone through a real DB round
trip via `ApprovalService`/`updateStatus` would have entered the
chip-confirmation retry block searching for a chip literally named `"null"`,
burned `CHIP_CONFIRMATION_RETRIES` × `CHIP_CONFIRMATION_RETRY_DELAY_MS` (6s)
retrying, and then falsely reported execution as failed — confirmed by
directly calling `ExecutionService.apply()` with a `chip: null` proposal
(mirroring a real DB read) before the fix landed. `toDomain()` fixes this
the same way, for free.

The existing unit tests never caught either bug: `proposal.service.spec.ts`'s
`FakeProposalRepository.save()` used to just overwrite the whole stored row
with whatever JS object was passed, including an explicit `chip: undefined`
key, as if it genuinely cleared the column — nothing like real
Postgres/TypeORM's "undefined is ignored" behavior. Fixed alongside the bug
(`withoutUndefined()` helper in the fake's `save()`, merging only
non-undefined properties onto the existing row) so this class of bug is
actually catchable going forward, plus a dedicated regression test that
does a *separate* re-read (`findById`, not just the mutated return value)
after `applyNoChipAlternative` — confirmed this fails without the real fix
(reverted `chip: null` back to `chip: undefined` locally to check) and
passes with it. See `proposal.service.spec.ts`'s `'actually persists the
cleared chip, not just on the return value'` test.

**Live-testing the above surfaced a real prediction-calibration problem —
not a bug, a modeling issue (2026-09-08).** The first real chip proposal
generated after this feature shipped reported `expectedGain: 175.47`
(Bench Boost) / `143.98` (the persisted no-chip alternative) — implausible
for a single gameweek; a genuinely elite live captain haul tops out around
20-24 points, let alone a whole-squad average outcome. Verified this
wasn't an arithmetic bug: hand-recomputing `HeuristicStrategy`'s exact
formula against live `bootstrap-static` data for the real 11-man lineup +
bench reproduced `175.47`/`143.98` to the cent — the code does exactly
what it's defined to do. The problem is the definition itself, three
things compounding:
1. FPL's own `form` field (recent average points/match) can already sit
   at 8-9+ for an early-season player on a small-sample hot streak — close
   to a season-best return, not a typical one, before any bonus is added.
2. The underlying-stats bonus (xG/xA) and defensive-contribution bonus
   both add on top of `form`, but a player with elevated `form` right now
   is often elevated *because of* those same good underlying/defensive
   numbers — double-counting the same "this player's been great" signal
   rather than correcting for luck, which was the xG bonus's original
   intent.
3. The fixture multiplier (up to 1.67× for the easiest fixtures) is
   multiplicative on top of that already-inflated base, amplifying any
   overestimate from (1)/(2) rather than gently adjusting it.
   `HeuristicStrategy.score()`, live example (Gakpo, the captain in this
   proposal): `(form 9.3 + underlying 1.12 + dc 1.5) × fixtureMult 1.33 =
   15.9` predicted points for one gameweek, on its own.

Directly undermines `chipRiskPremium` as a guardrail: an 8-point bar is
trivial to clear when the underlying numbers are inflated by this much,
so the guardrail added earlier today is weaker in practice than its
design intended. This is the "hand-tuned linear heuristic... weights are
reasonable guesses, not backtested" risk called out in
`HeuristicStrategy`'s own header comment, no longer theoretical — a
concrete, live demonstration of why every chip/hit/timing guardrail built
on top of this model is only as trustworthy as the model itself, which
remains unvalidated. Deliberately not patched with another guessed
constant (e.g. capping a player's predicted points at some ceiling) —
that repeats the same mistake with a different number. Real fix is the
same backtesting prerequisite already on record elsewhere in this file
(`ResultsService` reaching a half-season of predicted-vs-actual history)
before touching these weights with any confidence.

**Still not started — the genuinely hard part**: timing/hold value
(comparing this week's Wildcard against holding for a better week) and
`TrendsModule` integration. Investigated live while scoping the above:
this is a real code gap, not a missing-data one —
`PredictionService.predictGameweek()` is hardcoded to whichever gameweek
`bootstrap-static` marks `isNext`, with no path to request a future one.
FPL's own `element-summary/{id}/` (already called by
`FplPublicClient.elementSummary()`) already returns **every remaining
fixture for the season** (confirmed live: 35, not just 3) with
per-fixture `event`/`difficulty`, so fixture-swing awareness and
double-gameweek detection (two fixtures sharing an `event` for one team)
don't need a new data source either — just a multi-gameweek prediction
loop, which is real engineering work, not blocked on anything external.

**`chipRiskPremium` is a guardrail against the worst symptom, not a fix —
raised, discussed, deliberately not acted on yet (2026-09-08).**
Wildcard/Free Hit weren't live-tested (this account's still show
`unavailable` — no completed-gameweek picks history yet), but the same
"no hold-value modeling" gap almost certainly hits them too, via a
different mechanism than Bench Boost/Triple Captain's bonus terms:
`chipCoversTransferCost` gives them an unconstrained, zero-hit-cost full
squad rebuild against all ~700 players, so their `netExpectedPoints` is
*structurally* >= "no chip"'s (the solver could always just replicate the
constrained squad if nothing better existed) and, unlike a bonus capped
by a few specific players' scores, the potential gain from a full rebuild
is effectively unbounded — likely to clear the flat 8-pt premium even
more readily than Bench Boost/Triple Captain do. Revisit raising the
premium specifically for these two once they're actually observable
against a real squad (not yet possible on this account).

**The real fix, discussed but not started: multi-gameweek lookahead with
a rolling-max comparison.** Predict the next N gameweeks (5-8, say)
instead of just the next one — buildable now per the fixture-data finding
above, no external source needed — and only recommend playing a chip
*this* week if it's at or near the best opportunity across that window,
otherwise hold. Turns the current flat point-threshold guardrail into an
actual timing decision (including spotting an upcoming double gameweek
worth waiting for).

**When to actually build it: gated on a data checkpoint, not a calendar
date or "whenever there's time."** A lookahead model is only as good as
the single-week predictions it's built on, and those are still "reasonable
guesses, not backtested" (`HeuristicStrategy`'s own header comment). Right
time is once `ResultsService`'s predicted-vs-actual history covers
roughly half a season (~15-19 gameweeks — the same threshold reasoned out
for step 5 generally), enough to know whether the underlying predictions
are even directionally trustworthy. Building the lookahead architecture
before that just stacks a more confident-looking decision on an
unvalidated foundation — worse than today's blunt guardrail, not better.
One option to shorten the wait: the multi-gameweek prediction *plumbing*
itself isn't data-blocked, only its *trustworthiness* is — could build it
earlier and run it in a log-only/shadow mode (compute what it would
recommend, don't act on it yet) until the backtesting checkpoint
validates it, the same idea `ResultsModule` already applies to tracking
overall prediction accuracy without gating anything on it.

Tracked as [issue #4](https://github.com/buka4rill/fpl-bot/issues/4)
(filed 2026-09-09), sequenced after
[#3](https://github.com/buka4rill/fpl-bot/issues/3)'s weight
recalibration — see "Currently at" under "Build order" below for the
concrete calendar projection of when that checkpoint actually lands.

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

## Telegram slash commands (2026-09-08, implemented)

The Telegram webhook (`ApprovalController`'s single `/approval/telegram-callback`
route — Telegram posts every update type there, button taps and plain
messages alike) previously only ever handled `callback_query` updates; a
typed message like `/status` was silently ignored — received, acknowledged
with a bare `{ok:true}`, nothing done. Fixed by also handling `message`
updates whose text starts with `/`, routed (after the same
`assertConfiguredChat` check callback_query already used) to a new
`TelegramCommandsService` (`src/telegram-commands/`):

- **`/status`** — same as `POST /team-state/report`: live free transfers +
  chip availability for the upcoming gameweek.
- **`/propose`** — same as `POST /proposal/generate`: runs the real
  optimizer-driven flow right now instead of waiting for the scheduler's
  lead-time window.
- **`/login`** — reports whether the FPL session is currently
  authenticated. Deliberately **status-only, never attempts an actual
  login** — the real login step stays unscripted on purpose (DataDome,
  see "Execution auth" below), so this just tells you to run
  `pnpm run auth:login` locally if you're logged out, the same as every
  other manual endpoint's `assertAuthenticated()` message already does.
- **`/help`** / **`/start`** — lists the commands. Unknown commands get
  the same list appended, so a typo is never a silent no-op either.

**`/chip <wildcard|freehit|bboost|3xc>`** and **`/results`** (added
2026-09-08, later same day) — same "cover every manual HTTP endpoint
worth having on demand" motivation as the original four, prompted by
auditing all controllers against the command list and finding these two
gaps (`captain-swap`/`manual-transfer`/`chip-manual` were deliberately
left out — those are testing scaffolding built to verify execution auth
against the disposable account, not ongoing product features; see
"Execution auth" above).

- **`/chip <name>`** — same as `POST /proposal/chip`: declares a chip and
  runs it through the real optimizer (transfers included), not a
  squad-unchanged shortcut. The chip name is the raw `FplChip` enum value
  (`wildcard`/`freehit`/`bboost`/`3xc`) — the same string the HTTP body
  already expects, so there's only one contract to remember rather than a
  second set of chat aliases. Case-insensitive; missing or unrecognized
  names get a `Usage: /chip <...>` reply instead of silently doing
  nothing.
- **`/results`** — same check `ResultsService`'s hourly poll runs
  (`POST /results/report`), triggered on demand instead of waiting for
  it. `ResultsService.checkFinishedGameweeks()` now returns how many
  proposals it actually reported on (previously `void`) specifically so
  this command (and the HTTP endpoint, now `{checked, reported}`) can say
  "no new finished-gameweek results yet" explicitly rather than going
  quiet when there's nothing to report — the same no-silent-no-op
  principle the rest of this feature was built around. When there *is*
  something to report, `checkFinishedGameweeks()` already sends its own
  `📊 GW{n} Result` message per proposal, so the command adds nothing on
  top of that.

`ResultsModule` now exports `ResultsService` (previously provider-only)
so `TelegramCommandsModule` can inject it — no other change to
`ResultsModule` itself; the hourly poll (`onModuleInit`'s `setInterval`)
is unaffected.

Every command is best-effort and self-reporting: any failure inside
`TelegramCommandsService.handleCommand` is caught and sent back over
Telegram with the underlying error's own message, rather than the command
just silently doing nothing (the exact complaint that prompted building
this — verified live: a stale-session `/status` call correctly reported
`⚠️ /status failed: ... invalid_grant ...` instead of going quiet).
`TelegramAdapter` also registers the command list with Telegram itself
(`setMyCommands`, on module init, best-effort) so they show up in the `/`
autocomplete menu in the chat.

**Live-testing this surfaced a real operational gotcha, not a bug in the
feature itself:** dev and the deployed prod instance currently share one
FPL account (see "Decided 2026-09-08: prod stays on the disposable test
account" above), and FPL allows only one active session per account. A
`pnpm run auth:login` run pushes to whichever URL `AUTH_TARGET_URL`
currently points at (prod, after the deploy work) — so re-authenticating
one environment silently invalidates the other's session; they can't both
stay logged in at once as long as they share an account. Confirmed live:
running `auth:login` fixed prod but left dev's session exactly as stale as
before, still failing `/status` there with `invalid_grant`. **Decided
2026-09-08: leave dev stale for now** rather than fix it (which would just
re-break prod) — prod is what actually matters day to day. Revisit giving
dev its own separate disposable FPL account (mirroring the Telegram bot
split) if this ping-pong becomes a real problem.

**`/propose` immediately surfaced a second, real bug — fixed same day, not
specific to the command itself.** `PredictionService.predictGameweek()`
read the current squad via `IngestionService.getCurrentSquad()`, the
*public* entry/picks endpoint — the exact same 404 already documented
under "Execution auth" for `manual-transfer`/`captain-swap`/`chip-manual`
(this account's `entry.current_event` points at a gameweek it has no
saved public picks history for). Since `/propose` mirrors the real
optimizer-driven `POST /proposal/generate` flow, this meant the bug wasn't
command-specific — it silently threatened the **automatic weekly
proposal flow** too, for any account in this state. Fixed by adding
`ExecutionService.getCurrentSquad(teamId, gameweekId)` (authenticated
my-team endpoint, same source `manual-transfer`/`captain-swap`/
`chip-manual` already use successfully) and switching
`PredictionService` to it — `PredictionModule` now depends on
`ExecutionModule`, a real dependency addition, not just a call-site swap.
Deliberately not a new practical auth requirement: every real caller of
`predictGameweek()`/`generateProposal()` (`DeadlineWatcherService`,
`ProposalController`, `TelegramCommandsService`) already asserts
authentication before reaching this code. `IngestionService.getCurrentSquad()`
itself is untouched and still has a real, distinct use — reading *any*
team's public squad without needing to be authenticated as them, which
the authenticated path can't do.

**That fix immediately exposed a second, more serious bug — fixed same
day.** With `/propose`'s real optimizer path finally reaching a live
transfer submission for the first time (every transfer tested before this
was a single hand-specified pair via `/proposal/manual-transfer`, which
never exercised the optimizer's own transfer-list construction at all),
FPL's real `/api/transfers/` rejected the batch outright: `"Element in
and element out must be of the same type"`. Root cause:
`SquadOptimizerService.deriveTransfers()` paired sold/bought players
purely by **array index** — `playersOut.map((playerOutId, i) => ({
playerOutId, playerInId: playersIn[i] }))` — with no regard for whether
the two players were even the same position. It happened to produce
correct pairs in every existing test fixture (sold/bought lists were
coincidentally in matching order), which is exactly why this had never
been caught. Confirmed via `bank`/`teamValue` unchanged before/after that
FPL rejected the *entire* batch atomically — nothing was actually applied
to the account. Fixed by grouping both lists by position first and
pairing within each group (squad-position counts are fixed by
`SquadRules`, so for every position exactly as many players leave as
arrive) — see the regression test in `squad-optimizer.service.spec.ts`
that deliberately reorders the fixture to break the "coincidentally
matching order" case the bug was hiding behind. **Verified live 2026-09-08,
same day, after deploying the fix**: re-ran `/propose` → Telegram approve
against prod (`fpl-bot-buka4rill`, disposable test account) — the same
9-transfer batch that previously failed atomically now applied
successfully end-to-end (`✅ GW4 applied — 9 transfers now live`).

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

## Divergence detection (2026-09-09, implemented)

Raised while investigating a live chip-confirmation incident (see
"Chip-confirmation" fixes above): the post-gameweek results report treats
every APPROVED proposal's predicted-vs-actual comparison as a clean
model-accuracy check, but that's only true if what got executed is still
what was actually live at kickoff. If the owner cancels a chip or edits
the lineup in the FPL app *after* approval — something the bot has no way
of knowing about, since it never re-checks a proposal once executed — the
"actual" score reflects that later edit, not the model's plan, and the
comparison silently misattributes the difference to the model being wrong.

Fixed by cross-checking the real picks endpoint once a gameweek finishes,
same idea as the `appliedManually` check-in but automatic and evidence-based
rather than asked for. `IngestionService.getGameweekResult` (already
fetching `EntryPicksResponse` for `entry_history.points`) now also returns
`activeChip`/`captainId`/`startingXI`, normalized from the picks list —
`RawPick` (`fpl-api.types.ts`) was widened from just
`element`/`element_type` to also capture `position`/`multiplier`/
`is_captain`/`is_vice_captain`, the same fields the authenticated
`FplPick` already has (standard on FPL's public picks endpoint too, just
never typed since nothing needed them before). New pure function
`detectDivergence` (`gameweek-scoring.util.ts`, tested directly like
`computeProposalActualScore`) compares a proposal's `chip`/`captainId`/
`lineup` against that real outcome and returns which specific fields
differ, if any — deliberately scoped to chip/captain/starting-XI
membership only, not bench order or vice-captain (those don't change the
actual score the way a swapped captain or dropped chip does).

`ResultsService.reportResult` only calls this for `status: APPROVED` —
REJECTED/EXPIRED never had anything of the bot's own live at kickoff to
diverge from, so the check would be meaningless (and always "diverged")
for them. When it fires and finds a mismatch, `AlertService.sendResultReport`
shows the specific reasons instead of presenting the predicted-vs-actual
delta as a clean comparison (`⚠️ Something changed after I applied this —
not a fair model comparison:` followed by each reason), and the result is
persisted as `Proposal.divergedFromPlan` (new nullable boolean column,
migration `AddDivergedFromPlanToProposals...`, set via
`ProposalService.markResultReported`'s new second argument) so step 5's
eventual backtesting can exclude a diverged gameweek without recomputing
the comparison — the SQL in "Step 5's data checkpoint" above should filter
`divergedFromPlan IS NOT TRUE` alongside `source = 'AUTO'` once this has
had time to actually flag something live.

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

**CD** (`.github/workflows/deploy.yml`): auto-deploys after a green CI run
on `main` (2026-09-08, was `workflow_dispatch`-only before this — see
below for why auto-deploy is now safe), plus `workflow_dispatch` still
there for a manual re-run. `FLY_API_TOKEN` is already set as a GitHub repo
secret — `fly launch` did this automatically (detected the GitHub remote
and pushed it via `gh`) as part of the first launch below, not something
that needed doing by hand.

**Deploy is gated on CI via `workflow_run`, not a second `push` trigger
(fixed same day, caught live).** The first version of this triggered
`deploy.yml` on `push: branches: [main]` directly, same as `ci.yml` —
looked fine, but the two workflows then run fully in parallel with no
ordering guarantee, so a commit that fails CI could still finish deploying
before its own CI failure even shows up (observed live: Deploy completing
before Test on the same push). Branch protection's required "test" status
check doesn't help here — it only gates merging a PR, not a direct push,
which is exactly the auto-deploy path. Fixed by switching the trigger to
`workflow_run` on the `CI` workflow (`types: [completed]`, `branches:
[main]`), with the job itself gated on `github.event.workflow_run.conclusion
== 'success'` (manual `workflow_dispatch` still bypasses this gate, same
as before — it's an explicit "deploy this known-good commit now"). The
checkout step pins `ref: github.event.workflow_run.head_sha` rather than
just `github.ref`, so it deploys the exact commit CI validated, not
whatever happens to be newest on `main` by the time the Deploy job starts.

**Branch protection on `main` (2026-09-08)** is what makes auto-deploy on
push safe, given the repo is **public**: a bad deploy here means an
autonomous bot pushing bad changes to a real FPL account, not just a
broken staging site, so "anyone can open a PR" must never be able to turn
into "anyone can get it deployed." Public visibility alone does **not**
grant push access — before this, `buka4rill` was already the only
collaborator with write access, confirmed live via the GitHub API — but
branch protection makes that structural rather than incidental (holds even
if a collaborator is ever added later): `main` now requires a pull request
with at least 1 approval before merging (stale approvals dismissed on new
commits), requires the CI `test` check to pass, and blocks force-pushes/
deletions — with **"enforce for administrators" left off**, so
`buka4rill` (the repo admin) can still push straight to `main` without
going through a PR, while anyone else must go through an approved PR.
`ci.yml` itself was already safe for this — it triggers on plain
`pull_request` (not `pull_request_target`), so a fork's PR never gets
repo secrets, checked as part of the same pass.

**Correction, same day: "1 approval" alone doesn't mean *your* approval —
and there's no way to force that on a personal repo.** The 1-approval rule
above is satisfied by an approving review from *anyone* with read access,
which on a public repo means any GitHub account — not specifically
`buka4rill`. First fix tried: a `.github/CODEOWNERS` file (`* @buka4rill`)
plus `require_code_owner_reviews: true`, which does correctly force the
counted approval to be the owner's (verified live with a real throwaway
PR — GitHub reported it `BLOCKED`/`REVIEW_REQUIRED`, and as a nice side
effect GitHub won't let a PR's own author approve their own PR, so this
only ever gates *other* people's PRs). **Reverted the same day** —
decided instead that anyone should be able to *approve* a PR, with
merging itself the thing restricted to the owner. The natural mechanism
for that is branch protection's `restrictions` (push restrictions,
which also gate merging since a merge is a push under the hood) — but
the API rejected it outright: `"Only organization repositories can have
users and team restrictions"`. **This repo is a personal-account repo,
not an organization-owned one, so per-user push restrictions don't exist
here at all** — not a config mistake, a real GitHub plan/ownership-tier
limitation. `require_code_owner_reviews` is back to `false`
(`required_approving_review_count: 1` stays, satisfied by any approver);
`CODEOWNERS` is kept (harmless, still auto-requests `buka4rill` as
reviewer on every PR) but is no longer an enforcement mechanism. What
actually guarantees "only I can merge" now is plain **collaborator
permissions** — `buka4rill` is the sole collaborator with write access
(confirmed live via the API), and merging has always required write
access regardless of branch protection. That holds today but isn't
*structural* the way the CODEOWNERS approach was — if a collaborator is
ever added at Write+ level, they could approve their own PR (no code-owner
gate) and merge it themselves. Revisit then: either grant future
collaborators only Read/Triage (never Write), or move the repo into a
free GitHub organization, where `restrictions` becomes available again.

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

**`flyctl` on `PATH` gotcha (2026-09-09) — separate from the `fly launch`
gotcha above, hit when checking prod's DB weeks after the initial setup.**
The Windows install script (`iwr https://fly.io/install.ps1 -useb | iex`)
installs the binary to `~/.fly/bin/flyctl.exe` and adds it to the user
`PATH` env var, but that only takes effect in shells opened *after* the
install — a terminal (or an agent's shell) that was already open, or a
different shell type than whichever one the installer updated, still gets
`command not found` even though `flyctl` is genuinely installed. Fix:
either open a brand-new terminal, or call it by full path directly
(`"$HOME/.fly/bin/flyctl" postgres connect -a fpl-bot-buka4rill-db`).

**`fly postgres connect` drops you into the `postgres` database, not the
app's own one (2026-09-09).** Querying `proposals`/`player_snapshots`
directly after connecting fails with `relation "..." does not exist` until
you run `\l` to list databases and `\c fpl_bot_buka4rill` (the name `fly
postgres attach` actually created) to switch into the right one first.
Worth remembering any time this gets used to check real backtesting
progress (see the step-5 data-checkpoint note above) — see README's
"Production (Fly.io)" section for the exact commands.

## Build order (ARCHITECTURE.md §11)

1. ✅ Ingestion + prediction + optimization, recommend-only
2. ✅ Approval state machine + alert loop
3. ✅ Execution for lineup/captain only — verified live end-to-end
4. ✅ Extend execution to transfers + chips — built 2026-09-08; transfers,
   Bench Boost, and Triple Captain all verified live the same day against a
   disposable test account (see "Execution auth" above), fixing two real
   transfer bugs and resolving the Triple Captain multiplier question the
   community-derived contract had left open. The optimizer's own
   transfer-list construction (as opposed to hand-specified pairs) was
   verified separately, same day, once `/propose`'s real optimizer path
   first reached a live submission and hit the position-pairing bug above
   — re-verified live after the fix (see "Transfer-hit policy"/`deriveTransfers`
   above). Only Wildcard/Free Hit remain unverified
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

**Open work tracked as GitHub issues (filed 2026-09-09)**, replacing prose
as the source of truth for "what's next" now that the list is long enough
to need real tracking:
[#2](https://github.com/buka4rill/fpl-bot/issues/2) Wildcard/Free Hit
verification (near-term, actionable once GW4's saved squad exists),
[#3](https://github.com/buka4rill/fpl-bot/issues/3) backtest/recalibrate
`HeuristicStrategy` weights (step 5 itself),
[#4](https://github.com/buka4rill/fpl-bot/issues/4) multi-gameweek chip
hold-value lookahead,
[#5](https://github.com/buka4rill/fpl-bot/issues/5) `StatsProviderClient`
(Elo/xGOT),
[#6](https://github.com/buka4rill/fpl-bot/issues/6) `TrendsModule`
consumption,
[#7](https://github.com/buka4rill/fpl-bot/issues/7) revisit
auto-execution-vs-notification-only with real prod data. #3-#6 are
sequenced (#4/#5/#6 depend on #3 landing first) — see each issue's own
timeline section for reasoning, not duplicated here.

**Step 5's data checkpoint now has a concrete calendar projection, not just
"half a season" (2026-09-09).** Checked live: prod only began generating
real automated proposals from GW4 onward (deploy day, 2026-09-08); GW4
itself is contaminated as backtesting data (all ~10 of its `proposals` rows
were same-day manual execution tests — real transfers/chips applied and
reverted repeatedly against the live account, not one clean weekly
decision). Cross-checked against the real 2026/27 fixture calendar: the
15-19-gameweek threshold lands on GW20-24, whose deadlines fall 2027-01-06
to 2027-01-30 — so realistically **not before January 2027, more likely
January-February 2027**. Verify the real count periodically rather than
trusting this projection as it ages:
```sql
SELECT count(DISTINCT (season, "gameweekId")) FROM proposals
WHERE "resultReportedAt" IS NOT NULL AND source = 'AUTO'
  AND "divergedFromPlan" IS NOT TRUE;
```
(the `source = 'AUTO'` filter is the AUTO/MANUAL tagging fix above,
2026-09-09 — without it this count still includes GW4's contaminated rows;
`"divergedFromPlan" IS NOT TRUE` is the divergence-detection fix, same
day — excludes a gameweek where the owner edited the plan in the FPL app
after approval, since that week's predicted-vs-actual comparison isn't a
fair model check)
run via `fly postgres connect -a fpl-bot-buka4rill-db` (see README's
"Production (Fly.io)" section for the connection gotchas — it drops you
into the `postgres` database, not the app's `fpl_bot_buka4rill` one, and
`flyctl` may not be on `PATH` in every shell even once installed).

Note that GW4 is no longer permanently excluded the way it was before the
AUTO/MANUAL fix: its manual-testing rows can no longer block the
scheduler's own dedupe check (that check is now scoped to `source: AUTO`),
so `DeadlineWatcherService` will propose for GW4 normally once its own
trigger window opens (deadline 2026-09-12T12:30 UTC, so the window opens
2026-09-11T12:30 UTC) — it just won't count toward the *clean* history
above, since by then the account's actual squad already reflects that
testing.

## Open question: keep auto-execution, or go notification-only? (deferred, not decided)

Raised 2026-09-07, right after step 3 shipped. **Decided 2026-09-08: keep
auto-execution for now** — step 4 (transfers + chips) was built rather than
skipped. This isn't a final "no" to notification-only, though: the plan is
to stress-test the FPL auth story for real once the bot runs on a cloud
server (see the deploy TODO below — not started yet), and revisit this
question with that real data in hand, rather than deciding on a hunch now.
Tracked as [issue #7](https://github.com/buka4rill/fpl-bot/issues/7)
(filed 2026-09-09) — no fixed revisit date, evidence-based.

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
