import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

@Injectable()
export class DeadlineWatcherService {
  // TODO: daily check against bootstrap-static's next deadline; schedule the
  // actual pipeline run for `deadlineLeadHours` before it. Never hardcode a weekday.
  @Cron(CronExpression.EVERY_DAY_AT_NOON)
  checkDeadline() {
    return;
  }
}
