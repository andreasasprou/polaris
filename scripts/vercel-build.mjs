import { execSync } from "node:child_process";

const run = (cmd) => execSync(cmd, { stdio: "inherit" });

const env = process.env.VERCEL_ENV; // "production" | "preview" | "development"

if (env === "production") {
  console.log("Running database migrations…");
  run("pnpm drizzle-kit migrate");
}

run("next build");
