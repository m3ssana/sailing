/**
 * HUD UI layer — React components + the vanilla Zustand store + the DOM mount
 * entry. The render loop publishes view models (built by `@game/hud`) into the
 * store; React renders them. React never touches the render loop.
 */

export * from './hudStyles';
export * from './hudStore';
export { Panel, Readout, sourceLabel } from './Panel';
export { WindIndicator } from './WindIndicator';
export { SpeedPanel } from './SpeedPanel';
export { TrimGauge } from './TrimGauge';
export { HeelHelmGauge } from './HeelHelmGauge';
export { CompassPanel } from './CompassPanel';
export { ConditionsPanel } from './ConditionsPanel';
export { CoachingBanner } from './CoachingBanner';
export { HudRoot, HudRootConnected } from './HudRoot';
export { mountHud, ensureHudStyles } from './mountHud';
export type { MountedHud } from './mountHud';
