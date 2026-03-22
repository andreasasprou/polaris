# Cursor Glass Product Colors (Authenticated App)

> Extracted from the live cursor.com/agents app on 2026-03-22 via authenticated session.
> These are the ACTUAL computed values from the product UI, not the marketing site.

## Light Mode (Default for Product)

### Core Surfaces

| Token | Value | Use |
|-------|-------|-----|
| `--chrome` | `#F7F7F7` | Page chrome / frame |
| `--sidebar` | `#F3F3F3` | Sidebar background |
| `--editor` | `#FCFCFC` | Editor / main content area |
| `--base` | `#141414` | Base foreground (text derives from this) |

### Text Hierarchy (color-mix from `--base`)

| Token | Formula | Effective Opacity | Use |
|-------|---------|-------------------|-----|
| `--text-primary` | `color-mix(in oklab, #141414 94%, transparent)` | 94% | Primary body text |
| `--text-secondary` | `color-mix(in oklab, #141414 70%, transparent)` | 70% | Descriptions, secondary |
| `--text-tertiary` | `color-mix(in oklab, #141414 48%, transparent)` | 48% | Timestamps, captions |
| `--text-quaternary` | `color-mix(in oklab, #141414 32%, transparent)` | 32% | Disabled, hints |
| `--text-inverted` | `#FCFCFC` | 100% | Text on dark backgrounds |

### Icon Hierarchy (color-mix from `--base` and `--chrome`)

| Token | Formula | Use |
|-------|---------|-----|
| `--icon-primary` | `color-mix(in oklab, #141414 86%, #F7F7F7)` | Primary icons |
| `--icon-secondary` | `color-mix(in oklab, #141414 62%, #F7F7F7)` | Secondary icons |
| `--icon-tertiary` | `color-mix(in oklab, #141414 40%, #F7F7F7)` | Tertiary icons |
| `--icon-quaternary` | `color-mix(in oklab, #141414 24%, #F7F7F7)` | Disabled icons |

### Background Surfaces (color-mix from `--base`)

| Token | Formula | Effective Opacity | Use |
|-------|---------|-------------------|-----|
| `--bg-primary` | `color-mix(in oklab, #141414 20%, transparent)` | 20% | Strongest bg tint |
| `--bg-secondary` | `color-mix(in oklab, #141414 14%, transparent)` | 14% | Medium bg tint |
| `--bg-tertiary` | `color-mix(in oklab, #141414 8%, transparent)` | 8% | Subtle bg tint (sidebar active, hover) |
| `--bg-quaternary` | `color-mix(in oklab, #141414 6%, transparent)` | 6% | Very subtle bg |
| `--bg-quinary` | `color-mix(in oklab, #141414 4%, transparent)` | 4% | Barely visible bg |
| `--bg-elevated` | `#FCFCFC` | Opaque | Cards, elevated surfaces |
| `--bg-neutral` | `#141414` | Opaque | Primary buttons (dark on light) |
| `--bg-scrim` | `rgba(0,0,0,0.4)` | 40% | Modal overlay |

### Border Hierarchy (color-mix from `--base`)

| Token | Formula | Effective Opacity | Use |
|-------|---------|-------------------|-----|
| `--border-primary` | `color-mix(in oklab, #141414 20%, transparent)` | 20% | Strongest border |
| `--border-secondary` | `color-mix(in oklab, #141414 12%, transparent)` | 12% | Medium border |
| `--border-tertiary` | `color-mix(in oklab, #141414 8%, transparent)` | 8% | Default/subtle border |
| `--border-quaternary` | `color-mix(in oklab, #141414 4%, transparent)` | 4% | Nearly invisible |
| `--border-neutral` | `color-mix(in oklab, #141414 80%, transparent)` | 80% | Strong border (inputs) |
| `--border-focus` | `#3C7CAB` | 100% | Focus ring color |

### Status / Semantic Colors

| Token | Hex | Use |
|-------|-----|-----|
| `--brand` | `#F54E00` | Brand orange (primary actions) |
| `--accent` | `#3C7CAB` | Blue accent (links, focus) |
| `--success` | `#1F8A65` | Success green |
| `--warn` | `#C08532` | Warning amber |
| `--danger` | `#CF2D56` | Error/danger red |
| `--red` | `#CF2D56` | Same as danger |
| `--orange` | `#DB704B` | Orange |
| `--yellow` | `#C08532` | Same as warn |
| `--green` | `#1F8A65` | Same as success |
| `--cyan` | `#4C7F8C` | Cyan / untracked |
| `--blue` | `#3C7CAB` | Same as accent |
| `--magenta` | `#B8448B` | Magenta |
| `--purple` | `#7754D9` | Purple / info |

### Status Color Tiers (bg variants, for badges/banners)

Each status color has 4 background tiers using `color-mix`:

| Tier | Opacity | Example (green) | Use |
|------|---------|-----------------|-----|
| `--bg-{color}` | 92% | `color-mix(in oklab, #1F8A65 92%, transparent)` | Solid fill |
| `--bg-{color}-secondary` | 24% | `color-mix(in oklab, #1F8A65 24%, transparent)` | Badge/pill bg |
| `--bg-{color}-tertiary` | 12% | `color-mix(in oklab, #1F8A65 12%, transparent)` | Banner bg |
| `--bg-{color}-quaternary` | 8% | `color-mix(in oklab, #1F8A65 8%, transparent)` | Subtle tint |

### Shadows

| Token | Value | Use |
|-------|-------|-----|
| `--shadow-primary` | `rgba(0,0,0,0.12)` | Darkest shadow |
| `--shadow-secondary` | `rgba(0,0,0,0.072)` | Medium shadow |
| `--shadow-tertiary` | `rgba(0,0,0,0.036)` | Lightest shadow |
| `--cursor-box-shadow-sm` | `0 2px 8px 0px rgba(0,0,0,0.072)` | Small elevation |
| `--cursor-box-shadow-base` | `0 0 0 1px border-tertiary, 0 0 4px 0px rgba(0,0,0,0.072), 0 8px 24px -2px rgba(0,0,0,0.072)` | Card/dropdown |
| `--cursor-box-shadow-lg` | `0 0 4px 0 rgba(255,255,255,0.05) inset, ...` | Dialog |
| `--cursor-box-shadow-xl` | `0 0 4px 0 rgba(255,255,255,0.05) inset, ...` | Command palette |
| `--color-theme-shadow-card` | `0 0 2px 0 rgba(0,0,0,0.06), 0 6px 16px 0 rgba(0,0,0,0.06)` | Card shadow |
| `--color-theme-shadow-dialog` | `0 0 0 1px border-tertiary, 0 0 2px 0 rgba(0,0,0,0.06), 0 6px 16px 0 rgba(0,0,0,0.06)` | Dialog |
| `--color-theme-shadow-command` | `0 25px 50px -12px rgba(0,0,0,0.25), 0 12px 24px -8px rgba(0,0,0,0.15)` | Command palette |

### Diff Colors

| Token | Value | Use |
|-------|-------|-----|
| `--diffs-addition-color-override` | `#1F8A65` | Added line text |
| `--diffs-deletion-color-override` | `#CF2D56` | Removed line text |
| `--diffs-bg-addition-override` | `#1F8A651F` | Added line bg (~12%) |
| `--diffs-bg-deletion-override` | `#CF2D561F` | Removed line bg (~12%) |

### Buttons

| Token | Value | Use |
|-------|-------|-----|
| `--cursor-button-background` | `#141414` | Primary button bg |
| `--cursor-button-foreground` | `#FCFCFC` | Primary button text |
| `--cursor-button-hover-background` | `color-mix(in oklab, #F7F7F7 10%, #141414)` | Primary hover |
| `--cursor-button-secondary-background` | `color-mix(in oklab, #141414 8%, transparent)` | Secondary button bg |
| `--cursor-button-secondary-foreground` | `color-mix(in oklab, #141414 94%, transparent)` | Secondary button text |

### Scrollbars

| Token | Value |
|-------|-------|
| `--cursor-scrollbar-thumb-background` | `color-mix(in srgb, #141414 20%, transparent)` |
| `--cursor-scrollbar-thumb-hover-background` | `color-mix(in srgb, #141414 30%, transparent)` |
| `--cursor-scrollbar-thumb-active-background` | `color-mix(in srgb, #141414 40%, transparent)` |

---

## Key Design Patterns

### 1. Everything derives from `--base` and `--chrome`

The entire color system is built from just two core values:
- `--base`: `#141414` (near-black) — all text, icons, borders, and surface tints derive from this
- `--chrome`: `#F7F7F7` (near-white) — the page chrome background

Text = `color-mix(in oklab, base N%, transparent)` where N controls the hierarchy.
Icons = `color-mix(in oklab, base N%, chrome)` — mixed toward chrome, not transparent.
Borders = `color-mix(in oklab, base N%, transparent)` — same as text but lower percentages.
Surfaces = `color-mix(in oklab, base N%, transparent)` — very low percentages (4-20%).

### 2. Status colors use 4-tier opacity system

For each semantic color (red, green, yellow, etc.):
- **Text**: Full hex (e.g., `#1F8A65`) with secondary at 78%
- **Icon**: 92% with secondary at 70%
- **Background**: 92% (solid), 24% (badge), 12% (banner), 8% (subtle)
- **Border**: 92% (strong), 56% (medium), 42% (subtle), 28% (faint)

### 3. Light mode is NOT warm-tinted in the product

Unlike the marketing site (which uses warm `#14120b`/`#26251e`), the authenticated product UI uses **neutral** `#141414` as the base. The warmth comes from the marketing-specific CSS, not the product design system.

This is an important finding — our warm-tinted tokens (`oklch(x 0.008 70)`) go BEYOND what Cursor's product actually does. The product uses pure neutral `#141414` (approximately `oklch(0.15 0 0)`).

### 4. `color-mix(in oklab, ...)` is the core primitive

Cursor uses `color-mix` in the `oklab` color space for perceptually uniform mixing. This is better than `rgba` opacity because it accounts for perceptual lightness. Our current approach of using `oklch` values directly is fine — `oklab` and `oklch` are the same color space with different coordinate systems.
