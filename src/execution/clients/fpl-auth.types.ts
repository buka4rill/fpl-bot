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
