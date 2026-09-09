// Who caused a Proposal/PlayerSnapshot row to be created — the scheduler's
// own hourly poll (AUTO) vs. any manual trigger: a controller endpoint, a
// Telegram command, a one-off testing call (MANUAL). Only DeadlineWatcherService
// passes AUTO; every other call site defaults to MANUAL.
//
// This exists because manual triggers have no dedupe — /propose, /chip, and
// the testing-scaffolding endpoints (captain-swap/manual-transfer/chip-manual)
// are meant to be runnable on demand, any number of times, for the same
// gameweek. Without this tag, that repeated use is indistinguishable from a
// real weekly decision once it lands in proposals/player_snapshots — exactly
// what happened to GW4 on 2026-09-08 (~10 manual execution-testing rows
// blocked the scheduler's own dedupe check from ever proposing for that
// gameweek). AUTO is the only source safe to treat as backtesting signal
// (step 5) or to gate the scheduler's "already proposed this gameweek" check.
export enum TriggerSource {
  AUTO = 'AUTO',
  MANUAL = 'MANUAL',
}
