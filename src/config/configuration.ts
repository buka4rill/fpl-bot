export interface AppConfig {
  fpl: {
    teamId: string;
    refreshToken: string;
  };
  telegram: {
    botToken: string;
    chatId: string;
  };
  scheduler: {
    deadlineLeadHours: number;
  };
}

export default (): AppConfig => ({
  fpl: {
    teamId: process.env.FPL_TEAM_ID ?? '',
    refreshToken: process.env.FPL_REFRESH_TOKEN ?? '',
  },
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN ?? '',
    chatId: process.env.TELEGRAM_CHAT_ID ?? '',
  },
  scheduler: {
    deadlineLeadHours: Number(process.env.DEADLINE_LEAD_HOURS ?? 24),
  },
});
