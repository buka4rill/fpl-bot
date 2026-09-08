export interface AppConfig {
  fpl: {
    teamId: string;
    refreshToken: string;
  };
  auth: {
    pushSecret: string;
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
    host: process.env.DATABASE_HOST ?? 'localhost',
    port: Number(process.env.DATABASE_PORT ?? 5432),
    name: process.env.DATABASE_NAME ?? 'fpl_bot',
    user: process.env.DATABASE_USER ?? 'fpl_bot',
    password: process.env.DATABASE_PASSWORD ?? 'fpl_bot',
  },
});
