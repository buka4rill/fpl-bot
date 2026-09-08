import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { of, throwError } from 'rxjs';
import { AxiosError } from 'axios';
import * as fs from 'fs';
import { FplAuthClient } from './fpl-auth.client';

jest.mock('fs');

describe('FplAuthClient', () => {
  let client: FplAuthClient;
  let http: { post: jest.Mock; get: jest.Mock };
  const REFRESH_TOKEN = 'initial-refresh-token';

  const tokenResponse = (overrides: Record<string, unknown> = {}) => ({
    data: {
      access_token: 'access-token-1',
      token_type: 'Bearer',
      expires_in: 28800,
      refresh_token: REFRESH_TOKEN,
      scope: 'openid profile email',
      id_token: 'id-token',
      ...overrides,
    },
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    (fs.readFileSync as jest.Mock).mockReturnValue(
      `FPL_REFRESH_TOKEN=${REFRESH_TOKEN}\n`,
    );
    (fs.writeFileSync as jest.Mock).mockImplementation(() => undefined);

    http = { post: jest.fn(), get: jest.fn() };
    const config = {
      get: jest.fn((key: string) =>
        key === 'fpl.refreshToken' ? REFRESH_TOKEN : undefined,
      ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FplAuthClient,
        { provide: HttpService, useValue: http },
        { provide: ConfigService, useValue: config },
      ],
    }).compile();

    client = module.get<FplAuthClient>(FplAuthClient);
  });

  describe('isAuthenticated', () => {
    it('refreshes and returns true when the refresh token is valid', async () => {
      http.post.mockReturnValue(of(tokenResponse()));

      expect(await client.isAuthenticated()).toBe(true);
      expect(http.post).toHaveBeenCalledTimes(1);
    });

    it('returns true from the cached access token without a network call once already refreshed', async () => {
      http.post.mockReturnValue(of(tokenResponse()));
      await client.isAuthenticated();
      http.post.mockClear();

      expect(await client.isAuthenticated()).toBe(true);
      expect(http.post).not.toHaveBeenCalled();
    });

    it('returns false when the refresh token is rejected', async () => {
      const axiosError = new AxiosError('Request failed');
      axiosError.response = {
        status: 400,
        data: { error: 'invalid_grant' },
      } as AxiosError['response'];
      http.post.mockReturnValue(throwError(() => axiosError));

      expect(await client.isAuthenticated()).toBe(false);
    });
  });

  describe('ensureAccessToken de-duplication (via getMyTeam)', () => {
    it('only fires one refresh for two concurrent calls needing a token', async () => {
      http.post.mockReturnValue(of(tokenResponse()));
      http.get.mockReturnValue(of({ data: { picks: [] } }));

      await Promise.all([client.getMyTeam(1), client.getMyTeam(1)]);

      expect(http.post).toHaveBeenCalledTimes(1);
      expect(http.get).toHaveBeenCalledTimes(2);
    });
  });

  describe('applyRefreshToken', () => {
    it('updates the token used for the next refresh and persists it to .env', async () => {
      client.applyRefreshToken('pushed-token');
      http.post.mockReturnValue(
        of(tokenResponse({ refresh_token: 'pushed-token' })),
      );

      await client.isAuthenticated();

      const [, body] = http.post.mock.calls[0] as [string, URLSearchParams];
      expect(body.get('refresh_token')).toBe('pushed-token');
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('.env'),
        expect.stringContaining('FPL_REFRESH_TOKEN=pushed-token'),
        'utf8',
      );
    });

    it('forces a fresh refresh rather than serving the old cached access token', async () => {
      http.post.mockReturnValue(of(tokenResponse()));
      await client.isAuthenticated(); // caches an access token under the old refresh token
      http.post.mockClear();

      client.applyRefreshToken('pushed-token');
      http.post.mockReturnValue(
        of(tokenResponse({ refresh_token: 'pushed-token' })),
      );
      await client.isAuthenticated();

      expect(http.post).toHaveBeenCalledTimes(1);
    });
  });

  describe('rotated refresh token persistence', () => {
    it('persists a rotated refresh token to .env when one comes back from a refresh', async () => {
      http.post.mockReturnValue(
        of(tokenResponse({ refresh_token: 'rotated-token' })),
      );

      await client.isAuthenticated();

      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('.env'),
        expect.stringContaining('FPL_REFRESH_TOKEN=rotated-token'),
        'utf8',
      );
    });

    it('does not fail the caller when persisting to .env throws', async () => {
      (fs.readFileSync as jest.Mock).mockImplementation(() => {
        throw new Error('ENOENT');
      });
      http.post.mockReturnValue(
        of(tokenResponse({ refresh_token: 'rotated-token' })),
      );

      await expect(client.isAuthenticated()).resolves.toBe(true);
    });
  });

  describe('TOKEN_STORE_PATH (persistent-volume mode, e.g. Fly.io)', () => {
    const STORE_PATH = '/data/fpl-refresh-token.txt';

    const buildClientWithStorePath = async (): Promise<FplAuthClient> => {
      http = { post: jest.fn(), get: jest.fn() };
      const config = {
        get: jest.fn((key: string) => {
          if (key === 'fpl.refreshToken') return REFRESH_TOKEN;
          if (key === 'auth.tokenStorePath') return STORE_PATH;
          return undefined;
        }),
      };
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          FplAuthClient,
          { provide: HttpService, useValue: http },
          { provide: ConfigService, useValue: config },
        ],
      }).compile();
      return module.get<FplAuthClient>(FplAuthClient);
    };

    it('prefers a token already on the store over the config-sourced one', async () => {
      (fs.readFileSync as jest.Mock).mockReturnValue('stored-token\n');
      const storeClient = await buildClientWithStorePath();
      http.post.mockReturnValue(of(tokenResponse()));

      await storeClient.isAuthenticated();

      const [, body] = http.post.mock.calls[0] as [string, URLSearchParams];
      expect(body.get('refresh_token')).toBe('stored-token');
    });

    it('falls back to the config-sourced token when nothing is on the store yet', async () => {
      (fs.readFileSync as jest.Mock).mockImplementation(() => {
        throw new Error('ENOENT: no such file');
      });
      const storeClient = await buildClientWithStorePath();
      http.post.mockReturnValue(of(tokenResponse()));

      await storeClient.isAuthenticated();

      const [, body] = http.post.mock.calls[0] as [string, URLSearchParams];
      expect(body.get('refresh_token')).toBe(REFRESH_TOKEN);
    });

    it('writes a rotated token to the store path, not .env', async () => {
      (fs.readFileSync as jest.Mock).mockReturnValue('stored-token\n');
      const storeClient = await buildClientWithStorePath();
      http.post.mockReturnValue(
        of(tokenResponse({ refresh_token: 'rotated-token' })),
      );

      await storeClient.isAuthenticated();

      expect(fs.writeFileSync).toHaveBeenCalledWith(
        STORE_PATH,
        'rotated-token',
        'utf8',
      );
      expect(fs.writeFileSync).not.toHaveBeenCalledWith(
        expect.stringContaining('.env'),
        expect.anything(),
        expect.anything(),
      );
    });

    it('does not fail the caller when writing to the store path throws', async () => {
      (fs.readFileSync as jest.Mock).mockReturnValue('stored-token\n');
      const storeClient = await buildClientWithStorePath();
      (fs.writeFileSync as jest.Mock).mockImplementation(() => {
        throw new Error('EROFS: read-only file system');
      });
      http.post.mockReturnValue(
        of(tokenResponse({ refresh_token: 'rotated-token' })),
      );

      await expect(storeClient.isAuthenticated()).resolves.toBe(true);
    });
  });
});
