import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AlertService } from '../alert/alert.service';

describe('AuthController', () => {
  let controller: AuthController;
  let authService: { applyRefreshToken: jest.Mock };
  let alertService: { sendMessage: jest.Mock };
  const PUSH_SECRET = 'correct-secret';

  beforeEach(async () => {
    authService = { applyRefreshToken: jest.fn() };
    alertService = { sendMessage: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        { provide: AuthService, useValue: authService },
        { provide: AlertService, useValue: alertService },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) =>
              key === 'auth.pushSecret' ? PUSH_SECRET : undefined,
            ),
          },
        },
      ],
    }).compile();

    controller = module.get<AuthController>(AuthController);
  });

  it('applies the token and confirms via Telegram when the secret matches', async () => {
    const result = await controller.receiveToken(`Bearer ${PUSH_SECRET}`, {
      refreshToken: 'fresh-token',
    });

    expect(authService.applyRefreshToken).toHaveBeenCalledWith('fresh-token');
    expect(alertService.sendMessage).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ok: true });
  });

  it('rejects a missing Authorization header', async () => {
    await expect(
      controller.receiveToken(undefined, { refreshToken: 'fresh-token' }),
    ).rejects.toThrow('Invalid or missing push secret');
    expect(authService.applyRefreshToken).not.toHaveBeenCalled();
  });

  it('rejects a wrong secret', async () => {
    await expect(
      controller.receiveToken('Bearer wrong-secret', {
        refreshToken: 'fresh-token',
      }),
    ).rejects.toThrow('Invalid or missing push secret');
    expect(authService.applyRefreshToken).not.toHaveBeenCalled();
  });

  it('rejects when refreshToken is missing from the body', async () => {
    await expect(
      controller.receiveToken(`Bearer ${PUSH_SECRET}`, {}),
    ).rejects.toThrow('refreshToken is required');
    expect(authService.applyRefreshToken).not.toHaveBeenCalled();
  });

  it('fails closed when no push secret is configured at all', async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        { provide: AuthService, useValue: authService },
        { provide: AlertService, useValue: alertService },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue(undefined) },
        },
      ],
    }).compile();
    const unconfigured = module.get<AuthController>(AuthController);

    await expect(
      unconfigured.receiveToken('Bearer anything', {
        refreshToken: 'fresh-token',
      }),
    ).rejects.toThrow('Invalid or missing push secret');
  });
});
