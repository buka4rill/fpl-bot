import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AlertService } from '../alert/alert.service';
import { TeamStateEntity } from '../persistence/entities/team-state.entity';
import { TeamState } from '../common/types/domain.types';

export type ChipPromptStep =
  | 'wildcard1'
  | 'freeHit1'
  | 'benchBoost1'
  | 'tripleCaptain1'
  | 'wildcard2'
  | 'freeHit2'
  | 'benchBoost2'
  | 'tripleCaptain2';
export type PromptStep = 'free_transfers' | ChipPromptStep;

const FIRST_HALF_STEPS: ChipPromptStep[] = [
  'wildcard1',
  'freeHit1',
  'benchBoost1',
  'tripleCaptain1',
];
const SECOND_HALF_STEPS: ChipPromptStep[] = [
  'wildcard2',
  'freeHit2',
  'benchBoost2',
  'tripleCaptain2',
];

// Per CLAUDE.md: the first-half chip set must be played before the
// Gameweek 19 deadline and doesn't carry over, so it stops being askable
// from Gameweek 20 on — regardless of whether the owner ever explicitly
// answered "no" for it. The second-half set is the mirror image: not
// askable until it actually unlocks.
const FIRST_HALF_CUTOFF_GAMEWEEK = 19;
const SECOND_HALF_UNLOCK_GAMEWEEK = 20;

const CHIP_STEP_COLUMN: Record<ChipPromptStep, keyof TeamState> = {
  wildcard1: 'wildcard1Available',
  freeHit1: 'freeHit1Available',
  benchBoost1: 'benchBoost1Available',
  tripleCaptain1: 'tripleCaptain1Available',
  wildcard2: 'wildcard2Available',
  freeHit2: 'freeHit2Available',
  benchBoost2: 'benchBoost2Available',
  tripleCaptain2: 'tripleCaptain2Available',
};

const CHIP_STEP_QUESTION: Record<ChipPromptStep, string> = {
  wildcard1: 'Is your first Wildcard still available (not yet played)?',
  freeHit1: 'Is your first Free Hit still available (not yet played)?',
  benchBoost1: 'Is your first Bench Boost still available (not yet played)?',
  tripleCaptain1:
    'Is your first Triple Captain still available (not yet played)?',
  wildcard2: 'Is your second Wildcard still available (not yet played)?',
  freeHit2: 'Is your second Free Hit still available (not yet played)?',
  benchBoost2: 'Is your second Bench Boost still available (not yet played)?',
  tripleCaptain2:
    'Is your second Triple Captain still available (not yet played)?',
};

// Fixed step order for a given gameweek — a pure function of gameweekId
// alone, not filtered by availability up front. Availability is applied as
// a forward-scan skip when advancing (see nextStep), which keeps "find the
// next step after X" correct even when X's own flag just flipped false.
function promptStepOrder(gameweekId: number): PromptStep[] {
  return [
    'free_transfers',
    ...(gameweekId <= FIRST_HALF_CUTOFF_GAMEWEEK ? FIRST_HALF_STEPS : []),
    ...(gameweekId >= SECOND_HALF_UNLOCK_GAMEWEEK ? SECOND_HALF_STEPS : []),
  ];
}

function isChipStepAvailable(step: ChipPromptStep, state: TeamState): boolean {
  return state[CHIP_STEP_COLUMN[step]] !== false;
}

function nextStep(
  afterStep: PromptStep,
  gameweekId: number,
  state: TeamState,
): PromptStep | null {
  const order = promptStepOrder(gameweekId);
  const idx = order.indexOf(afterStep);
  for (let i = idx + 1; i < order.length; i++) {
    const step = order[i];
    if (step !== 'free_transfers' && !isChipStepAvailable(step, state)) {
      continue;
    }
    return step;
  }
  return null;
}

@Injectable()
export class TeamStateService {
  private readonly logger = new Logger(TeamStateService.name);
  // In-process claim guard, same category as
  // DeadlineWatcherService.lastClaimedGameweekId — closes the race between
  // two overlapping checkDeadline() calls (e.g. the immediate on-init check
  // racing the first hourly poll) both trying to start the same week's
  // prompt before either's DB write has landed. Resets on restart, which is
  // fine: ensureWeeklyPromptStarted is otherwise idempotent via the DB row.
  private readonly promptStartInFlight = new Set<number>();

  constructor(
    @InjectRepository(TeamStateEntity)
    private readonly repository: Repository<TeamStateEntity>,
    private readonly alertService: AlertService,
    private readonly config: ConfigService,
  ) {}

  private teamId(): number {
    return Number(this.config.get<string>('fpl.teamId'));
  }

  private async getOrCreate(): Promise<TeamStateEntity> {
    const teamId = this.teamId();
    const existing = await this.repository.findOneBy({ teamId });
    if (existing) return existing;

    const created = this.repository.create({
      teamId,
      freeTransfers: null,
      freeTransfersAsOfGameweekId: null,
      wildcard1Available: true,
      freeHit1Available: true,
      benchBoost1Available: true,
      tripleCaptain1Available: true,
      wildcard2Available: true,
      freeHit2Available: true,
      benchBoost2Available: true,
      tripleCaptain2Available: true,
      pendingPromptStep: null,
      pendingPromptGameweekId: null,
    });
    return this.repository.save(created);
  }

  async isFreshFor(gameweekId: number): Promise<boolean> {
    const state = await this.getOrCreate();
    return (
      state.freeTransfersAsOfGameweekId === gameweekId &&
      state.pendingPromptStep === null
    );
  }

  // Idempotent: a no-op if this exact gameweek's prompt is already in
  // flight (whether that's from an earlier call in this same process, or a
  // prior run persisted to the DB before a restart).
  async ensureWeeklyPromptStarted(gameweekId: number): Promise<void> {
    if (this.promptStartInFlight.has(gameweekId)) return;

    const state = await this.getOrCreate();
    if (
      state.pendingPromptGameweekId === gameweekId &&
      state.pendingPromptStep !== null
    ) {
      return;
    }

    this.promptStartInFlight.add(gameweekId);
    try {
      state.pendingPromptStep = 'free_transfers';
      state.pendingPromptGameweekId = gameweekId;
      await this.repository.save(state);
      await this.alertService.sendMessage(
        `🔢 How many free transfers do you have available for GW${gameweekId}? Reply with a number (0-5).`,
      );
    } finally {
      this.promptStartInFlight.delete(gameweekId);
    }
  }

  // Throws rather than silently falling back to a stale/default number —
  // matches the project's "fail loud" convention (FplAuthClient,
  // ExecutionService) — since DeadlineWatcherService only calls this after
  // isFreshFor has already confirmed the data is current.
  async getFreeTransfers(gameweekId: number): Promise<number> {
    const state = await this.getOrCreate();
    if (
      state.freeTransfersAsOfGameweekId !== gameweekId ||
      state.freeTransfers === null
    ) {
      throw new Error(
        `Free transfers not confirmed for gameweek ${gameweekId}.`,
      );
    }
    return state.freeTransfers;
  }

  // Only acts while a 'free_transfers' step is actually pending — any other
  // plain text message in the chat (a stray reply, small talk) is silently
  // ignored rather than misapplied to whatever step happens to be pending.
  async handleTextReply(text: string): Promise<void> {
    const state = await this.getOrCreate();
    if (state.pendingPromptStep !== 'free_transfers') return;

    const parsed = Number(text.trim());
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 5) {
      await this.alertService.sendMessage(
        'Please reply with a whole number from 0 to 5 for free transfers.',
      );
      return;
    }

    state.freeTransfers = parsed;
    state.freeTransfersAsOfGameweekId = state.pendingPromptGameweekId;
    await this.advance(state, 'free_transfers');
  }

  // Validates both the gameweek and the step against what's actually
  // pending — a stale button from a previous week's prompt (Telegram
  // buttons stay tappable indefinitely) asking about a chip that happens to
  // still be available must not get applied to the current week.
  async handleChipReply(
    gameweekId: number,
    step: string,
    answer: 'yes' | 'no',
  ): Promise<string> {
    const state = await this.getOrCreate();
    if (
      state.pendingPromptGameweekId !== gameweekId ||
      state.pendingPromptStep !== step
    ) {
      throw new Error(
        `Chip reply for GW${gameweekId}/${step} doesn't match the currently pending prompt.`,
      );
    }

    if (answer === 'no') {
      const column = CHIP_STEP_COLUMN[step as ChipPromptStep];
      (state as unknown as Record<string, boolean>)[column] = false;
    }
    await this.advance(state, step as PromptStep);
    return 'Noted.';
  }

  private async advance(
    state: TeamStateEntity,
    fromStep: PromptStep,
  ): Promise<void> {
    const gameweekId = state.pendingPromptGameweekId;
    if (gameweekId === null) return;

    const next = nextStep(fromStep, gameweekId, state);
    state.pendingPromptStep = next;
    await this.repository.save(state);

    if (next === null) {
      await this.alertService.sendMessage(
        `✅ Thanks — I'll generate GW${gameweekId}'s proposal shortly.`,
      );
      return;
    }
    if (next === 'free_transfers') return; // unreachable in practice

    await this.alertService.sendYesNoPrompt(
      CHIP_STEP_QUESTION[next],
      `chipavail:${gameweekId}:${next}`,
    );
  }
}
