/**
 * SpeedPanel — SOG, upwind/downwind VMG, and target-speed percentage of polar.
 * Target fraction is shown as both a bar and a visible percentage (never
 * colour-only); the tone shifts to positive/warn purely as a redundant cue.
 */

import type { ReactNode } from 'react';
import type { SpeedViewModel, UnitSystem, HudStrings } from '@game/hud';
import { formatSpeed } from '@game/hud';
import { Panel, Readout } from './Panel';

export interface SpeedPanelProps {
  speed: SpeedViewModel;
  units: UnitSystem;
  strings: HudStrings;
}

export function SpeedPanel({ speed, units, strings }: SpeedPanelProps): ReactNode {
  const pct = speed.targetFraction;
  const pctClamped = Math.max(0, Math.min(1.2, pct));
  const tone: 'positive' | 'warn' | 'default' =
    pct >= 0.95 ? 'positive' : pct < 0.75 ? 'warn' : 'default';
  // Upwind VMG is the meaningful figure upwind; show the one with larger
  // magnitude but always label both so the player isn't guessing.
  const label =
    `Speed over ground ${strings.sog}. ` +
    `Upwind VMG ${strings.vmgUpwind}, downwind VMG ${strings.vmgDownwind}. ` +
    `Target ${strings.targetFraction} of polar.`;

  return (
    <Panel className="hud-speed" ariaLabel="Speed and VMG">
      <div role="img" aria-label={label}>
        <Readout label="SOG" value={formatSpeed(speed.sog, units, 1)} />
        <Readout label="VMG ↑" value={formatSpeed(speed.vmgUpwind, units, 1)} />
        <Readout label="VMG ↓" value={formatSpeed(speed.vmgDownwind, units, 1)} />
        <Readout label="Target" value={formatSpeed(speed.target, units, 1)} />
        <Readout label="% polar" value={strings.targetFraction} tone={tone} />
        <div
          className="hud-bar"
          role="progressbar"
          aria-label="Percentage of polar target speed"
          aria-valuenow={Math.round(pct * 100)}
          aria-valuemin={0}
          aria-valuemax={120}
        >
          <span style={{ width: `${(pctClamped / 1.2) * 100}%` }} />
        </div>
      </div>
    </Panel>
  );
}
