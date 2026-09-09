import { FplChip } from '../enums/chip.enum';
import { ProposalStatus } from '../enums/proposal-status.enum';
import { Position } from '../enums/position.enum';
import { TriggerSource } from '../enums/trigger-source.enum';

// Plain interfaces standing in for the ARCHITECTURE.md §6 schema sketch.
// Promote these to ORM entities once a persistence layer is chosen.

export interface Gameweek {
  id: number; // resets to 1 each season — only unique combined with `season`
  deadlineAt: string; // ISO timestamp, always read from bootstrap-static
  isCurrent: boolean;
  isNext: boolean;
  finished: boolean;
  // "YY_YY" (e.g. "26_27") — bootstrap-static has no season field, so this
  // is derived from `deadlineAt` (see season.util.ts). Exists so storage
  // keyed on gameweek identity doesn't collide across a season rollover.
  season: string;
}

export interface Team {
  id: number;
  name: string;
  shortName: string;
}

// Static player identity — team/position rarely change mid-season.
// Price, form, and other time-varying stats live on PlayerSnapshot instead.
export interface Player {
  id: number;
  webName: string;
  fullName: string;
  teamId: number;
  position: Position;
}

export interface Fixture {
  id: number;
  gameweekId: number | null; // null when not yet scheduled (blank gameweek)
  homeTeamId: number;
  awayTeamId: number;
  kickoffAt: string | null; // ISO timestamp, null until scheduled
  finished: boolean;
  homeDifficulty: number;
  awayDifficulty: number;
}

export interface PlayerSnapshot {
  gameweekId: number;
  playerId: number;
  price: number;
  ownershipPct: number;
  predictedPoints?: number;
  form?: number;
  xg?: number;
  xa?: number;
  minutesPlayed?: number;
  // FPL status code: 'a' available, 'd' doubtful, 'i' injured, 's' suspended,
  // 'u' unavailable.
  status?: string;
  // 0-100, null/undefined means no fitness doubt reported.
  chanceOfPlayingNextRound?: number | null;
  // 1 (easiest) to 5 (hardest). Filled in by PredictionService from ingested
  // fixtures — absent on the snapshot as returned by IngestionService itself.
  nextFixtureDifficulty?: number;
  // Static identity, duplicated here (not just on Player) so backtesting
  // history is self-contained without a join back to the players table.
  position?: Position;
  // Season-cumulative CBIT/CBIRT count, straight from FPL — see
  // HeuristicStrategy for how the position-specific threshold is applied.
  defensiveContribution?: number;
}

export interface PositionRules {
  position: Position;
  squadCount: number; // required count in the 15-man squad
  minStarting: number; // min allowed in the starting XI
  maxStarting: number; // max allowed in the starting XI
}

// Squad-selection rules, read from bootstrap-static's game_settings and
// element_types rather than hardcoded — same principle as never hardcoding
// a deadline, since FPL exposes these dynamically too.
export interface SquadRules {
  squadSize: number; // total squad, e.g. 15
  startingSize: number; // starting XI, e.g. 11
  maxPerClub: number; // e.g. 3
  budget: number; // £m, e.g. 100.0
  positions: PositionRules[];
}

// Your currently-owned squad, from the public entry/picks endpoints — no
// login needed. `freeTransfers` is deliberately absent: the public API
// doesn't expose your accumulated free-transfer count (that needs the
// authenticated my-team endpoint, or reconstructing it from transfer
// history across every gameweek since the last wildcard/reset). Callers
// that need it must supply it themselves.
export interface CurrentSquad {
  teamId: number;
  gameweekId: number; // the gameweek this snapshot reflects (entry.current_event)
  playerIds: number[]; // 15 owned player IDs
  bank: number; // £m
  teamValue: number; // £m — total squad value per FPL's own accounting
  activeChip?: FplChip;
}

export interface TransferPlan {
  playerOutId: number;
  playerInId: number;
}

// The chip-free plan ChipEvaluatorService already computed and discarded
// while picking the winning candidate — persisted here so "Approve
// (without chip)" has something real to execute, potentially hours after
// the proposal was generated. Only ever set when the winning proposal
// itself has a chip.
export interface NoChipAlternative {
  transfers: TransferPlan[];
  lineup: number[];
  benchGoalkeeperId: number;
  benchOutfieldIds: number[];
  captainId: number;
  viceCaptainId: number;
  expectedGain: number;
  hitCost: number;
}

export interface Proposal {
  id: string;
  gameweekId: number; // resets to 1 each season — only unique combined with `season`
  season: string; // see Gameweek.season — required for a season-safe dedupe lookup
  deadlineAt: string; // ISO timestamp — the gameweek deadline this must be actioned before
  transfers: TransferPlan[];
  lineup: number[]; // starting XI player IDs
  benchGoalkeeperId: number;
  benchOutfieldIds: number[]; // ordered by predicted points desc
  captainId: number;
  viceCaptainId: number;
  chip?: FplChip;
  expectedGain: number;
  hitCost: number;
  status: ProposalStatus;
  createdAt: string;
  // AUTO (the scheduler's own hourly poll) or MANUAL (any on-demand
  // trigger — /propose, /chip, or a testing endpoint). Only AUTO proposals
  // count as real backtesting signal or block the scheduler's own dedupe
  // check — see TriggerSource's doc comment.
  source: TriggerSource;
  // Only meaningful once status is EXPIRED — null/undefined otherwise (never
  // asked). Answered via a post-deadline Telegram Yes/No check-in purely to
  // label the outcome for future backtesting (step 5); it never gates or
  // re-triggers execution, and a REJECTED/APPROVED proposal's outcome is
  // already known without asking.
  appliedManually?: boolean | null;
  // Set once ResultsService has sent the post-gameweek points report for
  // this proposal — a one-time-send guard, same idea as the dedupe on
  // proposal generation itself. Null/undefined until then.
  resultReportedAt?: string | null;
  // See NoChipAlternative — only set when this proposal's own `chip` is
  // set, so the Telegram alert can offer "Approve (without chip)" as a
  // real, execution-ready third option.
  noChipAlternative?: NoChipAlternative | null;
}

// Actual per-player performance for a single finished gameweek, from the
// live-gameweek endpoint — normalized here (rather than left as
// LiveGameweekResponse) once ResultsService became the first real consumer.
// `played` (not just `minutes > 0`) mirrors FPL's own autosub eligibility
// signal directly rather than re-deriving it.
export interface PlayerGameweekStats {
  playerId: number;
  totalPoints: number;
  minutes: number;
  played: boolean;
}

export interface Approval {
  proposalId: string;
  decidedBy: string;
  decision: ProposalStatus.APPROVED | ProposalStatus.REJECTED;
  decidedAt: string;
}

export interface ExecutionLog {
  proposalId: string;
  requestPayload: unknown;
  responsePayload: unknown;
  appliedAt: string;
  success: boolean;
}
