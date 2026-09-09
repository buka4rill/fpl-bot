export interface AppConfig {
  fpl: {
    teamId: string;
    refreshToken: string;
  };
  auth: {
    pushSecret: string;
    // Path to a file on a mounted persistent volume (e.g. Fly.io) where the
    // refresh token is read/written instead of rewriting .env — most PaaS
    // hosts give the app an ephemeral filesystem, so .env wouldn't survive
    // a restart there. Unset locally, where the .env rewrite still applies.
    tokenStorePath: string | undefined;
  };
  telegram: {
    botToken: string;
    chatId: string;
  };
  scheduler: {
    deadlineLeadHours: number;
  };
  optimizer: {
    maxHitsPerWeek: number;
    hitRiskPremium: number;
    chipRiskPremium: number;
  };
  execution: {
    // How long to keep re-checking FPL's my-team endpoint for a declared
    // chip to show as actually played before giving up and reporting
    // execution as failed (ExecutionService.apply). FPL's backend doesn't
    // always finish propagating a chip-active state immediately. Widened
    // twice live on 2026-09-09 (6s, then 40s) and still hit a third false
    // "execution FAILED" for a chip that had actually landed — each time
    // confirmed genuinely active via a later, unrelated /status check. Now
    // 15 retries * 8s = 120s, plus (same day) each attempt is logged and
    // persisted on the execution log's `chipConfirmationAttempts`, so if
    // this recurs there's finally real data instead of guessing at the
    // number again. Widening costs little either way — the deadline is
    // always hours away — while a false negative causes real confusion and
    // an unnecessary "make this change manually" prompt.
    chipConfirmationRetries: number;
    chipConfirmationRetryDelayMs: number;
  };
  database: {
    // Set in production (e.g. `fly postgres attach` injects this) — takes
    // priority over the discrete host/port/name/user/password fields below
    // when present. Local dev (docker-compose) uses the discrete fields.
    url: string | undefined;
    host: string;
    port: number;
    name: string;
    user: string;
    password: string;
  };
  narrative: {
    // Unset means the feature is off, not misconfigured — NarrativeService
    // treats a missing key as "skip the rationale for this alert" rather
    // than throwing, same as every other best-effort feature in this app
    // (see CLAUDE.md, issue #8).
    anthropicApiKey: string | undefined;
    model: string;
  };
}

export default (): AppConfig => ({
  fpl: {
    teamId: process.env.FPL_TEAM_ID ?? '',
    refreshToken: process.env.FPL_REFRESH_TOKEN ?? '',
  },
  auth: {
    pushSecret: process.env.AUTH_PUSH_SECRET ?? '',
    tokenStorePath: process.env.TOKEN_STORE_PATH || undefined,
  },
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN ?? '',
    chatId: process.env.TELEGRAM_CHAT_ID ?? '',
  },
  scheduler: {
    deadlineLeadHours: Number(process.env.DEADLINE_LEAD_HOURS ?? 24),
  },
  optimizer: {
    maxHitsPerWeek: Number(process.env.OPTIMIZER_MAX_HITS_PER_WEEK ?? 1),
    hitRiskPremium: Number(process.env.OPTIMIZER_HIT_RISK_PREMIUM ?? 4),
    chipRiskPremium: Number(process.env.OPTIMIZER_CHIP_RISK_PREMIUM ?? 8),
  },
  execution: {
    chipConfirmationRetries: Number(
      process.env.EXECUTION_CHIP_CONFIRMATION_RETRIES ?? 15,
    ),
    chipConfirmationRetryDelayMs: Number(
      process.env.EXECUTION_CHIP_CONFIRMATION_RETRY_DELAY_MS ?? 8000,
    ),
  },
  database: {
    url: process.env.DATABASE_URL || undefined,
    host: process.env.DATABASE_HOST ?? 'localhost',
    port: Number(process.env.DATABASE_PORT ?? 5432),
    name: process.env.DATABASE_NAME ?? 'fpl_bot',
    user: process.env.DATABASE_USER ?? 'fpl_bot',
    password: process.env.DATABASE_PASSWORD ?? 'fpl_bot',
  },
  narrative: {
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || undefined,
    model: process.env.NARRATIVE_MODEL ?? 'claude-haiku-4-5',
  },
});
