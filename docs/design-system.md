# Design System — Church Manager (Premium Enterprise)

The complete visual language for the Methodist Church Ghana / Dunwell Methodist church management system. Inspired by Linear, Notion, Stripe Dashboard and Vercel. Built on the existing Trypan Blue + Harvest Gold brand palette.

All tokens live in `public/styles.css`. This document is the canonical reference.

---

## 1. Color palette

### Brand (always on)

| Token | Hex | RGB | Use |
|---|---|---|---|
| `--sidebar-bg` | `#1d4e89` | 29, 78, 137 | Sidebar start (Trypan Blue) |
| `--sidebar-bg-2` | `#103060` | 16, 48, 96 | Sidebar end |
| `--sidebar-bg-deep` | `#0c2c5a` | 12, 44, 90 | Methodist Ghana logo shield |
| `--gold` | `#d4a017` | 212, 160, 23 | Primary action, brand accent |
| `--gold-soft` | `#fbf0cf` | 251, 240, 207 | Gold tinted background |
| `--gold-dark` | `#b9890b` | 185, 137, 11 | Pressed/hovered gold |
| `--gold-deep` | `#7a5b00` | 122, 91, 0 | Gold text on light surface |
| `--gold-ink` | `#2a2205` | 42, 34, 5 | Dark text on gold fill |
| `--purple` | `#7c5cfc` | 124, 92, 252 | Secondary action, links |
| `--purple-soft` | `#ece8fe` | 236, 232, 254 | Purple tinted background |
| `--purple-dark` | `#6240e0` | 98, 64, 224 | Pressed purple |
| `--purple-deep` | `#4a2fb0` | 74, 47, 176 | Deep purple, link text |

### Semantic

| Token | Hex | Use |
|---|---|---|
| `--green` | `#16a34a` | Success, positive trend, "Active" |
| `--green-soft` | `#dcfce7` | Success background |
| `--blue` | `#3b82f6` | Info, "Regular" |
| `--blue-soft` | `#dbeafe` | Info background |
| `--orange` | `#e08a1e` | Warning, "Visitor" |
| `--orange-soft` | `#fdecd2` | Warning background |
| `--danger` | `#dc2626` | Destructive, "Failed" |
| `--danger-soft` | `#fde8e8` | Destructive background |

### Surface (light)

| Token | Hex | Use |
|---|---|---|
| `--bg` | `#f3f6fb` | App background |
| `--panel` | `#ffffff` | Card / panel surface |
| `--soft` | `#f1f2f7` | Inactive chip, hover bg |
| `--field` | `#ffffff` | Form input background |
| `--ink` | `#172033` | Primary text |
| `--muted` | `#667085` | Secondary text |
| `--border` | `#dfe6f1` | Hairline border |
| `--border-strong` | `#cfd8e7` | Strong border |

### Surface (dark)

| Token | Hex | Use |
|---|---|---|
| `--bg` | `#0d1320` | App background |
| `--panel` | `#171d2b` | Card surface |
| `--soft` | `#212838` | Hover bg |
| `--ink` | `#eef2f8` | Primary text |
| `--muted` | `#a5adbd` | Secondary text |
| `--border` | `#30384a` | Hairline |

### Premium gradients

| Token | Stops | Use |
|---|---|---|
| `--e-grad-primary` | `#e8b923 → #d4a017 → #b9890b` | Primary CTA (Save, Submit) |
| `--e-grad-purple` | `#8b6cff → #7c5cfc → #4a2fb0` | Secondary CTA, avatars |
| `--e-grad-accent` | `var(--gold) → var(--purple)` | Card top accent stripe |
| `--e-grad-success` | `#22c55e → #16a34a → #15803d` | Success pill |
| `--e-grad-info` | `#60a5fa → #3b82f6 → #1d4ed8` | Info pill |

---

## 2. Typography

### Stack

| Role | Family | Weights | Where |
|---|---|---|---|
| **Display** | `Plus Jakarta Sans` | 700 · 800 · 900 | h1, h2, KPI values, hero numbers |
| **Body** | `Inter` | 400 · 500 · 600 · 650 · 700 | UI, body, labels, buttons |

Both loaded via `@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400..800&family=Plus+Jakarta+Sans:wght@600..900&display=swap')` near the top of `styles.css`.

Numeric data uses `font-variant-numeric: tabular-nums` everywhere money or counts appear.

### Scale

| Token | Size | Line | Tracking | Use |
|---|---|---|---|---|
| `display-xl` | 2.2rem (35px) | 1.05 | -0.025em | Page hero h1 |
| `display-lg` | 1.75rem (28px) | 1.1 | -0.028em | Stat card value |
| `display-md` | 1.4rem (22px) | 1.1 | -0.022em | Day-count, big-figure |
| `display-sm` | 1.15rem (18px) | 1.2 | -0.018em | Card title (h2) |
| `body-lg` | 1rem (16px) | 1.55 | -0.005em | Body, paragraphs |
| `body` | 0.9rem (14px) | 1.55 | -0.005em | Default UI |
| `body-sm` | 0.82rem (13px) | 1.5 | 0 | Meta, captions |
| `label` | 0.74rem (12px) | 1.4 | 0.04em | Form labels |
| `label-strong` | 0.66rem (11px) | 1.4 | 0.14em | Table headers, kickers (UPPERCASE) |

### Rules

- All headlines: `font-family: var(--p-font-display); font-weight: 800; letter-spacing: -0.022em`
- All money: `font-family: var(--p-font-display); font-variant-numeric: tabular-nums`
- All table headers: UPPERCASE, 0.14em letter-spacing, 700 weight, muted color
- All form labels: UPPERCASE, 0.04em letter-spacing, 700 weight, muted color
- Never exceed h1 1.85rem outside hero numbers

---

## 3. Spacing — 8-point grid

| Token | Value | Px | Where |
|---|---|---|---|
| `--e-space-1` | 0.25rem | 4 | Icon-to-text inside chip |
| `--e-space-2` | 0.5rem | 8 | Compact gaps, label margin |
| `--e-space-3` | 0.75rem | 12 | Card-head gap, table cell padding |
| `--e-space-4` | 1rem | 16 | Standard padding |
| `--e-space-5` | 1.25rem | 20 | Card interior padding |
| `--e-space-6` | 1.5rem | 24 | Section spacing |
| `--e-space-8` | 2rem | 32 | Page hero padding |
| `--e-space-10` | 2.5rem | 40 | Empty-state padding |

### Radius

| Token | Value | Where |
|---|---|---|
| `--e-radius-sm` | 8px | Inline pill (small), table cell pill |
| `--e-radius` | 12px | Buttons, inputs |
| `--e-radius-md` | 16px | Hero stat tile, ribbon |
| `--e-radius-lg` | 20px | Standard card |
| `--e-radius-xl` | 24px | Page hero |
| `999px` | full | Pill, badge |

### Shadow

| Token | Use |
|---|---|
| `--p-shadow-xs` | Card resting state |
| `--p-shadow-sm` | Card hover |
| `--p-shadow-md` | Elevated card, dropdown |
| `--p-shadow-lg` | Modal, toast, page hero |
| `--p-shadow-gold` | Primary CTA |
| `--p-shadow-purple` | Secondary CTA |

### Ring (focus)

`--p-ring: 0 0 0 4px rgba(124, 92, 252, 0.14)` — applied on `:focus-visible` for every interactive element.

---

## 4. Component anatomy

### Button

```
┌──────────────────────────────┐
│  icon  Label                 │  ← 40px height
└──────────────────────────────┘
   ↑      ↑
   12px   650 weight body font, -0.005em tracking
```

| Variant | Background | Color | Border | Shadow | Use |
|---|---|---|---|---|---|
| **Primary** | `--e-grad-primary` (gold) | `--gold-ink` | none | gold | Save, Submit, Create |
| **Secondary** | `--e-grad-purple` | `#fff` | none | purple | Filter, View all, +New |
| **Ghost** | `--panel` | `--ink` | `--p-border-strong` 1px | `--p-shadow-xs` | Export, Cancel |
| **Danger** | `--danger-soft` → `--danger` on hover | `--danger` → `#fff` | red soft 1px | none | Archive, Delete |
| **Icon** | `--soft` | `--muted` | transparent | none on rest, `xs` on hover | View / Edit / Trash row actions |
| **Link** | transparent | `--purple-dark` | none | none | "Remove photo", "Forgot password?" |

All buttons: 12px radius, 40px height, 0–16px horizontal padding (variable per content), 160ms ease transitions, `translateY(-1px)` on hover, returns on `:active`.

### Input

```
LABEL UPPERCASE                         ← 12px, 700, 0.04em, --muted
┌──────────────────────────────────┐
│                                  │  ← 40px height
└──────────────────────────────────┘
  12px padding · 12px radius · 1px --border-strong border
```

Focus: border `rgba(124,92,252,.55)` + 4px outer ring `rgba(124,92,252,.14)`.

### Card

```
┌──────────────────────────────────────────┐ ← 20px radius
│  Title                       Meta   ▸    │  card-head: 700, 16px, border-bottom 1px
│  ──────────────────────────────────────  │
│                                          │
│  body content                            │  card body: 20px padding, min-height varies
│                                          │
└──────────────────────────────────────────┘
       ↑
       Card hover: lifts -2px, shadow → md
       Dashboard cards: gradient gold→purple top stripe revealed on hover
```

### Stat card (KPI)

```
┌────────────────────────────────────────┐
│ ▆ Label · Cohort                    ⊕  │ ← top: label (650, 0.74rem) + icon tile
│                                        │
│ 1,284                                  │ ← value (display, 1.75rem, 800, tabular)
│ ▲ 4.8% vs. last month                  │ ← trend chip (green/red)
│                                        │
│ ╱╲╱╲╱╲╱╲╱╲╱╲╱╲╱╲╱╲╱╲╱╲╱╲              │ ← sparkline (svg, gradient fill)
└────────────────────────────────────────┘
   3px colored top stripe (var per metric)
```

### Hero stat tile

```
┌────────────────────────────┐
│ ⊕  1,284                   │ ← icon (42×42, soft tint) + value
│    Total Members           │ ← label (truncate)
└────────────────────────────┘
   1px colored left border + white panel
```

### Pill / badge

```
[ ⚬ Active ]    ← 0.66rem · 0.04em · 700 · 4px×9px · 999px radius
```

Status variants: `.pill-member` (green), `.pill-regular` (blue), `.pill-visitor` (orange), `.pill-inactive` (gray), `.pill-sent` (green), `.pill-failed` (red), `.pill-pending` (orange), `.pill-new` (blue), `.pill-active` (green).

### Table

```
NAME            CONTACT         DAY NAME      STATUS    ACTIONS    ← thead: UPPERCASE 0.66rem 0.14em
═════════════════════════════════════════════════════════════════
[AO] Adwoa O    📞 0244555…    Monday        [Active]  ⊙ ✎ 🗑    ← row: 0.88rem, 12px×16px padding
[KM] Kwabena M  📞 0244555…    Tuesday       [Active]  ⊙ ✎ 🗑
                                                                  ← row hover: subtle gold+purple gradient
─────────────────────────────────────────────────────────────────
```

Sticky header. 32×32 icon-btn action column.

### Pop / dropdown

12px radius, 1px border, `--p-shadow-lg`, `backdrop-filter: blur(12px)`. Menu items: 9px radius, 160ms ease, `translateX(2px)` on hover.

### Toast

`--e-radius` 14px, `--p-shadow-lg`, backdrop blur, colored left border by status, auto-dismiss with `toast-out` keyframe.

### Form

```
.form (card container, 20px padding, panel bg)
  ├─ <label>FIELD NAME *</label>
  ├─ <input> / <select> / <textarea>
  ├─ ... grouped in 2-col grid (.two-col) on wide viewports
  ├─ <div class="actions">
  │     <button type="submit">Save</button>    ← gold gradient primary
  │  </div>
  └─ danger zone: <button class="danger">Archive member</button>
```

### Day-born card (Akan fellowship)

```
┌──────────────────┐
│ ▔▔▔▔▔▔▔▔▔▔▔▔ │ ← gold→purple 3px stripe
│ Monday           │ ← display 0.88rem 800 -0.012em
│ Adwoa · Kwadwo   │ ← 0.7rem muted
│                  │
│ 182              │ ← display 1.55rem 800 tabular
│ MEMBERS          │ ← 0.62rem UPPERCASE 700 0.1em
│                  │
│ ⊙ Lead: Efua A.  │ ← 0.68rem muted, line-clamp 2
└──────────────────┘
```

7-column grid on desktop, 4 on tablet, 2 on mobile.

### Day tile (event date)

```
┌──────┐
│ JUN  │ ← month: 0.6rem UPPERCASE 700 gold-deep
│  08  │ ← day: display 1.3rem 800
└──────┘
   gold→white gradient bg, 12px radius
```

### Avatar

```
( AO )    ← 34×34 circle, display 0.78rem 700
           gradient bg per index (purple/gold/green/blue/rose)
```

### Sidebar nav

```
┌─ logo + brand
│
│  DASHBOARD                    ← section label 0.66rem 0.18em UPPERCASE
│  ◆ Dashboard          [▍]    ← active: gold-tinted bg, 3px gold left border
│
│  MEMBERS
│  ◷ Members
│  ✓ Attendance
│  ⊕ Bible Classes
│  ⌘ Organizations
│
│  ...
│
└─ Scripture of the day (translucent card, gold→purple wash)
```

Nav item: 40px min-height, 12px radius, 0.88rem 600. Hover: `translateX(2px)` + lift bg.

---

## 5. ASCII wireframes

### Dashboard

```
┌─────────┬─────────────────────────────────────────────────────────────────┐
│ ◇ Dunwell │  Home / Dashboard            🔍 Search…                    ⌘K │
│  Methodist│ ──────────────────────────────────────  🔔  ?  ◐  (RA) Admin │
│ Ministry  │                                                                │
│           │ Dashboard                                                      │
│ DASHBOARD │ Welcome back, Richard                          [⇩ Export]      │
│ ▍◆ Dash   │ Sunday, 07 June 2026                          [+ New Event]   │
│           │                                               [⊕ Record Svc]  │
│ MEMBERS   │ ┌──────────┬──────────┬──────────┬──────────┐                │
│ ◷ Members │ │▔gold     │▔purple   │▔blue     │▔green    │                │
│ ✓ Attend  │ │Total     │Sunday    │Offerings │Visitors  │                │
│ ⊕ Bible   │ │Members   │Attend.   │June      │June      │                │
│ ⌘ Orgs    │ │ 1,284    │  872     │₵48,210   │   23     │                │
│           │ │▲4.8%↑    │▲2.1%↑    │▲11.4%↑   │▲6 ↑      │                │
│ FINANCE   │ │╱╲╱╲╱╲    │╱╲╱╲╱╲    │╱╲╱╲╱╲    │╱╲╱╲╱╲    │                │
│ ◉ Finance │ └──────────┴──────────┴──────────┴──────────┘                │
│ ⎙ Invent  │                                                                │
│           │ ┌─────────────────────────────┬──────────────────────────┐    │
│ EVENTS    │ │ Attendance Trend  [1W|1M*|3M|1Y] │ Upcoming   View all → │    │
│ ⊞ Events  │ │   Weekly average                  │ JUN  Youth Bible      │    │
│ ▥ Preach  │ │                                   │ 08   7:00pm · Hall B  │    │
│ ✝ Sacram  │ │   ╱╲     ╱╲    ╱╲                 │                       │    │
│ ✉ Comms   │ │  ╱  ╲___╱  ╲__╱  ╲___              │ JUN  Confirmation     │    │
│           │ │  ────────────────────              │ 11   5:30pm · Sanc.   │    │
│ REPORTS   │ │  This year  / Last year(dashed)   │                       │    │
│ ⌬ Reports │ │                                   │ JUN  Choir Anniv      │    │
│ ◉ Operate │ └─────────────────────────────────┴──────────────────────────┘ │
│           │                                                                │
│ ADMIN     │ ┌────────────────────────────────────────────────────────────┐ │
│ 🔑 Users  │ │ Day-born Groups               [Assign leaders] [View all→] │ │
│ ⛁ Backup  │ │ Akan fellowship view                                       │ │
│ ⚠ Errors  │ │ ┌────┬────┬────┬────┬────┬────┬────┐                       │ │
│ ⚙ Settings│ │ │Mon │Tue │Wed │Thu │Fri │Sat │Sun │  ← 7-col grid         │ │
│           │ │ │Adw │Abe │Aku │Yaa │Afi │Ama │Ako │                       │ │
│ ─────────│ │ │182 │204 │176 │158 │191 │167 │206 │                       │ │
│ Verse of  │ │ │EA  │KM  │..  │YO  │KA  │AB  │AO  │  (lead initials)      │ │
│ the day   │ │ └────┴────┴────┴────┴────┴────┴────┘                       │ │
│ ...       │ └────────────────────────────────────────────────────────────┘ │
│           │                                                                │
│           │ ┌──────────────┬──────────────┬──────────────┐                │
│           │ │ Ministry     │ Finance Sum  │ Attendance   │ ← row 4, equal │
│           │ │ Overview     │ This month   │ Overview     │   heights      │
│           │ │ [4 mini      │ Services 150 │  donut + 0   │                │
│           │ │  tiles 2x2]  │ Harvest 330  │              │                │
│           │ │              │ Special 675  │              │                │
│           │ │              │ Expenses 0   │              │                │
│           │ │              │ Net  ₵1,155  │              │                │
│           │ └──────────────┴──────────────┴──────────────┘                │
│           │                                                                │
│           │ ┌──────────────┬──────────────┬──────────────┐                │
│           │ │ Birthdays    │ Recent       │ Pending      │ ← row 5, equal │
│           │ │ This week    │ Activities   │ Follow-ups   │   heights      │
│           │ │              │              │ • Visitors 3 │                │
│           │ │ (centered    │ (centered    │ • Absent  5  │                │
│           │ │  empty)      │  empty)      │ • No class 2 │                │
│           │ └──────────────┴──────────────┴──────────────┘                │
│           │                                                                │
│           │ © 2026 Dunwell Methodist             Last backup · 07 Jun 19:17│
└─────────┴─────────────────────────────────────────────────────────────────┘
```

### Members list

```
┌─────────┬─────────────────────────────────────────────────────────────────┐
│ sidebar │ Home / Members                                                   │
│         │ ┌──────────────────────────────────────────────────────────────┐ │
│         │ │ COMMAND CENTER                                               │ │
│         │ │ Members Directory                                            │ │
│         │ │ Manage and view all church members in one place.             │ │
│         │ └──────────────────────────────────────────────────────────────┘ │
│         │                                                                  │
│         │ ┌──────────┬──────────┬──────────┬──────────────┬─────────────┐ │
│         │ │ 12       │ 11       │ 1        │ [+ Add New]  │ [Bible Cls] │ │
│         │ │ Total    │ Active   │ New(30d) │              │             │ │
│         │ └──────────┴──────────┴──────────┴──────────────┴─────────────┘ │
│         │                                                                  │
│         │ ┌──────────────────────────────────────────────────────────────┐ │
│         │ │ 🔎 Search & Filters                                          │ │
│         │ │ [Search by name, ID, email…  ] [Bible class▾] [Status▾] [⇩] │ │
│         │ │                                              [Filter ⟶]    │ │
│         │ └──────────────────────────────────────────────────────────────┘ │
│         │                                                                  │
│         │ ┌──────────────────────────────────────────────────────────────┐ │
│         │ │ ⚬ Members List                                  [12 members] │ │
│         │ │ ──────────────────────────────────────────────────────────── │ │
│         │ │ □ NAME            CONTACT          DAY NAME  STATUS  ACTIONS │ │
│         │ │ ──────────────────────────────────────────────────────────── │ │
│         │ │ □ (AO) Adwoa O.   📞 0244555001    Monday    [Active] ⊙ ✎ 🗑 │ │
│         │ │      adwoa.o@…    📧 (Mobile-ready)                          │ │
│         │ │ ──────────────────────────────────────────────────────────── │ │
│         │ │ □ (KM) Kwabena M. 📞 0244555002    Tuesday   [Active] ⊙ ✎ 🗑 │ │
│         │ │      kmensah@…                                                │ │
│         │ │ ──────────────────────────────────────────────────────────── │ │
│         │ │ ...                                                          │ │
│         │ └──────────────────────────────────────────────────────────────┘ │
└─────────┴─────────────────────────────────────────────────────────────────┘
```

### Finance / Overview

```
┌─────────┬─────────────────────────────────────────────────────────────────┐
│ sidebar │ Home / Finance                                                   │
│         │ ┌──────────────────────────────────────────────────────────────┐ │
│         │ │ COMMAND CENTER                                               │ │
│         │ │ Finance                                                      │ │
│         │ │ Offerings, tithes, harvests and expenses — this year.        │ │
│         │ └──────────────────────────────────────────────────────────────┘ │
│         │                                                                  │
│         │ ╭──────────────────────────────────────────────────────────────╮ │
│         │ │ Overview┃ Services Tithes Harvests Special Pledges …         │ │
│         │ ╰──────────────────────────────────────────────────────────────╯ │
│         │                                                                  │
│         │ ┌──────────┬──────────┬──────────┬──────────┬──────────┐       │
│         │ │ ⊕ Gold   │ ⊕ Green  │ ⊕ Blue   │ ⊕ Purple │ ⊕ Orange │       │
│         │ │ ₵ 0.00   │ ₵ 0.00   │ ₵ 0.00   │ ₵ 0.00   │ ₵ 0.00   │       │
│         │ │ Service  │ Tithes   │ Harvest  │ Special  │ Expenses │       │
│         │ │ YTD      │ YTD      │ YTD      │ YTD      │ YTD      │       │
│         │ └──────────┴──────────┴──────────┴──────────┴──────────┘       │
│         │                                                                  │
│         │ ┌──────────────────────────────────────────────────────────────┐ │
│         │ │ Net YTD                                                      │ │
│         │ │ ₵ 0.00                          Offerings + Harvests - Exp.  │ │
│         │ └──────────────────────────────────────────────────────────────┘ │
│         │                                                                  │
│         │ ┌──────────────────────────┬──────────────────────────────────┐ │
│         │ │ Recent Services [View →] │ Recent Special Offerings [View →]│ │
│         │ │                          │                                  │ │
│         │ │ No services recorded.    │ None yet.                        │ │
│         │ └──────────────────────────┴──────────────────────────────────┘ │
│         │                                                                  │
│         │ ┌──────────────────────────────────────────────────────────────┐ │
│         │ │ Day-Born Totals (YTD)                    Service offerings   │ │
│         │ │ ──────────────────────────────────────────────────────────── │ │
│         │ │ DAY        AMOUNT         HEADS                              │ │
│         │ │ Sunday     ₵ 0.00         0                                  │ │
│         │ │ Monday     ₵ 0.00         0                                  │ │
│         │ │ Tuesday    ₵ 0.00         0                                  │ │
│         │ │ Wednesday  ₵ 0.00         0                                  │ │
│         │ │ Thursday   ₵ 0.00         0                                  │ │
│         │ │ Friday     ₵ 0.00         0                                  │ │
│         │ │ Saturday   ₵ 0.00         0                                  │ │
│         │ └──────────────────────────────────────────────────────────────┘ │
└─────────┴─────────────────────────────────────────────────────────────────┘
```

### Login

```
┌──────────────────────────────────────────────────────────────────┐
│                                                                  │
│         ╭───────────────────────╮  ╭───────────────────────╮     │
│         │                       │  │ ⊕ Dunwell Methodist   │     │
│         │       [LOGO 168px]    │  │                       │     │
│         │     official seal of  │  │ Sign in               │     │
│         │  The Methodist Church │  │                       │     │
│         │        Ghana          │  │ USERNAME              │     │
│         │                       │  │ ┌───────────────────┐ │     │
│         │                       │  │ │                   │ │     │
│         │ REFINED MINISTRY OPS  │  │ └───────────────────┘ │     │
│         │ Dunwell Methodist     │  │                       │     │
│         │                       │  │ PASSWORD              │     │
│         │ Secure access for     │  │ ┌───────────────────┐ │     │
│         │ members, giving,      │  │ │                   │ │     │
│         │ services, reports …   │  │ └───────────────────┘ │     │
│         │                       │  │                       │     │
│         │                       │  │ [  Sign in  ←gold ]   │     │
│         │                       │  │                       │     │
│         │                       │  │ Forgot password?      │     │
│         │ deep-blue gradient    │  │  white panel          │     │
│         ╰───────────────────────╯  ╰───────────────────────╯     │
│                                                                  │
│       Page background: layered indigo/purple gradient            │
└──────────────────────────────────────────────────────────────────┘
```

---

## 6. Motion

| Property | Duration | Easing |
|---|---|---|
| Hover transforms | 160ms | `cubic-bezier(0.4, 0, 0.2, 1)` |
| Color/bg fades | 140ms | ease |
| Card lift | 200ms | ease |
| Toast in/out | 250ms | ease |

`prefers-reduced-motion: reduce` clamps all to `0.01ms`.

---

## 7. Layout grid

| Breakpoint | Behavior |
|---|---|
| ≥ 1280px | Day-born: 7 cols · stat-grid: 4 cols · dash-grid: 3 cols |
| 1100–1280 | Day-born: 4 cols · stat-grid: 4 cols · dash-grid: 3 cols |
| 760–1099 | Day-born: 4 cols · stat-grid: 2 cols · dash-grid: 2 cols |
| < 760 | Day-born: 2 cols · stat-grid: 1 col · dash-grid: 1 col, sidebar becomes bottom-sheet |

Max container: 1320px. Side padding scales responsively.

---

## 8. File organization

`public/styles.css` is a single layered stylesheet:

| Lines | Layer | Purpose |
|---|---|---|
| 1 – 100 | Brand tokens + reset | Light/dark CSS vars |
| 100 – 1300 | Component primitives | Cards, buttons, inputs, tables |
| 1300 – 2200 | Page-specific | Members directory, finance tabs, calendar |
| 1348 – 2700 | Enterprise polish v1 | First premium pass |
| 2700 – 4400 | Premium enterprise v2 | Refined cards, hero, day-born grid |
| 4400 – end | **v3 alignment + login logo** | Equal-height rows, activity-card fix, Methodist Ghana logo |

Later layers override earlier ones via cascade. **Always add to the end** — never edit earlier layers.

---

## 9. Adding a new component

1. Define markup in `lib/views.js` or a route file
2. Append CSS to the bottom of `public/styles.css` under a `/* ---------- ComponentName ---------- */` heading
3. Use only the tokens above — no hard-coded hex / px outside this doc
4. Add a dark-mode override if the component uses bespoke backgrounds
5. Run `npm test` — the smoke test enforces certain CSS contracts (e.g. `.dash-grid .day-born-grid` 7-col scoping)
6. Update this doc with the new component's anatomy

---

## 10. Reference assets

- `public/methodist-ghana-logo.svg` — official emblem (gold disc, blue Ghana map, red cross, Wesleyan rosette, "Your Kingdom Come · 1835" ribbon). Used on `/login`, `/setup`, `/forgot`, `/reset`.
- `docs/ui-mockup.html` — self-contained design reference / interactive preview.
