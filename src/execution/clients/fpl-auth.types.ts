// Shapes for the authenticated FPL endpoints, captured 2026-09-07 via a real
// browser session (see project memory: fpl-write-api-contract). Undocumented
// and only known through this capture — can drift without notice.

export interface FplPick {
  element: number;
  position: number;
  multiplier: number;
  is_captain: boolean;
  is_vice_captain: boolean;
  element_type: number;
  selling_price: number;
  purchase_price: number;
}

// Per-chip availability as reported by the authenticated my-team endpoint —
// `name` matches FplChip's enum values 1:1 ('wildcard' | 'freehit' |
// 'bboost' | '3xc'). `number` distinguishes the first/second-half instance
// of a chip (1 or 2) once the 2025/26 twice-per-season rule applies.
// `status_for_entry` observed live so far: 'available' | 'unavailable' —
// treated as a plain string rather than a closed union since a third state
// (e.g. once a chip is actually played) hasn't been observed yet.
export interface FplChipStatus {
  id: number;
  status_for_entry: string;
  played_by_entry: number[];
  name: string;
  number: number;
  start_event: number;
  stop_event: number;
  chip_type: string;
  is_pending: boolean;
}

// `limit`/`status` together are FPL's own free-transfer accounting for the
// upcoming event — `status: 'unlimited'` (limit: null) observed preseason;
// a normal week is expected to report a numeric `limit` instead, unverified
// beyond what's been seen live so far (captured 2026-09-08).
export interface FplTransfersState {
  cost: number;
  status: string;
  limit: number | null;
  made: number;
  bank: number;
  value: number;
}

export interface FplMyTeam {
  picks: FplPick[];
  picks_last_updated: string;
  chips: FplChipStatus[];
  transfers: FplTransfersState;
}

export interface FplTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token: string;
  scope: string;
  id_token: string;
}

// POST /api/transfers/ — never captured live (unlike everything else in
// this file), sourced from amosbastian/fpl's fpl/models/user.py (an
// actively-maintained community library, see ARCHITECTURE.md's Sources),
// not a guess. Needs live confirmation the first time this actually runs
// against a real transfer. Response shape is genuinely unknown — treated
// as `unknown` at the call site rather than typed here.
export interface FplTransferSubmission {
  element_in: number;
  element_out: number;
  purchase_price: number;
  selling_price: number;
}

export interface FplTransferPayload {
  confirmed: boolean;
  entry: number;
  event: number;
  transfers: FplTransferSubmission[];
  wildcard: boolean;
  freehit: boolean;
}
