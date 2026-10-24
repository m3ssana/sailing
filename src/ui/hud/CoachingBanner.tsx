/**
 * CoachingBanner — surfaces a single CoachingHint (requirement 6.10). Severity
 * drives prominence (tone) but the message text always carries the information;
 * severity never changes WHAT is said, only how it's emphasised (no colour-only).
 *
 * Uses an aria-live polite region so a newly surfaced hint is announced without
 * stealing focus.
 */

import type { ReactNode } from 'react';
import type { CoachingViewModel } from '@game/hud';
import { Panel } from './Panel';

export interface CoachingBannerProps {
  coaching: CoachingViewModel | null;
}

export function CoachingBanner({ coaching }: CoachingBannerProps): ReactNode {
  const tone = coaching === null ? '' : coaching.severity >= 0.66 ? 'hud-danger' : coaching.severity >= 0.33 ? 'hud-warn' : '';
  return (
    <Panel className="hud-coaching" ariaLabel="Coaching tips">
      <div aria-live="polite">
        <span className="hud-label">Coaching</span>
        {coaching === null ? (
          <div className="hud-value" style={{ fontSize: 13, color: 'var(--hud-text-dim)' }}>
            —
          </div>
        ) : (
          <div className={`hud-value ${tone}`} style={{ fontSize: 13, textAlign: 'left' }}>
            {coaching.message}
          </div>
        )}
      </div>
    </Panel>
  );
}
