# Design System

## Direction

MDBASE Connect is a desktop utility used in ordinary daylight at a personal
computer while the user is making a consequential access decision. The theme is
minimal, precise, and almost entirely white. A narrow white sidebar provides
stable desktop navigation without becoming a contrasting visual rail. The
content remains an uninterrupted white canvas. Hierarchy comes from typography,
spacing, and alignment rather than tinted surfaces, boxes, or decoration.

## Color

- Ink: `oklch(0.34 0.007 255)`
- Action grey: `oklch(0.46 0.007 250)`
- White: `oklch(1 0 0)`
- Hover: `oklch(0.975 0.003 250)`
- Line: `oklch(0.96 0.003 250)`
- Strong line: `oklch(0.90 0.004 250)`
- Connected green: `oklch(0.65 0.09 158)`
- Warning amber: `oklch(0.72 0.09 75)`
- Danger red: `oklch(0.59 0.11 28)`
- Muted text: `oklch(0.52 0.01 250)`

Use a light monochrome strategy. White is the only major surface. Controls stay
white and use fine grey outlines rather than dark fills. Green indicates verified
connection or completion. Amber indicates pending attention. Red indicates
revocation, disconnection, or destructive local administration. Semantic color
should occupy as little space as possible.

## Typography

- Primary family: the native system UI sans stack.
- Technical data: IBM Plex Mono for origins, paths, versions, IDs, and operation
  names.
- Product headings use compact fixed sizes and strong weight contrast.
- Body copy is 12 to 14px at 1.45 to 1.55 line height, capped near 70ch.

## Layout

- Desktop shell uses a narrow persistent sidebar beside a flexible content
  workspace. Both stay white, separated by one near-white rule.
- Primary navigation is conventional and text-led, with counts only when action
  is required.
- Configuration rows are preferred over card grids. Pending access decisions
  use ruled rows. Empty states are plain text with a single next action.
- Whitespace establishes section rhythm. Fine dividers are limited to dense
  lists and places where rows would otherwise become ambiguous.

## Components

- Buttons: 4px radius, 34 to 36px height. Primary and secondary actions remain
  white with different grey border emphasis; quiet and danger actions are text
  led. No dark fills or shadows. All include hover, focus, disabled, and busy
  states.
- Status: pair a colored dot with a text label. Never show a dot alone.
- Permission scopes: plain checkboxes with concrete action descriptions.
- Lists: stable four-column rhythm for identity, target, state, and actions.
- Empty states teach the first useful action without decorative illustration.
- Dialogs are limited to creating collections and confirming high-impact
  actions; routine configuration uses inline panels.

## Motion

Use 150 to 200ms ease-out transitions for hover, navigation, and inline reveals.
Do not animate layout or orchestrate page entry. Disable nonessential motion
under `prefers-reduced-motion`.
