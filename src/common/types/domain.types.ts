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
}

export interface TransferPlan {
  playerOutId: number;
  playerInId: number;
}

export interface Proposal {
  id: string;
  gameweekId: number;
  transfers: TransferPlan[];
  lineup: number[]; // starting XI player IDs
  captainId: number;
  viceCaptainId: number;
  chip?: FplChip;
  expectedGain: number;
  hitCost: number;
  status: ProposalStatus;
  createdAt: string;
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
