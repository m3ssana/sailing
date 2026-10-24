/**
 * CompassPanel — a traditional rotating compass card (art-direction §8.5: "a
 * rotating card, fixed lubber line, not a digital readout") plus heading, COG,
 * and the bearing/distance to the next mark.
 *
 * The card rotates so the boat's heading sits under the fixed lubber line at the
 * top. Cardinal letters are drawn on the card so a screen-reader-independent
 * sighted player reads direction; the numeric HDG is also shown as text.
 */

import type { ReactNode } from 'react';
import type { CompassViewModel, HudStrings } from '@game/hud';
import { Panel, Readout } from './Panel';

const CX = 48;
const CY = 48;
const R = 40;

const CARDINALS: readonly { label: string; deg: number }[] = [
  { label: 'N', deg: 0 },
  { label: 'E', deg: 90 },
  { label: 'S', deg: 180 },
  { label: 'W', deg: 270 },
];

export interface CompassPanelProps {
  compass: CompassViewModel;
  strings: HudStrings;
}

export function CompassPanel({ compass, strings }: CompassPanelProps): ReactNode {
  const headingDeg = (compass.heading * 180) / Math.PI;
  // Rotate the card opposite to heading so the heading sits under the lubber line.
  const cardRotate = -headingDeg;

  const markLine =
    compass.bearingToMark !== null && strings.distanceToMark !== null
      ? ` Next mark ${compass.markId ?? ''} bearing ${strings.bearingToMark ?? ''}, ${strings.distanceToMark}.`
      : ' No active mark.';
  const label = `Compass. Heading ${strings.heading}. Course over ground ${strings.cog}.${markLine}`;

  return (
    <Panel className="hud-compass" ariaLabel="Course compass">
      <span className="hud-label">Compass</span>
      <svg width={96} height={96} viewBox="0 0 96 96" role="img" aria-label={label}>
        {/* Fixed lubber line at the top. */}
        <line x1={CX} y1={CY - R - 3} x2={CX} y2={CY - R + 6} stroke="var(--hud-accent)" strokeWidth={2} />
        <circle cx={CX} cy={CY} r={R} fill="none" stroke="var(--hud-border)" strokeWidth={1} />
        {/* Rotating card. */}
        <g className="hud-card" transform={`rotate(${cardRotate} ${CX} ${CY})`}>
          {CARDINALS.map((c) => {
            const rad = (c.deg * Math.PI) / 180;
            const x = CX + (R - 10) * Math.sin(rad);
            const y = CY - (R - 10) * Math.cos(rad);
            return (
              <text
                key={c.label}
                x={x}
                y={y + 3}
                textAnchor="middle"
                fontSize={9}
                fill="var(--hud-text)"
                fontFamily="var(--hud-mono)"
              >
                {c.label}
              </text>
            );
          })}
        </g>
      </svg>
      <Readout label="HDG" value={strings.heading} />
      <Readout label="COG" value={strings.cog} />
      {compass.bearingToMark !== null && strings.bearingToMark !== null ? (
        <>
          <Readout label={`BRG ${compass.markId ?? ''}`.trim()} value={strings.bearingToMark} />
          {strings.distanceToMark !== null ? (
            <Readout label="DTM" value={strings.distanceToMark} />
          ) : null}
        </>
      ) : null}
    </Panel>
  );
}
