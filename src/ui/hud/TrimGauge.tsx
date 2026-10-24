/**
 * TrimGauge — mainsheet / jib / traveller / board positions plus per-sail
 * attachment and luff indicators from the physics `SailAeroState` (when exposed).
 *
 * Bipolar controls (traveller, rudder) centre at zero; unipolar (sheets, board)
 * fill from zero. A luffing sail is shown with the visible word "LUFF" — not just
 * a colour — satisfying the no-colour-only rule.
 */

import type { ReactNode } from 'react';
import type { TrimViewModel } from '@game/hud';
import { Panel } from './Panel';

/** A horizontal fill bar, 0..1 (unipolar) or −1..1 (bipolar). */
function TrimBar(props: { label: string; value: number; bipolar?: boolean }): ReactNode {
  const { label, value, bipolar } = props;
  const pct = bipolar ? ((value + 1) / 2) * 100 : Math.max(0, Math.min(1, value)) * 100;
  const valueText = bipolar
    ? `${value >= 0 ? '+' : ''}${Math.round(value * 100)}`
    : `${Math.round(value * 100)}%`;
  return (
    <div className="hud-row">
      <span className="hud-label">{label}</span>
      <div
        className="hud-bar"
        style={{ width: 70 }}
        role="progressbar"
        aria-label={`${label} ${valueText}`}
        aria-valuenow={Math.round(bipolar ? value * 100 : pct)}
        aria-valuemin={bipolar ? -100 : 0}
        aria-valuemax={100}
      >
        <span style={{ width: `${pct}%` }} />
      </div>
      <span className="hud-value" style={{ fontSize: 12, minWidth: 34 }}>
        {valueText}
      </span>
    </div>
  );
}

export interface TrimGaugeProps {
  trim: TrimViewModel;
}

export function TrimGauge({ trim }: TrimGaugeProps): ReactNode {
  return (
    <Panel className="hud-trim" ariaLabel="Trim">
      <span className="hud-label">Trim</span>
      <TrimBar label="Main" value={trim.mainsheet} />
      <TrimBar label="Jib" value={trim.jibsheet} />
      <TrimBar label="Trav" value={trim.traveller} bipolar />
      <TrimBar label="Board" value={trim.board} />
      {trim.sails.length > 0 ? (
        <ul className="hud-label" style={{ listStyle: 'none', margin: '4px 0 0', padding: 0 }}>
          {trim.sails.map((s) => (
            <li key={s.sailId} className="hud-row">
              <span>{s.sailId}</span>
              <span
                className={s.luffing ? 'hud-warn' : 'hud-positive'}
                aria-label={
                  s.luffing
                    ? `${s.sailId} luffing`
                    : `${s.sailId} attached ${Math.round(s.attachment * 100)} percent`
                }
              >
                {s.luffing ? 'LUFF' : `${Math.round(s.attachment * 100)}% set`}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </Panel>
  );
}
