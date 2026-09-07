import { Injectable } from '@nestjs/common';
import { FplAuthClient } from './clients/fpl-auth.client';

@Injectable()
export class ExecutionService {
  constructor(private readonly fplAuthClient: FplAuthClient) {}

  // TODO: only ever invoked from an APPROVED proposal. Re-validate the
  // deadline hasn't passed, apply the change, write a full audit record.
}
