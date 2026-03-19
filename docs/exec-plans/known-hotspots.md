# Known Hotspots

_Last updated: 2026-03-19_

Issues here are local context for agents. Actionable items should also be GitHub issues.

- **Session reconciliation scattered across 3 locations**: GET handler, prompt liveness check, and DELETE handler each independently reconcile session status. Adding new statuses requires updating all three.
- **Callback URL duplication**: `buildCallbackUrl()` is duplicated in `prompt-dispatch.ts`, `sandbox-lifecycle.ts`, and `coding-task.ts` (pr-review and sweeper already use the shared version).
- **GitHub install/callback routes hardcode localhost:3000**: `app/api/integrations/github/install/route.ts` and `callback/route.ts` both default to `http://localhost:3000` instead of using `APP_BASE_URL`.
- **sandbox-agent persist hardcodes schema**: Both `lib/sandbox-agent/persist.ts` and `lib/sandbox-proxy/index.ts` hardcode `schema: "sandbox_agent"`, preventing per-schema DB isolation.
- **Drizzle migrations reference `"public".*`**: 36 occurrences of `"public".*` in FK references across migration files, blocking schema-per-worktree isolation.
