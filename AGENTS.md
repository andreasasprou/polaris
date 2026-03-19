# Polaris — Claude Code Instructions

## Architecture Principles

- **No plasters.** Don't patch edge cases with one-off fixes. Design primitives and flows so they handle all states as first-class citizens.
- **Data produces correct state; UI just renders.** The consolidation/data layer should handle all state transitions (terminal sessions, interrupted tool calls, etc.) so consumers never need special-case logic.
- **Context parameters over data mutation.** When the data layer needs external context (e.g. "is this session terminal?"), pass it as a parameter — don't inject synthetic events or mutate the event log.

## Testing & Verification

**Always verify your own work.** Run `pnpm typecheck` before considering any change complete.

### QA Process

When making changes to session lifecycle, UI, or sandbox interaction code:

1. **Typecheck first**: `pnpm typecheck` must pass
2. **Visual verification**: Use browser automation (Claude in Chrome) at `http://localhost:3001` to verify every visual state:
   - Active sessions (spinner, shimmer on pending tool calls)
   - Completed sessions (checkmarks, no spinners)
   - Failed/stopped sessions (error states, interrupted tool calls show ■ not spinner)
   - Hibernated/resumed sessions (status transitions render correctly)
3. **Data verification**: Query the DB via API endpoints (`/api/interactive-sessions/[id]`, `/api/sessions/[id]/events`) to verify data consistency
4. **Run traces**: Use Trigger.dev MCP `get_run_details` to inspect task execution
5. **Edge cases**: Test stale sessions, expired tokens, sandbox death, hibernate/resume cycles
6. **State matrix**: When adding a new status or visual state, verify it renders correctly in ALL contexts — session detail page, runs page, session list. Check the `statusConfig` maps in both `status.ts` and UI components have entries for the new state.

### What to check for terminal sessions specifically

- `turnInProgress` must be `false`
- All pending/running tool calls must show "interrupted" (■), not spinner
- All pending permissions/questions must show "rejected"
- Chat input should be disabled with appropriate placeholder
- No infinite polling — `pollIntervalMs` should be `0`

## Reference Documentation

Working with niche dependencies? Read the reference doc first:
- Vercel Sandbox: `docs/references/vercel-sandbox-llms.txt`
- Sandbox Agent: `docs/references/sandbox-agent-llms.txt`
- ACP HTTP Client: `docs/references/acp-http-client-llms.txt`

## Key Commands

- `pnpm typecheck` — must pass before considering work complete
- `pnpm dev` — local dev server on port 3001
- Trigger.dev MCP — use `get_run_details` to inspect task execution traces
