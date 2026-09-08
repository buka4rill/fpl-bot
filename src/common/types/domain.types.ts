import { FplChip } from '../enums/chip.enum';
import { ProposalStatus } from '../enums/proposal-status.enum';
import { Position } from '../enums/position.enum';

// Plain interfaces standing in for the ARCHITECTURE.md §6 schema sketch.
// Promote these to ORM entities once a persistence layer is chosen.

export interface Gameweek {
  id: number;
  deadlineAt: string; // ISO timestamp, always read from bootstrap-static
  isCurrent: boolean;
  isNext: boolean;
  finished: boolean;
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

export interface Proposal {
  id: string;
  gameweekId: number;
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
  // Only meaningful once status is EXPIRED — null/undefined otherwise (never
  // asked). Answered via a post-deadline Telegram Yes/No check-in purely to
  // label the outcome for future backtesting (step 5); it never gates or
  // re-triggers execution, and a REJECTED/APPROVED proposal's outcome is
  // already known without asking.
  appliedManually?: boolean | null;
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
