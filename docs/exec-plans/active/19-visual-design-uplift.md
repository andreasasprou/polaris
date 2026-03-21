---
title: Visual Design Uplift
status: planned
created: 2026-03-20
owner: andreas
related_prs: []
domains: [ui, design-system]
references: [docs/references/cursor-glass-design-tokens.md]
---

# 19 — Visual Design Uplift

## Problem Statement

Current UI looks "default shadcn" — pure achromatic grays, uniform text sizing, weak borders, sparse empty states, minimal liveness animations. The goal is a **Cursor Glass-inspired** aesthetic: warm neutrals, near-invisible borders, surface-tier depth, and "color = signal only."

## Design Principles (from Cursor Glass)

1. **Warm neutrals, never pure gray** — All neutrals tinted at hue ~70 (olive/sepia) with chroma 0.005-0.01. This is the single biggest differentiator from stock shadcn.
2. **Color = signal only** — Chromatic color appears ONLY on status badges, progress indicators, and attention dots. Never on backgrounds, headers, or decorative elements.
3. **Near-invisible default borders** — 6-8% opacity (Cursor uses 2.5%, we go slightly stronger for readability). Structure reveals on hover/focus.
4. **Surface tiers for depth, not shadows** — Each elevation adds ~0.03 lightness. Shadows are near-zero.
5. **Dense but readable** — Product text at 12-13px. Hierarchy through weight and opacity, not size.
6. **Alive, not loud** — Subtle motion (breathing glow, attention pulse) signals activity without screaming.

> Reference: `docs/references/cursor-glass-design-tokens.md` for all resolved Cursor values.

## Implementation

### Phase 1: Warm Neutral Foundation

**Modify `app/globals.css`**

The highest-impact change: shift all achromatic values to warm hue ~70.

**Dark mode (`:root` stays for light, `.dark` is the product default):**

```css
/* ── Before (generic shadcn zinc) ── */
--background: oklch(0.145 0 0);
--foreground: oklch(0.985 0 0);
--card: oklch(0.205 0 0);
--muted: oklch(0.269 0 0);
--border: oklch(1 0 0 / 10%);

/* ── After (warm Cursor-inspired) ── */
--background: oklch(0.145 0.008 70);        /* #14120b warm near-black */
--foreground: oklch(0.93 0.005 90);         /* #edecec warm off-white */
--card: oklch(0.19 0.01 70);               /* #1b1913 elevated surface */
--card-foreground: oklch(0.93 0.005 90);
--popover: oklch(0.19 0.01 70);
--popover-foreground: oklch(0.93 0.005 90);
--primary: oklch(0.87 0.005 90);
--primary-foreground: oklch(0.17 0.01 70);
--secondary: oklch(0.22 0.01 70);          /* card tier 2 */
--secondary-foreground: oklch(0.93 0.005 90);
--muted: oklch(0.22 0.01 70);
--muted-foreground: oklch(0.73 0 0);       /* #b0b0b0 */
--accent: oklch(0.24 0.01 70);             /* card tier 3 */
--accent-foreground: oklch(0.93 0.005 90);
--destructive: oklch(0.68 0.19 30);        /* Cursor #f06030 brand/error */
--border: oklch(1 0 0 / 6%);              /* near-invisible (Cursor uses 2.5%, we use 6%) */
--input: oklch(1 0 0 / 12%);             /* slightly stronger for inputs */
--ring: oklch(0.6 0 0);
--sidebar: oklch(0.145 0.008 70);          /* sidebar = page bg (Cursor pattern) */
--sidebar-foreground: oklch(0.93 0.005 90);
--sidebar-primary: oklch(0.87 0.005 90);
--sidebar-primary-foreground: oklch(0.17 0.01 70);
--sidebar-accent: oklch(0.22 0.01 70);
--sidebar-accent-foreground: oklch(0.93 0.005 90);
--sidebar-border: oklch(1 0 0 / 6%);
--sidebar-ring: oklch(0.6 0 0);
```

**Light mode (`:root`):**
```css
--background: oklch(0.97 0.005 90);        /* #f7f7f4 warm off-white */
--foreground: oklch(0.17 0.01 70);         /* #26251e warm near-black */
--card: oklch(0.95 0.005 90);              /* #f2f1ed */
--muted: oklch(0.93 0.005 90);
--muted-foreground: oklch(0.45 0.005 70);
--border: oklch(0 0 0 / 8%);
--input: oklch(0 0 0 / 12%);
--sidebar: oklch(0.97 0.005 90);
```

**Key changes from current:**
- Every `0 0` (achromatic) → `0.005-0.01 70` (warm tint)
- `--border` from `10%` → `6%` opacity (cleaner, Cursor-like)
- `--sidebar` from `oklch(0.205)` → matches `--background` (sidebar = darkest surface, Cursor pattern)

### Phase 2: Status Color Tokens

**Status colors** — derived from Cursor's semantic palette:

```css
/* Light mode */
:root {
  --status-active:  oklch(0.55 0.12 230);    /* Cursor --accent #5aa0d0 → blue */
  --status-success: oklch(0.50 0.14 160);    /* Cursor --green #3cb88a → green */
  --status-warning: oklch(0.65 0.14 75);     /* Cursor --amber #d4a24a → amber */
  --status-error:   oklch(0.55 0.19 30);     /* Cursor --brand #f06030 → orange-red */
  --status-info:    oklch(0.50 0.16 285);    /* Cursor --purple #9580e0 → purple */
  --status-idle:    oklch(0.55 0 0);
}

/* Dark mode */
.dark {
  --status-active:  oklch(0.68 0.12 230);
  --status-success: oklch(0.68 0.14 160);
  --status-warning: oklch(0.75 0.14 75);
  --status-error:   oklch(0.68 0.19 30);
  --status-info:    oklch(0.62 0.16 285);
  --status-idle:    oklch(0.6 0 0);
}
```

**Dim variants** (for badge backgrounds, matching Cursor's `-dim` pattern at ~10% opacity):
```css
.dark {
  --status-active-dim:  oklch(0.68 0.12 230 / 10%);
  --status-success-dim: oklch(0.68 0.14 160 / 10%);
  --status-warning-dim: oklch(0.75 0.14 75 / 10%);
  --status-error-dim:   oklch(0.68 0.19 30 / 10%);
  --status-info-dim:    oklch(0.62 0.16 285 / 10%);
}
```

**Tailwind registration** — add to `@theme inline`:
```css
--color-status-active: var(--status-active);
--color-status-success: var(--status-success);
--color-status-warning: var(--status-warning);
--color-status-error: var(--status-error);
--color-status-info: var(--status-info);
--color-status-idle: var(--status-idle);
--color-status-active-dim: var(--status-active-dim);
--color-status-success-dim: var(--status-success-dim);
--color-status-warning-dim: var(--status-warning-dim);
--color-status-error-dim: var(--status-error-dim);
--color-status-info-dim: var(--status-info-dim);
```

**New `--brand` token** (Cursor's primary action orange, NOT replacing `--accent`):
```css
.dark {
  --brand: oklch(0.68 0.19 30);          /* Cursor #f06030 */
  --brand-dim: oklch(0.68 0.19 30 / 10%);
}
```

### Phase 3: Typography Scale

Cursor's product UI uses 11-13px text. Our typography classes:

```css
.text-page-title  { @apply text-xl font-semibold tracking-tight; }  /* 20px, not 24 — denser */
.text-section-title { @apply text-base font-semibold tracking-tight; } /* 16px, not 18 */
.text-body        { @apply text-[13px] leading-[1.33]; }             /* Cursor's --text-product-lg */
.text-caption     { @apply text-xs text-muted-foreground; }          /* 12px */
.text-timestamp   { @apply text-[11px] tabular-nums text-muted-foreground/50; } /* Cursor's --text-product-sm, 50% opacity */
.text-label       { @apply text-[11px] font-medium uppercase tracking-wider text-muted-foreground; }
.text-code        { @apply font-mono text-[13px] rounded-[3px] bg-muted/60 px-1.5 py-0.5; }
```

Note: Cursor uses `tracking: 0.0044em` for product small text — nearly zero. Our `tracking-tight` (-0.025em) is close enough.

### Phase 4: Shadows, Borders & Scrollbars

**Shadows** — Cursor uses near-zero shadows. Override shadcn defaults:

```css
/* Add as CSS custom properties */
--shadow-sm: 0 2px 8px 0 rgba(0,0,0,0.06);
--shadow-md: 0 0 8px 2px rgba(0,0,0,0.08);
--shadow-lg: 0 0 4px 0 rgba(255,255,255,0.04) inset,
             0 0 3px 0 rgba(0,0,0,0.06),
             0 16px 24px 0 rgba(0,0,0,0.03);
```

The `inset rgba(255,255,255,0.04)` is Cursor's subtle inner glow on elevated surfaces.

**Border radius** — Cursor uses 6px for most elements, 8px for cards:
```css
--radius: 0.5rem;  /* 8px, down from current 0.625rem (10px) */
```

**Scrollbar styling:**
```css
::-webkit-scrollbar { width: 14px; height: 12px; }
::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, var(--foreground) 12%, transparent);
  border-radius: 9999px;
  border: 3px solid transparent;
  background-clip: padding-box;
}
::-webkit-scrollbar-thumb:hover {
  background: color-mix(in srgb, var(--foreground) 20%, transparent);
}
::-webkit-scrollbar-track { background: transparent; }
```

**Transition defaults** — Cursor uses `0.14s ease-out` for micro-interactions:
```css
/* Add to @layer base */
* { transition-timing-function: cubic-bezier(0, 0, .2, 1); }
```

### Phase 5: Animation Utilities

**v1 scope:** Only `breathing-glow` and `attention-pulse`.

```css
@keyframes breathing-glow {
  0%, 100% { box-shadow: 0 0 0 0 var(--glow-color, oklch(0.68 0.12 230 / 0)); }
  50% { box-shadow: 0 0 12px 2px var(--glow-color, oklch(0.68 0.12 230 / 0.12)); }
}

@keyframes attention-pulse {
  0%, 100% { box-shadow: 0 0 0 0 var(--glow-color, oklch(0.75 0.14 75 / 0)); }
  50% { box-shadow: 0 0 10px 2px var(--glow-color, oklch(0.75 0.14 75 / 0.15)); }
}

.animate-breathing-glow {
  --glow-color: var(--status-active);
  animation: breathing-glow 2.5s ease-in-out infinite;
}

.animate-attention-pulse {
  --glow-color: var(--status-warning);
  animation: attention-pulse 1.8s ease-in-out infinite;
}

@media (prefers-reduced-motion: reduce) {
  .animate-breathing-glow,
  .animate-attention-pulse {
    animation: none;
  }
}
```

### Phase 6: Status Badge Overhaul

**Modify `components/status-badge.tsx`**

Keep shadcn `<Badge>`. Apply chromatic classes via `cn()`:

```typescript
const statusConfig: Record<string, { className: string; isLive?: boolean }> = {
  creating:     { className: "border-status-active/30 text-status-active bg-status-active-dim", isLive: true },
  active:       { className: "border-status-active/20 text-status-active bg-status-active-dim", isLive: true },
  running:      { className: "border-status-active/20 text-status-active bg-status-active-dim", isLive: true },
  idle:         { className: "border-border text-muted-foreground bg-transparent" },
  snapshotting: { className: "border-status-info/30 text-status-info bg-status-info-dim", isLive: true },
  hibernated:   { className: "border-border text-muted-foreground bg-muted/50" },
  completed:    { className: "border-status-success/20 text-status-success bg-status-success-dim" },
  succeeded:    { className: "border-status-success/20 text-status-success bg-status-success-dim" },
  failed:       { className: "border-status-error/20 text-status-error bg-status-error-dim" },
  stopped:      { className: "border-border text-muted-foreground bg-transparent" },
  cancelled:    { className: "border-border text-muted-foreground bg-muted/50" },
};
```

Live dot for active statuses:
```tsx
{config.isLive && (
  <span className="size-1.5 rounded-full bg-current animate-pulse" />
)}
```

### Phase 7: Empty States

**Enhance `components/ui/empty.tsx`:**
- Add `illustration` variant to EmptyMedia: `size-16 rounded-2xl bg-gradient-to-br from-muted to-muted/50` with `size-7` icon
- Add `EmptyActions` sub-component

**Update pages:**
- Sessions: `MessageSquareIcon` illustration + "Start your first session" CTA
- Runs: `PlayIcon` + "Runs are created when automations trigger" guidance
- Dashboard: "Welcome to Polaris" + create automation CTA

### Phase 8: Typography Application

Exact changes per file:
- `automations/page.tsx` line 23: `text-2xl font-medium` → `text-page-title`
- `sessions/page.tsx` line 44: same
- `runs/page.tsx` line 83: same
- `dashboard/page.tsx` line 92: same
- `runs/[runId]/page.tsx` MetadataCard label: `text-xs font-medium text-muted-foreground` → `text-label`
- All timestamp cells in tables: wrap in `<span className="text-timestamp">`

### Phase 9: Liveness Animations

- **Chat input**: `animate-breathing-glow` when agent is working (on container div, not the disabled input)
- **Permission/Question requests**: `animate-attention-pulse` when pending
- **Tool call status icons**: Use `--status-*` token colors instead of ad-hoc classes

### Phase 10: Loading States

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
| `app/globals.css` | Warm neutral foundation, status tokens, dim variants, brand token, typography scale, shadows, scrollbars, radius, transitions, animations |
| `components/status-badge.tsx` | Chromatic status colors with dim backgrounds, live dot |
| `components/ui/empty.tsx` | Illustration variant, EmptyActions |
| `components/sessions/chat-input.tsx` | Breathing glow on active |
| `components/sessions/permission-request.tsx` | Attention pulse |
| `components/sessions/question-request.tsx` | Attention pulse |
| `components/sessions/tool-call-item.tsx` | Status token colors |
| `app/(dashboard)/sessions/page.tsx` | Typography, empty state, loading |
| `app/(dashboard)/runs/page.tsx` | Typography, empty state, loading |
| `app/(dashboard)/runs/[runId]/page.tsx` | Typography, labels, loading |
| `app/(dashboard)/dashboard/page.tsx` | Typography, empty state |
| `app/(dashboard)/automations/page.tsx` | Typography |

## Scope Limits (Intentional)

- No SVG illustrations — lucide icons in gradient containers
- No framer-motion — pure CSS animations
- No sidebar structural changes — Plan 10 owns that
- `--accent` NOT changed — new `--brand` token instead
- Only 2 animations for v1 (breathing-glow, attention-pulse)
- No changes to base shadcn component structure (Button, Card, Input) — only token values

## Verification

1. `pnpm typecheck` — no type changes in this plan
2. Visual verification in browser at `http://localhost:3001`:
   - Dark mode: warm backgrounds, near-invisible borders, chromatic status badges
   - Light mode: warm off-whites, consistent tint
   - Check all pages: dashboard, sessions, runs, automations, session detail
   - Verify no regressions in shadcn components (dropdowns, dialogs, tooltips)
3. Ensure `prefers-reduced-motion` disables all animations
