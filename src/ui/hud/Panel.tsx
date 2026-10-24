/**
 * Shared HUD UI primitives. Flat high-contrast panels per art-direction §8.3.
 */

import type { ReactNode } from 'react';
import type { WeatherSource } from '@/types/weather';
import { strings } from '@/ui/strings';

/** Props shared by every HUD panel. */
export interface PanelProps {
  /** Extra class identifying the panel's grid slot (e.g. 'hud-wind'). */
  className: string;
  /** Accessible label for the panel region. */
  ariaLabel: string;
  children: ReactNode;
}

/**
 * A flat instrument panel: solid backdrop, 1px wire border, no shadow. Exposed as
 * a `region` with an aria-label so each panel is a named landmark for screen
 * readers.
 */
export function Panel({ className, ariaLabel, children }: PanelProps): ReactNode {
  return (
    <section className={`hud-panel ${className}`} role="region" aria-label={ariaLabel}>
      {children}
    </section>
  );
}

/**
 * A labelled numeric readout: uppercase label + right-aligned monospace value +
 * smaller muted unit. The visible text is the information — never colour alone
 * (WCAG AA, art-direction §8.4).
 */
export function Readout(props: {
  label: string;
  value: string;
  unit?: string;
  tone?: 'default' | 'warn' | 'danger' | 'positive';
}): ReactNode {
  const toneClass =
    props.tone === 'warn'
      ? 'hud-warn'
      : props.tone === 'danger'
        ? 'hud-danger'
        : props.tone === 'positive'
          ? 'hud-positive'
          : '';
  return (
    <div className="hud-row">
      <span className="hud-label">{props.label}</span>
      <span className={`hud-value ${toneClass}`}>
        {props.value}
        {props.unit !== undefined ? <span className="hud-unit">{props.unit}</span> : null}
      </span>
    </div>
  );
}

/** Localized, human-readable weather-source label from the shared string table. */
export function sourceLabel(source: WeatherSource): string {
  return strings.weather.sourceLabels[source];
}
