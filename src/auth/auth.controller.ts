import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'crypto';
import { AuthService } from './auth.service';
import { AlertService } from '../alert/alert.service';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly alertService: AlertService,
    private readonly config: ConfigService,
  ) {}

  // Landing spot for scripts/auth-login.ts's Playwright-assisted capture —
  // the only way a freshly-captured refresh token gets applied to a
  // *running* instance, rather than editing .env by hand and restarting.
  // Guarded by a shared secret (AUTH_PUSH_SECRET), not the Telegram chat
  // gate the rest of the app uses, since this is meant to be called from a
  // local script, not Telegram — and it's a public route once deployed, so
  // it fails closed (rejects everything) if the secret isn't configured at
  // all, rather than silently accepting any request.
  @Post('token')
  @HttpCode(200)
  async receiveToken(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: { refreshToken?: string },
  ): Promise<{ ok: true }> {
    this.assertPushSecret(authorization);
    if (!body.refreshToken) {
      throw new UnauthorizedException('refreshToken is required.');
    }

    this.authService.applyRefreshToken(body.refreshToken);
    await this.alertService.sendMessage(
      "✅ FPL login updated. I'll pick this back up on the next check — or retry right away if you triggered this yourself.",
    );
    return { ok: true };
  }

  private assertPushSecret(authorization: string | undefined): void {
    const expected = this.config.get<string>('auth.pushSecret');
    const provided = authorization?.startsWith('Bearer ')
      ? authorization.slice('Bearer '.length)
      : undefined;

    if (!expected || !provided || !this.safeEqual(expected, provided)) {
      throw new UnauthorizedException('Invalid or missing push secret.');
    }
  }

  // Constant-time comparison — a plain `===` would leak how many leading
  // characters matched via response timing. Overkill for a single-user
  // hobby bot maybe, but cheap to do properly.
  private safeEqual(a: string, b: string): boolean {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) return false;
    return timingSafeEqual(bufA, bufB);
  }
}
