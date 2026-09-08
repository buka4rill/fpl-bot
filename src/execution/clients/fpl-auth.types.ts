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

export interface FplMyTeam {
  picks: FplPick[];
  picks_last_updated: string;
  chips: unknown[];
  transfers: unknown;
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
