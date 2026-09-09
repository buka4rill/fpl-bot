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
  squad_select: number; // required count of this position in the 15-man squad
  squad_min_play: number; // min allowed in the starting XI
  squad_max_play: number; // max allowed in the starting XI
}

// bootstrap-static's game_settings — squad-selection rules, not game/league
// settings unrelated to squad building are omitted.
export interface RawGameSettings {
  squad_squadsize: number;
  squad_squadplay: number; // starting XI size
  squad_team_limit: number; // max players per club
  squad_total_spend: number; // tenths of £m, e.g. 1000 = £100.0m
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
  // Season-cumulative combined CBIT (DEF) / CBIRT (MID/FWD) action count —
  // backs the 2025/26 defensive-contribution rule (2 pts at 10 for DEF, 12
  // for MID/FWD). A genuine JSON number, unlike expected_goals/
  // expected_assists above — confirmed via a live bootstrap-static call.
  defensive_contribution: number;
}

export interface BootstrapStaticResponse {
  events: RawEvent[];
  teams: RawTeam[];
  element_types: RawElementType[];
  elements: RawElement[];
  game_settings: RawGameSettings;
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
  // Per-match, numeric strings — unlike RawElement.expected_goals/
  // expected_assists above, which are season-cumulative. Confirmed live
  // via a real element-summary call: one history entry per fixture played,
  // each carrying that single match's xG/xA rather than a running total.
  expected_goals: string;
  expected_assists: string;
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

// GET /api/entry/{teamId}/ — captured 2026-09-07.
export interface RawEntry {
  id: number;
  current_event: number;
  last_deadline_bank: number; // tenths of £m
  last_deadline_value: number; // tenths of £m
}

// GET /api/entry/{teamId}/event/{gw}/picks/ — captured 2026-09-07, widened
// 2026-09-09 to add position/multiplier/is_captain/is_vice_captain (same
// fields the authenticated my-team endpoint's FplPick already has —
// standard on FPL's public picks endpoint too, just unused/untyped until
// ResultsService's divergence check needed them). No selling_price per
// pick — that's only exposed by the authenticated my-team endpoint, which
// IngestionModule deliberately doesn't touch.
export interface RawPick {
  element: number;
  element_type: number;
  position: number; // 1-11 starting XI, 12-15 bench (order = autosub priority)
  multiplier: number;
  is_captain: boolean;
  is_vice_captain: boolean;
}

export interface RawEntryHistory {
  event: number;
  points: number; // actual points scored that gameweek
  bank: number; // tenths of £m
  value: number; // tenths of £m
}

export interface EntryPicksResponse {
  active_chip: string | null;
  entry_history: RawEntryHistory;
  picks: RawPick[];
}
