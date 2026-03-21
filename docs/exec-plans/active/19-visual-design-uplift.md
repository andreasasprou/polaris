---
title: Visual Design Uplift
status: planned
created: 2026-03-20
owner: andreas
related_prs: []
domains: [ui, design-system]
---

# 19 — Visual Design Uplift

## Problem Statement

Current UI looks "default shadcn" — uniform text sizing, achromatic status badges, sparse empty states, minimal liveness animations. Needs stronger visual hierarchy, chromatic status colors, purposeful motion, and polished empty states.

## Implementation

### Phase 1: Design Tokens & Typography

**Modify `app/globals.css`**

**Status color tokens** (OKLch, light mode):
```css
--status-active:  oklch(0.55 0.2 230);   /* vivid blue */
--status-success: oklch(0.55 0.2 145);   /* vivid green */
--status-warning: oklch(0.65 0.2 75);    /* vivid amber */
--status-error:   oklch(0.55 0.22 27);   /* vivid red */
--status-info:    oklch(0.55 0.15 260);  /* indigo */
--status-idle:    oklch(0.6 0.0 0);      /* neutral grey */
```

**Dark mode values:**
```css
.dark {
  --status-active:  oklch(0.72 0.16 230);
  --status-success: oklch(0.72 0.14 145);
  --status-warning: oklch(0.78 0.16 75);
  --status-error:   oklch(0.70 0.19 22);
  --status-info:    oklch(0.72 0.12 260);
  --status-idle:    oklch(0.6 0.0 0);
}
```

**Tailwind registration:** Add to the `@theme inline` block in globals.css: `--color-status-active: var(--status-active);` (and same for all 6 tokens). Without this, `bg-status-active/10` syntax won't work.

**`--accent` change risk:** Changing `--accent` globally affects every shadcn component using `bg-accent`. **Safer approach:** Do NOT change `--accent`. Instead, introduce a new `--brand` token with the blue tint (`oklch(0.97 0.01 250)`) and use it explicitly where personality is needed (e.g., active session indicators, primary action buttons). This avoids cascading regressions.

**Typography scale**:
- `.text-page-title`: `text-2xl font-semibold tracking-tight`
- `.text-section-title`: `text-lg font-semibold tracking-tight`
- `.text-caption`: `text-xs text-muted-foreground`
- `.text-timestamp`: `text-[11px] tabular-nums text-muted-foreground/60`
- `.text-label`: `text-xs font-medium uppercase tracking-wider text-muted-foreground`
- `.text-code`: `font-mono text-[13px] rounded-[3px] bg-muted/60 px-1.5 py-0.5`

### Phase 2: Animation Utilities

**Animation scope (v1):** Ship only `breathing-glow` and `attention-pulse` keyframes. Defer `border-pulse`, `success-flash`, and `shimmer-border` to v2. Two animations with clear use cases > four animations that may go unused.

**Add to `globals.css`**:

- `@keyframes breathing-glow` — subtle box-shadow pulse (2.5s ease-in-out)
- `@keyframes attention-pulse` — amber variant for pending HITL (2s)

Utility classes: `animate-breathing-glow`, `animate-attention-pulse`

All respect `@media (prefers-reduced-motion: reduce)`.

CSS custom properties (`--glow-color`, `--pulse-color`) allow re-theming per context.

### Phase 3: Status Badge Overhaul

**Modify `components/status-badge.tsx`**

Replace achromatic badge variants with chromatic status config:
- `active`/`running`: `bg-status-active/10 text-status-active border-status-active/20`
- `completed`/`succeeded`: `bg-status-success/10 text-status-success`
- `creating`/`snapshotting`: `border-status-active/30 text-status-active animate-pulse-bright`
- `failed`: destructive (already red)

**Status badge structure:** Keep the shadcn `<Badge>` component. Apply chromatic classes via `cn(badgeVariants({ variant }), statusConfig[status].className)`. The live dot is a child `<span>` element: `<span className='size-1.5 rounded-full bg-current animate-pulse' />` rendered conditionally for `isLive` statuses (active, running, creating).

### Phase 4: Empty States

**Enhance `components/ui/empty.tsx`**:
- Add `illustration` variant to EmptyMedia (size-16 container, gradient bg, size-7 icon)
- Add `EmptyActions` sub-component

**Update pages**:
- Sessions: proper Empty with MessageSquareIcon illustration + "Start your first session" CTA
- Runs: Empty with PlayIcon + "Runs are created by automations" guidance
- Dashboard: Empty with "Welcome to Polaris" + create automation CTA

### Phase 5: Typography Application

**Phase 5 specificity:** Provide a checklist of exact changes per file:
- `automations/page.tsx` line 23: `text-2xl font-medium` -> `text-page-title`
- `sessions/page.tsx` line 44: same
- `runs/page.tsx` line 83: same
- `dashboard/page.tsx` line 92: same
- `runs/[runId]/page.tsx` MetadataCard label: `text-xs font-medium text-muted-foreground` -> `text-label`
- All timestamp cells in tables: wrap in `<span className='text-timestamp'>`

### Phase 6: Liveness Animations

- **Chat input**: `animate-breathing-glow` when agent is working
- **Permission/Question requests**: `animate-attention-pulse` when pending
- **Tool call status icons**: Use `--status-*` colors instead of ad-hoc classes

### Phase 7: Loading States

Replace bare "Loading..." text with consistent pattern:
```tsx
<div className="flex flex-col items-center gap-3 py-16">
  <Spinner className="text-muted-foreground" />
  <p className="text-caption">Loading...</p>
</div>
```

Apply to: sessions page, runs page, run detail, session detail.

## Files Modified

| File | Changes |
|------|---------|
| `app/globals.css` | Status tokens, typography scale, animation keyframes |
| `components/status-badge.tsx` | Chromatic status colors, live dot |
| `components/ui/empty.tsx` | Illustration variant, EmptyActions |
| `components/sessions/chat-input.tsx` | Breathing glow on active |
| `components/sessions/permission-request.tsx` | Attention pulse |
| `components/sessions/question-request.tsx` | Attention pulse |
| `components/sessions/session-status.tsx` | Success flash |
| `components/sessions/tool-call-item.tsx` | Status token colors |
| `app/(dashboard)/sessions/page.tsx` | Typography, empty state, loading |
| `app/(dashboard)/runs/page.tsx` | Typography, empty state, loading |
| `app/(dashboard)/runs/[runId]/page.tsx` | Typography, labels, loading |
| `app/(dashboard)/dashboard/page.tsx` | Typography, empty state |
| `app/(dashboard)/automations/page.tsx` | Typography |

## Scope Limits (Intentional)

- No SVG illustrations — lucide icons in gradient containers
- No framer-motion — pure CSS animations
- No sidebar changes — content area only
- No changes to base shadcn components (Button, Card, Input)
