---
title: MCP Integration Marketplace
status: planned
created: 2026-03-22
owner: andreas
related_prs: [110]
domains: [lib/mcp-servers, app/api/mcp-servers, app/(dashboard)/[orgSlug]/integrations/mcp, app/(dashboard)/[orgSlug]/settings/mcp]
---

# 11 — MCP Integration Marketplace

This ExecPlan is a living document. The sections Progress, Surprises & Discoveries, Decision Log, and Outcomes & Retrospective must be kept up to date as work proceeds.

## Purpose / Big Picture

PR #110 shipped the backend plumbing for org-level MCP servers: schema, dispatch threading, proxy integration, OAuth, and SSRF protection. But the UI is a raw developer form — users must manually enter URLs, transport types, OAuth endpoints, client IDs, and scopes. This is not a product UX.

After this change, admins see a curated marketplace of integrations (Sentry, Datadog, etc.) with one-click "Enable" flows. For OAuth integrations like Sentry, clicking "Enable" uses a template-owned MCP server URL and OAuth client ID, auto-discovers OAuth endpoints from the server URL (RFC 9728 + RFC 8414), then redirects to the provider's consent page. For API-key integrations like Datadog, the user sees only the fields that matter — a region dropdown and two key fields — not raw URLs or transport selectors. A "Test tools" button validates the connection, persists health state, and caches the discovered tool inventory. The existing raw form becomes an "Add Your Own" escape hatch for custom/internal servers, and the legacy settings page becomes a redirect into the new flow.

To see it working: navigate to `/{orgSlug}/integrations/mcp`, see a grid of provider cards, click "Enable" on Sentry, complete the OAuth flow, see "Connected" with discovered tools listed, then dispatch a prompt to any session — the agent sees Sentry's tools.

## User Flows & Wireframes

### Navigation

From the dashboard sidebar or Settings page, the user navigates to the MCP integrations page:

    Settings > MCP Integrations
    or
    Sidebar > Integrations > MCP card

### Flow 1: Marketplace Browse

The user lands on the marketplace grid. Each card shows enough context to decide without clicking in.

    ┌─────────────────────────────────────────────────────────────────┐
    │  MCP Integrations                                              │
    │  Connect external tools to your agent sessions.                │
    │                                                                │
    │  [All] [Installed] [Not Installed]    [Search...]               │
    │                                                                │
    │  ┌──────────────────────┐  ┌──────────────────────┐            │
    │  │ 🔶 Sentry  [Official]│  │ 🟣 Datadog [Official]│            │
    │  │                      │  │                      │            │
    │  │ Debug production     │  │ Retrieve telemetry   │            │
    │  │ errors with full     │  │ insights: incidents, │            │
    │  │ stack traces.        │  │ logs, dashboards.    │            │
    │  │                      │  │                      │            │
    │  │ OAuth · Org-shared   │  │ API Keys · Org-shared│            │
    │  │                      │  │                      │            │
    │  │ ● Not installed      │  │ ● Not installed      │            │
    │  └──────────────────────┘  └──────────────────────┘            │
    │                                                                │
    │  ┌──────────────────────┐                                      │
    │  │      +               │                                      │
    │  │                      │                                      │
    │  │  Add Your Own        │                                      │
    │  │  Set up an MCP       │                                      │
    │  │  server that's not   │                                      │
    │  │  in the marketplace. │                                      │
    │  └──────────────────────┘                                      │
    └─────────────────────────────────────────────────────────────────┘

Each card shows:
- Provider icon + name
- Trust badge: "Official" (green), "Verified" (blue), or "Community" (gray)
- One-line description
- Auth type: "OAuth" or "API Keys"
- Ownership model: "Org-shared" or "Personal"
- Install status: "Not installed", "Connected" (green), "Needs auth" (yellow)

Clicking a card navigates to the per-integration install/manage page.

### Flow 2: Enable Sentry (OAuth, zero-config)

User clicks the Sentry card → lands on the install page:

    ┌─────────────────────────────────────────────────────────────────┐
    │  ← Back to MCP Integrations                                    │
    │                                                                │
    │  🔶 Sentry                                        [Official]   │
    │                                                                │
    │  Retrieve detailed issue data, full stack traces, and          │
    │  search/filter issues. Analyze errors and debug production     │
    │  problems.                                                     │
    │                                                                │
    │  Transport: HTTP    Auth: OAuth    Ownership: Org-shared        │
    │  📄 Documentation    🌐 Website                                │
    │                                                                │
    │  ─────────────────────────────────────────────────────────      │
    │                                                                │
    │  What agents will be able to do:                               │
    │  • Read and search issues, events, and stack traces            │
    │  • Manage project settings and team membership                 │
    │  • Write event data                                            │
    │                                                                │
    │                              ┌──────────────┐                  │
    │                              │   Enable     │                  │
    │                              └──────────────┘                  │
    └─────────────────────────────────────────────────────────────────┘

User clicks "Enable" → security notice modal appears:

    ┌─────────────────────────────────────────────────────────────────┐
    │                                                                │
    │         Enable MCP Integration                          ✕      │
    │                                                                │
    │  Grant Polaris access to Sentry. You can disable this          │
    │  integration at any time from Integrations.                    │
    │                                                                │
    │  ┌───────────────────────────────────────────────────────┐     │
    │  │  ⚠️  Security Notice                                  │     │
    │  │                                                       │     │
    │  │  You're about to give agents significant access to    │     │
    │  │  Sentry, allowing them to read issues, stack traces,  │     │
    │  │  and manage project settings.                         │     │
    │  │                                                       │     │
    │  │  Enabling this integration will allow all members of  │     │
    │  │  your organization to use the same MCP server         │     │
    │  │  connection, sharing a single authentication state    │     │
    │  │  for all actions.                                     │     │
    │  │                                                       │     │
    │  │  We recommend using a service account.                │     │
    │  └───────────────────────────────────────────────────────┘     │
    │                                                                │
    │  ☐ I understand and want to enable this integration            │
    │                                                                │
    │                           ┌─────────────────────┐              │
    │                           │  Enable integration │ (disabled)   │
    │                           └─────────────────────┘              │
    └─────────────────────────────────────────────────────────────────┘

User checks the checkbox → "Enable integration" becomes clickable → clicks it.

Behind the scenes: Polaris auto-discovers OAuth endpoints from the MCP spec, no user input needed. The browser redirects to Sentry's OAuth consent page:

    ┌─────────────────────────────────────────────────────────────────┐
    │                         🔶                                     │
    │                                                                │
    │        Sentry is requesting access to Sentry                   │
    │                                                                │
    │  ☑ Inspect Issues & Events              16 tools               │
    │    Search for errors, analyze traces,                          │
    │    and explore event data                                      │
    │                                                                │
    │  ☑ Seer                                  9 tools               │
    │    Sentry's AI debugger that helps you                         │
    │    analyze, root cause, and fix issues                         │
    │                                                                │
    │  ☐ Documentation                         5 tools               │
    │  ☐ Triage Issues                        12 tools               │
    │  ☐ Manage Projects & Teams               9 tools               │
    │                                                                │
    │           [Cancel]     [Approve]                                │
    └─────────────────────────────────────────────────────────────────┘

(This page is Sentry's — we don't control it. Sentry already supports tool-group selection during OAuth consent.)

User clicks "Approve" → redirected back to Polaris → integration page shows connected state:

    ┌─────────────────────────────────────────────────────────────────┐
    │  ← Back to MCP Integrations                                    │
    │                                                                │
    │  🔶 Sentry                           [Official]  ● Connected   │
    │                                                                │
    │  Retrieve detailed issue data, full stack traces, and          │
    │  search/filter issues.                                         │
    │                                                                │
    │  Transport: HTTP    Auth: OAuth    Ownership: Org-shared        │
    │  📄 Documentation    🌐 Website                                │
    │                                                                │
    │  ─────────────────────────────────────────────────────────      │
    │                                                                │
    │  Tools (25 available)                                          │
    │                                                                │
    │  • search_issues       Search and filter Sentry issues         │
    │  • get_issue_details   Get detailed info about an issue        │
    │  • get_event           Retrieve a specific event               │
    │  • list_projects       List projects in organization           │
    │  • get_trace           Get full distributed trace              │
    │  • analyze_with_seer   Use Sentry's AI to root-cause           │
    │    ... 19 more                                     [Show all]  │
    │                                                                │
    │  Last tested: just now · 25 tools discovered                   │
    │                                                                │
    │  ┌──────────────┐  ┌────────────┐  ┌──────────────────┐       │
    │  │ Test tools   │  │  Disable   │  │ Remove           │       │
    │  └──────────────┘  └────────────┘  └──────────────────┘       │
    └─────────────────────────────────────────────────────────────────┘

User can:
- **Test tools**: re-runs `tools/list` to verify connection is still working
- **Reconnect**: re-run OAuth if the provider token expires or is revoked
- **Disable**: keeps config but stops injecting into sessions
- **Remove**: deletes the integration entirely

### Flow 3: Enable Datadog (API keys + region)

User clicks the Datadog card → install page:

    ┌─────────────────────────────────────────────────────────────────┐
    │  ← Back to MCP Integrations                                    │
    │                                                                │
    │  🟣 Datadog                                       [Official]   │
    │                                                                │
    │  Retrieve telemetry insights and manage Datadog platform       │
    │  features including incidents, monitors, logs, dashboards.     │
    │                                                                │
    │  Transport: HTTP    Auth: API Keys    Ownership: Org-shared     │
    │  📄 Documentation    🌐 Website                                │
    │                                                                │
    │  ─────────────────────────────────────────────────────────      │
    │                                                                │
    │  Configuration                                                 │
    │                                                                │
    │  Region                                                        │
    │  ┌──────────────────────────┐                                  │
    │  │ US1                   ▼  │                                  │
    │  └──────────────────────────┘                                  │
    │                                                                │
    │  DD-API-KEY *                                                  │
    │  ┌──────────────────────────────────────────┐                  │
    │  │ ••••••••••••••••••                       │                  │
    │  └──────────────────────────────────────────┘                  │
    │                                                                │
    │  DD-APPLICATION-KEY *                                          │
    │  ┌──────────────────────────────────────────┐                  │
    │  │ ••••••••••••••••••                       │                  │
    │  └──────────────────────────────────────────┘                  │
    │                                                                │
    │                              ┌──────────────┐                  │
    │                              │   Enable     │                  │
    │                              └──────────────┘                  │
    └─────────────────────────────────────────────────────────────────┘

User selects region, pastes two keys, clicks "Enable" → same security notice modal → confirms → integration is created → page shows connected state with tool list (same as Sentry post-connect view).

Note: the user never types a URL. The URL is derived from the region selection (US1 → `https://app.datadoghq.com/mcp`). The header names (`DD-API-KEY`, `DD-APPLICATION-KEY`) are pre-defined by the template — the user only provides values.

### Flow 4: Add Your Own (custom MCP server)

User clicks the "Add Your Own" card → custom server form:

    ┌─────────────────────────────────────────────────────────────────┐
    │  ← Back to MCP Integrations                                    │
    │                                                                │
    │  Add Your Own MCP Server                                       │
    │  Connect to an MCP server not in the marketplace.              │
    │                                                                │
    │  ─────────────────────────────────────────────────────────      │
    │                                                                │
    │  Name *                                                        │
    │  ┌──────────────────────────────────────────┐                  │
    │  │ My Internal Tools                        │                  │
    │  └──────────────────────────────────────────┘                  │
    │                                                                │
    │  Server URL *                                                  │
    │  ┌──────────────────────────────────────────┐                  │
    │  │ https://mcp.internal.company.com/mcp     │                  │
    │  └──────────────────────────────────────────┘                  │
    │  ℹ️ We'll check for OAuth support automatically                │
    │                                                                │
    │  Transport                                                     │
    │  ┌──────────────────────────┐                                  │
    │  │ Streamable HTTP       ▼  │                                  │
    │  └──────────────────────────┘                                  │
    │                                                                │
    │  When the user blurs the URL field, the system probes for      │
    │  .well-known/oauth-protected-resource. If OAuth is detected:   │
    │                                                                │
    │  ✅ OAuth support detected                                     │
    │  Authorization endpoint: https://mcp.internal.company.com/...  │
    │  Token endpoint: https://mcp.internal.company.com/...          │
    │                                                                │
    │  OAuth Client ID *                                             │
    │  ┌──────────────────────────────────────────┐                  │
    │  │ polaris-internal-client                  │                  │
    │  └──────────────────────────────────────────┘                  │
    │                                                                │
    │  ┌──────────────────────────────────┐                          │
    │  │ Connect with OAuth              │                          │
    │  └──────────────────────────────────┘                          │
    │                                                                │
    │  ── OR if no OAuth detected ──────────────────────────         │
    │                                                                │
    │  Authentication: None / Static Headers                         │
    │                                                                │
    │  Headers                                                       │
    │  ┌────────────────┐ ┌──────────────────────────┐               │
    │  │ Authorization  │ │ Bearer ••••••••••         │               │
    │  └────────────────┘ └──────────────────────────┘               │
    │  [+ Add header]                                                │
    │                                                                │
    │                              ┌──────────────┐                  │
    │                              │   Enable     │                  │
    │                              └──────────────┘                  │
    └─────────────────────────────────────────────────────────────────┘

For custom OAuth servers, Polaris discovers endpoints automatically but still requires a client ID unless Polaris already ships a template-owned client for that provider.

After enabling, the same security notice modal → same connected state with test tools and discovered tool inventory.

### Flow 5: Managing an installed integration

From the marketplace grid, installed integrations show their status:

    ┌──────────────────────┐  ┌──────────────────────┐
    │ 🔶 Sentry  [Official]│  │ 🟣 Datadog [Official]│
    │                      │  │                      │
    │ Debug production     │  │ Retrieve telemetry   │
    │ errors with full     │  │ insights: incidents, │
    │ stack traces.        │  │ logs, dashboards.    │
    │                      │  │                      │
    │ OAuth · Org-shared   │  │ API Keys · Org-shared│
    │                      │  │                      │
    │ ● Connected          │  │ ● Connected          │
    │   25 tools discovered│  │   12 tools discovered│
    └──────────────────────┘  └──────────────────────┘

Status chips on cards:
- **● Connected** (green) — working, tokens valid
- **● Needs auth** (yellow) — OAuth token expired/revoked, needs reconnect
- **● Misconfigured** (red) — last test failed
- **● Not installed** (gray) — not set up yet

Clicking an installed card shows the manage view (same as the post-connect view above) where the admin can test tools, reconnect if needed, disable, or remove.

### Flow Summary Diagram

    ┌─────────────┐
    │ Marketplace │
    │    Grid     │
    └──────┬──────┘
           │
     ┌─────┼──────────────────────────┐
     │     │                          │
     ▼     ▼                          ▼
  ┌──────┐ ┌────────┐          ┌───────────┐
  │Sentry│ │Datadog │          │Add Your   │
  │ page │ │ page   │          │Own page   │
  └──┬───┘ └───┬────┘          └─────┬─────┘
     │         │                     │
     ▼         ▼                     ▼
  ┌─────────────────────────────────────────┐
  │         Security Notice Modal           │
  │  permission summary + ownership +       │
  │  "I understand" checkbox                │
  └────────────────┬────────────────────────┘
                   │
         ┌─────────┼───────────┐
         │         │           │
         ▼         ▼           ▼
    ┌─────────┐ ┌────────┐ ┌──────────┐
    │  OAuth  │ │  API   │ │  Auto-   │
    │ consent │ │  keys  │ │ discover │
    │ (Sentry)│ │ saved  │ │ + manual │
    └────┬────┘ └───┬────┘ └────┬─────┘
         │         │           │
         └─────────┼───────────┘
                   │
                   ▼
    ┌──────────────────────────────┐
    │   Connected / Enabled       │
    │   ┌──────────────────────┐  │
    │   │   Test tools         │  │
    │   │   25 tools found     │  │
    │   │   • search_issues    │  │
    │   │   • get_event        │  │
    │   │   • delete_project   │  │
    │   │   ...                │  │
    │   └──────────────────────┘  │
    │                             │
    │   [Disable]  [Remove]       │
    └──────────────────────────────┘

## Progress

- [ ] Milestone 1: Integration catalog + install status model
- [ ] Milestone 2: Auto-discovery (RFC 9728 + RFC 8414 probing)
- [ ] Milestone 3: Test tools handshake + health persistence
- [ ] Milestone 4: Marketplace UI + org-scoped routes
- [ ] Milestone 5: Sentry one-click OAuth flow (auto-discovered, zero config)
- [ ] Milestone 6: Datadog region + API key flow
- [ ] Milestone 7: Security notice + credential ownership UX
- [ ] Milestone 8: "Add Your Own" custom server form + legacy redirect
- [ ] Milestone 9: End-to-end validation

## Surprises & Discoveries

(None yet — to be updated during implementation.)

## Decision Log

- Decision: Two-lane architecture — marketplace templates + "Add Your Own" escape hatch.
  Rationale: Every major platform (Devin, Cursor, Windsurf, Cline) converges on this pattern. Curated templates handle 90% of use cases with zero config; raw form handles the long tail.
  Date/Author: 2026-03-22 / andreas

- Decision: Auto-discover OAuth endpoints via MCP spec (RFC 9728 → RFC 8414), don't require users to enter them.
  Rationale: The MCP spec requires servers to expose Protected Resource Metadata (RFC 9728) and Authorization Server Metadata (RFC 8414). Sentry already implements this: fetching `https://mcp.sentry.dev/.well-known/oauth-protected-resource/mcp` returns `authorization_servers`, then fetching `https://mcp.sentry.dev/.well-known/oauth-authorization-server` returns all endpoints, scopes, and PKCE methods. Users should never type an OAuth endpoint.
  Date/Author: 2026-03-22 / andreas

- Decision: Catalog templates are hardcoded JSON in the codebase (not a DB table).
  Rationale: Templates change rarely and should be versioned with the code. A DB table adds migration overhead and admin UI for something that's effectively static config. If we need a community marketplace later, that's a separate feature.
  Date/Author: 2026-03-22 / andreas

- Decision: Start with Sentry and Datadog only, then expand.
  Rationale: These two cover the two primary auth patterns (OAuth and API keys) and are the most requested by users. Shipping two well-polished integrations is better than shipping twenty half-baked ones.
  Date/Author: 2026-03-22 / andreas

- Decision: Test tools calls the MCP server's tools/list method and shows results in the UI.
  Rationale: Devin has "Test listing tools" as a first-class button. Without this, users configure an integration and have no idea if it actually works until an agent tries to use it. This is the minimum viable verification.
  Date/Author: 2026-03-22 / andreas

- Decision: Keep existing mcp_servers table, add catalogSlug column to link installed servers to templates.
  Rationale: The table structure is correct — it stores the org-specific installation state. The template defines the defaults; the installed row stores the org's specific config (tokens, keys, which region). Adding a column is simpler than a new table + FK.
  Date/Author: 2026-03-22 / andreas

- Decision: Marketplace status is derived in the data layer, not assembled ad hoc in React.
  Rationale: This follows the repo's architecture rule that data produces correct state and the UI just renders. A single query helper should merge catalog templates with installed rows and derive `not_installed`, `needs_auth`, `misconfigured`, or `connected` from row presence, auth state, and last test result.
  Date/Author: 2026-03-22 / andreas

- Decision: Security notice modal before OAuth redirect, with human-readable permission summary and credential ownership disclosure.
  Rationale: Devin shows "You're about to give Devin significant access to Sentry" with an "I understand" checkbox before redirect. Cline warns users to trust the source. This is especially important because Polaris connections are org-wide — every agent session will use the same auth state. The notice must say what the integration can do (not OAuth jargon) and whether access is personal or org-shared.
  Date/Author: 2026-03-22 / andreas

- Decision: Per-template credential ownership model (org-shared vs per-user) declared in the catalog and shown in the UI before the user clicks Connect.
  Rationale: Devin says org-shared and recommends service accounts. Cursor says per-user for cloud agents. These are materially different security models. The user needs to see this before granting access, not after. Template declares `ownershipModel: "org-shared" | "per-user"` and the enable flow surfaces it.
  Date/Author: 2026-03-22 / andreas

- Decision: V1 ships tool inventory and health status, not per-tool filtering.
  Rationale: The current `mcp_servers` runtime contract and proxy payload do not support an allowlist of tool names. Showing toggles without enforcing them at dispatch would be deceptive. Ship read-only discovery in this plan; treat filtering as a separate end-to-end change once the proxy/runtime contract supports it.
  Date/Author: 2026-03-22 / andreas

- Decision: No dynamic client registration in this exec plan.
  Rationale: The current OAuth model stores a client ID and uses PKCE public-client flow. It has no place for dynamically registered client metadata or secrets. Zero-config marketplace entries must provide a known client ID in the catalog; DCR is a separate feature.
  Date/Author: 2026-03-22 / andreas

- Decision: This is not an MVP — ship a production-quality version with Sentry and Datadog as first-class citizens.
  Rationale: User explicitly requested a strong, complete implementation. No shortcuts on UX, security notices, test tools, install-state modeling, or route integration. Two polished integrations > twenty half-baked ones.
  Date/Author: 2026-03-22 / andreas

## Outcomes & Retrospective

(To be completed after implementation.)

## Context and Orientation

This plan builds on the foundation from exec plan 10 (PR #110). All backend plumbing is in place:

**What exists (from PR #110):**
- `lib/mcp-servers/schema.ts` — `mcp_servers` table with org scoping, encrypted auth configs, OAuth metadata columns
- `lib/mcp-servers/actions.ts` — CRUD + auth management (create, update, clear, clearIfStale)
- `lib/mcp-servers/queries.ts` — list, find, `getResolvedMcpServers()` (fail-open, parallel refresh)
- `lib/mcp-servers/oauth-state.ts` — HMAC-signed state for OAuth redirects
- `lib/mcp-servers/url-validation.ts` — SSRF-safe fetch with DNS pinning + TLS SNI
- `app/api/mcp-servers/` — CRUD + OAuth start/callback routes (admin-only)
- `lib/sandbox-proxy/acp-bridge.ts` — `toSdkMcpServers()` conversion, threaded through all session creation paths
- `lib/orchestration/prompt-dispatch.ts`, `coding-task.ts`, `pr-review.ts`, `sweeper.ts` — all load and inject mcpServers
- `lib/auth/hmac-state.ts` — generic HMAC state signing (shared with GitHub App flow)
- `lib/auth/session.ts` — `getSessionWithOrgAdmin()` for admin-only routes

**What needs to change:**
- New: `lib/mcp-servers/catalog.ts` — hardcoded integration templates (Sentry, Datadog, etc.)
- New: `lib/mcp-servers/discovery.ts` — RFC 9728/8414 auto-discovery
- New: `app/api/mcp-servers/[id]/test/route.ts` — test tools endpoint
- New: `app/(dashboard)/[orgSlug]/integrations/mcp/page.tsx` — marketplace grid
- New: `app/(dashboard)/[orgSlug]/integrations/mcp/[slug]/page.tsx` — per-integration install page
- New: `app/(dashboard)/[orgSlug]/integrations/mcp/custom/page.tsx` — custom server list/create/manage page
- Modify: `lib/mcp-servers/schema.ts` — add `catalogSlug`, test-status fields, discovered-tool cache, and a unique partial index for catalog installs
- Modify: `lib/mcp-servers/actions.ts` / `queries.ts` — persist test results and expose a marketplace read model
- Modify: `app/api/mcp-servers/route.ts` — POST can accept `catalogSlug` and merge template defaults
- Modify: `app/api/mcp-servers/oauth/start/route.ts` — use auto-discovered endpoints when available
- Modify: `app/api/mcp-servers/oauth/callback/route.ts` — redirect to org-scoped marketplace/custom views
- Modify: `app/(dashboard)/[orgSlug]/integrations/page.tsx` — add MCP entry to the existing integrations overview
- Modify: `app/(dashboard)/[orgSlug]/settings/page.tsx` — link to the new integrations page
- Modify: `app/(dashboard)/[orgSlug]/settings/mcp/page.tsx` — redirect legacy traffic into the new marketplace/custom surface

**MCP OAuth auto-discovery flow (verified against Sentry's live endpoints):**
1. Client sends unauthenticated request to MCP server URL
2. Server returns 401 with `WWW-Authenticate: Bearer resource_metadata="https://.../.well-known/oauth-protected-resource/mcp"`
3. Client fetches protected resource metadata → gets `authorization_servers: ["https://mcp.sentry.dev"]`
4. Client fetches `https://mcp.sentry.dev/.well-known/oauth-authorization-server` → gets full OAuth metadata:
   - `authorization_endpoint`: `https://mcp.sentry.dev/oauth/authorize`
   - `token_endpoint`: `https://mcp.sentry.dev/oauth/token`
   - `registration_endpoint`: `https://mcp.sentry.dev/oauth/register`
   - `scopes_supported`: `["org:read", "project:write", "team:write", "event:write"]`
   - `code_challenge_methods_supported`: `["plain", "S256"]`
   - `grant_types_supported`: `["authorization_code", "refresh_token"]`

This means: for any spec-compliant OAuth MCP server, the endpoints are discoverable from the server URL. Marketplace templates can therefore hide the OAuth plumbing entirely; custom servers still need a client ID unless Polaris has a template-owned one.

**Existing UI patterns to follow:**
- Integrations page: `app/(dashboard)/[orgSlug]/integrations/page.tsx` — card-based GitHub installation grid
- Settings navigation: `app/(dashboard)/[orgSlug]/settings/page.tsx` — card grid with links to sub-pages
- Environment page: `app/(dashboard)/[orgSlug]/settings/environment/page.tsx` — CRUD form + list
- Legacy MCP page: `app/(dashboard)/[orgSlug]/settings/mcp/page.tsx` exists today, but do not copy its direct `useEffect` pattern. This repo's guidance is to use server-rendered data and explicit event handlers / query abstractions instead.

## Plan of Work

### Milestone 1: Integration Catalog + Install Status Model

**1a. Catalog definition** — Create `lib/mcp-servers/catalog.ts`. This is a hardcoded array of integration templates:

    export type McpIntegrationTemplate = {
      slug: string;                    // "sentry", "datadog"
      name: string;                    // "Sentry"
      description: string;             // "Debug production errors with full stack traces"
      icon: string;                    // URL or path to icon
      category: string;                // "Monitoring", "Databases", etc.
      badge: "official" | "verified" | "community";
      serverUrl: string | null;        // Fixed URL (Sentry) or null (built from region)
      transport: "streamable-http" | "sse";
      authType: "oauth-discovery" | "static-headers";
      oauthClientId?: string;          // Required for zero-config OAuth templates
      // For oauth-discovery: endpoints are auto-discovered, no config needed
      // For static-headers: define required header names
      requiredHeaders?: string[];      // ["DD-API-KEY", "DD-APPLICATION-KEY"]
      regionOptions?: Array<{ label: string; value: string; url: string }>;
      scopes?: string;                 // OAuth scopes to request (fallback if discovery fails)
      docsUrl?: string;
      websiteUrl?: string;
      ownershipModel: "org-shared" | "per-user";
      permissionSummary: string;       // "Read issues, traces, and stack traces"
    };

    export const MCP_CATALOG: McpIntegrationTemplate[] = [
      {
        slug: "sentry",
        name: "Sentry",
        description: "Retrieve detailed issue data, full stack traces, and search/filter issues. Analyze errors and debug production problems.",
        icon: "/integrations/sentry.svg",
        category: "Monitoring & Analytics",
        badge: "official",
        serverUrl: "https://mcp.sentry.dev/mcp",
        transport: "streamable-http",
        authType: "oauth-discovery",
        oauthClientId: "<polaris-public-client-id>",
        scopes: "org:read project:write team:write event:write",
        docsUrl: "https://docs.sentry.io/product/sentry-mcp/",
        websiteUrl: "https://sentry.io",
        ownershipModel: "org-shared",
        permissionSummary: "Read and search issues, view stack traces, manage project settings",
      },
      {
        slug: "datadog",
        name: "Datadog",
        description: "Retrieve telemetry insights and manage Datadog platform features including incidents, monitors, logs, dashboards, metrics, traces, hosts, and more.",
        icon: "/integrations/datadog.svg",
        category: "Monitoring & Analytics",
        badge: "official",
        serverUrl: null, // built from region
        transport: "streamable-http",
        authType: "static-headers",
        requiredHeaders: ["DD-API-KEY", "DD-APPLICATION-KEY"],
        regionOptions: [
          { label: "US1", value: "us1", url: "https://app.datadoghq.com/mcp" },
          { label: "US3", value: "us3", url: "https://us3.datadoghq.com/mcp" },
          { label: "US5", value: "us5", url: "https://us5.datadoghq.com/mcp" },
          { label: "EU", value: "eu", url: "https://app.datadoghq.eu/mcp" },
          { label: "AP1", value: "ap1", url: "https://ap1.datadoghq.com/mcp" },
          { label: "AP2", value: "ap2", url: "https://ap2.datadoghq.com/mcp" },
          { label: "US1-FED", value: "us1-fed", url: "https://app.ddog-gov.com/mcp" },
        ],
        docsUrl: "https://docs.datadoghq.com/integrations/mcp/",
        websiteUrl: "https://www.datadoghq.com",
        ownershipModel: "org-shared",
        permissionSummary: "Read logs, metrics, traces, monitors, and dashboards",
      },
    ];

    export function getCatalogTemplate(slug: string): McpIntegrationTemplate | undefined {
      return MCP_CATALOG.find(t => t.slug === slug);
    }

Zero-config OAuth entries must ship with a known `oauthClientId` in the catalog. Dynamic client registration is explicitly out of scope for this exec plan.

**1b. Schema extension** — Extend `mcp_servers` to support marketplace installs and data-driven status:

    catalogSlug: text("catalog_slug"), // nullable — null for custom "Add Your Own" servers
    lastTestStatus: text("last_test_status"), // nullable — "ok" | "error"
    lastTestError: text("last_test_error"),
    lastTestedAt: timestamp("last_tested_at", { withTimezone: true }),
    lastDiscoveredTools: text("last_discovered_tools"), // JSON array cached from latest tools/list

Add a unique partial index on `(organizationId, catalogSlug)` for rows where `catalogSlug IS NOT NULL`. This is the real guardrail that enforces one marketplace install per template per org. Keep the existing `(organizationId, name)` uniqueness for custom entries.

Generate and apply migration with `drizzle-kit`; do not hand-write SQL.

**1c. Marketplace read model** — Add a query helper that merges templates with installed rows and computes the card/detail status in one place.

Suggested shape:

    type CatalogInstallStatus =
      | "not_installed"
      | "needs_auth"
      | "misconfigured"
      | "connected";

    type CatalogInstallationView = {
      template: McpIntegrationTemplate;
      server: typeof mcpServers.$inferSelect | null;
      status: CatalogInstallStatus;
      toolCount: number;
      lastTestedAt: Date | null;
      lastTestError: string | null;
      discoveredTools: Array<{ name: string; description?: string }> | null;
    };

Status rules live in the data layer, not in React:
- `not_installed`: no row for this `catalogSlug`
- `needs_auth`: row exists, `authType === "oauth"`, and no stored auth tokens
- `misconfigured`: row exists and `lastTestStatus === "error"`
- `connected`: installed and no failing test state

**1d. API extension** — Modify `POST /api/mcp-servers` to accept `catalogSlug` for marketplace installs. When provided, merge template defaults server-side (server URL, transport, auth type, OAuth client ID, docs metadata), derive the final URL from region if needed, and reject duplicate installs by `catalogSlug`. The existing raw request shape remains supported for the custom page.

### Milestone 2: Auto-Discovery (RFC 9728 + RFC 8414)

Create `lib/mcp-servers/discovery.ts` — a module that auto-discovers OAuth endpoints from any MCP server URL.

    export type DiscoveredOAuthConfig = {
      authorizationEndpoint: string;
      tokenEndpoint: string;
      registrationEndpoint?: string;
      scopesSupported?: string[];
      codeChallengeMethodsSupported?: string[];
    };

    /**
     * Discover OAuth configuration from an MCP server URL.
     * Follows the MCP spec's two-step discovery:
     * 1. Fetch Protected Resource Metadata (RFC 9728) to find authorization_servers
     * 2. Fetch Authorization Server Metadata (RFC 8414) to get endpoints
     *
     * Falls back to probing well-known URIs if the 401 WWW-Authenticate header
     * doesn't include resource_metadata.
     */
    export async function discoverOAuthConfig(
      serverUrl: string,
    ): Promise<DiscoveredOAuthConfig | null> { ... }

The function:
1. Sends a GET to `serverUrl` without auth
2. If 401, parses `WWW-Authenticate` header for `resource_metadata` URL
3. Fetches the resource metadata → extracts `authorization_servers[0]`
4. If no header, falls back to probing well-known URIs:
   - `/.well-known/oauth-protected-resource/<path>` (path-specific)
   - `/.well-known/oauth-protected-resource` (root)
5. Fetches `/.well-known/oauth-authorization-server` from the discovered auth server
6. Returns the full OAuth config

All fetches use `safeFetch` from `url-validation.ts` for SSRF protection. Discovery failures return null. Template-backed flows may still succeed if the template already contains the required endpoints; custom flows fall back to manual entry.

### Milestone 3: Test Tools Handshake + Health Persistence

Create `app/api/mcp-servers/[id]/test/route.ts`:

    POST /api/mcp-servers/:id/test

This endpoint:
1. Requires admin auth (`getSessionWithOrgAdmin`)
2. Loads the MCP server config by id + org
3. Resolves auth (decrypts headers or OAuth token)
4. Performs a proper MCP handshake (`initialize` + `tools/list`) over the configured transport
5. Persists `lastTestStatus`, `lastTestError`, `lastTestedAt`, and `lastDiscoveredTools`
6. Returns the list of discovered tools: `{ tools: [{ name, description, inputSchema }] }`
7. On failure, returns `{ error: "..." }` with the specific failure reason (auth, network, timeout)

The test must use `safeFetch` for SSRF protection and have a 10-second timeout.

Do not fake this with a one-off raw `tools/list` POST. Reuse an existing MCP client if one is already available in the dependency graph; otherwise add a small server-side helper (for example `lib/mcp-servers/test-client.ts`) that implements the minimum compliant flow for `streamable-http` and `sse`.

### Milestone 4: Marketplace UI + Org-Scoped Routes

**4a. Org-scoped routes** — Create:

- `app/(dashboard)/[orgSlug]/integrations/mcp/page.tsx`
- `app/(dashboard)/[orgSlug]/integrations/mcp/[slug]/page.tsx`
- `app/(dashboard)/[orgSlug]/integrations/mcp/custom/page.tsx`

Use server components for initial data loading and small client components for interactive forms/actions. Do not copy the old `settings/mcp` page's direct `useEffect` pattern.

**4b. Marketplace grid page** — `app/(dashboard)/[orgSlug]/integrations/mcp/page.tsx`:

- Title: "MCP Integrations"
- Subtitle: "Connect external tools to your agent sessions"
- Filter tabs: All, Installed, Not Installed (+ category filters)
- Grid of provider cards, each showing: icon, name, badge, description, auth type, category, install status
- "Add Your Own" card at the end (links to the raw form)
- Each card links with `orgPath(orgSlug, ...)` to `/integrations/mcp/[slug]` for marketplace entries or `/integrations/mcp/custom` for Add Your Own

**4c. Per-integration install page** — `app/(dashboard)/[orgSlug]/integrations/mcp/[slug]/page.tsx`:

For OAuth integrations (Sentry):
- Shows: icon, name, badge, description, transport, auth type, docs link, website link
- Permission summary: "This integration will allow agents to: read issues and stack traces, ..."
- Ownership notice: "This connection is shared across your workspace. We recommend using a service account."
- "Enable" button → security notice modal → starts OAuth flow
- If already installed: shows derived status, "Test tools" button, cached tool list, "Disable"/"Remove" buttons, and "Reconnect" when auth is missing/stale

For API-key integrations (Datadog):
- Shows: icon, name, badge, description, region dropdown (pre-filled options)
- Required fields: DD-API-KEY (password input), DD-APPLICATION-KEY (password input)
- "Enable" button → creates server with region-derived URL and headers
- If already installed: shows derived status, "Test tools" button, cached tool list, "Disable"/"Remove"

**4d. Existing navigation surfaces** — Add an MCP card to `app/(dashboard)/[orgSlug]/integrations/page.tsx` and update `app/(dashboard)/[orgSlug]/settings/page.tsx` to link to the marketplace. Reuse the current information architecture rather than inventing a new sidebar subtree.

### Milestone 5: Sentry One-Click OAuth

Wire up the Sentry template's `authType: "oauth-discovery"` to the auto-discovery flow:

1. User clicks "Enable" on `/{orgSlug}/integrations/mcp/sentry`
2. Frontend calls `POST /api/mcp-servers` with `{ catalogSlug: "sentry" }` — no URL, no auth config needed
3. Backend loads the template, uses `serverUrl: "https://mcp.sentry.dev/mcp"` and the template-owned `oauthClientId`, creates the DB row with `authType: "oauth"`
4. Backend calls `discoverOAuthConfig("https://mcp.sentry.dev/mcp")` to get OAuth endpoints
5. Backend stores discovered endpoints (and discovered scopes if helpful) in the DB row's OAuth columns
6. Frontend redirects to `GET /api/mcp-servers/oauth/start?serverId=<id>`
7. OAuth start route reads endpoints from DB (populated by discovery) → redirects to Sentry's consent page
8. User approves → callback → tokens stored → redirect to `/{orgSlug}/integrations/mcp/sentry?success=connected`
9. User clicks "Test tools" → shows Sentry's 16+ tools

The key change from the current flow: **no manual endpoint entry**. The user never sees OAuth URLs, client IDs, or scopes. Endpoints are auto-discovered; the client ID comes from the catalog template.

If discovery unexpectedly fails for Sentry, surface an explicit setup error instead of redirecting into a broken OAuth flow.

### Milestone 6: Datadog Region + API Key Flow

Wire up the Datadog template's `authType: "static-headers"` with region selection:

1. User clicks "Enable" on the Datadog card
2. Install page shows: region dropdown (US1, US3, US5, EU, AP1, AP2, US1-FED), two API key fields
3. User selects region, pastes keys, clicks "Enable"
4. Frontend calls `POST /api/mcp-servers` with:
   `{ catalogSlug: "datadog", region: "us1", headers: { "DD-API-KEY": "...", "DD-APPLICATION-KEY": "..." } }`
5. Backend loads template, resolves `serverUrl` from `regionOptions`, creates server with static auth
6. Redirects to `/{orgSlug}/integrations/mcp/datadog?success=connected` → "Connected" status, "Test tools" button

### Milestone 7: Security Notice + Credential Ownership UX

**7a. Security notice modal** — shown before any OAuth redirect or API-key submission:

The modal is rendered on the per-integration install page (`[slug]/page.tsx`). Content is driven by the catalog template:

    "Enable MCP Integration"
    "Grant Polaris access to {name}. You can disable this integration at any time."

    [Security Notice box]
    "You're about to give agents {permissionSummary}."
    "{ownershipNotice}"

    [checkbox] "I understand and want to enable this integration"
    [Enable integration] button (disabled until checkbox is checked)

For org-shared integrations (Sentry, Datadog), the ownership notice says: "Enabling this integration will allow all members of your organization to use the same MCP server connection, sharing a single authentication state for all actions. We recommend using a service account."

For per-user integrations, it says: "This connection is personal. Each team member will need to connect their own account."

The template's `ownershipModel` field drives which notice is shown. The enable button is disabled until the checkbox is checked.

**7b. Credential ownership display** — on integration cards and install pages, show a badge:

- "Org-shared" (with people icon) for `ownershipModel: "org-shared"`
- "Personal" (with user icon) for `ownershipModel: "per-user"`

This is visible on the marketplace card before the user clicks into the integration.

### Milestone 8: "Add Your Own" Custom Server + Legacy Redirect

Refine the existing raw form into a secondary path without losing the ability to manage multiple custom servers:

- `app/(dashboard)/[orgSlug]/integrations/mcp/custom/page.tsx` is the place for custom installs
- The page lists existing custom servers and includes the create/manage form
- Keep the current manual form structure but improve it:
  - Try auto-discovery on URL blur (event handler, not `useEffect`)
  - If OAuth is detected, pre-fill endpoints and offer OAuth auth with a client-ID field
  - If no OAuth, show the static headers form
  - Show the same security notice modal as marketplace integrations
- After enabling, show the same "Test tools" and discovered-tool inventory as marketplace integrations
- `app/(dashboard)/[orgSlug]/settings/mcp/page.tsx` becomes a redirect to `/{orgSlug}/integrations/mcp/custom`
- OAuth callback and all success/error redirects should target org-scoped marketplace/custom pages directly; the legacy settings path is only a compatibility redirect

### Milestone 9: End-to-End Validation

1. `pnpm typecheck` passes
2. `pnpm test:unit` passes
3. Integration tests pass if the local DB environment is available
4. Manual: navigate to `/{orgSlug}/integrations`, see the MCP entry, and navigate to `/{orgSlug}/integrations/mcp`
5. Manual: marketplace cards show badges, ownership labels, and derived status chips from the read model
6. Manual: click Enable on Sentry → see security notice modal with permission summary and ownership notice → check "I understand" → OAuth flow → Connected → Test tools shows discovered tools and persists status
7. Manual: click Enable on Datadog → see security notice → select region, paste keys → Connected → Test tools shows discovered tools and persists status
8. Manual: "Add Your Own" → enter custom URL → auto-discovery attempted → if OAuth, provide client ID → security notice → configure → test tools
9. Manual: visit `/{orgSlug}/settings/mcp` and confirm it redirects to the new custom-server surface
10. Dispatch a prompt to a session → agent sees configured MCP server tools

## Concrete Steps

### Milestone 1 Commands

    mkdir -p lib/mcp-servers
    # After creating catalog.ts and extending schema fields/indexes:
    pnpm exec drizzle-kit generate
    DATABASE_URL=postgresql://polaris:polaris@localhost:5432/polaris pnpm exec drizzle-kit migrate
    pnpm typecheck

### Milestone 2 Commands

    pnpm typecheck
    # Manual test: node -e "import('./lib/mcp-servers/discovery.ts').then(m => m.discoverOAuthConfig('https://mcp.sentry.dev/mcp').then(console.log))"

### Milestone 3 Commands

    pnpm typecheck
    # Test via curl:
    curl -X POST http://localhost:3001/api/mcp-servers/<id>/test -H "Cookie: <session>"

### Milestones 4-8 Commands

    pnpm typecheck
    pnpm test:unit
    # Visual verification in browser at http://localhost:3001/<orgSlug>/integrations/mcp

## Validation and Acceptance

The feature is complete when:

1. **Marketplace works**: Navigate to `/{orgSlug}/integrations/mcp`. See Sentry and Datadog cards with logos, badges, descriptions, auth type labels, ownership badges, and derived status chips.
2. **Sentry zero-config**: Click "Enable" → security notice modal with permission summary + ownership disclosure + "I understand" checkbox → OAuth consent → "Connected" → Test shows discovered tools. User never enters a URL, OAuth endpoint, or client ID.
3. **Datadog region flow**: Click "Enable" → security notice → pick region, paste keys → "Connected" → Test shows discovered tools.
4. **Security notice**: Every enable flow (marketplace + Add Your Own) shows the security notice modal with human-readable permissions and credential ownership before granting access.
5. **Install status is data-driven**: The marketplace read model derives `Connected` / `Needs auth` / `Misconfigured` / `Not installed` from stored installation state and latest test result. The UI does not invent its own status rules.
6. **Add Your Own**: Enter a custom URL → auto-discovery probes for OAuth → if OAuth, provide a client ID → security notice → fallback to manual/static headers when needed → test tools → discovered tool inventory.
7. **Legacy route compatibility**: `/{orgSlug}/settings/mcp` redirects cleanly to the new custom-server surface.
8. **Test tools**: Shows tool name, description, and input schema for each discovered tool, and persists the latest health/test result.
9. **Dispatch works**: Agent sessions include configured MCP servers with resolved auth.
10. **Typecheck and tests pass**.

## Idempotence and Recovery

- Catalog templates are hardcoded — no migration needed to update them.
- `catalogSlug` on mcp_servers links installations to templates. If a template changes, existing installations keep their stored config.
- OAuth auto-discovery is best-effort — if it fails, the system falls back to template-provided or manually-entered endpoints.
- Test tools is non-destructive (read-only `initialize` + `tools/list` flow).
- Latest tool inventory and test status are cached on the row and overwritten on each re-test.

## Artifacts and Notes

### File inventory

    Create: lib/mcp-servers/catalog.ts (integration templates)
    Create: lib/mcp-servers/discovery.ts (RFC 9728 + 8414 auto-discovery)
    Create: lib/mcp-servers/test-client.ts (minimal MCP handshake for initialize + tools/list, if no reusable client is available)
    Create: app/api/mcp-servers/[id]/test/route.ts (test tools endpoint)
    Create: app/(dashboard)/[orgSlug]/integrations/mcp/page.tsx (marketplace grid)
    Create: app/(dashboard)/[orgSlug]/integrations/mcp/[slug]/page.tsx (per-integration install/manage)
    Create: app/(dashboard)/[orgSlug]/integrations/mcp/custom/page.tsx (Add Your Own list/create/manage)
    Create: public/integrations/sentry.svg (provider icon)
    Create: public/integrations/datadog.svg (provider icon)
    Modify: lib/mcp-servers/schema.ts (add catalogSlug, test-status fields, discovered-tool cache, catalog uniqueness)
    Modify: lib/mcp-servers/actions.ts (persist latest test results and discovered tools)
    Modify: lib/mcp-servers/queries.ts (marketplace read model + derived install statuses)
    Modify: app/api/mcp-servers/route.ts (accept catalogSlug, merge template defaults)
    Modify: app/api/mcp-servers/oauth/start/route.ts (use discovered endpoints)
    Modify: app/api/mcp-servers/oauth/callback/route.ts (redirect to org-scoped marketplace/custom views)
    Modify: app/(dashboard)/[orgSlug]/integrations/page.tsx (add MCP entry)
    Modify: app/(dashboard)/[orgSlug]/settings/page.tsx (add integrations link)
    Modify: app/(dashboard)/[orgSlug]/settings/mcp/page.tsx (legacy redirect)

### Reference: Sentry MCP auto-discovery chain

    # Step 1: Probe for Protected Resource Metadata (RFC 9728)
    GET https://mcp.sentry.dev/.well-known/oauth-protected-resource/mcp
    → { "resource": "https://mcp.sentry.dev/mcp", "authorization_servers": ["https://mcp.sentry.dev"], "scopes_supported": [...] }

    # Step 2: Fetch Authorization Server Metadata (RFC 8414)
    GET https://mcp.sentry.dev/.well-known/oauth-authorization-server
    → { "authorization_endpoint": "https://mcp.sentry.dev/oauth/authorize",
        "token_endpoint": "https://mcp.sentry.dev/oauth/token",
        "registration_endpoint": "https://mcp.sentry.dev/oauth/register",
        "scopes_supported": ["org:read", "project:write", "team:write", "event:write"],
        "code_challenge_methods_supported": ["plain", "S256"],
        "grant_types_supported": ["authorization_code", "refresh_token"] }

### Reference: Datadog MCP region URLs

    US1:     https://app.datadoghq.com/mcp
    US3:     https://us3.datadoghq.com/mcp
    US5:     https://us5.datadoghq.com/mcp
    EU:      https://app.datadoghq.eu/mcp
    AP1:     https://ap1.datadoghq.com/mcp
    AP2:     https://ap2.datadoghq.com/mcp
    US1-FED: https://app.ddog-gov.com/mcp

### Edge cases

- **Discovery fails**: Auto-discovery is best-effort. If the server doesn't implement RFC 9728/8414, fall back to template-provided endpoints. If neither exists, show the manual form.
- **Custom OAuth servers**: Auto-discovery can fill endpoints, but custom servers still require a client ID because dynamic client registration is out of scope.
- **Template vs installed config divergence**: Once installed, the org's config is independent of the template. Template updates (e.g., new scopes) don't retroactively change existing installations. Users can "Reconnect" to pick up new scopes.
- **Multiple installations of same template**: Prevented by a unique partial index on `(organizationId, catalogSlug)` where `catalogSlug IS NOT NULL`. Custom installs remain separate and can still use different names.
- **Multiple custom servers**: Managed on the `/integrations/mcp/custom` page, which lists all custom rows and allows creating additional ones.
- **Test tools timeout**: 10-second timeout on the test call. Show specific error: "Connection timed out", "Authentication failed", "Server returned error".
- **Unknown test state**: A newly connected integration may have no `lastTestStatus` yet. Treat that as connected but untested, and show "Never tested" in the detail view until the first successful or failed test.
- **Dynamic client registration**: Explicitly out of scope. Marketplace OAuth entries must supply a known client ID in the catalog.
