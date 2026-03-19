import { createEvlog } from "evlog/next";

export const { withEvlog, useLogger, log, createError } = createEvlog({
  service: "polaris",
  routes: {
    "/api/webhooks/**": { service: "polaris-webhooks" },
    "/api/callbacks/**": { service: "polaris-callbacks" },
    "/api/cron/**": { service: "polaris-cron" },
    "/api/interactive-sessions/**": { service: "polaris-sessions" },
  },
  enrich: (ctx) => {
    if (process.env.VERCEL_REGION) ctx.event.region = process.env.VERCEL_REGION;
    ctx.event.environment = process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "development";
    if (process.env.VERCEL_GIT_COMMIT_SHA) ctx.event.gitSha = process.env.VERCEL_GIT_COMMIT_SHA.slice(0, 8);
  },
  sampling: { keep: [{ status: 400 }, { status: 500 }, { duration: 2000 }] },
});
