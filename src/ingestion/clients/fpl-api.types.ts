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
  expected_goals: string; // season-cumulative, numeric string
  expected_assists: string; // season-cumulative, numeric string
  minutes: number; // season-cumulative
  status: string; // 'a' | 'd' | 'i' | 's' | 'u'
  chance_of_playing_next_round: number | null;
}

export interface BootstrapStaticResponse {
  events: RawEvent[];
  teams: RawTeam[];
  element_types: RawElementType[];
  elements: RawElement[];
}

// GET /api/fixtures/?event={gw} — captured 2026-09-07.
export interface RawFixture {
  id: number;
  event: number | null; // null when not yet scheduled (blank gameweek)
  team_h: number;
  team_a: number;
  kickoff_time: string | null;
  finished: boolean;
  team_h_difficulty: number;
  team_a_difficulty: number;
}

// GET /api/element-summary/{id}/ — captured 2026-09-07. `history_past`
// (prior-season totals) is omitted; nothing here needs multi-season data yet.
export interface RawElementSummaryFixture {
  id: number;
  event: number | null;
  is_home: boolean;
  difficulty: number;
  kickoff_time: string | null;
}

export interface RawElementSummaryHistory {
  element: number;
  fixture: number;
  opponent_team: number;
  round: number;
  was_home: boolean;
  kickoff_time: string;
  total_points: number;
  minutes: number;
}

export interface ElementSummaryResponse {
  fixtures: RawElementSummaryFixture[];
  history: RawElementSummaryHistory[];
}

// GET /api/event/{gw}/live/ — captured 2026-09-07. Actual per-player
// performance once a gameweek is underway/finished, for post-hoc comparison
// against predicted points. `explain` (per-fixture point breakdown) is
// omitted as unused.
export interface RawLiveElementStats {
  minutes: number;
  total_points: number;
  bonus: number;
  in_dreamteam: boolean;
  played: boolean;
}

export interface RawLiveElement {
  id: number;
  stats: RawLiveElementStats;
}

export interface LiveGameweekResponse {
  elements: RawLiveElement[];
}
