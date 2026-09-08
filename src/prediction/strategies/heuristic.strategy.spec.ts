import { HeuristicStrategy } from './heuristic.strategy';
import { PlayerSnapshot } from '../../common/types/domain.types';
import { Position } from '../../common/enums/position.enum';

describe('HeuristicStrategy', () => {
  let strategy: HeuristicStrategy;

  const basePlayer: PlayerSnapshot = {
    gameweekId: 3,
    playerId: 1,
    price: 6.0,
    ownershipPct: 38.7,
  };

  beforeEach(() => {
    strategy = new HeuristicStrategy();
  });

  it('scores an average fixture with unknown difficulty as form unchanged', async () => {
    const [result] = await strategy.predict([{ ...basePlayer, form: 5 }]);
    expect(result.predictedPoints).toBe(5);
  });

  it('boosts the score for an easy upcoming fixture', async () => {
    const [result] = await strategy.predict([
      { ...basePlayer, form: 5, nextFixtureDifficulty: 1 },
    ]);
    // (6 - 1) / 3 = 1.667
    expect(result.predictedPoints).toBeCloseTo(5 * (5 / 3), 5);
  });

  it('discounts the score for a hard upcoming fixture', async () => {
    const [result] = await strategy.predict([
      { ...basePlayer, form: 5, nextFixtureDifficulty: 5 },
    ]);
    // (6 - 5) / 3 = 0.333
    expect(result.predictedPoints).toBeCloseTo(5 * (1 / 3), 5);
  });

  it('zeroes out injured/suspended/unavailable players', async () => {
    const [result] = await strategy.predict([
      { ...basePlayer, form: 8, status: 'i' },
    ]);
    expect(result.predictedPoints).toBe(0);
  });

  it('scales down doubtful players by chance of playing', async () => {
    const [result] = await strategy.predict([
      { ...basePlayer, form: 4, status: 'd', chanceOfPlayingNextRound: 50 },
    ]);
    expect(result.predictedPoints).toBe(2);
  });

  it('treats a null chance-of-playing as fully available', async () => {
    const [result] = await strategy.predict([
      { ...basePlayer, form: 4, chanceOfPlayingNextRound: null },
    ]);
    expect(result.predictedPoints).toBe(4);
  });

  it('ignores xG/xA below the minutes sample threshold', async () => {
    const [result] = await strategy.predict([
      { ...basePlayer, form: 3, xg: 5, xa: 5, minutesPlayed: 90 },
    ]);
    expect(result.predictedPoints).toBe(3);
  });

  it('adds an underlying-stats bonus once minutes clear the threshold', async () => {
    const [result] = await strategy.predict([
      { ...basePlayer, form: 3, xg: 0.5, xa: 0.5, minutesPlayed: 450 },
    ]);
    // per90Factor = 90/450 = 0.2; (0.5*0.2 + 0.5*0.2) * weight(2) = 0.4
    expect(result.predictedPoints).toBeCloseTo(3.4, 5);
  });

  it('awards the full defensive-contribution bonus once a defender hits the 10-action threshold', async () => {
    const [result] = await strategy.predict([
      {
        ...basePlayer,
        form: 3,
        position: Position.DEF,
        minutesPlayed: 450,
        defensiveContribution: 50, // per90Factor 0.2 -> dcPer90 = 10
      },
    ]);
    expect(result.predictedPoints).toBeCloseTo(5, 5); // 3 + 2
  });

  it('caps the defensive-contribution bonus at 2 even well past the threshold', async () => {
    const [result] = await strategy.predict([
      {
        ...basePlayer,
        form: 3,
        position: Position.DEF,
        minutesPlayed: 450,
        defensiveContribution: 100, // dcPer90 = 20, double the threshold
      },
    ]);
    expect(result.predictedPoints).toBeCloseTo(5, 5); // still 3 + 2, not 3 + 4
  });

  it('gives partial defensive-contribution credit below the threshold', async () => {
    const [result] = await strategy.predict([
      {
        ...basePlayer,
        form: 3,
        position: Position.DEF,
        minutesPlayed: 450,
        defensiveContribution: 25, // dcPer90 = 5, half the threshold
      },
    ]);
    expect(result.predictedPoints).toBeCloseTo(4, 5); // 3 + (5/10)*2
  });

  it('uses the 12-action threshold for midfielders and forwards', async () => {
    const [midResult] = await strategy.predict([
      {
        ...basePlayer,
        form: 3,
        position: Position.MID,
        minutesPlayed: 450,
        defensiveContribution: 60, // dcPer90 = 12
      },
    ]);
    const [fwdResult] = await strategy.predict([
      {
        ...basePlayer,
        form: 3,
        position: Position.FWD,
        minutesPlayed: 450,
        defensiveContribution: 60,
      },
    ]);
    expect(midResult.predictedPoints).toBeCloseTo(5, 5);
    expect(fwdResult.predictedPoints).toBeCloseTo(5, 5);
  });

  it('never gives goalkeepers a defensive-contribution bonus', async () => {
    const [result] = await strategy.predict([
      {
        ...basePlayer,
        form: 3,
        position: Position.GKP,
        minutesPlayed: 450,
        defensiveContribution: 999,
      },
    ]);
    expect(result.predictedPoints).toBe(3);
  });

  it('ignores defensive contribution below the minutes sample threshold', async () => {
    const [result] = await strategy.predict([
      {
        ...basePlayer,
        form: 3,
        position: Position.DEF,
        minutesPlayed: 90,
        defensiveContribution: 100,
      },
    ]);
    expect(result.predictedPoints).toBe(3);
  });

  it('degrades to no bonus when position/defensiveContribution are missing', async () => {
    const [result] = await strategy.predict([
      { ...basePlayer, form: 3, minutesPlayed: 450 },
    ]);
    expect(result.predictedPoints).toBe(3);
  });

  it('preserves the original snapshot fields', async () => {
    const [result] = await strategy.predict([{ ...basePlayer, form: 5 }]);
    expect(result.playerId).toBe(1);
    expect(result.price).toBe(6.0);
    expect(result.ownershipPct).toBe(38.7);
  });
});
