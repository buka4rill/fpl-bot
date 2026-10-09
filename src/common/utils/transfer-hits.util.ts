import {
  FplChipStatus,
  FplTransfersState,
} from '../../auth/clients/fpl-auth.types';

// Points FPL will deduct at the deadline for transfers already made this
// gameweek, from the authenticated my-team state. Added 2026-10-09 after a
// GW6 Wildcard silently failed to play (see FplTransferPayload) and its
// full-squad rebuild landed as ordinary transfers — nothing in the bot
// could show the resulting hit, only the FPL app.
//
// `limit` is the gameweek's total free transfers, not what's left of them
// (observed live: still 2 after a rebuild had used them up), so the hit is
// whatever `made` exceeds it by, at `cost` points each (inferred from that
// one live observation — not yet seen against a real pending hit). An
// unlimited week or an active Wildcard/Free Hit covers every transfer that
// gameweek, including ones confirmed before the chip was played. Returns
// undefined when the shape isn't fully numeric rather than guessing.
export function pendingHitPoints(
  transfers: Partial<FplTransfersState> | undefined,
  chips: FplChipStatus[] = [],
): number | undefined {
  if (!transfers) return undefined;
  if (transfers.status === 'unlimited') return 0;
  const transferChipActive = chips.some(
    (chip) =>
      chip.chip_type === 'transfer' && chip.status_for_entry === 'active',
  );
  if (transferChipActive) return 0;
  const { made, limit, cost } = transfers;
  if (
    typeof made !== 'number' ||
    typeof limit !== 'number' ||
    typeof cost !== 'number'
  ) {
    return undefined;
  }
  return Math.max(0, made - limit) * cost;
}
