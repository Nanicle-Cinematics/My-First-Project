# Design System

Premium enterprise visual system for the Church Manager. All tokens live in `public/styles.css`; this doc is the reference.

## Type

| Role | Family | Weights | Use |
|---|---|---|---|
| Display | `Plus Jakarta Sans` | 700 / 800 | h1, h2, big figures, KPI values |
| Body | `Inter` | 400 / 500 / 600 / 650 / 700 | UI text, body, labels |

- Display tracking: `-0.022em`
- Tabular nums on all money/numbers: `font-variant-numeric: tabular-nums`
- Labels: uppercase, 0.04–0.14em letter-spacing, 700 weight

## Color

| Token | Value | Use |
|---|---|---|
| `--sidebar-bg` / `-bg-2` | `#1d4e89` → `#103060` | Sidebar gradient (Trypan Blue) |
| `--gold` | `#d4a017` | Primary actions, brand accent |
| `--purple` | `#7c5cfc` | Secondary actions, links, focus |
| `--green` | `#16a34a` | Success / positive |
| `--blue` | `#3b82f6` | Info |
| `--orange` / `--danger` | — | Warning / destructive |

Each color has a `*-soft` tint for backgrounds (e.g. `--gold-soft`).

Gradients (`--e-grad-*`):
- `--e-grad-primary` — gold (primary CTA)
- `--e-grad-purple` — purple (secondary CTA)
- `--e-grad-accent` — gold→purple (decorative accent stripes)

## Spacing (8-pt grid)

| Token | Value |
|---|---|
| `--e-space-1` | 0.25rem |
| `--e-space-2` | 0.5rem |
| `--e-space-3` | 0.75rem |
| `--e-space-4` | 1rem |
| `--e-space-5` | 1.25rem |
| `--e-space-6` | 1.5rem |
| `--e-space-8` | 2rem |
| `--e-space-10` | 2.5rem |

## Radius

| Token | Value | Use |
|---|---|---|
| `--e-radius-sm` | 8px | Inline pills, small chips |
| `--e-radius` | 12px | Buttons, inputs |
| `--e-radius-md` | 16px | Mid-sized cards, hero stats |
| `--e-radius-lg` | 20px | Standard cards |
| `--e-radius-xl` | 24px | Hero / page header |

## Shadow

| Token | Use |
|---|---|
| `--p-shadow-xs` | Default card resting state |
| `--p-shadow-sm` | Card hover |
| `--p-shadow-md` | Elevated cards, dropdowns |
| `--p-shadow-lg` | Modals, toasts, hero |
| `--p-shadow-gold` / `-purple` | Branded primary/secondary CTAs |

## Components

### Page hero
Every top-level page uses `pageHero(title, subtitle)` from `lib/views.js`:
- Gold→purple radial backdrop on indigo gradient
- "COMMAND CENTER" kicker pill, h1, supporting paragraph
- Radial highlight at top-right

### Stat card (`.stat`)
- Icon (44×44) in colored tinted square, left side
- Label (0.74rem, 650 weight, ellipsis-truncated)
- Value (1.75rem, display font, tabular nums)
- Trend chip + sparkline at bottom
- Top accent stripe (3px, colored)

### Hero stat (`.hero-stat`)
Used below page hero. White card with colored left border, icon + value + label inline.

### Button hierarchy
- **Primary** (`.btn.primary` or `.form button[type="submit"]`) — gold gradient
- **Secondary** (`.btn.purple`) — purple gradient
- **Ghost** (`.btn.ghost`) — neutral panel
- **Danger** (`.danger`) — red soft → solid on hover
- **Icon** (`.icon-btn`) — 32×32 neutral with hover lift
- **Link** (`.link`) — text-only

All buttons share height 40px, radius 12px, 650 weight.

### Input
40px height, 12px radius, soft border, premium focus ring `0 0 0 4px rgba(124,92,252,.14)`.

### Table
- Uppercase letter-spaced headers (0.66rem / 0.14em / 700)
- Subtle gradient row hover
- Row-actions: 32×32 icon buttons

### Pill
- 0.66rem / 0.04em / 700
- 999px radius, soft background, dark text
- Variants: `.pill-member`, `.pill-visitor`, `.pill-sent`, etc.

### Day-born card
- 7-column grid (4 on tablet, 2 on mobile)
- Gradient gold→purple top stripe
- Display-font day name + Akan name pair sub-line
- Big count + uppercase "Members" label
- Leader / meeting meta below

### Dark mode
Every component has dark-mode tokens via `[data-theme="dark"]`. Test by toggling theme.

## Motion

- Transitions: 160–200ms `cubic-bezier(0.4, 0, 0.2, 1)`
- Hover lift: `translateY(-2px)` for cards, `(-1px)` for buttons
- Card hover: shadow upgrades `sm → md`
- Reduced motion: all transitions clamped to 0.01ms via `@media (prefers-reduced-motion: reduce)`

## Layout grid

- Max container: 1320px
- Side padding: scales with viewport
- Dashboard grid: 3 equal columns at ≥1100px, 2 at <1100px, 1 at <720px
- Day-born grid: 7 / 4 / 2 columns by viewport

## File organization

- `public/styles.css` — single stylesheet, organized in layers:
  1. Base tokens + reset (lines 1–106)
  2. Component primitives (lines 107–1300)
  3. Page-specific (lines 1300–2200)
  4. Enterprise polish v1 (lines 1348–2700)
  5. **Premium enterprise layer v2** (final ~700 lines)

Layers cascade — later wins. Avoid editing earlier layers; add to the v2 layer instead.
