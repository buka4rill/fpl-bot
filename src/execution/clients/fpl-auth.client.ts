import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { isAxiosError } from 'axios';
import { FplMyTeam, FplPick, FplTokenResponse } from './fpl-auth.types';

// Axios errors carry the full request (headers, body) on `.config` — for
// every call this client makes, that includes either the refresh token or
// the bearer access token. Never let a raw AxiosError propagate: NestJS's
// default exception handler logs the whole object, which would print a live
// credential straight to the console (confirmed live — ARCHITECTURE.md's
// "never logged" secrets rule). Always rethrow through this instead.
function sanitizeError(error: unknown): Error {
  if (isAxiosError(error)) {
    return new Error(
      `FPL API request failed (${error.response?.status ?? 'no response'}): ${JSON.stringify(error.response?.data ?? error.message)}`,
    );
  }
  return error instanceof Error ? error : new Error(String(error));
}

// The ONLY client in the system allowed to hold an authenticated FPL session.
// FPL's write auth is OIDC via a hosted identity provider (PingOne DaVinci)
// as of 2026-09 — see project memory: fpl-write-api-contract. The
// interactive login step is a bot-guarded, stateful flow (DataDome present)
// and deliberately isn't scripted here: it's fragile and adversarial, not a
// stable contract worth maintaining. Instead, a long-lived refresh token is
// captured manually once (FPL_REFRESH_TOKEN) and this client only ever
// exchanges it for short-lived access tokens. If the refresh token expires
// or is revoked, a human must repeat that manual capture — there's no
// automated re-login path.
@Injectable()
export class FplAuthClient {
  private readonly logger = new Logger(FplAuthClient.name);
  private readonly tokenUrl = 'https://account.premierleague.com/as/token';
  private readonly apiBase = 'https://fantasy.premierleague.com/api';
  // Public OAuth client id for the FPL single-page app — not a secret,
  // captured from its own login flow's query params.
  private readonly clientId = 'bfcbaf69-aade-4c1b-8f00-c1cb8a193030';

  private refreshToken: string;
  private accessToken: string | undefined;
  private accessTokenExpiresAt = 0;

  constructor(
    private readonly http: HttpService,
    private readonly config: ConfigService,
  ) {
    this.refreshToken = this.config.get<string>('fpl.refreshToken') ?? '';
  }

  async getMyTeam(teamId: number): Promise<FplMyTeam> {
    const accessToken = await this.ensureAccessToken();
    try {
      const { data } = await firstValueFrom(
        this.http.get<FplMyTeam>(`${this.apiBase}/my-team/${teamId}/`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        }),
      );
      return data;
    } catch (error) {
      throw sanitizeError(error);
    }
  }

  async setLineup(teamId: number, picks: FplPick[]): Promise<FplMyTeam> {
    const accessToken = await this.ensureAccessToken();
    try {
      const { data } = await firstValueFrom(
        this.http.post<FplMyTeam>(
          `${this.apiBase}/my-team/${teamId}/`,
          { picks },
          { headers: { Authorization: `Bearer ${accessToken}` } },
        ),
      );
      return data;
    } catch (error) {
      throw sanitizeError(error);
    }
  }

  private async ensureAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.accessTokenExpiresAt) {
      return this.accessToken;
    }
    if (!this.refreshToken) {
      throw new Error(
        'FPL_REFRESH_TOKEN is not configured — capture one manually from a ' +
          'logged-in browser session before execution can run (see project ' +
          'memory: fpl-write-api-contract).',
      );
    }

    // The token endpoint sits behind a custom AWS API Gateway (not a raw
    // PingOne endpoint) that enforces standard OAuth2 form-encoding
    // (RFC 6749) — a JSON body gets a 415, confirmed live 2026-09-07.
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: this.refreshToken,
      client_id: this.clientId,
    });
    let data: FplTokenResponse;
    try {
      ({ data } = await firstValueFrom(
        this.http.post<FplTokenResponse>(this.tokenUrl, body, {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        }),
      ));
    } catch (error) {
      throw sanitizeError(error);
    }

    this.accessToken = data.access_token;
    // The token server may rotate the refresh token on use — carry forward
    // whichever one comes back so the next refresh doesn't use a stale one.
    // This only lives in memory (no persistence layer yet, CLAUDE.md); on
    // restart it reverts to FPL_REFRESH_TOKEN from .env, which may by then
    // be stale if a rotation happened after the last restart.
    if (data.refresh_token && data.refresh_token !== this.refreshToken) {
      this.refreshToken = data.refresh_token;
      this.logger.warn(
        'FPL refresh token rotated — update FPL_REFRESH_TOKEN in .env, or ' +
          'this instance will need a fresh manual capture after its next restart.',
      );
    }
    // Small safety margin before the token's real expiry.
    this.accessTokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000;
    return this.accessToken;
  }
}
