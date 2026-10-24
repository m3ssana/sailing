/**
 * HudRoot — composes the HUD widgets, applying the density preset's visibility
 * table and the opaque-backdrop accessibility option.
 *
 * Two forms:
 * - {@link HudRoot}: PURE — takes a view model as a prop. Renders nothing React-
 *   stateful, so it is trivially testable via `renderToStaticMarkup`.
 * - {@link HudRootConnected}: binds to a {@link HudStore} with zustand's `useStore`
 *   hook and renders `HudRoot` from the store's current view model. React only
 *   ever READS the store the render loop publishes into — it never touches the
 *   render loop (the architectural rule).
 */

import type { ReactNode } from 'react';
import { useStore } from 'zustand';
import type { HudViewModel } from '@game/hud';
import { formatHud } from '@game/hud';
import type { HudStore } from './hudStore';
import { HUD_OPAQUE_CLASS, HUD_ROOT_CLASS } from './hudStyles';
import { WindIndicator } from './WindIndicator';
import { SpeedPanel } from './SpeedPanel';
import { TrimGauge } from './TrimGauge';
import { HeelHelmGauge } from './HeelHelmGauge';
import { CompassPanel } from './CompassPanel';
import { ConditionsPanel } from './ConditionsPanel';
import { CoachingBanner } from './CoachingBanner';

export interface HudRootProps {
  vm: HudViewModel;
}

/** Pure HUD composition from a view model. */
export function HudRoot({ vm }: HudRootProps): ReactNode {
  const strings = formatHud(vm);
  const rootClass = `${HUD_ROOT_CLASS}${vm.opaqueBackdrop ? ` ${HUD_OPAQUE_CLASS}` : ''}`;
  return (
    <div className={rootClass} aria-label="Sailing instruments">
      {vm.visible.wind ? <WindIndicator wind={vm.wind} units={vm.units} strings={strings} /> : null}
      {vm.visible.speed ? <SpeedPanel speed={vm.speed} units={vm.units} strings={strings} /> : null}
      {vm.visible.trim ? <TrimGauge trim={vm.trim} /> : null}
      {vm.visible.heelHelm ? <HeelHelmGauge heelHelm={vm.heelHelm} /> : null}
      {vm.visible.compass ? <CompassPanel compass={vm.compass} strings={strings} /> : null}
      {vm.visible.conditions ? (
        <ConditionsPanel conditions={vm.conditions} units={vm.units} strings={strings} />
      ) : null}
      {vm.visible.coaching ? <CoachingBanner coaching={vm.coaching} /> : null}
    </div>
  );
}

export interface HudRootConnectedProps {
  store: HudStore;
}

/** Store-bound HUD. Renders nothing until the first view model is published. */
export function HudRootConnected({ store }: HudRootConnectedProps): ReactNode {
  const vm = useStore(store, (s) => s.vm);
  if (vm === null) return null;
  return <HudRoot vm={vm} />;
}
