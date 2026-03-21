---
title: Richer Automations View
status: planned
created: 2026-03-20
owner: andreas
related_prs: []
domains: [ui, automations]
---

# 15 — Richer Automations View

## Problem Statement

Automations page shows a simple table with name, trigger, repo, and status. No run history, no quick actions, basic creation flow. Need: enriched rows with run summaries, sparkline, inline actions.

## Implementation

### Phase 1: Data Layer

**Add `findAutomationsWithRunSummaryByOrg` to `lib/automations/queries.ts`**

Two-query batch approach:
1. Fetch all automations for org (existing query)
2. Fetch last 10 runs for ALL automation IDs in single query using `inArray()`
3. Group runs by automationId in application code

Return type per row:
```typescript
type EnrichedAutomationRow = {
  automation: Automation;
  repoOwner: string | null;
  repoName: string | null;
  lastRun: RunSummary | null;
  recentRuns: RunSummary[];     // last 10, for sparkline
  nextScheduledRun: string | null; // v2 — not implemented in initial version
};
```

**`nextScheduledRun`:** Mark as v2 — not implemented in initial version. Would require `cron-parser` dependency and reading `triggerConfig.cron`. For v1, show "Daily at 9:00" text from the cron expression directly (human-readable display, not computed next date).

**Create `POST /api/automations/[id]/run-now/route.ts`**

Triggers immediate manual run:
1. Call `getSessionWithOrg()` for auth, then verify the automation belongs to the authenticated org
2. Verify repositoryId exists
3. Create automationRun with `source: "manual"`
4. Call `dispatchCodingTask` with synthesized trigger event
5. Only for oneshot mode (continuous needs PR context)

**Auth:** The `run-now` endpoint must call `getSessionWithOrg()` for auth, matching every other API route in the codebase. Then verify the automation belongs to the authenticated org.

**`source` field:** The `automationRuns.source` column is plain text with existing values: `'github' | 'slack' | 'schedule' | 'webhook' | 'sentry'`. Adding `'manual'` is fine at the DB level but update any UI display logic that pattern-matches on source values (e.g., trigger type display in the runs table).

**Trigger event synthesis:** `dispatchCodingTask` expects `AutomationCodingTaskPayload` with a `triggerEvent`. For manual runs, synthesize: `{ manual: true, triggeredBy: userId, ref: 'refs/heads/' + repository.defaultBranch, commits: [], repository: { full_name: owner/name } }`. The `resolveAutomationContext` function falls back to "Automation task" as the title when `event.commits` is empty.

### Phase 2: Enriched Table

**Refactor `automations-table.tsx`**

New columns: Last Run (relative time + status badge), Recent Runs (sparkline), Actions (inline)

**Create `run-sparkline.tsx`**

Row of colored dots (8px, 4px gap):
- Green = succeeded, Red = failed, Amber = cancelled, Grey = pending/running
- Tooltip on each dot with details

**Inline quick actions:**
- Visible: Run Now (PlayIcon, oneshot only), View Runs (HistoryIcon)
- Dropdown: Edit, Duplicate, Delete

**Optimistic UI:** Do NOT use `React.useOptimistic` — it is designed for Server Actions, not arbitrary fetch calls. Use the existing pattern from `automations-table.tsx`: `useState` for tracking in-progress IDs + `router.refresh()` on completion. For run-now: add `runningIds` state, show spinner on button while running, call `router.refresh()` when the API responds.

### Phase 3: Empty State

Template cards linking to `/automations/new?template=X`:
- PR Review Bot: auto-review every PR
- Coding Task: run agent on push

## Scope Note

**Scope split:** The creation wizard (Phase 4) is large enough to be its own plan. This plan focuses on Phases 1-3 (data layer + enriched table + empty state). The wizard can be a follow-up plan (15b). This reduces the blast radius and lets the enriched table ship independently.

## File Summary

| Action | File |
|--------|------|
| Create | `app/api/automations/[id]/run-now/route.ts` |
| Create | `app/(dashboard)/automations/_components/run-sparkline.tsx` |
| Modify | `lib/automations/queries.ts` |
| Modify | `app/(dashboard)/automations/_components/automations-table.tsx` |
| Modify | `app/(dashboard)/automations/page.tsx` |

## Key Considerations

- **Performance**: `idx_automation_runs_automation_created` index supports efficient run aggregation
- **Run Now for continuous**: Disabled with tooltip "PR reviews are triggered by pull request events"
