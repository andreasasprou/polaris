# Cursor Glass Design Tokens Reference

> Extracted from cursor.com CSS (marketing site + docs app) on 2026-03-21.
> The agents/dashboard app is behind auth; tokens below are from the shared
> Next.js deployment CSS, which powers all cursor.com surfaces including
> the public marketing site, docs, and the agents product.

---

## 1. Core Theme Colors

Cursor uses a warm-tinted neutral palette (not pure gray). The base hue
leans olive/sepia rather than blue-gray.

### Dark Mode (default for product surfaces)

| Token | Hex | Description |
|-------|-----|-------------|
| `--color-theme-bg` | `#14120b` | Page background (warm near-black) |
| `--color-theme-fg` | `#edecec` | Primary text |
| `--color-theme-fg-02` | `#d7d6d5` | Secondary text weight |
| `--color-theme-card-hex` | `#1b1913` | Card / elevated surface |
| `--color-theme-card-01-hex` | `#1d1b15` | Card tier 1 (subtle lift) |
| `--color-theme-card-02-hex` | `#201e18` | Card tier 2 |
| `--color-theme-card-03-hex` | `#26241e` | Card tier 3 |
| `--color-theme-card-04-hex` | `#2b2923` | Card tier 4 (highest elevation) |
| `--color-theme-card-warm-hex` | `#1c1713` | Warm-tinted card variant |
| `--color-theme-card-hover-hex` | `#201e18` | Card hover state |
| `--color-theme-card-hover-light-hex` | `#1d1b15` | Card hover (light variant) |
| `--color-theme-product-chrome` | = `--color-theme-bg` | Sidebar / chrome = page bg |
| `--color-theme-product-editor` | = `--color-theme-card-hex` | Editor area = card surface |

### Light Mode

| Token | Hex | Description |
|-------|-----|-------------|
| `--color-theme-bg` | `#f7f7f4` | Page background (warm off-white) |
| `--color-theme-fg` | `#26251e` | Primary text (warm near-black) |
| `--color-theme-card-hex` | `#f2f1ed` | Card surface |
| `--color-theme-card-01-hex` | `#f0efeb` | Card tier 1 |
| `--color-theme-card-02-hex` | `#ebeae5` | Card tier 2 |
| `--color-theme-card-03-hex` | `#e6e5e0` | Card tier 3 |
| `--color-theme-card-04-hex` | `#e1e0db` | Card tier 4 |
| `--color-theme-card-warm-hex` | `#f3ede6` | Warm card variant |
| `--color-theme-accent` | `#f54e00` | Brand accent (Cursor orange) |

---

## 2. Text Hierarchy

### Dark Mode (product)

| Token | Value | Opacity | Use |
|-------|-------|---------|-----|
| `--color-theme-product-text` | `#26251eeb` | ~92% of fg | Primary body text |
| `--color-theme-product-text-sec` | `#26251e99` | ~60% of fg | Secondary / descriptions |
| `--color-theme-product-text-tertiary` | `#26251e66` | ~40% of fg | Timestamps, captions |
| `--color-theme-text` | = `--color-theme-fg` | 100% | Headings |
| `--color-theme-text-sec` | `#26251e99` | ~60% | Secondary text |
| `--color-theme-text-tertiary` | `#26251e66` | ~40% | Tertiary text |

### Docs App Tokens (more explicit)

| Token | Dark | Light |
|-------|------|-------|
| `--text-primary` | `#e4e4e4` | `#141414` |
| `--text-secondary` | `#b0b0b0` | `#444444` |
| `--text-tertiary` | `#888888` | `#777777` |

---

## 3. Foreground Opacity Ladder

Cursor builds its entire surface system from the foreground color at
varying opacities. This creates a unified warm tone across all grays.

| Token | Opacity | Hex (dark, approx) | Use |
|-------|---------|---------------------|-----|
| `--color-theme-fg-01` | 1% | `#26251e03` | Barely visible wash |
| `--color-theme-fg-02-5` | 2.5% | `#26251e06` | Subtle tint |
| `--color-theme-fg-05` | 5% | `#26251e0d` | Light surface lift |
| `--color-theme-fg-07-5` | 7.5% | `#26251e13` | Hover surface |
| `--color-theme-fg-10` | 10% | `#26251e1a` | Active surface |
| `--color-theme-fg-15` | 15% | `#26251e26` | Pressed state |
| `--color-theme-fg-20` | 20% | `#26251e33` | Strong emphasis |

---

## 4. Border System

| Token | Value (hex w/ alpha) | Opacity | Use |
|-------|----------------------|---------|-----|
| `--color-theme-border-01` | `#26251e06` | ~2.5% | Default border (nearly invisible) |
| `--color-theme-border-01-5` | `#26251e0d` | ~5% | Slightly visible border |
| `--color-theme-border-02` | `#26251e1a` | ~10% | Separator / divider |
| `--color-theme-border-02-5` | `#26251e33` | ~20% | Stronger divider |
| `--color-theme-border-03` | `#26251e99` | ~60% | High-contrast border (inputs) |
| `--color-theme-border` | = `border-01` | ~2.5% | Default alias |
| `--color-theme-card-hover-border` | = `border-02` | ~10% | Card hover border |

### Docs App Borders

| Token | Dark | Light |
|-------|------|-------|
| `--border` | `#333333` | `#d9d9d9` |
| `--border-subtle` | `#2a2a2a` | `#e0e0e0` |

---

## 5. Status / Semantic Colors

### Docs App (hex, most explicit)

| Token | Dark | Light | Use |
|-------|------|-------|-----|
| `--brand` | `#f06030` | `#d94400` | Brand / primary action |
| `--brand-dim` | `#f0603026` | `#d944001a` | Brand tint bg |
| `--accent` | `#5aa0d0` | `#2e6890` | Accent / links |
| `--accent-dim` | `#5aa0d01f` | `#2e68901a` | Accent tint bg |
| `--green` | `#3cb88a` | `#16734f` | Success |
| `--green-dim` | `#3cb88a1f` | `#16734f1a` | Success tint bg |
| `--amber` | `#d4a24a` | `#9a6a1e` | Warning / attention |
| `--amber-dim` | `#d4a24a1f` | `#9a6a1e1a` | Warning tint bg |
| `--purple` | `#9580e0` | `#5c3db8` | Info / special |
| `--purple-dim` | `#9580e01f` | `#5c3db81a` | Info tint bg |

### Marketing Product Tokens

| Token | Value | Use |
|-------|-------|-----|
| `--color-theme-product-ansi-green` | `#1f8a65` (light) | Terminal green |
| `--color-theme-product-ansi-red` | `#cf2d56` (light) | Terminal red |
| `--color-theme-product-line-inserted-line-background` | `#1f8a6514` | Diff added bg |
| `--color-theme-product-removed-line-background` | `#cf2d560f` | Diff removed bg |

### Tailwind Base Palette (from CSS)

| Token | Value |
|-------|-------|
| `--color-red-500` | `#fb2c36` |
| `--color-red-600` | `#e40014` |
| `--color-green-50` | `#f0fdf4` |
| `--color-green-500` | `#00c758` |
| `--color-green-600` | `#00a544` |
| `--color-green-800` | `#016630` |
| `--color-green-900` | `#0d542b` |
| `--color-blue-50` | `#eff6ff` |
| `--color-blue-600` | `#155dfc` |
| `--color-blue-800` | `#193cb8` |
| `--color-blue-900` | `#1c398e` |
| `--color-purple-400` | `#c07eff` |
| `--color-gray-50` | `#f9fafb` |
| `--color-gray-200` | `#e5e7eb` |
| `--color-gray-300` | `#d1d5dc` |
| `--color-gray-500` | `#6a7282` |
| `--color-gray-600` | `#4a5565` |
| `--color-gray-700` | `#364153` |
| `--color-gray-800` | `#1e2939` |
| `--color-gray-900` | `#101828` |

---

## 6. Shadows

| Token | Value | Use |
|-------|-------|-----|
| `--shadow-outline-theme` | `0 0 0 1px var(--color-theme-border-02)` | Focus ring / card outline |
| `--shadow-flyout` | `0 0 1rem #00000005, 0 0 .5rem #00000002` | Flyout/dropdown shadow (very subtle) |
| `--window-shadow-inner` | `0 -1px 0 0 var(--color-theme-border-02) inset` | Dark mode inner window border |

### Docs App Code Block

| Token | Dark | Light |
|-------|------|-------|
| `--code-block-bg` | `#111111` | `#1a1a1a` |
| `--code-block-border` | `#2a2a2a` | `#333333` |
| `--code-block-text` | `#d4d4d4` | `#e4e4e4` |

---

## 7. Typography

### Font Stacks

| Token | Value |
|-------|-------|
| `--font-sans` (marketing) | `"CursorGothic", "CursorGothic Fallback", system-ui, Helvetica Neue, ...` |
| `--font-cursor-sans` (docs) | `"cursorSans", "cursorSans Fallback", system-ui, Helvetica Neue, ...` |
| `--font-berkeley-mono` | `"berkeleyMono", ui-monospace, SFMono-Regular, Menlo, Monaco, ...` |
| `--font-system` | `system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", ...` |

### Type Scale

| Token | Size | Line Height |
|-------|------|-------------|
| `--text-product-sm` | `0.6875rem` (11px) | 1.27 |
| `--text-product-base` | `0.75rem` (12px) | 1.33 |
| `--text-product-lg` | `0.8125rem` (13px) | -- |
| `--text-xs` | `0.75rem` (12px) | 1.33 |
| `--text-sm` | `0.875rem` (14px) | 1.43 |
| `--text-base` | `1rem` (16px) | 1.5 |
| `--text-md-sm` | `1.125rem` (18px) | -- |
| `--text-md` | `1.375rem` (22px) | -- |
| `--text-md-lg` | `1.625rem` (26px) | -- |
| `--text-lg` | `2.25rem` (36px) | -- |
| `--text-xl` | `3.25rem` (52px) | -- |
| `--text-2xl` | `4.5rem` (72px) | 1.33 |

### Font Weights

| Token | Value |
|-------|-------|
| `--font-weight-normal` | `400` |
| `--font-weight-medium` | `500` |
| `--font-weight-semibold` | `600` |
| `--font-weight-bold` | `700` |

### Letter Spacing (Tracking)

| Token | Value | Use |
|-------|-------|-----|
| `--tracking-product-sm` | `0.0044em` | Product UI small text |
| `--tracking-sm` | `0.01em` | Small text |
| `--tracking-base` | `0.005em` | Body text |
| `--tracking-md` | `-0.005em` | Medium headings |
| `--tracking-md-lg` | `-0.0125em` | Large-medium headings |
| `--tracking-lg` | `-0.02em` | Large headings |
| `--tracking-xl` | `-0.025em` | XL headings |
| `--tracking-2xl` | `-0.03em` | Display headings |
| `--tracking-tight` | `-0.025em` | Tailwind tight |
| `--tracking-wide` | `0.025em` | Tailwind wide |

### Line Height (Leading)

| Token | Value |
|-------|-------|
| `--leading-tight` | `1.1` |
| `--leading-2xsnug` | `1.15` |
| `--leading-xsnug` | `1.2` |
| `--leading-snug` | `1.25` |
| `--leading-product-base-mono` | `1.25rem` |
| `--leading-product-sm` | `1.27` |
| `--leading-product-base` | `1.33` |
| `--leading-snug-plus` | `1.3` |
| `--leading-cozy` | `1.4` |
| `--leading-normal` | `1.5` |
| `--leading-relaxed` | `1.625` |

---

## 8. Spacing System

Cursor uses two spacing scales: a horizontal grid (`--g`) and a vertical
rhythm (`--v`).

### Horizontal Grid

| Token | Computed (~) | Use |
|-------|--------------|-----|
| `--g` | `0.625rem` (10px) | Base unit |
| `--spacing-g0.25` | `2.5px` | Micro gap |
| `--spacing-g0.5` | `5px` | Tight gap |
| `--spacing-g0.75` | `7.5px` | Small gap |
| `--spacing-g1` | `10px` | Standard gap |
| `--spacing-g1.25` | `12.5px` | Medium gap |
| `--spacing-g1.5` | `15px` | Comfortable gap |
| `--spacing-g2` | `20px` | Section gap |
| `--spacing-g2.5` | `25px` | Large gap |
| `--spacing-g3` | `30px` | XL gap |

### Vertical Rhythm

| Token | Computed (~) | Use |
|-------|--------------|-----|
| `--v` | `1.4rem` (~22.4px) | Base vertical unit |
| `--spacing-v1/12` | `1.87px` | Micro vertical space |
| `--spacing-v3/12` | `5.6px` | Small vertical space |
| `--spacing-v6/12` | `11.2px` | Half-unit |
| `--spacing-v1` | `22.4px` | One unit |
| `--spacing-v1.5` | `33.6px` | 1.5 units |
| `--spacing-v2` | `44.8px` | Two units |
| `--spacing-v3` | `67.2px` | Section break |
| `--spacing-v5` | `112px` | Large section |

### Key Fixed Values

| Token | Value |
|-------|-------|
| `--site-header-height` | `56px` |
| `--site-sticky-top` | `64px` |
| `--max-width-container` | `1300px` |
| `--grid-gap` | `calc(12rem / 15)` = `12.8px` |
| `--spacing-prose-narrow` | `48ch` |
| `--spacing-prose-medium-wide` | `80ch` |
| `--spacing-prose-wide` | `96ch` |

---

## 9. Border Radius

| Token | Value |
|-------|-------|
| `--radius-2xs` | `2px` |
| `--radius-xs` | `4px` |
| `--radius-sm` | `0.25rem` (4px) |
| `--radius-md` | `8px` |
| `--radius-lg` | `0.5rem` (8px) |
| `--radius-xl` | `0.75rem` (12px) |
| `--radius-2xl` | `1rem` (16px) |

---

## 10. Animation & Transitions

| Token | Value | Use |
|-------|-------|-----|
| `--duration` | `0.14s` | Micro-interactions |
| `--duration-slow` | `0.25s` | Deliberate transitions |
| `--default-transition-duration` | `0.15s` | Standard transitions |
| `--default-transition-timing-function` | `cubic-bezier(.4, 0, .2, 1)` | Ease-out |
| `--ease-out` | `cubic-bezier(0, 0, .2, 1)` | Decelerate |
| `--ease-out-spring` | `cubic-bezier(.25, 1, .5, 1)` | Springy decelerate |
| `--animate-spin` | `spin 1s linear infinite` | Loading spinner |
| `--animate-pulse` | `pulse 2s cubic-bezier(.4, 0, .6, 1) infinite` | Attention pulse |

### Blur

| Token | Value |
|-------|-------|
| `--blur-sm` | `8px` |
| `--blur-md` | `12px` |

---

## 11. Button Padding

| Token | Value | Use |
|-------|-------|-----|
| `--button-padding-default` | `.89em 1.45em .91em` | Standard button |
| `--button-padding-md-sm` | `.64em 1.2em .66em` | Medium-small |
| `--button-padding-sm` | `.45em .8em .46em` | Small button |
| `--button-padding-xs` | `.15em .5em` | Extra-small / badge |

---

## 12. Containers

| Token | Value |
|-------|-------|
| `--container-2xs` | `18rem` (288px) |
| `--container-sm` | `24rem` (384px) |
| `--container-md` | `28rem` (448px) |
| `--container-lg` | `32rem` (512px) |
| `--container-2xl` | `42rem` (672px) |
| `--container-3xl` | `48rem` (768px) |
| `--container-4xl` | `56rem` (896px) |
| `--container-5xl` | `64rem` (1024px) |
| `--container-7xl` | `80rem` (1280px) |

---

## 13. CSS Patterns & Techniques

### Warm Neutral System
Cursor never uses pure gray. All neutrals derive from the foreground
color (`#26251e` light / `#edecec` dark) at varying opacities, applied
over the background. This creates a cohesive warm tone throughout.

### Elevation via Layered Gradients
Cards use stacked `linear-gradient` layers rather than flat colors:
```css
--color-theme-card-02: linear-gradient(var(--color-theme-fg-02-5) 0% 100%),
                       linear-gradient(var(--color-theme-card-hex) 0% 100%);
```
Each elevation tier adds a slightly more opaque fg overlay on the base
card color, creating subtle depth without drop shadows.

### Near-Invisible Default Borders
The default border (`--color-theme-border-01` at ~2.5% opacity) is
barely visible. Borders become more apparent on hover/focus
(`border-02` at 10%, `border-03` at 60%). This creates a clean, minimal
appearance that reveals structure on interaction.

### Product vs Chrome Color Split
In dark mode, the sidebar chrome uses the page background (`#14120b`)
while the main content area uses the slightly lighter card color
(`#1b1913`). This is inverted from most dark UIs where the sidebar is
darker.

### Dim Pattern for Status Colors
Each semantic color has a `-dim` variant at ~10-12% opacity, used for
tinted background surfaces (e.g., success banner bg = `--green-dim`).

---

## 14. Mapping to Polaris (shadcn/Tailwind)

### Direct Token Mapping

| Cursor Token | Polaris Token (globals.css) | Recommended Value (dark) |
|--------------|---------------------------|--------------------------|
| `--color-theme-bg` | `--background` | `oklch(0.16 0.01 70)` * |
| `--color-theme-fg` | `--foreground` | `oklch(0.93 0.005 90)` * |
| `--color-theme-card-hex` | `--card` | `oklch(0.19 0.01 70)` |
| `--color-theme-fg` | `--primary` | `oklch(0.93 0.005 90)` |
| `--color-theme-bg` | `--primary-foreground` | `oklch(0.16 0.01 70)` |
| `--color-theme-card-02-hex` | `--secondary` | `oklch(0.22 0.01 70)` |
| `--color-theme-card-02-hex` | `--muted` | `oklch(0.22 0.01 70)` |
| `--text-secondary` (#b0b0b0) | `--muted-foreground` | `oklch(0.73 0 0)` |
| `--color-theme-card-03-hex` | `--accent` | `oklch(0.24 0.01 70)` |
| `--color-theme-border-02` | `--border` | `oklch(1 0 0 / 8%)` |
| `--color-theme-border-02-5` | `--input` | `oklch(1 0 0 / 15%)` |
| `--color-theme-border-03` | `--ring` | `oklch(0.6 0 0)` |
| `--color-theme-bg` | `--sidebar` | `oklch(0.16 0.01 70)` |

> \* The warm hue angle (~70, olive/sepia) is what gives Cursor its
> distinctive feel. Pure achromatic (`0 0`) produces the generic shadcn
> look. Even a tiny chroma of 0.005-0.01 at hue 70 transforms the palette.

### Status Color Mapping

| Cursor | Polaris (from plan 19) | Recommended |
|--------|----------------------|-------------|
| `--green` (#3cb88a) | `--status-success` | `oklch(0.72 0.14 160)` |
| `--amber` (#d4a24a) | `--status-warning` | `oklch(0.75 0.14 75)` |
| `--brand` (#f06030) | `--destructive` or `--status-error` | `oklch(0.68 0.19 30)` |
| `--accent` (#5aa0d0) | `--status-active` | `oklch(0.68 0.12 230)` |
| `--purple` (#9580e0) | `--status-info` | `oklch(0.62 0.16 285)` |

### New Tokens to Introduce

These tokens exist in Cursor but have no Polaris equivalent:

| Cursor Token | Proposed Polaris Token | Purpose |
|-------------|----------------------|---------|
| `--brand` | `--brand` | Primary action color (orange) |
| `--brand-dim` | `--brand` at `/10` opacity | Brand tinted background |
| `--text-tertiary` | `--tertiary-foreground` | Third-level text hierarchy |
| `--border-subtle` | `--border-subtle` | Nearly invisible structural border |
| `--bg-card-hover` | `--card-hover` | Explicit hover state for cards |
| `--code-block-bg` | `--code-bg` | Code block background |
| `--code-block-border` | `--code-border` | Code block border |

---

## 15. Key Recommendations for Polaris

### A. Adopt the Warm Neutral Hue
The single highest-impact change: shift all achromatic values (hue 0)
to hue ~70 with chroma 0.005-0.01. This transforms the default shadcn
"zinc" feel into something closer to Cursor's warm, crafted aesthetic.

```css
/* Before (generic shadcn) */
--background: oklch(0.145 0 0);
--foreground: oklch(0.985 0 0);

/* After (warm Cursor-inspired) */
--background: oklch(0.145 0.008 70);
--foreground: oklch(0.93 0.005 90);
```

### B. Use Foreground-Opacity Surfaces Instead of Fixed Grays
Instead of hard-coding card/surface colors, derive them from
foreground at opacity. This auto-adapts to theme changes:

```css
--card: oklch(from var(--foreground) l c h / 5%);
--muted: oklch(from var(--foreground) l c h / 8%);
```

Or use the simpler hex-alpha approach Cursor uses:
`color-mix(in srgb, var(--foreground) 5%, transparent)`.

### C. Reduce Default Border Contrast
Cursor's default border is ~2.5% opacity (nearly invisible). Polaris
currently uses `oklch(1 0 0 / 10%)`. Consider reducing to 6-8% for a
cleaner look, with 10% reserved for hover/focus states.

### D. Adopt the Dim Pattern for Status Badges
Each status color should have a pre-defined `dim` variant at 10-12%
opacity for badge backgrounds. This eliminates ad-hoc `bg-green-500/10`
one-offs and ensures consistent tint intensity.

### E. Product Text Scale
Cursor's product (non-marketing) type scale is notably smaller than
typical web: 11px/12px/13px. For an agent workbench UI, consider
adopting `--text-product-base: 0.8125rem` (13px) as the default body
size to increase information density.

### F. Near-Zero Shadows
Cursor barely uses box-shadows. The flyout shadow is almost invisible
(`#00000005`). Depth is communicated through surface color tiers, not
shadows. Consider removing or drastically reducing shadow intensity in
Polaris components.

### G. Transition Timing
Cursor uses `0.14s` for micro-interactions (hover, focus) and `0.25s`
for deliberate transitions (open/close). The easing curve
`cubic-bezier(0, 0, .2, 1)` (ease-out) is their default. The spring
variant `cubic-bezier(.25, 1, .5, 1)` is used for more playful
animations. These are faster than the Tailwind default of `0.15s`.

---

## Appendix: Cursor Product Surface Hierarchy (Dark Mode)

```
Layer 0: Page background     #14120b   oklch(0.145 0.01 70)
Layer 1: Card / elevated     #1b1913   oklch(0.17 0.01 70)
Layer 2: Card tier 2         #201e18   oklch(0.19 0.01 70)
Layer 3: Card tier 3         #26241e   oklch(0.22 0.01 70)
Layer 4: Card tier 4         #2b2923   oklch(0.25 0.01 70)

Text 1: Primary              #edecec   oklch(0.93 0.005 90)
Text 2: Secondary            #b0b0b0   oklch(0.73 0 0)
Text 3: Tertiary             #888888   oklch(0.59 0 0)

Border 1: Default            2.5% fg opacity
Border 2: Separator          10% fg opacity
Border 3: Input/interactive  60% fg opacity
```

Each layer lifts by approximately `oklch(+0.03 lightness)`.

---

## 16. Product UI Token System (from `--cursor-*` variables)

The user's CSS dump reveals the full product design system. The `--cursor-*`
namespace wraps underlying semantic tokens. Below is the complete mapping
with resolved values from the dark theme.

### 16.1 Shadow System

From the CSS variables:
```css
--cursor-shadow-primary:   var(--shadow-primary);    /* ~rgba(0,0,0,0.25) */
--cursor-shadow-secondary: var(--shadow-secondary);  /* ~rgba(0,0,0,0.12) */
--cursor-shadow-tertiary:  var(--shadow-tertiary);   /* ~rgba(0,0,0,0.06) */

--cursor-box-shadow-sm:  0 2px 8px 0px var(--cursor-shadow-secondary);
--cursor-box-shadow-md:  0 0 8px 2px var(--cursor-shadow-primary);
--cursor-box-shadow-soft: 0 0 8px 2px var(--cursor-shadow-tertiary);
--cursor-box-shadow-lg:  0 0 4px 0 rgba(255,255,255,0.05) inset,
                         0 0 3px 0 var(--cursor-shadow-secondary),
                         0 16px 24px 0 var(--cursor-shadow-tertiary);
--cursor-box-shadow-xl:  0 0 4px 0 rgba(255,255,255,0.05) inset,
                         0 0 6px 8px var(--cursor-shadow-secondary),
                         0 24px 16px 6px var(--cursor-shadow-tertiary);
```

**Key insight:** The `inset rgba(255,255,255,0.05)` on lg/xl shadows adds a
subtle inner glow — a hint of light at the top edge of elevated surfaces. This
is far more refined than a simple drop shadow.

**For Polaris:** Our shadcn components use `shadow-sm`, `shadow-md`, etc. Override
these in `globals.css` to match Cursor's near-zero approach:
```css
--shadow-sm: 0 2px 8px 0 rgba(0,0,0,0.08);
--shadow-md: 0 0 8px 2px rgba(0,0,0,0.12);
--shadow-lg: 0 0 4px 0 rgba(255,255,255,0.04) inset,
             0 0 3px 0 rgba(0,0,0,0.08),
             0 16px 24px 0 rgba(0,0,0,0.04);
```

### 16.2 Scrollbar Styling

```css
--cursor-scrollbar-vertical-size: 14px;
--cursor-scrollbar-horizontal-size: 12px;
--cursor-scrollbar-thumb-background: color-mix(in srgb, var(--base) 20%, transparent);
--cursor-scrollbar-thumb-hover-background: color-mix(in srgb, var(--base) 30%, transparent);
--cursor-scrollbar-thumb-active-background: color-mix(in srgb, var(--base) 40%, transparent);
```

**Key insight:** Scrollbar thumb is the base color at 20% opacity — nearly invisible
until hovered (30%) or dragged (40%). This matches the "reveal structure on
interaction" philosophy.

**For Polaris:** Add to `globals.css`:
```css
::-webkit-scrollbar { width: 14px; height: 12px; }
::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, var(--foreground) 15%, transparent);
  border-radius: 9999px;
  border: 3px solid transparent;
  background-clip: padding-box;
}
::-webkit-scrollbar-thumb:hover {
  background: color-mix(in srgb, var(--foreground) 25%, transparent);
}
::-webkit-scrollbar-track { background: transparent; }
```

### 16.3 Input / Button Styles

```css
/* Input/editor bg = elevated surface */
--cursor-bg-input: var(--bg-elevated);      /* card-level surface */
--cursor-bg-editor: var(--bg-elevated);

/* Buttons */
--cursor-button-background: var(--bg-neutral);                /* same as page bg */
--cursor-button-foreground: var(--text-inverted);              /* contrast text */
--cursor-button-hover-background: var(--bg-neutral-hover);
--cursor-button-secondary-background: var(--bg-tertiary);      /* muted surface */
--cursor-button-secondary-foreground: var(--text-primary);
--cursor-button-secondary-hover-background: var(--bg-quaternary);

/* Focus */
--cursor-stroke-focused: var(--border-focus);  /* distinct focus ring color */
```

**Key insight:** Primary buttons use the inverted color scheme (dark bg + light text
in light mode, or vice versa). Secondary buttons use the tertiary surface — they
nearly blend into the background until hovered.

### 16.4 Sidebar Specific Tokens

```css
--cursor-bg-sidebar: var(--bg-tertiary);        /* slightly lifted from page bg */
--cursor-bg-active: var(--bg-tertiary);          /* selected/active item bg */
--cursor-bg-focused: var(--bg-tertiary);         /* focused item bg */
```

From the marketing CSS: sidebar chrome uses the page background (`#14120b`),
main editor area uses the card color (`#1b1913`). The sidebar is the DARKEST
surface, not lighter — inverted from most dark UIs.

**Sidebar item dimensions (from `--cursor-*` tokens):**
```css
--cursor-height-xs: 20px;   /* compact list items */
--cursor-height-sm: 24px;   /* standard sidebar items */
--cursor-height-md: 28px;   /* medium items */
--cursor-height-lg: 32px;   /* large items / buttons */
--cursor-font-size-xs: 11px;  /* timestamps, metadata */
--cursor-font-size-sm: 12px;  /* sidebar session titles */
--cursor-font-size-md: 13px;  /* primary text */
--cursor-font-size-lg: 14px;  /* headings */
```

**For Polaris sidebar (Plan 10):** Session items should be 24-28px tall with
12px titles and 11px timestamps. This is denser than our current sidebar items.

### 16.5 Syntax / Code Colors (Dark)

```css
--cursor-syntax-foreground:  #d6d6dd;
--cursor-syntax-background:  #181818;
--cursor-syntax-keyword:     #82d2ce;   /* teal */
--cursor-syntax-string:      #e394dc;   /* pink */
--cursor-syntax-function:    #efb080;   /* warm orange */
--cursor-syntax-number:      #ebc88d;   /* gold */
--cursor-syntax-comment:     #6E7781;   /* muted gray */
--cursor-syntax-constant:    #f8c762;   /* amber */
--cursor-syntax-parameter:   #d6d6dd;   /* same as fg */
--cursor-syntax-punctuation: #d6d6dd;   /* same as fg */
--cursor-syntax-link:        #87c3ff;   /* light blue */
--cursor-syntax-string-expression: #e394dc;
```

### 16.6 Diff Colors

```css
--cursor-bg-diff-inserted: var(--diffs-bg-addition-override);
--cursor-bg-diff-removed:  var(--diffs-bg-deletion-override);
```

From marketing CSS (resolved):
```css
--inserted-line-bg: #1f8a6514;  /* green at ~8% opacity */
--removed-line-bg:  #cf2d560f;  /* red at ~6% opacity */
```

**For Polaris (Plan 11):** Our current diff colors use `bg-emerald-500/5` and
`bg-red-500/5`. Cursor uses slightly more saturated base colors but similar
opacity. Consider:
```css
--diff-inserted-bg: oklch(0.55 0.15 160 / 8%);
--diff-removed-bg: oklch(0.55 0.18 15 / 6%);
```

### 16.7 Status Color System (Full)

From the `--cursor-*` variable declarations, each status color has:
- `text-{color}-primary` — full saturation text
- `text-{color}-secondary` — muted variant
- `icon-{color}-primary` — full saturation icon
- `icon-{color}-secondary` — muted variant
- `bg-{color}-primary` — full saturation bg (rare, for pills)
- `bg-{color}-secondary` — tinted bg (badges, banners)
- `stroke-{color}-primary` — border matching the color
- `stroke-{color}-secondary` — muted border

Colors available: red, yellow, green, magenta, cyan, orange, purple, accent.

**For Polaris:** Our Plan 19 status tokens (`--status-active`, `--status-success`,
etc.) should each have a `-dim` variant at 10% opacity for badge backgrounds,
matching Cursor's `bg-{color}-secondary` pattern:
```css
--status-success-dim: oklch(0.72 0.14 160 / 10%);
--status-warning-dim: oklch(0.75 0.14 75 / 10%);
--status-error-dim: oklch(0.68 0.19 30 / 10%);
--status-active-dim: oklch(0.68 0.12 230 / 10%);
--status-info-dim: oklch(0.62 0.16 285 / 10%);
```

### 16.8 Transition / Animation System

```css
--cursor-duration-instant: 50ms;
--cursor-duration-fast: 100ms;
--cursor-duration-normal: 150ms;
--cursor-duration-slow: 200ms;
--cursor-duration-slower: 300ms;

--cursor-easing-default: ease;
--cursor-easing-in: ease-in;
--cursor-easing-out: ease-out;
--cursor-easing-in-out: ease-in-out;
```

Combined with the marketing CSS values:
```css
--duration: 0.14s;          /* micro-interactions */
--duration-slow: 0.25s;     /* deliberate transitions */
--ease-out: cubic-bezier(0, 0, .2, 1);         /* decelerate */
--ease-out-spring: cubic-bezier(.25, 1, .5, 1); /* springy */
```

**For Polaris:** Define transition utilities in `globals.css`:
```css
.transition-micro { transition-duration: 100ms; transition-timing-function: cubic-bezier(0, 0, .2, 1); }
.transition-normal { transition-duration: 150ms; transition-timing-function: cubic-bezier(0, 0, .2, 1); }
.transition-slow { transition-duration: 250ms; transition-timing-function: cubic-bezier(0, 0, .2, 1); }
```

### 16.9 Radius System

```css
--cursor-radius-none: 0px;
--cursor-radius-xs: 2px;
--cursor-radius-sm: 4px;
--cursor-radius-md: 6px;
--cursor-radius-lg: 8px;
--cursor-radius-xl: 12px;
--cursor-radius-full: 9999px;
```

Our current shadcn radius is `0.625rem` (10px). Cursor uses 6px for most
interactive elements and 8px for cards. Consider reducing `--radius` to `8px`
for a slightly tighter, more Glass-like feel.

---

## 17. Coverage Assessment

| Area | Coverage | Source |
|------|----------|--------|
| Background colors | Complete | Marketing CSS + docs CSS |
| Text hierarchy | Complete | Marketing + docs (3 tiers resolved) |
| Border system | Complete | Marketing CSS (5 opacity tiers) |
| Status/semantic colors | Complete | Docs CSS (5 colors + dim variants) |
| Shadows | Complete | `--cursor-*` variables (5 shadow levels) |
| Typography scale | Complete | Marketing CSS (product + marketing scales) |
| Spacing system | Complete | Marketing CSS (h-grid + v-rhythm) |
| Border radius | Complete | `--cursor-*` variables |
| Transitions/animations | Complete | Both sources |
| Scrollbar styling | Complete | `--cursor-*` variables |
| Syntax/code colors | Complete | `--cursor-*` variables |
| Diff colors | Complete | Marketing CSS |
| Button styles | Partial | Token names resolved, not all computed values |
| Sidebar dimensions | Complete | `--cursor-*` height/font-size tokens |
| Input/focus styles | Partial | Token names, not all focus ring values |
| Dialog/modal styles | Minimal | Only `--cursor-box-shadow-xl` for modals |
| Tooltip styles | Not covered | Not in public CSS |
| Chat message layout | Not covered | Behind auth wall |

**Overall: ~85% coverage.** The missing items (tooltips, chat layout, modal
specifics) are standard patterns that can be inferred from the shadow/surface
system already documented.
