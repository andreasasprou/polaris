# MCP Servers

MCP Servers let you connect external tools — like Sentry, Datadog, or custom internal services — to your agent sessions. Once configured, every agent session in your workspace automatically has access to the tools those servers provide.

## How it works

1. **Add an MCP server** in Settings > MCP Servers
2. **Choose an auth method** — either static headers (e.g., Bearer token) or OAuth for providers that require it
3. **Every session gets it** — all interactive sessions, coding tasks, and PR reviews in the workspace will connect to the configured servers when they start

The agent sees the MCP server's tools alongside its built-in tools and can call them during prompts. For example, an agent connected to a Sentry MCP server can search issues, view stack traces, and analyze error patterns without you pasting anything into the prompt.

## Adding a static-header server

Most MCP servers accept a Bearer token or API key passed via HTTP headers.

1. Go to **Settings > MCP Servers**
2. Select the **Static Headers** tab
3. Fill in the server name, URL, and transport (Streamable HTTP or SSE)
4. Add at least one header — typically `Authorization: Bearer <your-token>`
5. Click **Add server**

The server appears in the list immediately and is active for all new sessions.

## Adding an OAuth server

Some providers (Sentry, etc.) require OAuth 2.1 authorization instead of static tokens.

1. Go to **Settings > MCP Servers**
2. Select the **OAuth** tab
3. Fill in the server name, URL, transport, and the OAuth details:
   - **Client ID** — from the provider's developer console
   - **Authorization URL** — the provider's OAuth authorize endpoint
   - **Token URL** — the provider's OAuth token endpoint
   - **Scopes** — space-separated list (optional)
4. Click **Add OAuth server**
5. Click **Connect** on the server card — this redirects you to the provider's authorization page
6. Authorize access — you'll be redirected back to the settings page with a "Connected" status

Tokens are encrypted at rest and refreshed automatically when they expire. If a token is revoked, the server shows "Not connected" and you can click **Connect** again to re-authorize.

## Managing servers

Each server in the list can be:

- **Enabled/disabled** — disabled servers are skipped during session creation but keep their configuration
- **Removed** — deletes the server and its credentials permanently

Only workspace **owners and admins** can add, modify, or remove MCP servers.

## When servers are connected

MCP server configs are loaded at **dispatch time**, not stored in the sandbox. This means:

| Scenario | Picks up changes? |
|----------|-------------------|
| New session | Yes |
| New prompt to existing session | Yes |
| Coding task dispatch | Yes |
| PR review dispatch | Yes |
| Session recovery after sandbox dies | Yes |

If you add or remove an MCP server, the very next prompt to any session will use the updated configuration.

## What happens when a server is down

If an MCP server can't be reached during a session, the agent continues without that server's tools. MCP connection failures never block the agent — they're logged and skipped. The agent still has access to all its built-in tools and any other configured MCP servers that are reachable.

## Transport options

MCP servers support two transport modes:

- **Streamable HTTP** — the current standard transport. Use this unless the server documentation says otherwise.
- **SSE** (Server-Sent Events) — the legacy transport. Some older MCP server implementations use this.

## Security notes

- Auth credentials (headers, OAuth tokens) are encrypted at rest using AES-256-GCM
- OAuth token endpoints are validated with DNS resolution to block private/internal addresses
- OAuth flows use PKCE (Proof Key for Code Exchange) for security
- Only org owners and admins can manage MCP servers — regular members can use them but not configure them
