/**
 * ConditionsPanel — the live environment readout with the all-important
 * DATA-SOURCE LABEL (requirement 2.6): the player always knows whether the
 * conditions are live, cached, climatology, a safe default, or sandbox
 * ("SIMULATED"). The source word comes from the shared string table so it is
 * localizable; the sandbox case additionally shows a prominent 'SIMULATED' badge.
 *
 * Wind is labelled "from" and current "towards" — the deliberate asymmetric
 * convention is made explicit in the UI so a player is never misled.
 */

import type { ReactNode } from 'react';
import type { ConditionsViewModel, HudStrings, UnitSystem } from '@game/hud';
import { formatBearing, formatDistance, formatSpeed } from '@game/hud';
import { Panel, Readout, sourceLabel } from './Panel';

export interface ConditionsPanelProps {
  conditions: ConditionsViewModel;
  units: UnitSystem;
  strings: HudStrings;
}

export function ConditionsPanel({ conditions, units }: ConditionsPanelProps): ReactNode {
  const src = sourceLabel(conditions.source);
  const label =
    `Conditions. Source: ${src}${conditions.simulated ? ' (simulated)' : ''}. ` +
    `True wind ${formatSpeed(conditions.trueWindSpeed, units)} from ${formatBearing(conditions.trueWindFrom)}. ` +
    `Current ${formatSpeed(conditions.currentSpeed, units)} towards ${formatBearing(conditions.currentTowards)}. ` +
    `Visibility ${formatDistance(conditions.visibility)}.`;

  return (
    <Panel className="hud-conditions" ariaLabel="Conditions">
      <div role="img" aria-label={label}>
        <div className="hud-row">
          <span className="hud-label">Source</span>
          <span className="hud-value" style={{ fontSize: 12 }} data-source={conditions.source}>
            {src}
          </span>
        </div>
        {conditions.simulated ? (
          <div style={{ margin: '2px 0 6px' }}>
            <span className="hud-badge" aria-label="Simulated conditions">
              SIMULATED
            </span>
          </div>
        ) : null}
        <Readout label="TWS" value={formatSpeed(conditions.trueWindSpeed, units)} />
        <Readout label="Wind from" value={formatBearing(conditions.trueWindFrom)} />
        <Readout label="Current" value={formatSpeed(conditions.currentSpeed, units)} />
        <Readout label="Set (to)" value={formatBearing(conditions.currentTowards)} />
        <Readout label="Vis" value={formatDistance(conditions.visibility)} />
      </div>
    </Panel>
  );
}
