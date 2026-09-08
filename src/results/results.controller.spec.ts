import { Test, TestingModule } from '@nestjs/testing';
import { ResultsController } from './results.controller';
import { ResultsService } from './results.service';

describe('ResultsController', () => {
  let controller: ResultsController;
  let resultsService: { checkFinishedGameweeks: jest.Mock };

  beforeEach(async () => {
    resultsService = {
      checkFinishedGameweeks: jest.fn().mockResolvedValue(2),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ResultsController],
      providers: [{ provide: ResultsService, useValue: resultsService }],
    }).compile();

    controller = module.get<ResultsController>(ResultsController);
  });

  it('triggers the check and reports success with the reported count', async () => {
    const result = await controller.triggerCheck();

    expect(resultsService.checkFinishedGameweeks).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ checked: true, reported: 2 });
  });
});
