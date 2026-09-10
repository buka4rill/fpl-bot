import { Injectable, UnauthorizedException } from '@nestjs/common';
import { FplAuthClient } from './clients/fpl-auth.client';

// Thin public wrapper around FplAuthClient — same "only exposes a derived
// shape, keeping FplAuthClient the one place holding the authenticated
// session" principle as ExecutionService's own passthroughs. Everything
// outside AuthModule and ExecutionModule (the one other module allowed to
// use FplAuthClient directly, for the actual write calls) should go through
// this rather than reaching for FplAuthClient itself.
@Injectable()
export class AuthService {
  constructor(private readonly fplAuthClient: FplAuthClient) {}

  isAuthenticated(): Promise<boolean> {
    return this.fplAuthClient.isAuthenticated();
  }

  // Throws a clear, actionable error (not a raw OIDC/axios error) when not
  // authenticated — for manual endpoints to call before attempting a live
  // flow, so a logged-out state surfaces as "here's what to do" rather than
  // a bare 500. UnauthorizedException (not a plain Error) so Nest's default
  // exception filter actually returns this message over HTTP instead of a
  // generic 500 — a plain Error gets swallowed as "Internal server error".
  async assertAuthenticated(): Promise<void> {
    if (await this.isAuthenticated()) return;
    throw new UnauthorizedException(
      'Not authenticated with FPL — run `pnpm run auth:login` on your ' +
        'machine to log back in, then retry.',
    );
  }

  applyRefreshToken(refreshToken: string): void {
    this.fplAuthClient.applyRefreshToken(refreshToken);
  }
}
