/**
 * WindIndicator — a radial wind instrument (art-direction §8.5: gauges are
 * circular arcs, not bars). Shows the apparent and true wind arrows relative to
 * the bow, the tack-angle laylines, numeric AWA/AWS and TWA/TWS, and the point of
 * sail.
 *
 * Accessibility: the SVG is `role="img"` with an aria-label text alternative
 * carrying the same numbers a sighted player reads, and the numerics are also
 * rendered as visible text (never colour-only).
 */

import type { ReactNode } from 'react';
import { UNITS } from '@/types/units';
import type { WindViewModel } from '@game/hud';
import {
  formatRelativeAngle,
  formatSpeed,
  type HudStrings,
} from '@game/hud';
import type { UnitSystem } from '@game/hud';
import { Panel, Readout } from './Panel';

const R = 46;
const CX = 56;
const CY = 56;

/** Convert a signed angle-off-bow (radians, +stbd) to an SVG point on the dial. */
function dialPoint(angleRad: number, radius: number): { x: number; y: number } {
  // Bow is up (−y in SVG). +angle (starboard) rotates clockwise to the right.
  return {
    x: CX + radius * Math.sin(angleRad),
    y: CY - radius * Math.cos(angleRad),
  };
}

export interface WindIndicatorProps {
  wind: WindViewModel;
  units: UnitSystem;
  strings: HudStrings;
}

export function WindIndicator({ wind, units, strings }: WindIndicatorProps): ReactNode {
  const app = dialPoint(wind.apparentAngle, R - 6);
  const tru = dialPoint(wind.trueAngle, R - 16);
  // Laylines are compass bearings; show them relative to the bow is not needed —
  // the dial is boat-relative, so draw the tack-angle wedge off dead-ahead.
  const portLay = dialPoint(-wind.tackAngle, R);
  const stbdLay = dialPoint(wind.tackAngle, R);

  const label =
    `Wind. Apparent ${formatSpeed(wind.apparentSpeed, units)} at ` +
    `${formatRelativeAngle(wind.apparentAngle)}. ` +
    `True ${formatSpeed(wind.trueSpeed, units)} at ${formatRelativeAngle(wind.trueAngle)}. ` +
    `Point of sail ${wind.pointOfSail}, ${wind.tack} tack.`;

  return (
    <Panel className="hud-wind" ariaLabel="Wind indicator">
      <span className="hud-label">Wind · {wind.pointOfSail}</span>
      <svg
        width={112}
        height={112}
        viewBox="0 0 112 112"
        role="img"
        aria-label={label}
      >
        {/* Dial ring */}
        <circle cx={CX} cy={CY} r={R} fill="none" stroke="var(--hud-border)" strokeWidth={1} />
        {/* Bow lubber line (fixed, pointing up) */}
        <line x1={CX} y1={CY} x2={CX} y2={CY - R} stroke="var(--hud-text-dim)" strokeWidth={1} />
        {/* Tack-angle laylines */}
        <line
          x1={CX}
          y1={CY}
          x2={portLay.x}
          y2={portLay.y}
          stroke="var(--hud-accent)"
          strokeWidth={1}
          strokeDasharray="3 3"
        />
        <line
          x1={CX}
          y1={CY}
          x2={stbdLay.x}
          y2={stbdLay.y}
          stroke="var(--hud-accent)"
          strokeWidth={1}
          strokeDasharray="3 3"
        />
        {/* True wind arrow */}
        <line
          className="hud-needle"
          x1={CX}
          y1={CY}
          x2={tru.x}
          y2={tru.y}
          stroke="var(--hud-twind)"
          strokeWidth={2}
        />
        {/* Apparent wind arrow */}
        <line
          className="hud-needle"
          x1={CX}
          y1={CY}
          x2={app.x}
          y2={app.y}
          stroke="var(--hud-awind)"
          strokeWidth={2}
        />
      </svg>
      <Readout label="AWA" value={formatRelativeAngle(wind.apparentAngle)} />
      <Readout label="AWS" value={strings.apparentWind} />
      <Readout label="TWA" value={formatRelativeAngle(wind.trueAngle)} />
      <Readout label="TWS" value={strings.trueWind} />
      <Readout
        label="Tack angle"
        value={`${Math.round(wind.tackAngle * UNITS.RAD_TO_DEG)}°`}
      />
    </Panel>
  );
}
