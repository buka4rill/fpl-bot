import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { isAxiosError } from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import {
  FplMyTeam,
  FplPick,
  FplTokenResponse,
  FplTransferPayload,
  FplTransferSubmission,
} from './fpl-auth.types';
import { FplChip } from '../../common/enums/chip.enum';

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

// The ONLY client in the system allowed to hold an authenticated FPL session
// (AuthModule's whole reason for being isolated from ExecutionModule/every
// other module — see CLAUDE.md's hard constraints). FPL's write auth is
// OIDC via a hosted identity provider (PingOne DaVinci) as of 2026-09 — see
// project memory: fpl-write-api-contract. The interactive login step is a
// bot-guarded, stateful flow (DataDome present) and deliberately isn't
// scripted here: it's fragile and adversarial, not a stable contract worth
// maintaining. Instead, a long-lived refresh token is captured via a real
// (human-driven) browser login — manually once via DevTools, or via
// `scripts/auth-login.ts`'s Playwright-assisted capture, which still
// requires you to actually do the login yourself — and this client only
// ever exchanges it for short-lived access tokens.
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
  // De-dupes concurrent callers hitting an expired cached access token at
  // the same time — without this, two overlapping refreshes could both fire,
  // and since the refresh token can rotate on use, the second call risks
  // using one already rotated away by the first (a latent race that existed
  // before this field; never actually observed live, hardened proactively).
  private refreshInFlight: Promise<string> | null = null;

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

  async setLineup(
    teamId: number,
    picks: FplPick[],
    chip: FplChip | null = null,
  ): Promise<FplMyTeam> {
    const accessToken = await this.ensureAccessToken();
    try {
      const { data } = await firstValueFrom(
        this.http.post<FplMyTeam>(
          `${this.apiBase}/my-team/${teamId}/`,
          { chip, picks },
          { headers: { Authorization: `Bearer ${accessToken}` } },
        ),
      );
      return data;
    } catch (error) {
      throw sanitizeError(error);
    }
  }

  // POST /api/transfers/ — see fpl-auth.types.ts: sourced from a community
  // library, not captured live until 2026-09-08 against a disposable test
  // account. That source assumed a dry-run-then-commit pattern (`confirmed:
  // false` validates without applying, a second `confirmed: true` call
  // actually submits) — **disproved live**: a single `confirmed: false`
  // call already applied the transfer for real (confirmed by checking the
  // account's actual squad afterward), before any second call was ever
  // made. What a second `confirmed: true` call would do on top of an
  // already-applied transfer is untested and deliberately not risked here —
  // this sends exactly one request, `confirmed: true` directly. `submissions`
  // can be an empty array with a chip flag set — that's how Wildcard/Free
  // Hit get activated on a week with no actual transfers.
  async submitTransfers(
    teamId: number,
    gameweekId: number,
    submissions: FplTransferSubmission[],
    chip: { wildcard: boolean; freehit: boolean },
  ): Promise<unknown> {
    const accessToken = await this.ensureAccessToken();
    const payload: FplTransferPayload = {
      confirmed: true,
      entry: teamId,
      event: gameweekId,
      transfers: submissions,
      wildcard: chip.wildcard,
      freehit: chip.freehit,
    };
    const headers = { Authorization: `Bearer ${accessToken}` };

    try {
      const { data } = await firstValueFrom(
        this.http.post<unknown>(`${this.apiBase}/transfers/`, payload, {
          headers,
        }),
      );
      // A clean response was assumed (community-library source) to be `{}`;
      // verified live 2026-09-08 to actually be an empty-body 200, which
      // axios can't JSON-parse and hands back as `''`. Treated the same as
      // `{}` here — not as an error.
      const hasErrors =
        data !== null &&
        data !== undefined &&
        data !== '' &&
        (typeof data !== 'object' || Object.keys(data).length > 0);
      if (hasErrors) {
        throw new Error(`Transfer submission failed: ${JSON.stringify(data)}`);
      }
      return data;
    } catch (error) {
      throw sanitizeError(error);
    }
  }

  // Cheap, non-invasive "am I logged in" check — reuses the cached access
  // token if it's still valid (no network call at all), otherwise attempts
  // a real refresh and reports whether that succeeded. AuthService exposes
  // this to the rest of the app so callers can ask *before* attempting a
  // flow, instead of only finding out via a thrown error mid-flow.
  async isAuthenticated(): Promise<boolean> {
    if (this.accessToken && Date.now() < this.accessTokenExpiresAt) {
      return true;
    }
    try {
      await this.ensureAccessToken();
      return true;
    } catch (error) {
      // sanitizeError() already stripped anything sensitive from this by
      // the time it gets here — safe to log, and the only way to see why
      // an auth check failed rather than just knowing that it did.
      this.logger.warn(`isAuthenticated() check failed: ${String(error)}`);
      return false;
    }
  }

  // Applies a freshly-captured refresh token at runtime — the landing spot
  // for AuthController's POST /auth/token push (see scripts/auth-login.ts).
  // Clears the cached access token so the very next call re-derives one
  // from the new refresh token, rather than serving a stale cached access
  // token a few more minutes.
  applyRefreshToken(refreshToken: string): void {
    this.refreshToken = refreshToken;
    this.accessToken = undefined;
    this.accessTokenExpiresAt = 0;
    this.persistRefreshTokenToEnv(refreshToken);
    this.logger.log('FPL refresh token updated.');
  }

  private async ensureAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.accessTokenExpiresAt) {
      return this.accessToken;
    }
    if (this.refreshInFlight) {
      return this.refreshInFlight;
    }

    this.refreshInFlight = this.refreshAccessToken();
    try {
      return await this.refreshInFlight;
    } finally {
      this.refreshInFlight = null;
    }
  }

  private async refreshAccessToken(): Promise<string> {
    if (!this.refreshToken) {
      throw new Error(
        'FPL_REFRESH_TOKEN is not configured — capture one via `pnpm run ' +
          'auth:login` or manually from a logged-in browser session before ' +
          'execution can run (see project memory: fpl-write-api-contract).',
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
    // whichever one comes back so the next refresh doesn't use a stale one,
    // and persist it to .env immediately so a restart doesn't lose it (the
    // exact friction that repeatedly cost a fresh manual capture in
    // practice before this was added — see project memory
    // fpl-test-account-for-execution-testing).
    if (data.refresh_token && data.refresh_token !== this.refreshToken) {
      this.refreshToken = data.refresh_token;
      this.persistRefreshTokenToEnv(this.refreshToken);
    }
    // Small safety margin before the token's real expiry.
    this.accessTokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000;
    return this.accessToken;
  }

  // Local-filesystem-only durability: fine for this app's current single-
  // machine deployment, but a checked-out `.env` won't survive a redeploy
  // on typical ephemeral-filesystem PaaS hosting (Fly.io, Railway, etc.) —
  // needs revisiting alongside CLAUDE.md's not-yet-started deploy TODO
  // (e.g. writing through to the platform's own secrets API instead).
  // Best-effort: a failure here must never block the access token this
  // call already successfully obtained.
  private persistRefreshTokenToEnv(refreshToken: string): void {
    try {
      const envPath = path.resolve(process.cwd(), '.env');
      const content = fs.readFileSync(envPath, 'utf8');
      const line = `FPL_REFRESH_TOKEN=${refreshToken}`;
      const updated = /^FPL_REFRESH_TOKEN=.*$/m.test(content)
        ? content.replace(/^FPL_REFRESH_TOKEN=.*$/m, line)
        : `${content.replace(/\n$/, '')}\n${line}\n`;
      fs.writeFileSync(envPath, updated, 'utf8');
    } catch (error) {
      this.logger.warn(
        `Failed to persist refresh token to .env — a restart before the ` +
          `next rotation will need a fresh capture: ${String(error)}`,
      );
    }
  }
}
