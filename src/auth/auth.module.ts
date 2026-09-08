import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { FplAuthClient } from './clients/fpl-auth.client';
import { AlertModule } from '../alert/alert.module';

// The most isolated module in the app (CLAUDE.md's hard constraint) — the
// only place FplAuthClient (and therefore the authenticated FPL session)
// is instantiated. ExecutionModule is the one other module allowed to
// import this and use FplAuthClient directly, for the actual write calls;
// everything else should go through AuthService's narrow status-check
// surface instead.
@Module({
  imports: [HttpModule, AlertModule],
  controllers: [AuthController],
  providers: [AuthService, FplAuthClient],
  exports: [AuthService, FplAuthClient],
})
export class AuthModule {}
