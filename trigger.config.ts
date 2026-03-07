import { defineConfig } from "@trigger.dev/sdk/v3";

export default defineConfig({
  project: "proj_oqqhbqagsmckcrxgpscx",
  runtime: "node",
  logLevel: "log",
  maxDuration: 3600,
  retries: {
    enabledInDev: false,
    default: {
      maxAttempts: 3,
      minTimeoutInMs: 1000,
      maxTimeoutInMs: 10000,
      factor: 2,
    },
  },
  dirs: ["./trigger"],
  build: {
    external: ["@vercel/sandbox"],
  },
});
