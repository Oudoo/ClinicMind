---
name: ClinicMind
description: The interface of a clinic's working day, for staff who read it hundreds of times a day.
colors:
  page: "hsl(220 20% 97%)"
  rail: "hsl(220 22% 94%)"
  surface: "hsl(0 0% 100%)"
  muted: "hsl(220 18% 95%)"
  ink: "hsl(218 27% 14%)"
  ink-muted: "hsl(220 10% 38%)"
  rule: "hsl(220 15% 89%)"
  field-border: "hsl(220 14% 84%)"
  accent: "hsl(243 75% 59%)"
  accent-tint: "hsl(243 75% 96%)"
  on-accent: "hsl(0 0% 100%)"
  success: "hsl(152 63% 28%)"
  warning: "hsl(30 92% 33%)"
  danger: "hsl(0 72% 45%)"
typography:
  page-title:
    fontFamily: "Plus Jakarta Sans, system-ui, sans-serif"
    fontSize: "1.375rem"
    fontWeight: 600
    lineHeight: 1.27
    letterSpacing: "-0.02em"
  section-heading:
    fontFamily: "Plus Jakarta Sans, system-ui, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 600
    lineHeight: 1.6
    letterSpacing: "-0.01em"
  figure:
    fontFamily: "Plus Jakarta Sans, system-ui, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 600
    letterSpacing: "-0.02em"
    fontFeature: "tnum"
  body:
    fontFamily: "Plus Jakarta Sans, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.43
  label:
    fontFamily: "Plus Jakarta Sans, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 500
    lineHeight: 1.33
  code:
    fontFamily: "JetBrains Mono, ui-monospace, monospace"
    fontSize: "0.75rem"
    fontWeight: 400
rounded:
  sm: "4px"
  md: "6px"
  lg: "8px"
spacing:
  row: "12px"
  card: "20px"
  section: "32px"
components:
  card:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.lg}"
    padding: "20px"
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    rounded: "{rounded.lg}"
    height: "36px"
  button-outline:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    height: "36px"
  badge:
    backgroundColor: "{colors.muted}"
    textColor: "{colors.ink-muted}"
    rounded: "{rounded.md}"
    height: "20px"
  nav-item-active:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    height: "32px"
---

# Design System: ClinicMind

> Written from the code as it stands after the first interface pass (navigation, overview,
> appointments; November 2026), without an interview. `PRODUCT.md` says who the product is for;
> this file says how its screens are built. The tokens live in `src/app/globals.css` and
> `tailwind.config.ts`, the shared parts in `src/components/ui/`.

## Overview

A working tool, read at a desk with a patient waiting. Screens are quiet and dense: one neutral
ground, white surfaces for content that belongs together, one accent, and colour kept for state.
Every screen opens on what the person should do now, then on what happened.

The first pass set these patterns on three screens. The rest of the product still shows the
older look in places (cards inside cards, status written in capitals from the database value);
bring a screen to these rules when you work on it.

## Colors

All colours are CSS variables, so the dark theme and a clinic's own accent need no rebuild.

- **Ground and surfaces.** The page is `page`; the navigation rail is `rail`, a step darker and
  cooler; content sits on `surface`. `muted` fills quiet chips and hovered rows.
- **Text.** `ink` for content, `ink-muted` for labels and secondary lines. Both read at 4.5:1 or
  better on every ground above.
- **Accent.** One colour, indigo by default: the primary button, the current item, links, and
  the visit under way. A clinic may replace it (`src/lib/brand.ts`), so never rely on it being
  indigo, and never use it for meaning that `success`, `warning` or `danger` carry.
- **State.** `success` done or settled, `warning` someone is waiting or money is owed, `danger`
  late, overdue or a no-show. Each is dark enough to be text on white and on its own 10% tint.
  A state is never told by colour alone: it has a word, and a mark of its own.
- **Dark theme.** The same roles with lighter state colours. Accent-coloured text is lightened
  there by a rule in `globals.css`, because the fill colour is too dim to read on a dark surface.

## Typography

One face for the interface, Plus Jakarta Sans, with tabular figures wherever numbers line up
(times, counts, money). JetBrains Mono is for codes and reference numbers only: an invoice
number, a national ID, a procedure code. It is never a label style.

| Role | Size | Use |
| --- | --- | --- |
| `page-title` | 22px, 600 | The one title of a page (`SectionTitle` outside a card) |
| `section-heading` | 15px, 600 | A heading inside a card, or `SectionTitle level="section"` |
| `figure` | 24px, 600 | A headline number in a `StatStrip` |
| `body` | 14px | Rows, forms, sentences |
| `label` | 12px, 500 | Field, column and figure labels (`.data-label`), chips |

Labels are sentence case. No capitals for emphasis, no letter-spacing on labels, nothing below
12px. Arabic is never letter-spaced or set in capitals.

## Layout

- **Shell.** A 240px rail on wide screens and a drawer below `lg`; a 56px top bar with the
  patient search, notifications, the theme switch and the account. The rail scrolls on its own.
- **Navigation.** Three pages are always in view: Overview, Appointments, Patients. Everything
  else is in five groups (Front desk, Clinical, Billing, Accounts, Clinic) whose order and
  starting state follow the role (`navPlan` in `src/components/dashboard/shell.tsx`). A new page
  goes into the group of the work it belongs to, never into the top three.
- **A page** is a title, then its content in order of urgency: what to do now, the list being
  worked, supporting figures, charts last. `space-y-4` inside a block, `space-y-8` between blocks.
- **Lists are rows.** One surface, rows divided by rules, 12px of vertical padding, the action at
  the end of the row. A row stacks on a phone with the status beside the time.
- **Figures** sit together in one `StatStrip`, divided by space, not in a card each.
- **Small screens.** Nothing scrolls sideways at 390px. Touch targets in the menu are 44px.

## Elevation & Depth

Flat. A surface is told from the ground by its border and a 1px shadow, not by lift. Menus and
dialogs are the only things that float, with one shadow each. No blur, no glass, no gradients as
decoration.

## Shapes

8px corners on surfaces, buttons and fields; 6px on chips and menu items; full circles for the
account initials and status dots. Borders are 1px in `rule`. No coloured stripe down one side of
a card or row.

## Components

- **Card** (`Card`, `.bento`): one bordered surface for content that belongs together. Never
  inside another card: divide with rules or space instead.
- **SectionTitle**: the page title at the top of a page, a section heading inside a card. Its
  action drops below the text on a narrow screen.
- **StatStrip**: several figures in one surface, each with a label, the change against the
  period before (`DeltaChip`) and one line of context. Which figures a role sees is decided by
  the page (`statsFor` on the overview).
- **Badge**: a short state beside the thing it describes, 20px high, sentence case. Give it an
  icon or `dot` when it is a status.
- **Appointment status** (`AppointmentStatusBadge`): every status has its own word, mark and
  tone, listed in `STATUS_STYLE`. Use `plain` in a narrow place (a day's column of the week).
- **Next step**: where bookings are listed for someone who may change them, the usual next move
  (confirm, check in, start, complete: `NEXT_STATUS`) is one outlined button on the row; every
  other move is in the row's menu. Moves that record something clinical or financial ask first.
- **Buttons**: one primary button to a page. Row and toolbar actions are outlined; quiet links
  are ghost buttons.
- **Select**: carries a chevron (`.select-caret`). A filter applies when it is chosen; it has no
  "Apply" button.
- **Empty state**: a dashed box with what is missing and what to do about it.

## Do's and Don'ts

**Do**

- Open a screen on the next action for the person's role, then the history.
- Say a state in words, with its mark and tone, the same way everywhere.
- Use the tokens (`bg-card`, `text-muted-foreground`, `text-warning`), never a raw colour.
- Keep times, counts and money in tabular figures; write money as whole EGP.
- Check a changed screen at 1440px and 390px, in the dark theme, and with a long Arabic name.

**Don't**

- Don't build a page out of equal cards, or put a card inside a card.
- Don't put a small label above a heading to introduce it; write a better heading.
- Don't use monospace, capitals or letter-spacing to make a label look technical.
- Don't show a sum of unlike things ("35 open"); name each thing and its count.
- Don't add a chart or a figure before the work it supports.
- Don't suggest that a financial record can be edited or deleted.
