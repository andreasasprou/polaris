<!-- Line budget: 80 lines max. Graduate detailed content to docs/ or ARCHITECTURE.md -->
# Polaris — Claude Code Instructions

## Architecture Principles

- **No plasters.** Don't patch edge cases with one-off fixes. Design primitives and flows so they handle all states as first-class citizens.
- **Data produces correct state; UI just renders.** The consolidation/data layer should handle all state transitions (terminal sessions, interrupted tool calls, etc.) so consumers never need special-case logic.
- **Context parameters over data mutation.** When the data layer needs external context (e.g. "is this session terminal?"), pass it as a parameter — don't inject synthetic events or mutate the event log.

## Codebase Navigation

- **Structural map**: See `ARCHITECTURE.md` for module map, state machines, invariants, and request lifecycle traces.
- **Deep-dive docs**: `docs/architecture/` — session continuation, event display, v2 architecture.
- **Execution plans**: `docs/exec-plans/active/` — check before starting complex work.
- **Reference docs**: `docs/references/` — LLM-optimized API docs for Vercel Sandbox, sandbox-agent, ACP.

## URL Routing

All dashboard URLs are org-scoped: `/{orgSlug}/dashboard`, `/{orgSlug}/sessions/{id}`, etc.

- **Route structure**: `app/(dashboard)/[orgSlug]/` contains all dashboard pages. The `[orgSlug]` layout validates the slug, checks membership, and syncs `activeOrganizationId`.
- **Link helpers**: Use `useOrgPath()` hook in client components (`op("/runs")`) and `orgPath(orgSlug, path)` in server components. Never hardcode bare paths like `/sessions/...`.
- **External links**: Use `orgUrl(slug, path)` from `lib/config/urls.ts` for GitHub check run detail URLs and similar.
- **Legacy redirects**: `app/(legacy-redirect)/` handles old bare-path bookmarks by resolving the resource's org from DB and redirecting.
- **Auth protection**: `proxy.ts` protects org-scoped paths and sets the `polaris_org_slug` cookie.
- **Reserved slugs**: `RESERVED_SLUGS` in `lib/config/urls.ts` — org slugs cannot collide with `api`, `login`, `onboarding`, `_next`.

## Where to Start

Pick the flow closest to your task. Paths show the recommended reading order:

- **Changing URL routing or org context?** `proxy.ts` → `app/(dashboard)/[orgSlug]/layout.tsx` → `lib/config/urls.ts` → `hooks/use-org-path.ts`
- **Changing session lifecycle?** `lib/sessions/status.ts` → `lib/sessions/actions.ts` → `lib/orchestration/sandbox-lifecycle.ts`
- **Modifying PR review logic?** `lib/reviews/prompt-builder.ts` → `lib/orchestration/pr-review.ts` → `lib/reviews/output-parser.ts`
- **Changing inline review comments?** `lib/reviews/inline-comments.ts` → `lib/reviews/github.ts` (postInlineReview, resolveReviewThreads) → `lib/orchestration/postprocess.ts` (steps 2c, 5)
- **Adding a new session status?** Add to `lib/sessions/status.ts` STATUS_CONFIG → Update `hooks/use-session-chat.ts` → Update `components/sessions/session-status.tsx`
- **Changing sandbox/agent communication?** `lib/sandbox-proxy/server.ts` → `lib/sandbox-proxy/types.ts` → rebuild with `pnpm build:proxy`
- **Modifying event consolidation?** `lib/sandbox-agent/event-types.ts` (consolidateEvents) → `hooks/use-session-chat.ts` (consumer)
- **Working with jobs/sweeper?** `lib/jobs/schema.ts` → `lib/jobs/actions.ts` → `lib/orchestration/sweeper.ts` → `lib/orchestration/callback-processor.ts`
- **Sandbox provisioning/health?** `lib/sandbox/SandboxManager.ts` → `lib/sandbox/SandboxHealthMonitor.ts` → `lib/sandbox/GitOperations.ts`

## Anti-Patterns

These have caused real production bugs — avoid them:

- **Never use Bearer auth for git HTTPS** — use `Basic base64(x-access-token:<token>)`. Bearer fails silently in sandbox.
- **Never check stderr for git push success** — git writes progress to stderr on success. Check `exitCode === 0`.
- **Always call `endStaleRuntimes(sessionId)` before `createRuntime()`** — unique constraint `idx_one_live_runtime_per_session` will throw otherwise.
- **Always wrap CAS + dispatch in try/catch with rollback** — if dispatch throws after CAS, the session gets stuck at "creating" forever.
- **When adding a new session status, update ALL `statusConfig` locations** — `lib/sessions/status.ts`, `hooks/use-session-chat.ts`, and `components/sessions/session-status.tsx`.
- **Sandbox proxy is bundled, not live code** — `lib/sandbox-proxy/` runs inside the VM. Changes require rebuilding (`pnpm build:proxy`) and redeploying.
- **Never use `git diff A..B` syntax** — it's invalid for `git diff`. Use `git diff A B` (separate args) or `git log A..B` for log.
- **Don't trust `git diff --cached origin/main` in sandbox** — can return empty even with staged changes. Use `git show --stat` as fallback.
- **Never pass production credentials (DATABASE_URL, secrets) to sandbox VMs** — the sandbox runs untrusted agent code that can read process env vars. Use callback-based patterns to persist data platform-side instead. The proxy collects events in-memory and sends them in callbacks; the platform persists them.
- **Never use `useEffect` directly** — use derived state, event handlers, `useQuery`, `useMountEffect`, or `key` resets. See [`docs/guides/no-use-effect.md`](docs/guides/no-use-effect.md).
- **Never hand-write migration files** — always use `drizzle-kit generate` so the SQL, journal entry, and snapshot stay in sync. Hand-written SQL without a journal entry won't run on deploy (`scripts/vercel-build.mjs` calls `drizzle-kit migrate` which reads `meta/_journal.json`).

## Testing & Verification

**Always verify your own work.** Run `pnpm typecheck` before considering any change complete.

1. **Typecheck**: `pnpm typecheck` must pass.
2. **Tests**: `pnpm test` (unit + integration) must pass. Use `pnpm test:unit` for fast feedback.
3. **Visual verification** (UI changes): Use browser automation at `http://localhost:3001`.
   Verify all session states: active (spinner), completed (checkmarks), failed/stopped (interrupted ■), hibernated/resumed.
4. **Data verification**: Query `/api/interactive-sessions/[id]` and `/api/sessions/[id]/events` to confirm data consistency.
5. **Run traces**: Query the `jobs` / `job_attempts` tables or hit `GET /api/jobs/[id]` to inspect dispatch lifecycle.
6. **Terminal session checklist**: `turnInProgress` must be `false`, all pending tool calls show interrupted (not spinner), `pollIntervalMs` must be `0`.
7. **Full QA matrix**: See `docs/qa-checklist.md` for the complete state matrix and flow test list.

## Observability

Production logs go to **Axiom** via evlog. Use Axiom MCP tools to debug.

1. **Query the `vercel` dataset** — contains all request logs with structured wide events from evlog.
   - Filter by path: `['vercel'] | where ['request.path'] == "/api/webhooks/github"`
   - Find errors: `['vercel'] | where level == "error" | project _time, message`
   - The `message` field contains JSON with structured context (`webhook.*`, `dispatch.*`, `sweep.*`, `router.*`, `error.*`).
2. **Always set a time range** — use `startTime`/`endTime` params (e.g. `now-30m`).
3. **Get schema first** — run `['vercel'] | take 1` to see available fields before writing complex queries.
4. **Key fields**: `request.path`, `request.statusCode`, `level`, `message` (JSON string with evlog wide event data).

## Local Development

- **Dev server**: `pnpm dev` → `https://polaris.localhost:1355` (uses [portless](https://github.com/nicolo-ribaudo/portless) for HTTPS + stable URL). Use `pnpm dev:raw` to bypass portless.
- **Setup guide**: See [`docs/guides/local-dev-e2e-testing.md`](docs/guides/local-dev-e2e-testing.md) for full setup including GitHub App creation, test user seeding, and E2E testing with `agent-browser`.
- **GitHub App setup**: `pnpm tsx scripts/setup-github-app.ts` — interactive script that creates a test GitHub App via the manifest flow, exchanges credentials, and writes them to `.env`.
- **DB migrations**: `pnpm drizzle-kit push` to sync local schema with code.

## Key Commands

- `pnpm typecheck` — must pass before considering work complete
- `pnpm test` — all tests (unit + integration)
- `pnpm test:unit` — fast unit tests only (no DB)
- `pnpm dev` — local dev server at `https://polaris.localhost:1355`
- `pnpm dev:raw` — plain Next.js at `http://localhost:3000` (no portless)
- `pnpm tsx scripts/setup-github-app.ts` — create test GitHub App
