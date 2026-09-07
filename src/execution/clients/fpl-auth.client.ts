import { Injectable } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';

// The ONLY client in the system allowed to hold an authenticated FPL session.
// Talks to undocumented endpoints (users.premierleague.com login, /api/my-team/,
// /api/transfers/) — see ARCHITECTURE.md §4. Capture exact request/response
// shapes from a real browser session before implementing; contracts here can
// drift without notice.
@Injectable()
export class FplAuthClient {
  constructor(
    private readonly http: HttpService,
    private readonly config: ConfigService,
  ) {}

  // TODO: login(), getMyTeam(), submitTransfers(), setLineup(), playChip()
}
