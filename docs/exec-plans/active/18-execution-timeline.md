---
title: Execution Timeline
status: planned
created: 2026-03-20
owner: andreas
related_prs: []
domains: [ui, sessions]
---

# 18 — Execution Timeline

## Problem Statement

Sessions go through distinct phases (provision → clone → agent → review → push → done) but there's no visual representation of this pipeline. CI/CD-style timeline visualization would give users clarity on what's happening.

## Design

### Phase Model

Derive from `session.status` + `job.status` + `job.type`:

**Universal phases** (subsets per job type):
```typescript
const PIPELINE_PHASES = [
  { id: "provision", label: "Provision" },
  { id: "clone",     label: "Clone" },
  { id: "agent",     label: "Agent" },
  { id: "review",    label: "Review" },   // review jobs only
  { id: "push",      label: "Push" },     // coding_task only
  { id: "done",      label: "Done" },
] as const;
```

Per job type:
- `prompt`: Provision → Agent → Done
- `coding_task`: Provision → Clone → Agent → Push → Done
- `review`: Provision → Agent → Review → Done

### Phase States

- `completed`: checkmark, muted
- `active`: highlighted, spinner
- `pending`: dimmed
- `failed`: red X
- `skipped`: hidden

### Visual Design

```
  ✓ ──── ✓ ──── ● ──── ○ ──── ○
 Prov   Clone  Agent  Push   Done
```

## Implementation

### Step 1: Enrich Session API

**Shared API enrichment:** Instead of adding `latestJob` directly to the GET handler, add it to the shared `enrichSessionResponse()` helper (from `lib/sessions/api-helpers.ts`, introduced by Plan 12). This helper is the single place where all session detail enrichments live, preventing merge conflicts between Plans 12, 14, and 18.

Add `latestJob` field to the enriched session response:
```typescript
latestJob: { id, type, status, createdAt, updatedAt } | null
```

Add `getLatestJobForSession(sessionId)` to `lib/jobs/actions.ts`.

### Step 2: Phase Model

**Create `lib/sessions/pipeline-phases.ts`**

```typescript
export function derivePipelinePhases(input: {
  sessionStatus: string;
  jobStatus: string | null;
  jobType: string | null;
}): PhaseInfo[]
```

Pure function, client-safe. Returns applicable phases with states based on current session+job status.

**Phase mapping specifics:**
- `sessionStatus = 'creating'` — provision active, rest pending
- `jobStatus = 'pending' | 'accepted'` — provision complete, agent pending (setup)
- `jobStatus = 'running'` — provision + clone complete, agent active
- `jobStatus = 'agent_completed' | 'postprocess_pending'` with `jobType = 'coding_task'` — agent complete, push active
- `jobStatus = 'agent_completed'` with `jobType = 'review'` — agent complete, review active
- `jobStatus = 'completed'` — all complete
- `sessionStatus = 'failed' | 'stopped'` — find last active phase, mark failed, rest pending
- `jobStatus = 'waiting_human'` — agent phase shows 'Waiting for input' (amber)

**Consumed by Plan 12:** The `SessionProgressBar` (Plan 12) derives its phase label from this pipeline model. The active phase's `label` is used directly. This avoids Plan 12 needing its own `PHASE_CONFIG`.

### Step 3: Timeline Component

**Create `components/sessions/execution-timeline.tsx`**

Props: `{ phases: PhaseInfo[] }`

- Flex layout, circles connected by horizontal lines
- Uses lucide icons (CheckIcon, XIcon) + existing Spinner
- Tailwind transitions (duration-500) for smooth state changes
- **Phase duration tooltips: Deferred to v2.** No per-phase timestamp data exists in the current schema. The tooltip for v1 shows only the phase label and status (e.g., 'Agent — Running'). Per-phase timing requires storing `StepMetrics` from `createStepTimer()` in a client-accessible location, which is a separate effort.

**Responsive collapse detail:** On `< 640px`, render: `<span className='text-xs text-muted-foreground'>Phase {currentIndex + 1}/{totalPhases}: {currentLabel}</span>`. No icons, no connector lines. Just a text indicator.

### Step 4: Integration

In session detail page:
```tsx
<div className="flex flex-col gap-2 border-b px-1 pb-3">
  {/* existing header */}
  {phases.length > 0 && <ExecutionTimeline phases={phases} />}
</div>
```

## File Summary

| Action | File |
|--------|------|
| Create | `lib/sessions/pipeline-phases.ts` |
| Create | `components/sessions/execution-timeline.tsx` |
| Modify | `app/api/interactive-sessions/[sessionId]/route.ts` |
| Modify | `lib/jobs/actions.ts` |
| Modify | `app/(dashboard)/sessions/[sessionId]/page.tsx` |

## Edge Cases

- **No job yet**: Only "Provision" phase shown as active
- **Failed mid-pipeline**: Last active phase shows red X, subsequent stay pending
- **Multiple runs**: Timeline shows latest job state. Resets on new prompt dispatch.
- **Snapshotting**: All phases completed + subtle "Saving..." indicator
