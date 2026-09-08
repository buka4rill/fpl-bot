import { computeSeason } from './season.util';

describe('computeSeason', () => {
  it('assigns an August deadline to the season starting that year', () => {
    expect(computeSeason('2026-08-21T17:30:00Z')).toBe('26_27');
  });

  it('assigns a January deadline to the season that started the previous August', () => {
    expect(computeSeason('2027-01-15T17:30:00Z')).toBe('26_27');
  });

  it('assigns a May deadline to the season that started the previous August', () => {
    expect(computeSeason('2027-05-20T17:30:00Z')).toBe('26_27');
  });

  it('rolls over at the July/August cutover', () => {
    expect(computeSeason('2027-06-30T00:00:00Z')).toBe('26_27');
    expect(computeSeason('2027-07-01T00:00:00Z')).toBe('27_28');
  });

  it('gives every gameweek in the same season the same season string', () => {
    const gw1 = computeSeason('2026-08-21T17:30:00Z');
    const gw20 = computeSeason('2027-01-02T17:30:00Z');
    const gw38 = computeSeason('2027-05-24T17:30:00Z');
    expect(gw1).toBe(gw20);
    expect(gw20).toBe(gw38);
  });
});
