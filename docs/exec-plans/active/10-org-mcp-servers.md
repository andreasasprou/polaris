---
title: Org-Level MCP Server Configuration
status: planned
created: 2026-03-20
owner: andreas
related_prs: []
domains: [lib/mcp-servers, lib/sandbox-proxy, lib/sandbox-agent, lib/orchestration, app/api/mcp-servers, app/(dashboard)/settings/mcp]
---

# 10 — Org-Level MCP Server Configuration

This ExecPlan is a living document. The sections Progress, Surprises & Discoveries, Decision Log, and Outcomes & Retrospective must be kept up to date as work proceeds. This document must be maintained in accordance with docs/exec-plans/PLANS.md (if present) or the ExecPlan format described in the project's agent instructions.

## Purpose / Big Picture

Polaris agents run inside Vercel Sandbox VMs. Each agent session can connect to MCP (Model Context Protocol) servers — external tool providers like Sentry, Datadog, or custom internal tools. Today, `mcpServers: []` is hardcoded in every session creation path, meaning agents have no access to external tools.

After this change, an org admin can go to Settings > MCP Servers, add a remote MCP server with static auth headers, and every subsequent agent session in that org will automatically have access to the configured tools. The agent sees the MCP server's tools in its tool list and can call them during prompts. A second phase adds OAuth 2.1 support for servers that require it (Sentry, etc.).

To see it working: add a server at `http://localhost:3001/settings/mcp`, then dispatch a prompt to any session. The proxy POST body will include the configured `mcpServers` array, and the sandbox-agent SDK will connect to those servers when creating the ACP session.

## Progress

- [x] (2026-03-20) Milestone 1: Database schema, types, actions, queries
- [x] (2026-03-20) Milestone 2: API routes for CRUD
- [x] (2026-03-20) Milestone 3: Settings UI for static servers
- [x] (2026-03-20) Milestone 4: Proxy protocol threading (acp-bridge)
- [x] (2026-03-20) Milestone 5: Dispatch integration (all 4 sites)
- [x] (2026-03-20) Milestone 6: Static-auth end-to-end validation
- [x] (2026-03-20) Milestone 7: OAuth schema extensions + flow routes
- [x] (2026-03-20) Milestone 8: OAuth UI + end-to-end validation
- [ ] (Optional) Milestone 9: SandboxAgentClient parity

## Surprises & Discoveries

- Observation: The ACP SDK's `McpServer` type uses `{ name, url, type: "http"|"sse", headers: Array<{ name, value }> }` — not a simple `Record<string, string>` for headers, and requires `name` and `type` fields. Our simpler format in `PromptConfig` needs conversion.
  Evidence: TypeScript error `Type '{ url: string; ... }' is not assignable to type 'McpServerSse & { type: "sse" }'` when passing our format directly. Fixed by adding `toSdkMcpServers()` conversion function in acp-bridge.ts.

- Observation: The `type` field must use `as const` literal types ("http" | "sse"), not plain string, to satisfy the SDK's discriminated union.
  Evidence: `Type 'string' is not assignable to type '"sse"'`. Fixed with `("sse" as const)`.

- Observation: The worktree does not have `node_modules` symlinked by default. `pnpm install` is required before any tooling (drizzle-kit, tsc) works.
  Evidence: `pnpm exec drizzle-kit generate` failed with `Command "drizzle-kit" not found` until `pnpm install` was run.

- Observation: Integration tests fail in this worktree due to no database connection. Unit tests pass cleanly.
  Evidence: 5 integration tests fail with `Cannot read properties of undefined (reading 'cleanup')`. All 283 unit tests pass.

## Decision Log

- Decision: Remote servers only (no stdio/local process MCP servers).
  Rationale: Sandbox VMs cannot spawn local processes outside the VM. Remote HTTP/SSE servers are the only viable transport. This avoids complexity with no user benefit.
  Date/Author: 2026-03-20 / andreas

- Decision: Per-org scope (not per-session or per-repo).
  Rationale: External tool access is an org-level concern — Sentry access, Datadog dashboards, etc. are shared across all repos. Per-session granularity adds complexity without clear demand. Can be narrowed later with a `scope` column.
  Date/Author: 2026-03-20 / andreas

- Decision: Static-first phasing — deliver static-header MCP servers end-to-end before adding OAuth.
  Rationale: Codex review identified that OAuth complexity was hiding completeness gaps in the data model and API layer. Static headers cover the majority of MCP servers (any server that accepts Bearer tokens). OAuth is a clean additive extension.
  Date/Author: 2026-03-20 / andreas

- Decision: No dynamic client registration. Require clientId as user input for OAuth servers.
  Rationale: Dynamic client registration is complex (spec-optional, most servers don't support it yet). Requiring clientId on the OAuth form is simpler, covers all known servers, and avoids a fallback chain. Can be added as a future enhancement.
  Date/Author: 2026-03-20 / andreas

- Decision: Centralize MCP server loading into a single helper, not scattered across 4 dispatch files.
  Rationale: The plan originally called for loading MCP servers independently in each dispatch file. This violates the "no plasters" principle. Instead, the resolution logic lives in one function (`getResolvedMcpServers` in `lib/mcp-servers/queries.ts`) that all dispatch sites call.
  Date/Author: 2026-03-20 / andreas

- Decision: Refresh OAuth tokens in parallel across servers, with 5-minute preemptive refresh window.
  Rationale: Sequential refresh of N OAuth servers adds N * latency to the dispatch hot path. Parallel refresh + preemptive window (refresh if expiresAt < now + 5min) means most dispatches hit cached tokens and pay zero latency.
  Date/Author: 2026-03-20 / andreas

- Decision: Drop `timeoutMs` field from initial implementation.
  Rationale: Codex review identified that timeoutMs was modeled in DB/API/UI but never consumed by the runtime types (McpServerEntry or PromptConfig). It's dead code. Can be added when the SDK supports per-server timeouts.
  Date/Author: 2026-03-20 / andreas

- Decision: SandboxAgentClient threading is optional cleanup (Milestone 9), not critical path.
  Rationale: All 4 live dispatch paths (prompt-dispatch, coding-task, pr-review, sweeper) POST to the sandbox proxy. SandboxAgentClient is not used by any live dispatch path. Threading mcpServers through it is correctness parity for when/if it becomes live again, but blocking on it delays the feature.
  Date/Author: 2026-03-20 / andreas

- Decision: Store OAuth setup metadata (clientId, endpoints, scopes) in dedicated DB columns, not in cookies or query params.
  Rationale: Codex review found that the original design collected OAuth metadata in the UI and passed it via query params / cookies, but never persisted it. After page reload, the "Connect" button wouldn't work because the metadata was gone. Storing in DB makes reconnect work after any page load.
  Date/Author: 2026-03-20 / andreas

## Outcomes & Retrospective

(To be completed after implementation.)

## Context and Orientation

Polaris is an autonomous coding agent platform. When a user sends a prompt to an interactive session (or an automation triggers a coding task / PR review), Polaris provisions a Vercel Sandbox VM, bootstraps an agent CLI (Claude Code, Codex, etc.) inside it, and POSTs the prompt to a REST proxy running in the sandbox. The proxy creates an ACP (Agent Communication Protocol) session with the agent, passing configuration including `sessionInit.mcpServers`. "ACP" is the Agent Communication Protocol — the JSON-RPC protocol between Polaris and the agent CLI.

The key files and their roles:

**Data layer pattern** — `lib/sandbox-env/` is the reference implementation for org-scoped encrypted data. It has:
- `schema.ts` — Drizzle pgTable definition for `sandbox_env_vars` with org scoping and a unique constraint on (organizationId, key).
- `actions.ts` — Write operations (`upsertEnvVar`, `deleteEnvVar`) that call `encrypt()` before insert.
- `queries.ts` — Read operations (`findEnvVarsByOrg` for UI metadata without decryption, `getDecryptedEnvVars` for runtime injection with decryption).

**API route pattern** — `app/api/sandbox-env-vars/route.ts` and `app/api/sandbox-env-vars/[id]/route.ts` are the reference API routes. Key conventions:
- All handlers are wrapped in `withEvlog()` from `@/lib/evlog` for structured logging.
- `getSessionWithOrg()` for auth — returns `{ session, orgId }`.
- Dynamic route params use Next 16 signature: `{ params }: { params: Promise<{ id: string }> }` — params must be `await`ed.
- DELETE returns `NextResponse.json({ ok: true })` (not 204).
- POST returns `NextResponse.json({ ... }, { status: 201 })`.

**Encryption** — `lib/credentials/encryption.ts` provides `encrypt(plaintext): string` and `decrypt(encoded): string` using AES-256-GCM. Format: `base64(iv + tag + ciphertext)`. Key: `ENCRYPTION_KEY` env var (32 bytes hex or raw).

**OAuth state signing** — `lib/integrations/github-state.ts` provides `signState(payload): string` and `verifyState(state): payload | null` using HMAC-SHA256 with `BETTER_AUTH_SECRET`. The signed state is `base64url(json).hmac` with expiry checking and timing-safe comparison.

**Proxy types** — `lib/sandbox-proxy/types.ts` defines `PromptConfig` (the config object in POST /prompt) at lines 14–25. Currently has: `agent`, `mode`, `model`, `effortLevel`, `modeIntent`, `sdkSessionId`, `nativeAgentSessionId`, `branch`, `cwd`, `env`. This is where `mcpServers` will be added.

**ACP bridge** (runs inside sandbox) — `lib/sandbox-proxy/acp-bridge.ts` creates ACP sessions. It has `mcpServers: []` hardcoded at 3 locations:
- Line 193: `sessionInit: { cwd: config.cwd, mcpServers: [] }` in `createSessionWithFallback` primary path
- Line 218: `sessionInit: { cwd: config.cwd, mcpServers: [] }` in `createSessionWithFallback` fallback path
- Line 286: `mcpServers: []` in `tryNativeResume` (function starts at line 250)

**SandboxAgentClient** — `lib/sandbox-agent/SandboxAgentClient.ts` is the server-side SDK client. It has a `SessionConfig` type at line 8 and `mcpServers: []` hardcoded at 5 locations (lines 132, 149, 188, 203, 262). NOTE: This client is NOT currently used by any live dispatch path — all 4 dispatch sites POST to the sandbox proxy directly. Threading mcpServers here is optional cleanup (Milestone 9).

**Dispatch sites** — Four files POST `/prompt` to the sandbox proxy with a `config` object:
1. `lib/orchestration/prompt-dispatch.ts` — interactive sessions. Config built at lines 170–173.
2. `lib/orchestration/coding-task.ts` — automation coding tasks. Config built at lines 166–171.
3. `lib/orchestration/pr-review.ts` — PR review automation. Config built at lines 379–385.
4. `lib/orchestration/sweeper.ts` — retry failed reviews. Config built at lines 446–452.

**Settings UI** — `app/(dashboard)/settings/page.tsx` is a card grid (lines 14–35) with links to sub-pages. `app/(dashboard)/settings/environment/page.tsx` is the reference UI: a client component with useState, fetch-based CRUD against `/api/sandbox-env-vars`, form with validation, and list with delete buttons.

**Auth** — `lib/auth/session.ts` exports `getSessionWithOrg()` which returns `{ session, orgId }` for authenticated routes. Redirects to /login if not authenticated.

**Database registration** — `lib/db/schema.ts` re-exports all table schemas via `export * from "..."` lines. New schemas must be added here for Drizzle to discover them.

**Migration output** — `drizzle.config.ts` sets `out: "./lib/db/migrations"`. Migrations go to `lib/db/migrations/`, NOT `drizzle/`.

**URL resolution** — `lib/config/urls.ts` provides `getAppBaseUrl(): string` which resolves the correct app origin across production, preview, and local dev (using `NEXT_PUBLIC_APP_URL`, `VERCEL_URL`, `APP_BASE_URL`, or `PORT` fallback). OAuth routes must use this helper for callback URLs, not ad-hoc env var lookups.

**Proxy build** — The proxy is built via `npx tsx lib/sandbox-proxy/build.ts` (see `lib/sandbox-proxy/build.ts` line 7). There is no `pnpm build:proxy` script. Output: `lib/sandbox-proxy/dist/proxy.js`.

## Plan of Work

The work is split into two phases. Phase A (Milestones 1–6) delivers static-header MCP servers end-to-end. Phase B (Milestones 7–8) adds OAuth 2.1 support. Milestone 9 is optional cleanup.

### Milestone 1: Database & Data Layer

Create `lib/mcp-servers/` with schema, types, actions, and queries.

**1a. Schema** — Create `lib/mcp-servers/schema.ts`. Follow the `lib/sandbox-env/schema.ts` pattern exactly.

Table `mcp_servers`:
- `id`: uuid PK (defaultRandom)
- `organizationId`: text NOT NULL
- `name`: text NOT NULL (display name, e.g. "Sentry Production")
- `serverUrl`: text NOT NULL (e.g. "https://mcp.sentry.dev/sse")
- `transport`: text NOT NULL DEFAULT "streamable-http" — either "streamable-http" or "sse" (matching MCP spec terminology; "streamable-http" is the current default transport, "sse" is the legacy server-sent-events transport)
- `authType`: text NOT NULL — either "static" or "oauth"
- `encryptedAuthConfig`: text (nullable — null for OAuth servers before authorization completes)
- `enabled`: boolean NOT NULL DEFAULT true
- `oauthClientId`: text (nullable — for OAuth servers, the client ID from the provider's developer console)
- `oauthAuthorizationEndpoint`: text (nullable — for OAuth servers, e.g. "https://sentry.io/oauth/authorize")
- `oauthTokenEndpoint`: text (nullable — for OAuth servers, e.g. "https://sentry.io/oauth/token")
- `oauthScopes`: text (nullable — space-separated scope string, e.g. "openid profile")
- `createdBy`: text (nullable)
- `createdAt`: timestamptz DEFAULT NOW() NOT NULL
- `updatedAt`: timestamptz DEFAULT NOW() NOT NULL
- UNIQUE constraint on (organizationId, name)

The OAuth columns (`oauthClientId`, `oauthAuthorizationEndpoint`, `oauthTokenEndpoint`, `oauthScopes`) store setup metadata in plaintext — they are not secrets. The encrypted auth tokens (access_token, refresh_token) go in `encryptedAuthConfig`.

Register the schema in `lib/db/schema.ts` by adding a new line: `export * from "@/lib/mcp-servers/schema";`

**1b. Types** — Create `lib/mcp-servers/types.ts`.

    // Decrypted auth config shapes (stored encrypted in DB)
    export type StaticAuthConfig = {
      headers: Record<string, string>;
    };

    export type OAuthAuthConfig = {
      accessToken: string;
      refreshToken: string;
      expiresAt: number; // unix epoch seconds
    };

    export type AuthConfig = StaticAuthConfig | OAuthAuthConfig;

    // SDK-ready format — this is what goes into sessionInit.mcpServers
    export type McpServerEntry = {
      url: string;
      transport?: "streamable-http" | "sse";
      headers?: Record<string, string>;
    };

Note: `OAuthAuthConfig` stores only the runtime tokens. Setup metadata (clientId, endpoints, scopes) lives in dedicated DB columns so the UI can display them and the "Connect" / "Reconnect" button works after page reload.

**1c. Actions** — Create `lib/mcp-servers/actions.ts`. Follow `lib/sandbox-env/actions.ts`.

    import { eq, and } from "drizzle-orm";
    import { db } from "@/lib/db";
    import { mcpServers } from "./schema";
    import { encrypt } from "@/lib/credentials/encryption";

- `createMcpServer({ organizationId, name, serverUrl, transport?, authType, authConfig?, oauthClientId?, oauthAuthorizationEndpoint?, oauthTokenEndpoint?, oauthScopes?, createdBy })` — if `authConfig` is provided, `encrypt(JSON.stringify(authConfig))` before insert. Returns the created row metadata (id, name, serverUrl, transport, authType, enabled, oauth columns, timestamps).
- `updateMcpServerAuth(id, organizationId, authConfig)` — encrypt and set `encryptedAuthConfig` + touch `updatedAt`. Used after OAuth flow completes or on token refresh.
- `deleteMcpServer(id, organizationId)` — delete with org scoping: `WHERE id = ? AND organizationId = ?`.
- `updateMcpServerEnabled(id, organizationId, enabled: boolean)` — toggle the enabled flag + touch `updatedAt`.
- `updateMcpServerHeaders(id, organizationId, headers: Record<string, string>)` — for static servers, encrypt new headers as StaticAuthConfig and set `encryptedAuthConfig` + touch `updatedAt`.
- `clearMcpServerAuth(id, organizationId)` — set `encryptedAuthConfig` to null + touch `updatedAt`. Called on fatal OAuth refresh failure (e.g. 401 from token endpoint) so the UI shows "Not connected" and prompts the admin to reconnect.

**1d. Queries** — Create `lib/mcp-servers/queries.ts`. Follow `lib/sandbox-env/queries.ts`.

    import { eq, and, isNotNull } from "drizzle-orm";
    import { db } from "@/lib/db";
    import { mcpServers } from "./schema";
    import { decrypt } from "@/lib/credentials/encryption";
    import type { StaticAuthConfig, OAuthAuthConfig, McpServerEntry } from "./types";

- `findMcpServersByOrg(orgId)` — metadata only for the UI list. Returns: id, name, serverUrl, transport, authType, enabled, oauthClientId, oauthAuthorizationEndpoint, oauthTokenEndpoint, oauthScopes, createdAt, updatedAt, and a computed `connected: boolean` (true when `encryptedAuthConfig IS NOT NULL`). Does NOT decrypt anything.

- `findMcpServerByIdAndOrg(id, orgId)` — single server with all columns including `encryptedAuthConfig`. Used by the OAuth start route and PATCH handler.

- `getResolvedMcpServers(orgId)` — the single resolution function for dispatch. Must be fail-open: if resolution throws for any individual server, that server is skipped (logged as warning), and the others are still returned. The function must never throw an exception that could strand a session in "active" status.

  Logic:
  1. Load all enabled servers for the org.
  2. For each server with `encryptedAuthConfig`:
     - **Static auth** (`authType === "static"`): decrypt config, return `{ url: serverUrl, transport, headers: config.headers }`.
     - **OAuth auth** (`authType === "oauth"`): decrypt config. If `expiresAt < now + 300` (5-minute preemptive window), refresh the token by POSTing to `oauthTokenEndpoint` with `grant_type=refresh_token&refresh_token=<token>&client_id=<oauthClientId>`. The refresh fetch MUST use `AbortSignal.timeout(5_000)` to prevent a hung token endpoint from stalling dispatch. Update DB with new tokens via `updateMcpServerAuth`. If refresh fails (network error, timeout, revoked token, missing refresh_token), log a warning and either skip this server (if no valid cached token) or use the existing cached token (if not yet expired). On fatal refresh failure (e.g. 401 from token endpoint indicating revocation), call `clearMcpServerAuth(id, orgId)` to null out `encryptedAuthConfig` so the UI shows "Not connected" and the admin knows to reconnect. Return `{ url: serverUrl, transport, headers: { Authorization: "Bearer <accessToken>" } }`.
  3. Servers with null `encryptedAuthConfig` (OAuth not yet connected): skip.
  4. Token refresh for multiple OAuth servers runs in parallel via `Promise.allSettled`.
  5. Wrap the entire function in try/catch — on unexpected error, return `[]` and log the error.

**1e. Migration** — Run `pnpm drizzle-kit generate` after the schema is registered, then `pnpm drizzle-kit migrate` to apply.

### Milestone 2: API Routes (CRUD)

**2a. List + Create** — Create `app/api/mcp-servers/route.ts`.

Follow the exact conventions in `app/api/sandbox-env-vars/route.ts`:

    import { NextResponse } from "next/server";
    import { getSessionWithOrg } from "@/lib/auth/session";
    import { findMcpServersByOrg } from "@/lib/mcp-servers/queries";
    import { createMcpServer } from "@/lib/mcp-servers/actions";
    import { withEvlog } from "@/lib/evlog";

    export const GET = withEvlog(async () => {
      const { orgId } = await getSessionWithOrg();
      const servers = await findMcpServersByOrg(orgId);
      return NextResponse.json({ servers });
    });

    export const POST = withEvlog(async (req: Request) => {
      const { session, orgId } = await getSessionWithOrg();
      const body = await req.json();
      // Validate: name non-empty, serverUrl valid URL, transport enum, authType enum
      // For static: headers required (at least one header)
      // For oauth: oauthClientId, oauthAuthorizationEndpoint, oauthTokenEndpoint required
      // Validate URLs are HTTPS (except localhost for dev)
      // Wrap insert in try/catch to handle unique constraint violation on (organizationId, name)
      try {
        const server = await createMcpServer({
          organizationId: orgId,
          name: body.name.trim(),
          serverUrl: body.serverUrl.trim(),
          transport: body.transport ?? "streamable-http",
          authType: body.authType,
          authConfig: body.authType === "static" ? { headers: body.headers } : undefined,
          oauthClientId: body.oauthClientId ?? null,
          oauthAuthorizationEndpoint: body.oauthAuthorizationEndpoint ?? null,
          oauthTokenEndpoint: body.oauthTokenEndpoint ?? null,
          oauthScopes: body.oauthScopes ?? null,
          createdBy: session.user.id,
        });
        return NextResponse.json({ server }, { status: 201 });
      } catch (err) {
        // Drizzle throws with code "23505" for unique constraint violations
        if (err instanceof Error && err.message.includes("unique")) {
          return NextResponse.json(
            { error: `An MCP server named "${body.name.trim()}" already exists` },
            { status: 409 },
          );
        }
        throw err;
      }
    });

URL validation: Reject non-HTTPS URLs except when hostname is `localhost` or `127.0.0.1` (for local dev). This prevents SSRF via user-supplied OAuth endpoints.

**2b. Delete + Toggle + Update** — Create `app/api/mcp-servers/[id]/route.ts`.

Follow the exact conventions in `app/api/sandbox-env-vars/[id]/route.ts`:

    import { NextResponse } from "next/server";
    import { getSessionWithOrg } from "@/lib/auth/session";
    import { deleteMcpServer, updateMcpServerEnabled, updateMcpServerHeaders } from "@/lib/mcp-servers/actions";
    import { withEvlog } from "@/lib/evlog";

    export const DELETE = withEvlog(async (
      _req: Request,
      { params }: { params: Promise<{ id: string }> },
    ) => {
      const { orgId } = await getSessionWithOrg();
      const { id } = await params;
      await deleteMcpServer(id, orgId);
      return NextResponse.json({ ok: true });
    });

    export const PATCH = withEvlog(async (
      req: Request,
      { params }: { params: Promise<{ id: string }> },
    ) => {
      const { orgId } = await getSessionWithOrg();
      const { id } = await params;
      const body = await req.json();

      // Reject empty body — at least one mutation must be present
      if (typeof body.enabled !== "boolean" && !body.headers) {
        return NextResponse.json({ error: "No valid fields to update" }, { status: 400 });
      }

      if (typeof body.enabled === "boolean") {
        await updateMcpServerEnabled(id, orgId, body.enabled);
      }

      // Headers can only be updated on static-auth servers — must load row to verify
      if (body.headers && typeof body.headers === "object") {
        const { findMcpServerByIdAndOrg } = await import("@/lib/mcp-servers/queries");
        const server = await findMcpServerByIdAndOrg(id, orgId);
        if (!server) return NextResponse.json({ error: "Server not found" }, { status: 404 });
        if (server.authType !== "static") {
          return NextResponse.json({ error: "Headers can only be updated on static-auth servers" }, { status: 400 });
        }
        await updateMcpServerHeaders(id, orgId, body.headers);
      }

      return NextResponse.json({ ok: true });
    });

### Milestone 3: Settings UI (Static Servers)

Create `app/(dashboard)/settings/mcp/page.tsx`. Follow the pattern in `app/(dashboard)/settings/environment/page.tsx` — a client component with useState and fetch-based CRUD.

**3a. Page structure**:

- Title: "MCP Servers", subtitle: "Connect external tools to agent sessions. Servers are available to all sessions in this workspace."
- Error alert (same pattern as environment page: Alert with AlertCircleIcon).
- "Add server" card with a form.
- Server list below.

**3b. Add form** (static servers first, OAuth tab added in Milestone 8):

- Name (text input, required)
- URL (text input, required, placeholder "https://mcp.example.com/sse")
- Transport (select: "Streamable HTTP" / "SSE", default "Streamable HTTP")
- Headers (key-value pair builder: inputs for header name + value, "Add header" button to add more rows, start with one row pre-filled with name "Authorization")
- Submit: POST /api/mcp-servers with `authType: "static"` and `headers: { ... }`

**3c. Server list** — Each server card shows:
- Name (bold), URL (truncated, monospace, `text-muted-foreground`)
- Auth type badge: "Static" or "OAuth"
- Enabled/disabled toggle (calls PATCH with `{ enabled: boolean }`)
- "Remove" button (calls DELETE, same style as environment page)

**3d. Settings grid** — Modify `app/(dashboard)/settings/page.tsx` to add an MCP Servers card after the Environment Variables card (around line 33):

    <Link href="/settings/mcp" className="block transition-colors hover:opacity-80">
      <Card>
        <CardHeader>
          <CardTitle>MCP Servers</CardTitle>
          <CardDescription>
            Connect external tools to agent sessions.
          </CardDescription>
        </CardHeader>
      </Card>
    </Link>

### Milestone 4: Proxy Protocol Threading

This milestone threads `mcpServers` from the dispatch POST body through to the ACP session creation inside the sandbox. The sandbox proxy is a bundled JS file that runs inside the VM — changes here require rebuilding.

**4a. PromptConfig** — In `lib/sandbox-proxy/types.ts`, add `mcpServers` to the `PromptConfig` type (line 14):

    export type PromptConfig = {
      agent: AgentType;
      mode?: string;
      model?: string;
      effortLevel?: string;
      modeIntent?: "autonomous" | "read-only" | "interactive";
      sdkSessionId?: string;
      nativeAgentSessionId?: string;
      branch?: string;
      cwd?: string;
      env?: Record<string, string>;
      mcpServers?: Array<{
        url: string;
        transport?: "streamable-http" | "sse";
        headers?: Record<string, string>;
      }>;
    };

The type is inlined (not imported from lib/mcp-servers/types) because the proxy is bundled standalone — it has no access to the Polaris codebase at runtime.

**4b. ACP bridge** — In `lib/sandbox-proxy/acp-bridge.ts`, thread `config.mcpServers ?? []` through all 3 session creation paths.

The `createSessionWithFallback` method (starts at line 183) needs `mcpServers` in its config parameter:

- Line 184: Add `mcpServers?: PromptConfig["mcpServers"]` to the config parameter type.
- Line 193: Change `mcpServers: []` to `mcpServers: config.mcpServers ?? []`.
- Line 218: Change `mcpServers: []` to `mcpServers: config.mcpServers ?? []`.

The `tryNativeResume` method (starts at line 250):
- Add `mcpServers` parameter to the method signature.
- Line 286: Change `mcpServers: []` to `mcpServers: mcpServers ?? []`.

Update `createOrResumeSession` (the public method that orchestrates session creation) to extract `mcpServers` from config and pass it through to both `createSessionWithFallback` and `tryNativeResume`.

**4c. Proxy rebuild** — Run `npx tsx lib/sandbox-proxy/build.ts`. Commit the rebuilt `lib/sandbox-proxy/dist/proxy.js`.

Backward compatibility: The `?? []` fallback means old proxies (without this change) silently ignore the new `mcpServers` field in the POST body. New proxies work with old Polaris code (no mcpServers in POST = undefined, falls back to []). Safe in both directions.

### Milestone 5: Dispatch Integration

Load org MCP servers at each dispatch site and include them in the config object sent to the proxy. The `getResolvedMcpServers` function is the single point of resolution — all 4 sites call it.

Note: The existing dispatch snippets in pr-review.ts and sweeper.ts pass `thoughtLevel` in the config, but `PromptConfig` types `effortLevel`. This is a pre-existing mismatch in the codebase — this plan reproduces it as-is to avoid scope creep. The proxy/acp-bridge only forwards `agent`, `model`, `mode`, and `cwd` today; extra fields are ignored. Fixing this mismatch is out of scope.

**5a. prompt-dispatch.ts** (interactive sessions) — In `dispatchPromptToSession`, after `resolveSessionCredentials` (around line 88), load MCP servers:

    const { getResolvedMcpServers } = await import("@/lib/mcp-servers/queries");
    const mcpServers = await getResolvedMcpServers(session.organizationId);

Then at lines 170–173, add `mcpServers` to the config:

    config: {
      agent: session.agentType,
      cwd: "/vercel/sandbox",
      mcpServers,
    },

**5b. coding-task.ts** — In `dispatchCodingTask`, after `buildSessionEnv` (around line 86), load MCP servers:

    const { getResolvedMcpServers } = await import("@/lib/mcp-servers/queries");
    const mcpServers = await getResolvedMcpServers(payload.orgId);

Then at lines 166–171, add `mcpServers`:

    config: {
      agent: ctx.agentType,
      mode: ctx.agentMode ?? undefined,
      model: ctx.model ?? undefined,
      cwd: SandboxManager.PROJECT_DIR,
      mcpServers,
    },

**5c. pr-review.ts** — In `dispatchPrReview`, after resolving agent config (around line 318), load MCP servers. This must happen BEFORE the dispatch loop (lines 333+) since we only need to load once:

    const { getResolvedMcpServers } = await import("@/lib/mcp-servers/queries");
    const mcpServers = await getResolvedMcpServers(orgId);

Then at lines 379–385 (inside the dispatch loop body), add `mcpServers`:

    config: {
      agent: resolved.agent,
      mode: resolved.mode,
      model: resolved.model,
      thoughtLevel: resolved.thoughtLevel,
      cwd: "/vercel/sandbox",
      mcpServers,
    },

**5d. sweeper.ts** — In `retryReviewDispatch`, after `getInteractiveSession` (line 371) which provides the session object:

    const { getResolvedMcpServers } = await import("@/lib/mcp-servers/queries");
    const mcpServers = await getResolvedMcpServers(session.organizationId);

Then at lines 446–452, add `mcpServers`:

    config: {
      agent: resolved.agent,
      mode: resolved.mode,
      model: resolved.model,
      thoughtLevel: resolved.thoughtLevel,
      cwd: "/vercel/sandbox",
      mcpServers,
    },

### Milestone 6: Static-Auth End-to-End Validation

This milestone verifies that the static-auth path works end-to-end. After this milestone, the feature is usable for all MCP servers that accept static Bearer tokens.

Verification steps:
1. `pnpm typecheck` passes.
2. `pnpm test` passes.
3. Add a static MCP server via the UI at `/settings/mcp`.
4. Verify the server appears in the DB: `psql postgresql://polaris:polaris@localhost:5432/polaris -c "SELECT id, name, server_url, auth_type, enabled FROM mcp_servers;"`
5. Dispatch a prompt to an interactive session. Check the proxy POST body includes `config.mcpServers` with the configured server's URL and headers.
6. Toggle enabled → dispatch again → verify server is not included when disabled.
7. Delete the server → verify removal from DB and UI.

### Milestone 7: OAuth Schema Extensions + Flow Routes

This milestone adds OAuth 2.1 Authorization Code + PKCE support.

**7a. OAuth state helper** — Create `lib/mcp-servers/oauth-state.ts`. Reuse the exact pattern from `lib/integrations/github-state.ts`:

    import crypto from "node:crypto";
    import { z } from "zod";

    export const mcpOAuthStateSchema = z.object({
      orgId: z.string(),
      userId: z.string(),
      serverId: z.string(),
      nonce: z.string(),
      exp: z.number(),
    });

    export type McpOAuthStatePayload = z.infer<typeof mcpOAuthStateSchema>;

    export function signMcpOAuthState(payload: McpOAuthStatePayload): string {
      const stateData = Buffer.from(JSON.stringify(payload)).toString("base64url");
      const hmac = crypto
        .createHmac("sha256", process.env.BETTER_AUTH_SECRET!)
        .update(stateData)
        .digest("base64url");
      return `${stateData}.${hmac}`;
    }

    export function verifyMcpOAuthState(state: string): McpOAuthStatePayload | null {
      try {
        const parts = state.split(".");
        if (parts.length !== 2) return null;
        const [stateData, hmac] = parts;
        const expectedHmac = crypto
          .createHmac("sha256", process.env.BETTER_AUTH_SECRET!)
          .update(stateData)
          .digest("base64url");
        if (!crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(expectedHmac))) return null;
        const raw = JSON.parse(Buffer.from(stateData, "base64url").toString());
        const payload = mcpOAuthStateSchema.parse(raw);
        if (payload.exp < Math.floor(Date.now() / 1000)) return null;
        return payload;
      } catch {
        return null;
      }
    }

**7b. Start route** — Create `app/api/mcp-servers/oauth/start/route.ts` (GET handler).

    import { NextResponse } from "next/server";
    import { getSessionWithOrg } from "@/lib/auth/session";
    import { findMcpServerByIdAndOrg } from "@/lib/mcp-servers/queries";
    import { signMcpOAuthState } from "@/lib/mcp-servers/oauth-state";
    import { getAppBaseUrl } from "@/lib/config/urls";
    import { withEvlog } from "@/lib/evlog";
    import crypto from "node:crypto";

    export const GET = withEvlog(async (req: Request) => {
      const { session, orgId } = await getSessionWithOrg();
      const url = new URL(req.url);
      const serverId = url.searchParams.get("serverId");
      if (!serverId) return NextResponse.json({ error: "serverId required" }, { status: 400 });

      // Load server from DB — OAuth metadata is persisted in columns
      const server = await findMcpServerByIdAndOrg(serverId, orgId);
      if (!server) return NextResponse.json({ error: "Server not found" }, { status: 404 });
      if (server.authType !== "oauth") return NextResponse.json({ error: "Not an OAuth server" }, { status: 400 });
      if (!server.oauthClientId || !server.oauthAuthorizationEndpoint || !server.oauthTokenEndpoint) {
        return NextResponse.json({ error: "OAuth metadata incomplete" }, { status: 400 });
      }

      // Generate PKCE
      const codeVerifier = crypto.randomBytes(32).toString("base64url"); // 43 chars
      const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");

      // Sign state
      const state = signMcpOAuthState({
        orgId,
        userId: session.user.id,
        serverId,
        nonce: crypto.randomUUID(),
        exp: Math.floor(Date.now() / 1000) + 300, // 5 minutes
      });

      // Build callback URL using the repo's canonical URL helper (lib/config/urls.ts)
      const callbackUrl = `${getAppBaseUrl()}/api/mcp-servers/oauth/callback`;

      // Store PKCE verifier in HttpOnly cookie — include serverId in cookie name
      // to prevent concurrent OAuth flows from clobbering each other
      const cookieName = `mcp_oauth_verifier_${serverId}`;
      const headers = new Headers();
      headers.append("Set-Cookie",
        `${cookieName}=${codeVerifier}; HttpOnly; SameSite=Lax; Path=/api/mcp-servers/oauth; Max-Age=300` +
        (process.env.NODE_ENV === "production" ? "; Secure" : "")
      );

      // Build authorization URL
      const authUrl = new URL(server.oauthAuthorizationEndpoint);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("client_id", server.oauthClientId);
      authUrl.searchParams.set("redirect_uri", callbackUrl);
      authUrl.searchParams.set("state", state);
      authUrl.searchParams.set("code_challenge", codeChallenge);
      authUrl.searchParams.set("code_challenge_method", "S256");
      if (server.oauthScopes) authUrl.searchParams.set("scope", server.oauthScopes);

      headers.set("Location", authUrl.toString());
      return new Response(null, { status: 302, headers });
    });

Key design choices:
- OAuth metadata (clientId, endpoints, scopes) comes from DB columns, not query params — survives page reload.
- PKCE verifier cookie includes serverId in the name (`mcp_oauth_verifier_<serverId>`) to avoid races when connecting multiple servers in parallel tabs.
- No metadata cookie needed — the callback reads everything from DB.

**7c. Callback route** — Create `app/api/mcp-servers/oauth/callback/route.ts` (GET handler).

    export const GET = withEvlog(async (req: Request) => {
      const { session, orgId } = await getSessionWithOrg();
      const url = new URL(req.url);

      // Check for OAuth error response — normalize to a safe error code
      // (don't reflect raw provider error_description into URLs to avoid leaking provider internals)
      const oauthError = url.searchParams.get("error");
      if (oauthError) {
        // Map standard OAuth error codes to user-friendly messages
        const errorMessages: Record<string, string> = {
          access_denied: "Access was denied by the provider",
          invalid_scope: "The requested scope is invalid",
          server_error: "The provider encountered an error",
          temporarily_unavailable: "The provider is temporarily unavailable",
        };
        const safeMessage = errorMessages[oauthError] ?? `OAuth error: ${oauthError}`;
        return NextResponse.redirect(new URL(`/settings/mcp?error=${encodeURIComponent(safeMessage)}`, req.url));
      }

      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (!code || !state) return NextResponse.redirect(new URL("/settings/mcp?error=missing+code+or+state", req.url));

      // Verify state
      const payload = verifyMcpOAuthState(state);
      if (!payload) return NextResponse.redirect(new URL("/settings/mcp?error=invalid+state", req.url));
      if (payload.userId !== session.user.id) return NextResponse.redirect(new URL("/settings/mcp?error=user+mismatch", req.url));
      if (payload.orgId !== orgId) return NextResponse.redirect(new URL("/settings/mcp?error=org+mismatch", req.url));

      // Load server to get OAuth endpoints
      const server = await findMcpServerByIdAndOrg(payload.serverId, orgId);
      if (!server || !server.oauthTokenEndpoint || !server.oauthClientId) {
        return NextResponse.redirect(new URL("/settings/mcp?error=server+not+found", req.url));
      }

      // Read PKCE verifier from cookie
      const cookieName = `mcp_oauth_verifier_${payload.serverId}`;
      const cookies = req.headers.get("cookie") ?? "";
      const verifierMatch = cookies.match(new RegExp(`${cookieName}=([^;]+)`));
      if (!verifierMatch) return NextResponse.redirect(new URL("/settings/mcp?error=missing+verifier", req.url));
      const codeVerifier = verifierMatch[1];

      // Token exchange — use canonical URL helper (lib/config/urls.ts)
      const { getAppBaseUrl } = await import("@/lib/config/urls");
      const callbackUrl = `${getAppBaseUrl()}/api/mcp-servers/oauth/callback`;

      const tokenRes = await fetch(server.oauthTokenEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: callbackUrl,
          client_id: server.oauthClientId,
          code_verifier: codeVerifier,
        }),
        signal: AbortSignal.timeout(15_000),
      });

      if (!tokenRes.ok) {
        const errBody = await tokenRes.text().catch(() => "");
        return NextResponse.redirect(new URL(`/settings/mcp?error=${encodeURIComponent(`Token exchange failed: ${tokenRes.status}`)}`, req.url));
      }

      const tokens = await tokenRes.json();
      if (!tokens.access_token) {
        return NextResponse.redirect(new URL("/settings/mcp?error=no+access+token+in+response", req.url));
      }

      // Store tokens
      await updateMcpServerAuth(payload.serverId, orgId, {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ?? "",
        expiresAt: tokens.expires_in
          ? Math.floor(Date.now() / 1000) + tokens.expires_in
          : Math.floor(Date.now() / 1000) + 3600, // default 1 hour if not specified
      });

      // Clear verifier cookie and redirect
      const headers = new Headers();
      headers.append("Set-Cookie", `${cookieName}=; HttpOnly; Path=/api/mcp-servers/oauth; Max-Age=0`);
      headers.set("Location", new URL("/settings/mcp?success=connected", req.url).toString());
      return new Response(null, { status: 302, headers });
    });

Error handling: The callback handles OAuth error responses (`?error=...&error_description=...`), missing code/state, state verification failure, token exchange failure, and missing access_token. All errors redirect to `/settings/mcp?error=...` so the UI can display them.

### Milestone 8: OAuth UI + End-to-End Validation

**8a. Extend the add form** — Add an OAuth tab to the MCP servers settings page:

OAuth tab fields:
- Name (text input, required)
- URL (text input, required)
- Transport (select, default "Streamable HTTP")
- Client ID (text input, required — from the provider's developer console)
- Authorization URL (text input, required — e.g. "https://sentry.io/oauth/authorize")
- Token URL (text input, required — e.g. "https://sentry.io/oauth/token")
- Scopes (text input, optional, space-separated)
- Submit: POST /api/mcp-servers with `authType: "oauth"` + the oauth fields

**8b. Extend the server list** — For OAuth servers, add connection status:
- "Connected" (green badge) if `connected === true`
- "Not connected" (yellow badge) with "Connect" button if `connected === false`
- "Connect" button navigates to: `window.location.href = "/api/mcp-servers/oauth/start?serverId=${server.id}"`
- On page load, check `?success=connected` or `?error=...` query params and show a toast/alert

**8c. OAuth end-to-end validation**:
1. `pnpm typecheck` passes.
2. Add an OAuth MCP server via the UI.
3. Click "Connect" → complete OAuth flow at provider.
4. Verify redirect back with "Connected" status.
5. Check DB: `SELECT id, name, encrypted_auth_config IS NOT NULL as connected FROM mcp_servers;`
6. Dispatch a prompt → verify OAuth server appears in config.mcpServers with Bearer token.
7. Set token `expiresAt` to past → dispatch again → verify auto-refresh occurs.

### Milestone 9 (Optional): SandboxAgentClient Parity

This milestone is NOT on the critical path. All live dispatch paths use the proxy, not SandboxAgentClient directly. This is cleanup for completeness.

In `lib/sandbox-agent/SandboxAgentClient.ts`, add `mcpServers` to `SessionConfig` (line 8):

    type SessionConfig = {
      agent: AgentType;
      model?: string;
      mode?: string;
      thoughtLevel?: string;
      cwd: string;
      mcpServers?: Array<{
        url: string;
        transport?: "streamable-http" | "sse";
        headers?: Record<string, string>;
      }>;
    };

Then replace all 5 hardcoded `mcpServers: []` with `mcpServers: config.mcpServers ?? []`:
- Line 132 in `createSession`
- Line 149 in `createSession` fallback
- Line 188 in `resumeSession`
- Line 203 in `resumeSession` fallback
- Line 262 in `nativeResumeSession`

## Concrete Steps

### Milestone 1 Commands

    # Working directory: project root
    mkdir -p lib/mcp-servers

    # After creating all files in lib/mcp-servers/ and registering in lib/db/schema.ts:
    pnpm drizzle-kit generate
    pnpm drizzle-kit migrate
    pnpm typecheck

Expected: Migration file generated in `lib/db/migrations/` directory. Typecheck passes. Database has new `mcp_servers` table:

    psql postgresql://polaris:polaris@localhost:5432/polaris -c "\d mcp_servers"

Should show all columns: id, organization_id, name, server_url, transport, auth_type, encrypted_auth_config, enabled, oauth_client_id, oauth_authorization_endpoint, oauth_token_endpoint, oauth_scopes, created_by, created_at, updated_at.

### Milestone 2 Commands

    pnpm typecheck
    pnpm dev

    # Test CRUD (in another terminal):
    curl -s -X POST http://localhost:3001/api/mcp-servers \
      -H "Content-Type: application/json" \
      -H "Cookie: <session-cookie>" \
      -d '{"name":"Test Sentry","serverUrl":"https://mcp.sentry.dev/sse","transport":"sse","authType":"static","headers":{"Authorization":"Bearer test-token"}}' | jq .

    curl -s http://localhost:3001/api/mcp-servers -H "Cookie: <session-cookie>" | jq .

Expected: POST returns 201 with `{ server: { id, name, serverUrl, ... } }` (row metadata, no `connected` field — that's computed by the GET list query). GET returns `{ servers: [...] }` with each server including a computed `connected: boolean`. DELETE returns `{ ok: true }`. POST with a duplicate name returns 409 with `{ error: "An MCP server named \"...\" already exists" }`.

### Milestone 4 Commands

    pnpm typecheck
    npx tsx lib/sandbox-proxy/build.ts

Expected: `lib/sandbox-proxy/dist/proxy.js` is regenerated.

### Milestone 5–6 Commands

    pnpm typecheck
    pnpm test

## Validation and Acceptance

The feature is complete when:

1. **Settings UI works**: Navigate to `/settings/mcp`. Add a static MCP server with headers. Toggle enabled. Delete. All state persists across page reloads.

2. **Dispatch includes servers**: Send a prompt to an interactive session. The POST to `/prompt` includes `config.mcpServers` with the configured servers' URLs and decrypted headers.

3. **Proxy threads to SDK**: Inside the sandbox, the ACP session is created with `sessionInit.mcpServers` populated. The agent sees the MCP server's tools.

4. **Graceful degradation**: If an MCP server config fails to resolve (decrypt error, etc.), the dispatch still succeeds — the server is skipped, not blocking.

5. **OAuth flow works** (Phase B): Click "Connect" on an OAuth server. Complete the provider's auth flow. Return to settings page with "Connected" status. Dispatch includes Bearer token. Token auto-refreshes when expired.

6. **Typecheck and tests pass**: `pnpm typecheck` and `pnpm test` both pass.

## Idempotence and Recovery

- All database operations are idempotent: UNIQUE constraint on (organizationId, name) prevents duplicates. Deletes are org-scoped.
- OAuth state has a 5-minute expiry with HMAC verification — stale states are rejected.
- PKCE verifier is in an HttpOnly cookie (per-server name), cleared after use.
- Token refresh uses `updateMcpServerAuth` which is a simple UPDATE — safe to retry.
- If migration is re-run, Drizzle handles idempotency via its migration journal.
- Proxy rebuild (`npx tsx lib/sandbox-proxy/build.ts`) is deterministic — safe to re-run.
- `getResolvedMcpServers` is fail-open: individual server failures are logged and skipped, never block dispatch.

## Artifacts and Notes

### File inventory

Phase A (static):

    Create: lib/mcp-servers/schema.ts
    Create: lib/mcp-servers/types.ts
    Create: lib/mcp-servers/actions.ts
    Create: lib/mcp-servers/queries.ts
    Create: app/api/mcp-servers/route.ts
    Create: app/api/mcp-servers/[id]/route.ts
    Create: app/(dashboard)/settings/mcp/page.tsx
    Modify: lib/db/schema.ts (add export line)
    Modify: lib/sandbox-proxy/types.ts (add mcpServers to PromptConfig)
    Modify: lib/sandbox-proxy/acp-bridge.ts (thread mcpServers, 3 locations)
    Modify: lib/orchestration/prompt-dispatch.ts (load + inject mcpServers)
    Modify: lib/orchestration/coding-task.ts (load + inject mcpServers)
    Modify: lib/orchestration/pr-review.ts (load + inject mcpServers)
    Modify: lib/orchestration/sweeper.ts (load + inject mcpServers)
    Modify: app/(dashboard)/settings/page.tsx (add MCP card)
    Rebuild: lib/sandbox-proxy/dist/proxy.js

Phase B (OAuth):

    Create: lib/mcp-servers/oauth-state.ts
    Create: app/api/mcp-servers/oauth/start/route.ts
    Create: app/api/mcp-servers/oauth/callback/route.ts
    Modify: app/(dashboard)/settings/mcp/page.tsx (add OAuth tab + connect flow)

Optional:

    Modify: lib/sandbox-agent/SandboxAgentClient.ts (thread mcpServers, 5 locations)

### Reference: existing API route pattern

    // app/api/sandbox-env-vars/route.ts — the exact pattern to follow
    import { NextResponse } from "next/server";
    import { getSessionWithOrg } from "@/lib/auth/session";
    import { findEnvVarsByOrg } from "@/lib/sandbox-env/queries";
    import { upsertEnvVar } from "@/lib/sandbox-env/actions";
    import { withEvlog } from "@/lib/evlog";

    export const GET = withEvlog(async () => {
      const { orgId } = await getSessionWithOrg();
      const envVars = await findEnvVarsByOrg(orgId);
      return NextResponse.json({ envVars });
    });

    // app/api/sandbox-env-vars/[id]/route.ts — dynamic route pattern
    export const DELETE = withEvlog(async (
      _req: Request,
      { params }: { params: Promise<{ id: string }> },
    ) => {
      const { orgId } = await getSessionWithOrg();
      const { id } = await params;
      await deleteEnvVar(id, orgId);
      return NextResponse.json({ ok: true });
    });

### Edge cases

- **Concurrent OAuth flows**: Cookie names include serverId (`mcp_oauth_verifier_<serverId>`) so connecting different servers in parallel tabs doesn't race. Two tabs connecting the same server will race — last writer wins, which is acceptable (admin-only, same tokens either way).
- **Token refresh failure**: On fatal refresh failure (401 from token endpoint), `getResolvedMcpServers` calls `clearMcpServerAuth` to null out `encryptedAuthConfig`. This makes `connected` (computed as `encryptedAuthConfig IS NOT NULL`) return false, so the UI shows "Not connected" with a "Reconnect" button. The server is skipped for dispatch. Non-fatal failures (timeout, network error) log a warning and use the cached token if not yet expired, or skip the server if expired.
- **Token refresh race**: Two concurrent dispatches may both try to refresh an expired token. Both refresh calls succeed independently. Last writer wins on DB update. The loser's token becomes orphaned but harmless — the winner's token is valid.
- **Token refresh timeout**: All refresh fetches use `AbortSignal.timeout(5_000)` to prevent hung token endpoints from stalling dispatch. On timeout, the server is skipped.
- **Hibernation/resume**: MCP configs are loaded fresh from DB at dispatch time, never stored in the sandbox. Hibernate → resume picks up any config changes automatically.
- **MCP server down during prompt**: The sandbox-agent SDK handles MCP connection failures gracefully — the agent continues without that server's tools. No Polaris-level error handling needed.
- **Proxy backward compat**: `config.mcpServers ?? []` fallback means old proxies ignore the field, new proxies work with old code. Safe in both directions.
- **URL validation / SSRF mitigation**: POST validation requires HTTPS for all URLs except localhost/127.0.0.1. OAuth endpoints are stored in DB columns and validated on create — they cannot be injected via query params. Note: this does not block HTTPS to private/internal targets. Full SSRF protection (blocking private IPs, link-local, internal DNS after resolution) is a future enhancement. The attack surface is admin-only (only org admins can add servers), which limits risk.
- **Missing refresh_token**: Some OAuth providers don't return refresh tokens on initial grant. If `refreshToken` is empty and token is expired, the server is skipped for dispatch and `clearMcpServerAuth` is called so the UI shows "Not connected".
- **Duplicate server names**: The UNIQUE constraint on (organizationId, name) is enforced by the DB. The POST handler catches the constraint violation and returns 409 with a user-friendly message. A novice should catch errors with `message.includes("unique")` (Drizzle surfaces the PG constraint as part of the error message).
- **OAuth error_description**: The callback normalizes OAuth error codes to safe, user-friendly messages rather than reflecting raw provider text into redirect URLs. This prevents leaking provider internals into logs/URLs.
- **OAuth scope**: Phase B implements a public-client PKCE flow only. Confidential-client flows (with client_secret) are not supported in this plan. This covers the known MCP OAuth landscape. If a provider requires confidential clients, the schema already has room to add `oauthClientSecret` (encrypted) as a future extension.

---

Revision 1 (2026-03-20): Major revision based on first Codex review (gpt-5.4). Changes: (1) Split into Phase A (static) and Phase B (OAuth) for incremental delivery. (2) Added OAuth metadata columns to schema (clientId, endpoints, scopes) so Connect button works after page reload. (3) Fixed proxy build command to `npx tsx lib/sandbox-proxy/build.ts`. (4) Fixed migration output path to `lib/db/migrations/`. (5) Dropped `timeoutMs` field (dead code — never consumed by runtime). (6) Moved SandboxAgentClient threading to optional Milestone 9 (not on live path). (7) Added `withEvlog` wrapper and Next 16 `params: Promise<...>` signature to API routes. (8) Changed DELETE to return `{ ok: true }` per repo conventions. (9) Added `findMcpServerByIdAndOrg` query. (10) Added `updateMcpServerHeaders` action. (11) Per-server cookie names for concurrent OAuth flows. (12) HTTPS validation for URLs (SSRF prevention). (13) OAuth callback error handling for error/error_description params and missing refresh_token. (14) Made `getResolvedMcpServers` fail-open with try/catch so it can never strand a session.

Revision 2 (2026-03-20): Fixes based on second Codex re-review. Changes: (1) PATCH route now loads row via `findMcpServerByIdAndOrg` and rejects `headers` updates on OAuth servers (was unsafe — could overwrite token blobs). (2) Added `clearMcpServerAuth` action for fatal OAuth refresh failures so UI correctly shows "Not connected" (was impossible state transition). (3) Added `AbortSignal.timeout(5_000)` to OAuth token refresh to prevent hung endpoints from stalling dispatch. (4) OAuth routes now use canonical `getAppBaseUrl()` from `lib/config/urls.ts` instead of ad-hoc env fallbacks (was wrong in preview/prod). (5) OAuth callback normalizes error codes to safe messages instead of reflecting raw `error_description` into URLs. (6) POST handler catches unique constraint violations and returns 409 (was unhandled 500). (7) Fixed `connected: true` claim in POST response docs (computed field is only on GET list query). (8) Documented SSRF limitation honestly (HTTPS check doesn't block private IPs — admin-only surface, future enhancement). (9) Documented `thoughtLevel`/`effortLevel` mismatch as pre-existing, out of scope. (10) Documented public-client-only OAuth scope, with note on future confidential-client extension.
