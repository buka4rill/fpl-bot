import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AlertService } from '../alert/alert.service';
import { ExecutionService } from '../execution/execution.service';
import {
  FplChipStatus,
  FplTransfersState,
} from '../execution/clients/fpl-auth.types';

export interface TeamState {
  freeTransfers: number;
  bank: number;
  teamValue: number;
  chips: FplChipStatus[];
}

const CHIP_DISPLAY_NAME: Record<string, string> = {
  wildcard: 'Wildcard',
  freehit: 'Free Hit',
  bboost: 'Bench Boost',
  '3xc': 'Triple Captain',
};

const CHIP_STATUS_EMOJI: Record<string, string> = {
  available: '✅',
  unavailable: '⏳',
  played: '☑️',
};

// Replaces the old weekly Telegram Q&A (2026-09-08 -> superseded 2026-09-08):
// that feature assumed free-transfer count and chip availability weren't
// obtainable without asking the owner directly. Turned out wrong — the
// authenticated my-team endpoint (the same one ExecutionService already
// calls to apply changes) returns both in `transfers`/`chips`, it was just
// typed `unknown` and discarded (see fpl-auth.types.ts). No more DB-backed
// prompt state machine: this is read fresh from FPL on every check.
@Injectable()
export class TeamStateService {
  constructor(
    private readonly executionService: ExecutionService,
    private readonly alertService: AlertService,
    private readonly config: ConfigService,
  ) {}

  private teamId(): number {
    return Number(this.config.get<string>('fpl.teamId'));
  }

  // Goes through ExecutionService rather than FplAuthClient directly —
  // CLAUDE.md's hard constraint keeps the authenticated FPL session
  // isolated to ExecutionModule; this only ever sees the derived
  // chips/transfers shape, never the session itself.
  async getTeamState(): Promise<TeamState> {
    const { chips, transfers } = await this.executionService.getTeamState(
      this.teamId(),
    );
    return {
      freeTransfers: this.deriveFreeTransfers(transfers),
      // FPL reports bank/value in tenths of a million, same unit as
      // FplPick's selling_price/purchase_price.
      bank: transfers.bank / 10,
      teamValue: transfers.value / 10,
      chips,
    };
  }

  // `status: 'unlimited'` (seen preseason) is the same "hits are free this
  // week" state SquadOptimizerService already gives an active Wildcard/Free
  // Hit — modeled the same way, via a free-transfer count no plan can
  // exceed (15 = FPL squad size). Anything else with no numeric `limit` is
  // an unrecognized shape from this still-not-fully-verified endpoint —
  // fail loud rather than silently guess a number.
  private deriveFreeTransfers(transfers: FplTransfersState): number {
    if (transfers.status === 'unlimited') return 15;
    if (transfers.limit !== null) return transfers.limit;
    throw new Error(
      `Unrecognized transfers shape from my-team: ${JSON.stringify(transfers)}`,
    );
  }

  // Fetches the live state and sends it as an informational Telegram
  // message — never blocks proposal generation, unlike the prompt it
  // replaced. Called once per gameweek by DeadlineWatcherService,
  // immediately before generating that week's proposal.
  async reportTeamState(gameweekId: number): Promise<TeamState> {
    const state = await this.getTeamState();
    await this.alertService.sendMessage(this.renderReport(gameweekId, state));
    return state;
  }

  private renderReport(gameweekId: number, state: TeamState): string {
    const lines = [
      `📋 *GW${gameweekId} Team Status*`,
      '',
      `🔄 Free Transfers: ${state.freeTransfers}`,
      `💰 Bank: £${state.bank.toFixed(1)}m  📈 Squad Value: £${state.teamValue.toFixed(1)}m`,
      '',
      '🃏 *Chips:*',
    ];
    for (const chip of state.chips) {
      const emoji = CHIP_STATUS_EMOJI[chip.status_for_entry] ?? '❔';
      const name = CHIP_DISPLAY_NAME[chip.name] ?? chip.name;
      lines.push(`${emoji} ${name} ${chip.number} — ${chip.status_for_entry}`);
    }
    return lines.join('\n');
  }
}
