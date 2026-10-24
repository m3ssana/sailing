/**
 * HUD visual tokens and stylesheet, transcribed from docs/art-direction.md §8
 * (nautical-instrument visual language).
 *
 * The stylesheet is a typed CSS-in-TS string rather than a `.css` file: the
 * project loads CSS inline in `index.html` and has no `import './x.css'`
 * precedent in `src/`, so a string we inject in `mountHud` keeps the HUD
 * self-contained, importable under vitest's node environment, and asset-free.
 *
 * Normative rules enforced here (art-direction §8.3–§8.5):
 * - No drop shadows, no background gradients — flat, high-contrast panels.
 * - No text shadows; contrast comes from the backdrop rectangle.
 * - Opaque backdrop option (Instrument Black @ 92%) for the WCAG AA contrast rule
 *   (`#E8ECF0` on `#0A0E12` = 16.5:1). Default backdrop is 75% opacity.
 * - Tabular-figure monospace numerics; proportional sans labels, +0.02em on caps.
 * - Animations respect `prefers-reduced-motion`.
 */

/** The §8.2 UI colour ramp. */
export const HUD_COLORS = {
  background: '#0A0E12', // Instrument Black
  surface: '#1A2028', // Deep Charcoal
  border: '#3A4248', // Wire Grey
  textPrimary: '#E8ECF0', // Chalk White
  textSecondary: '#8A9298', // Muted Grey
  accentPrimary: '#3A90D0', // Compass Blue
  accentWarn: '#D8A030', // Caution Amber
  accentDanger: '#D04040', // Alert Red
  positive: '#30A060', // Starboard Green
  apparentWind: '#40D8E0', // Apparent Cyan
  trueWind: '#5888C0', // True Blue
} as const;

/** Backdrop opacity levels (art-direction §8.4). */
export const HUD_BACKDROP = {
  /** Default semi-transparent backdrop. */
  defaultAlpha: 0.75,
  /** Opaque accessibility backdrop guaranteeing WCAG AA. */
  opaqueAlpha: 0.92,
} as const;

/** Root class on the HUD container. */
export const HUD_ROOT_CLASS = 'hud-root';
/** Added when the opaque backdrop accessibility option is enabled. */
export const HUD_OPAQUE_CLASS = 'hud-opaque';

/** Id of the injected <style> element (so injection is idempotent). */
export const HUD_STYLE_ELEMENT_ID = 'hud-styles';

/**
 * The HUD stylesheet. Uses CSS custom properties so the opaque toggle flips a
 * single variable rather than restyling every panel.
 */
export const HUD_CSS = `
.${HUD_ROOT_CLASS} {
  --hud-bg: ${HUD_COLORS.background};
  --hud-surface: ${HUD_COLORS.surface};
  --hud-border: ${HUD_COLORS.border};
  --hud-text: ${HUD_COLORS.textPrimary};
  --hud-text-dim: ${HUD_COLORS.textSecondary};
  --hud-accent: ${HUD_COLORS.accentPrimary};
  --hud-warn: ${HUD_COLORS.accentWarn};
  --hud-danger: ${HUD_COLORS.accentDanger};
  --hud-positive: ${HUD_COLORS.positive};
  --hud-awind: ${HUD_COLORS.apparentWind};
  --hud-twind: ${HUD_COLORS.trueWind};
  --hud-backdrop-alpha: ${HUD_BACKDROP.defaultAlpha};
  --hud-mono: ui-monospace, 'Cascadia Code', 'Consolas', monospace;
  --hud-sans: ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif;

  position: absolute;
  inset: 0;
  pointer-events: none;
  color: var(--hud-text);
  font-family: var(--hud-sans);
  font-variant-numeric: tabular-nums;
  display: grid;
  grid-template-columns: auto 1fr auto;
  grid-template-rows: auto 1fr auto;
  gap: 12px;
  padding: 16px;
}
.${HUD_ROOT_CLASS}.${HUD_OPAQUE_CLASS} {
  --hud-backdrop-alpha: ${HUD_BACKDROP.opaqueAlpha};
}
.${HUD_ROOT_CLASS} .hud-panel {
  /* Flat high-contrast panel: solid backdrop, 1px wire border, NO shadow, NO gradient. */
  background: color-mix(in srgb, var(--hud-bg) calc(var(--hud-backdrop-alpha) * 100%), transparent);
  border: 1px solid var(--hud-border);
  border-radius: 4px;
  padding: 8px 10px;
  box-shadow: none;
  pointer-events: auto;
}
.${HUD_ROOT_CLASS} .hud-label {
  font-size: 11px;
  font-weight: 400;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  color: var(--hud-text-dim);
}
.${HUD_ROOT_CLASS} .hud-value {
  font-family: var(--hud-mono);
  font-size: 16px;
  text-align: right;
  text-shadow: none;
}
.${HUD_ROOT_CLASS} .hud-unit {
  font-size: 11px;
  color: var(--hud-text-dim);
  margin-left: 2px;
}
.${HUD_ROOT_CLASS} .hud-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
}
.${HUD_ROOT_CLASS} .hud-wind { grid-column: 1; grid-row: 1; }
.${HUD_ROOT_CLASS} .hud-compass { grid-column: 3; grid-row: 1; justify-self: end; }
.${HUD_ROOT_CLASS} .hud-speed { grid-column: 1; grid-row: 3; align-self: end; }
.${HUD_ROOT_CLASS} .hud-trim { grid-column: 3; grid-row: 2; justify-self: end; align-self: center; }
.${HUD_ROOT_CLASS} .hud-heelhelm { grid-column: 3; grid-row: 3; justify-self: end; align-self: end; }
.${HUD_ROOT_CLASS} .hud-conditions { grid-column: 1; grid-row: 2; align-self: center; }
.${HUD_ROOT_CLASS} .hud-coaching { grid-column: 2; grid-row: 1; justify-self: center; }
.${HUD_ROOT_CLASS} .hud-badge {
  display: inline-block;
  font-family: var(--hud-mono);
  font-size: 10px;
  letter-spacing: 0.08em;
  color: var(--hud-bg);
  background: var(--hud-warn);
  border-radius: 3px;
  padding: 1px 5px;
}
.${HUD_ROOT_CLASS} .hud-bar {
  height: 6px;
  background: var(--hud-surface);
  border: 1px solid var(--hud-border);
  border-radius: 3px;
  overflow: hidden;
}
.${HUD_ROOT_CLASS} .hud-bar > span {
  display: block;
  height: 100%;
  background: var(--hud-accent);
}
.${HUD_ROOT_CLASS} .hud-warn { color: var(--hud-warn); }
.${HUD_ROOT_CLASS} .hud-danger { color: var(--hud-danger); }
.${HUD_ROOT_CLASS} .hud-positive { color: var(--hud-positive); }
.${HUD_ROOT_CLASS} svg { display: block; }
@media (prefers-reduced-motion: reduce) {
  .${HUD_ROOT_CLASS} * {
    transition: none !important;
    animation: none !important;
  }
}
@media (prefers-reduced-motion: no-preference) {
  .${HUD_ROOT_CLASS} .hud-needle,
  .${HUD_ROOT_CLASS} .hud-card {
    transition: transform 120ms linear;
  }
}
`;
