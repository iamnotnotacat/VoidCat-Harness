# VoidCat design-token contract

Status: approved visual contract. The owner directed completion of every audited gate on 2026-07-27; automated color, typography, motion, and responsive-layout contract checks are mandatory for subsequent changes.

VoidCat components consume semantic CSS variables from `app/design-tokens.css`. Palette literals belong only in that token source; feature styles must not introduce hexadecimal, RGB, HSL, or named presentation colors. This keeps the established Evangelion-inspired interface coherent without tying components to raw paint values.

## Token layers

| Layer | Prefix | Purpose |
|---|---|---|
| Palette | `--vc-palette-*` | Owner-approved raw colors. Components do not consume these directly unless defining another semantic token. |
| Surfaces | `--vc-surface-*` | Canvas, panels, raised controls, overlays, scrims, shadows, and interactive states. |
| Text | `--vc-text-*` | Primary, secondary, muted, dim, inverse, and critical copy. |
| Accents | `--vc-accent-*` | Primary purple structure and acid-highlight actions. |
| Status | `--vc-status-*` | Informational, success, warning, and critical state. |
| Borders | `--vc-border-*` | Subtle, default, strong, and focus structure. |
| Intelligence | `--vc-intel-*` | Observation categories and freshness roles used by Hunter-Seeker. |
| Map | `--vc-map-*` | Map canvas, geographic structure, grid, and label roles. |
| Typography | `--vc-font-*`, `--vc-type-*` | Shared families and a type scale with a hard 10px minimum. |
| Layout | `--vc-space-*`, `--vc-cut-*` | Spacing rhythm, title-bar geometry, control height, and clipped corners. |
| Motion | `--vc-motion-*`, `--vc-ease-*` | Short, bounded interface motion. Reduced-motion preferences always win. |
| Elevation | `--vc-shadow-*`, `--vc-z-*` | Focus, glow, overlay, navigation, and dialog layering. |

## Intelligence colors

Hunter-Seeker uses category roles rather than provider-specific colors:

- Military aircraft: `--vc-intel-military-aircraft`
- Civil or unclassified aircraft: `--vc-intel-civilian-aircraft`
- Maritime vessels: `--vc-intel-maritime`
- Orbital objects: `--vc-intel-space`
- Weather advisory: `--vc-intel-advisory`
- Critical observation: `--vc-intel-critical`
- Stale or degraded observation: `--vc-intel-stale`

Provider identity is communicated with labels and provenance, not by inventing additional provider colors.

## Typography rules

- No rendered application text may be smaller than 10px.
- Dense metadata uses `--vc-type-micro`, `--vc-type-caption`, `--vc-type-control`, or `--vc-type-label`.
- Body copy uses `--vc-type-body` and `--vc-leading-body`.
- Display faces are reserved for short headings and status values.
- Long values must wrap, truncate with an accessible title, or use the opt-in safe marquee. They must not force containers beyond the viewport.

## Motion rules

- Motion communicates loading, selection, or state change; it is not continuous decoration by default.
- Animations use the shared duration and easing tokens.
- Source data updates must never restart layout-wide animations.
- `prefers-reduced-motion` disables nonessential animation.
- Map rendering uses low-power WebGL settings and bounded tile memory.

## Component example

```css
.example-panel {
  border: 1px solid var(--vc-border-default);
  background: var(--vc-surface-panel);
  color: var(--vc-text-primary);
}

.example-panel[data-status="warning"] {
  border-color: var(--vc-status-warning);
}
```

## Adding or changing a token

1. Reuse an existing semantic role when the meaning already matches.
2. If no role fits, add a generic VoidCat-wide semantic token rather than a feature-specific raw color.
3. Define literals only in `app/design-tokens.css`.
4. Document the role here.
5. Run the token and typography tests.
6. Present owner-visible visual changes for approval.

Compatibility aliases such as `--purple`, `--acid`, and `--danger` remain temporarily available while older VoidCat screens migrate. New Hunter-Seeker work uses the `--vc-*` semantic names.
