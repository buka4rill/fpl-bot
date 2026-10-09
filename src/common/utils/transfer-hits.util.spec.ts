import { pendingHitPoints } from './transfer-hits.util';
import { FplChipStatus } from '../../auth/clients/fpl-auth.types';

describe('pendingHitPoints', () => {
  const transfers = (made: number, limit: number | null = 2) => ({
    cost: 4,
    status: 'cost',
    limit,
    made,
    bank: 190,
    value: 814,
  });
  const wildcard = (status: string): FplChipStatus => ({
    id: 1,
    status_for_entry: status,
    played_by_entry: status === 'active' ? [6] : [],
    name: 'wildcard',
    number: 1,
    start_event: 2,
    stop_event: 19,
    chip_type: 'transfer',
    is_pending: false,
  });

  it('charges cost per transfer beyond the free limit', () => {
    expect(pendingHitPoints(transfers(5), [wildcard('available')])).toBe(12);
  });

  it('is zero within the free limit', () => {
    expect(pendingHitPoints(transfers(2))).toBe(0);
  });

  it('is zero once a transfer chip is active, however many were made (GW6 Wildcard, 2026-10-09)', () => {
    expect(pendingHitPoints(transfers(11), [wildcard('active')])).toBe(0);
  });

  it('is zero in an unlimited week', () => {
    expect(
      pendingHitPoints({ ...transfers(11, null), status: 'unlimited' }),
    ).toBe(0);
  });

  it('returns undefined for an incomplete shape rather than guessing', () => {
    expect(pendingHitPoints(undefined)).toBeUndefined();
    expect(pendingHitPoints({})).toBeUndefined();
    expect(pendingHitPoints(transfers(5, null))).toBeUndefined();
  });
});
