// FPL's bootstrap-static exposes no season identifier anywhere in the
// payload (verified live 2026-09-08 against the real API — checked both
// top-level keys and every field on an event) and its gameweek `id` resets
// to 1 every season, so anything keying storage on `id` alone silently
// collides across a season boundary (e.g. this season's GW4 and next
// season's GW4 both being `id: 4`). Derived instead from a gameweek's own
// deadline: the Premier League season always starts in August and runs
// into the following May, so a July cutover has slack on both sides of the
// real close season regardless of which gameweek's deadline is passed in.
export function computeSeason(deadlineAt: string): string {
  const date = new Date(deadlineAt);
  const year = date.getUTCFullYear();
  const startYear = date.getUTCMonth() >= 6 ? year : year - 1; // getUTCMonth() is 0-indexed: 6 = July
  const twoDigit = (y: number): string => String(y % 100).padStart(2, '0');
  return `${twoDigit(startYear)}_${twoDigit(startYear + 1)}`;
}
