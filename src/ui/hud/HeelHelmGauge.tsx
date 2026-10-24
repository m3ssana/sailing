/**
 * HeelHelmGauge — heel angle (with a capsize warning), pitch, and normalized
 * helm load. Heel reads in degrees with a port/starboard sense; helm load as a
 * bar plus a percentage. A capsize shows the visible word "CAPSIZED".
 */

import type { ReactNode } from 'react';
import { UNITS } from '@/types/units';
import type { HeelHelmViewModel } from '@game/hud';
import { Panel, Readout } from './Panel';

export interface HeelHelmGaugeProps {
  heelHelm: HeelHelmViewModel;
}

function heelText(heelRad: number): string {
  const deg = Math.round(Math.abs(heelRad) * UNITS.RAD_TO_DEG);
  if (deg === 0) return '0° level';
  return `${deg}° ${heelRad >= 0 ? 'stbd' : 'port'}`;
}

export function HeelHelmGauge({ heelHelm }: HeelHelmGaugeProps): ReactNode {
  const heelDeg = Math.abs(heelHelm.heel * UNITS.RAD_TO_DEG);
  const heelTone = heelHelm.capsized ? 'danger' : heelDeg > 25 ? 'warn' : 'default';
  const helmPct = Math.round(heelHelm.helmLoad * 100);
  const label =
    `Heel ${heelText(heelHelm.heel)}. Helm load ${helmPct} percent.` +
    (heelHelm.capsized ? ' Capsized.' : '');

  return (
    <Panel className="hud-heelhelm" ariaLabel="Heel and helm load">
      <div role="img" aria-label={label}>
        <Readout label="Heel" value={heelText(heelHelm.heel)} tone={heelTone} />
        <Readout
          label="Pitch"
          value={`${Math.round(heelHelm.pitch * UNITS.RAD_TO_DEG)}°`}
        />
        <Readout label="Helm" value={`${helmPct}%`} tone={helmPct > 80 ? 'warn' : 'default'} />
        <div
          className="hud-bar"
          role="progressbar"
          aria-label="Helm load"
          aria-valuenow={helmPct}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <span style={{ width: `${helmPct}%` }} />
        </div>
        {heelHelm.capsized ? (
          <div className="hud-danger" style={{ fontWeight: 600, marginTop: 4 }}>
            CAPSIZED
          </div>
        ) : null}
      </div>
    </Panel>
  );
}
