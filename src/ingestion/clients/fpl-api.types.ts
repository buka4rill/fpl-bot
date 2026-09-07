// Raw shapes for the fields we actually consume from FPL's public API.
// The real payloads carry far more fields than this; captured from a live
// GET /api/bootstrap-static/ response on 2026-09-07 — re-verify if FPL
// changes its schema.

export interface RawEvent {
  id: number;
  deadline_time: string; // ISO timestamp
  finished: boolean;
  is_current: boolean;
  is_next: boolean;
}

export interface RawTeam {
  id: number;
  name: string;
  short_name: string;
}

export interface RawElementType {
  id: number;
  singular_name_short: string; // 'GKP' | 'DEF' | 'MID' | 'FWD'
}

export interface RawElement {
  id: number;
  web_name: string;
  first_name: string;
  second_name: string;
  team: number; // RawTeam.id
  element_type: number; // RawElementType.id
  now_cost: number; // tenths of £m, e.g. 60 = £6.0m
  selected_by_percent: string; // numeric string, e.g. "38.7"
  form: string; // numeric string, e.g. "5.0"
  expected_goals: string;
  expected_assists: string;
}

export interface BootstrapStaticResponse {
  events: RawEvent[];
  teams: RawTeam[];
  element_types: RawElementType[];
  elements: RawElement[];
}
