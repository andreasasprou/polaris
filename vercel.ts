import type { VercelConfig } from "@vercel/config/v1";

export const config: VercelConfig = {
  crons: [
    {
      path: "/api/cron/sweeper",
      schedule: "*/2 * * * *", // Every 2 minutes
    },
  ],
};
