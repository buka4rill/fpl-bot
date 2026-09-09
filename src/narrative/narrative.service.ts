import { Injectable, Logger } from '@nestjs/common';
import { IngestionService } from '../ingestion/ingestion.service';
import { AnthropicClient } from './clients/anthropic.client';
import {
  Player,
  PlayerRecentForm,
  PlayerSnapshot,
  Proposal,
} from '../common/types/domain.types';

const SYSTEM_PROMPT = `You are a concise fantasy football tactical analyst writing a short rationale for a Telegram message.

You will be given a JSON object of verified facts about one proposed gameweek plan — one or more transfers, a captain choice, fixture difficulty (1 easiest, 5 hardest), ownership percentage, and each player's recent form: xG+xA per 90 minutes and defensive contribution (tackles/interceptions/blocks/clearances/recoveries) per 90 minutes, over their recent matches. Defenders and defensive midfielders rarely register meaningful xG/xA — for them, defensive contribution is usually the more relevant number; attackers should usually be judged on xG+xA instead. Use whichever number actually fits each player's role.

Give a reason for every transfer in the "transfers" array — never silently skip one to stay short. If there is exactly one transfer, write 2-4 flowing sentences covering it and the captain choice together. If there are two or more transfers, instead write one short line per transfer (start each with the players' names, e.g. "Saka ➔ Palmer: ...") plus one closing line for the captain — this is what keeps every transfer visible instead of forcing you to pick which ones matter. Each line should be one sentence. Reference only the numbers you were given. Never invent a statistic, player, or fixture that isn't in the facts. If a player's recent-form sample is thin (few matches or minutes considered) or missing entirely, say so briefly rather than presenting it with full confidence. Do not repeat the raw JSON back — write natural prose, not JSON. Do not add a greeting, heading, or sign-off.`;

// Facts payload sent to the LLM — deliberately plain data, no computed
// prose, so the model only ever narrates numbers this service already
// verified rather than inferring its own.
interface PlayerFacts {
  name: string;
  position: string | undefined;
  fixtureDifficulty: number | null;
  ownershipPct: number | null;
  // null whenever this player's recentForm fetch failed (see buildRationale
  // below) — the LLM is told explicitly not to treat that as zero form.
  recentForm: {
    matchesConsidered: number;
    minutesConsidered: number;
    xgPer90: number;
    xaPer90: number;
    defensiveContributionPer90: number;
  } | null;
}

@Injectable()
export class NarrativeService {
  private readonly logger = new Logger(NarrativeService.name);

  constructor(
    private readonly ingestionService: IngestionService,
    private readonly anthropicClient: AnthropicClient,
  ) {}

  // Best-effort — any failure (missing API key, a bad IngestionService
  // call, the LLM erroring out) is caught here and reported as `undefined`,
  // never thrown, so a narrative-generation problem can never block or
  // delay the underlying proposal alert (same principle as every other
  // best-effort feature in this app — see CLAUDE.md, issue #8).
  async buildRationale(
    proposal: Proposal,
    players: Player[],
    snapshots: PlayerSnapshot[],
  ): Promise<string | undefined> {
    try {
      const relevantIds = new Set<number>();
      for (const transfer of proposal.transfers) {
        relevantIds.add(transfer.playerOutId);
        relevantIds.add(transfer.playerInId);
      }
      relevantIds.add(proposal.captainId);

      if (relevantIds.size === 0) return undefined;

      const playerById = new Map(players.map((p) => [p.id, p]));
      const snapshotById = new Map(snapshots.map((s) => [s.playerId, s]));

      // allSettled, not all — one player's live FPL call failing (e.g. a
      // bulk transfer touching a dozen players) must not drop the whole
      // rationale. A failed fetch just means that one player's recentForm
      // is null in the facts payload, same as buildRationale's own
      // catch-all does for a total failure, just scoped to one player.
      const recentFormResults = await Promise.allSettled(
        [...relevantIds].map((id) => this.ingestionService.getRecentForm(id)),
      );
      const recentFormById = new Map<number, PlayerRecentForm>();
      for (const result of recentFormResults) {
        if (result.status === 'fulfilled') {
          recentFormById.set(result.value.playerId, result.value);
        } else {
          this.logger.warn(
            `getRecentForm failed for one player, continuing without it: ${result.reason}`,
          );
        }
      }

      const describe = (id: number): PlayerFacts | null => {
        const player = playerById.get(id);
        if (!player) return null;
        const snapshot = snapshotById.get(id);
        const recentForm = recentFormById.get(id);
        return {
          name: player.webName,
          position: player.position,
          fixtureDifficulty: snapshot?.nextFixtureDifficulty ?? null,
          ownershipPct: snapshot?.ownershipPct ?? null,
          recentForm: recentForm
            ? {
                matchesConsidered: recentForm.matchesConsidered,
                minutesConsidered: recentForm.minutesConsidered,
                xgPer90: Number(recentForm.xgPer90.toFixed(2)),
                xaPer90: Number(recentForm.xaPer90.toFixed(2)),
                defensiveContributionPer90: Number(
                  recentForm.defensiveContributionPer90.toFixed(2),
                ),
              }
            : null,
        };
      };

      const facts = {
        gameweekId: proposal.gameweekId,
        chip: proposal.chip ?? null,
        expectedGain: Number(proposal.expectedGain.toFixed(1)),
        hitCost: proposal.hitCost,
        transfers: proposal.transfers.map((transfer) => ({
          out: describe(transfer.playerOutId),
          in: describe(transfer.playerInId),
        })),
        captain: describe(proposal.captainId),
      };

      return await this.anthropicClient.generateText(
        SYSTEM_PROMPT,
        JSON.stringify(facts),
      );
    } catch (error) {
      this.logger.warn(
        `Narrative generation failed, skipping rationale for proposal ${proposal.id}: ${error}`,
      );
      return undefined;
    }
  }
}
