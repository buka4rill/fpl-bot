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
  },
  database: {
    url: process.env.DATABASE_URL || undefined,
    host: process.env.DATABASE_HOST ?? 'localhost',
    port: Number(process.env.DATABASE_PORT ?? 5432),
    name: process.env.DATABASE_NAME ?? 'fpl_bot',
    user: process.env.DATABASE_USER ?? 'fpl_bot',
    password: process.env.DATABASE_PASSWORD ?? 'fpl_bot',
  },
});
