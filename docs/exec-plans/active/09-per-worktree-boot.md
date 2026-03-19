---
title: Per-Worktree App Booting for Isolated Agent Validation
status: completed
created: 2026-03-19
owner: andreas
related_prs: []
domains: [scripts, app/api, lib/auth, lib/db, CLAUDE.md]
---

# 09 — Per-Worktree App Booting

## Problem Statement

### What
Agents cannot verify changes against a running app instance. Port conflict (single port 3001), database conflict (shared Postgres), and no boot automation prevent isolated validation.

### Why
The Codex blog: "we made the app bootable per git worktree, so Codex could launch and drive one instance per change." Without this, every visual change requires human verification.

## Design Decisions

### Database Isolation: Deferred (Phase 2 — separate spike)

**Original assumption was wrong.** The plan originally claimed "zero-code-change schema isolation" based on `tests/helpers/db.ts`. Codex review found this is false:

1. **Drizzle migrations hardcode `"public".*`**: At least 36 references across migration files use `"public"."table_name"` in foreign key definitions. `SET search_path` does not redirect these — they resolve to the public schema regardless.
2. **sandbox-agent persistence hardcodes schema**: The sandbox-agent persist drivers use `schema: "sandbox_agent"`, bypassing search_path.
3. **Test helper is a weakened harness, not proof**: `tests/helpers/db.ts` uses a single `Client` (not `Pool`), strips all `REFERENCES`/`FOREIGN KEY` clauses, strips `DROP CONSTRAINT` statements, and strips `DO $$ ... END $$` blocks. It works by *removing* the constraints that would break, not by proving they work in a custom schema.

Database isolation requires fixing Drizzle migrations to remove `"public"`-qualified FK refs, making sandbox-agent persistence schema-aware, and validating the full migration journal in a non-public schema. This is a separate plan (see Decision Log).

**For Phase 1, all worktrees share the same database.** This is sufficient for UI verification and local development. Full sandbox flows already hit a shared DB in production.

**Why not SQLite?** Polaris uses pg-specific features (FOR UPDATE, ON CONFLICT, advisory locks).

### Worktree Identity

Use a hash of the full worktree path (`wt_<sha256(abs_path)[:12]>`) rather than the first 12 characters of the directory name. First-12-chars will collide for long paths that share a prefix.

### Port Isolation: Ephemeral

Next.js respects `PORT` env var. Script finds available port in 3100-3999. Propagates to `APP_BASE_URL` and `BETTER_AUTH_URL`.

### Auth: Exact origin via env var

Since the boot script knows the chosen port, use the exact origin (e.g. `http://localhost:3142`) rather than a wildcard. Set `BETTER_AUTH_URL=http://localhost:<port>` dynamically in the boot script. The auth config reads this env var to set `trustedOrigins` to the exact origin.

## Implementation Plan

### Phase 1: Port Isolation + Health + URL Helper + Auth (do now)

**1.1 Add `/api/health` endpoint** (`app/api/health/route.ts`)
- Returns DB connectivity, migration status, timestamp
- No auth required
- Agents use to confirm readiness

**1.2 Make `trustedOrigins` dynamic** (`lib/auth/index.ts`)
- Read `BETTER_AUTH_URL` env var; use exact origin in `trustedOrigins` for dev

**1.3 Centralize callback URL resolution**
- Extract duplicate fallback logic from 3 files into `lib/config/urls.ts`
- Reads `APP_BASE_URL`, falls back to `http://localhost:${PORT ?? 3001}`
- Direct duplication in: `sessions/sandbox-lifecycle.ts`, `sessions/prompt-dispatch.ts`, `orchestration/coding-task.ts`
- Note: `orchestration/pr-review.ts` and `jobs/sweeper.ts` already use `buildCallbackUrl()`
- Note: GitHub install/callback routes (`app/api/integrations/github/install/route.ts`, `app/api/integrations/github/callback/route.ts`) have ADDITIONAL base URL duplication hardcoded to `localhost:3000` — include these in the centralized helper

**1.4 Boot & Teardown Scripts**

`scripts/boot-worktree.sh`:
- Derive worktree identity from hash of full directory path
- Find available port (3100-3999)
- Run `pnpm install` (fast with pnpm store, but needed — worktrees don't inherit node_modules)
- Set env vars: `PORT`, `APP_BASE_URL`, `BETTER_AUTH_URL`
- Start dev server
- Wait for `/api/health` (120s timeout)
- Write PID file for teardown
- Output machine-readable JSON: `{"url":"http://localhost:3142","worktreeId":"wt_a1b2c3d4e5f6","pid":12345}`

`scripts/teardown-worktree.sh`:
- Read PID file, kill server
- Clean up PID file

`--foreground` mode: Trap SIGINT/SIGTERM → auto-teardown on exit

**1.5 Agent Integration**
- Add `pnpm boot:worktree` and `pnpm teardown:worktree` scripts
- Update CLAUDE.md with boot process documentation

### Phase 2: Database Isolation (separate spike — do later)

This phase is blocked on fundamental migration issues and should be treated as a separate plan.

**2.1 Fix Drizzle migrations**: Remove all `"public".*`-qualified FK references so schemas resolve via search_path.
**2.2 Make sandbox-agent persistence schema-aware**: Remove hardcoded `schema: "sandbox_agent"`.
**2.3 Validate full migration journal** in a non-public schema with all FKs intact (no stripping).
**2.4 Create `scripts/lib/worktree-db.ts`**: Schema create/drop/migrate utilities.
**2.5 Update boot script** to create/migrate schema and pass isolated `DATABASE_URL`.

### Phase 3: Observability (stretch)

Per-worktree log file + `GET /api/health/logs` endpoint.

## Dependency Graph

```
Phase 1.1 (/api/health)    ──┐
Phase 1.2 (auth origin)    ──┼── Phase 1.4 (boot script) ── Phase 1.5 (agent integration)
Phase 1.3 (callback URL)   ──┘

Phase 2 (db isolation spike) — independent, no dependency on Phase 1
```

## Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Turbopack cold start exceeds 120s | Low | Increase timeout. Or use `next build` + `start`. |
| Port exhaustion from leaked servers | Medium | `teardown-all-worktrees.sh` reads all PID files |
| node_modules not inherited by worktrees | Low | Boot script runs `pnpm install` (cheap with pnpm store). `.env` must be symlinked or copied. |
| Cookie collision across ports | Medium | Browser cookies are scoped by host, not port. Multiple localhost worktrees share Better Auth cookies — logging into one overwrites another. Use incognito or separate browser profiles per worktree. |
| Callback reachability from sandboxes | High | Remote Vercel sandboxes cannot call back to `http://localhost:<port>/api/callbacks`. Per-worktree local boot enables UI validation only, not full sandbox flows. This is a known limitation. |
| GitHub OAuth callback pinning | Medium | If GitHub App callback URL is pinned to one localhost URL, multi-port auth flows break. For local dev, either use a single auth worktree or update the callback URL per session. |
| Port scan race condition | Low | Check-then-bind can race if two worktrees boot simultaneously. Use atomic bind (attempt listen, retry next port on EADDRINUSE) rather than pre-checking. |

## Effort

| Phase | Effort | Value |
|-------|--------|-------|
| 1 (port isolation + health + URL helper + auth + scripts) | ~2h | High — unblocks agent-driven UI verification |
| 2 (db isolation spike) | Unknown — separate plan | Medium — only needed if worktrees must have isolated data |
| 3 (observability) | 1h | Low — defer |

## Decision Log

| Date | Decision | Rationale | Alternatives |
|------|----------|-----------|-------------|
| 2026-03-19 | Port range 3100-3999 | Avoids main dev server (3001) and common service ports | Random port: harder to predict for firewall rules |
| 2026-03-19 | Exact origin via BETTER_AUTH_URL | Boot script knows the port; exact origin is more secure than wildcard | `http://localhost:*`: works but overly permissive |
| 2026-03-19 | Worktree ID = hash of full path | First-12-chars collides for paths with shared prefixes | First-N-chars: collision risk |
| 2026-03-19 | Defer schema-per-worktree to Phase 2 | Codex review found Drizzle migrations hardcode `"public".*` in FKs (36 refs across 3 migration files), and sandbox-agent persistence hardcodes `schema: "sandbox_agent"`. `tests/helpers/db.ts` only works by stripping FKs, DROP CONSTRAINT, and DO $$ blocks — it's a weakened harness, not proof of production viability. Schema isolation requires a dedicated spike. | Original plan: schema-per-worktree in Phase 2 with "zero code changes" |

## Progress

- [ ] Phase 1.1: Add /api/health
- [ ] Phase 1.2: Dynamic trustedOrigins via BETTER_AUTH_URL
- [ ] Phase 1.3: Centralize callback URL (3 direct dupes + 2 GitHub routes)
- [ ] Phase 1.4: boot-worktree.sh + teardown-worktree.sh
- [ ] Phase 1.5: package.json scripts + CLAUDE.md docs
- [ ] Phase 2: DB isolation spike (separate plan — blocked on migration fixes)

## Completion Criteria

- [ ] `pnpm boot:worktree $(pwd)` starts server on an isolated port
- [ ] `/api/health` confirms DB connectivity
- [ ] Two worktree servers can boot on different ports simultaneously. UI verification works against each independently. Full sandbox flows require shared DB (known limitation).
- [ ] `pnpm teardown:worktree` cleans up server process
- [ ] CLAUDE.md documents boot process
- [ ] `pnpm typecheck` passes
