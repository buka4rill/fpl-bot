export enum Position {
  GKP = 'GKP',
  DEF = 'DEF',
  MID = 'MID',
  FWD = 'FWD',
}

// bootstrap-static element_types[].id -> Position. Fixed by the game rules,
// not expected to change, but only these four are handled.
export const POSITION_BY_ELEMENT_TYPE: Record<number, Position> = {
  1: Position.GKP,
  2: Position.DEF,
  3: Position.MID,
  4: Position.FWD,
};
