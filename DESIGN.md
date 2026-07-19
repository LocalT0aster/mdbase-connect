# Design System

## Direction

MDBASE Connect is a desktop utility used in ordinary daylight at a personal
computer while the user is making a consequential access decision. The theme is
light, restrained, and workmanlike. A dark navy navigation rail anchors the
local machine; fog-tinted content surfaces keep long configuration sessions
comfortable.

## Color

- Ink: `oklch(0.27 0.025 235)`
- Navy rail: `oklch(0.31 0.045 250)`
- Paper: `oklch(0.985 0.004 210)`
- Fog: `oklch(0.955 0.008 210)`
- Line: `oklch(0.88 0.012 210)`
- Signal blue: `oklch(0.58 0.22 266)`
- Connected green: `oklch(0.66 0.14 164)`
- Warning amber: `oklch(0.72 0.13 73)`
- Danger red: `oklch(0.56 0.14 28)`
- Muted text: `oklch(0.53 0.025 215)`

Use a restrained strategy. Blue is reserved for primary actions and current
navigation. Green indicates verified connection or completion. Amber indicates
pending attention. Red indicates revocation, disconnection, or destructive
local administration.

## Typography

- Primary family: Archivo Variable, with Segoe UI and system sans fallbacks.
- Technical data: IBM Plex Mono for origins, paths, versions, IDs, and operation
  names.
- Product headings use compact fixed sizes and strong weight contrast.
- Body copy is 12 to 14px at 1.45 to 1.55 line height, capped near 70ch.

## Layout

- Desktop shell uses a persistent 224 to 248px navigation rail and a flexible
  content workspace.
- Primary navigation is conventional and text-led, with counts only when action
  is required.
- Configuration rows are preferred over card grids. Cards are reserved for
  pending access decisions and focused empty states.
- Dividers establish section rhythm; spacing increases between separate tasks
  and tightens within a single configuration object.

## Components

- Buttons: 6px radius, 34 to 38px height, with primary, secondary, quiet, and
  danger treatments. All include hover, focus, disabled, and busy states.
- Status: pair a colored dot with a text label. Never show a dot alone.
- Permission scopes: compact action chips or checkboxes with plain-language
  descriptions.
- Lists: stable four-column rhythm for identity, target, state, and actions.
- Empty states teach the first useful action without decorative illustration.
- Dialogs are limited to creating collections and confirming high-impact
  actions; routine configuration uses inline panels.

## Motion

Use 150 to 200ms ease-out transitions for hover, navigation, and inline reveals.
Do not animate layout or orchestrate page entry. Disable nonessential motion
under `prefers-reduced-motion`.
