import { Test, TestingModule } from '@nestjs/testing';
import { AuthService } from './auth.service';
import { FplAuthClient } from './clients/fpl-auth.client';

describe('AuthService', () => {
  let service: AuthService;
  let fplAuthClient: {
    isAuthenticated: jest.Mock;
    applyRefreshToken: jest.Mock;
  };

  beforeEach(async () => {
    fplAuthClient = {
      isAuthenticated: jest.fn(),
      applyRefreshToken: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: FplAuthClient, useValue: fplAuthClient },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  describe('isAuthenticated', () => {
    it('delegates to FplAuthClient', async () => {
      fplAuthClient.isAuthenticated.mockResolvedValue(true);

      expect(await service.isAuthenticated()).toBe(true);
    });
  });

  describe('assertAuthenticated', () => {
    it('resolves without throwing when authenticated', async () => {
      fplAuthClient.isAuthenticated.mockResolvedValue(true);

      await expect(service.assertAuthenticated()).resolves.toBeUndefined();
    });

    it('throws a clear, actionable error when not authenticated', async () => {
      fplAuthClient.isAuthenticated.mockResolvedValue(false);

      await expect(service.assertAuthenticated()).rejects.toThrow('auth:login');
    });
  });

  describe('applyRefreshToken', () => {
    it('delegates to FplAuthClient', () => {
      service.applyRefreshToken('new-token');

      expect(fplAuthClient.applyRefreshToken).toHaveBeenCalledWith('new-token');
    });
  });
});
