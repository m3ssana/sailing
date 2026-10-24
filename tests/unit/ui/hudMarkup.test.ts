/**
 * Component markup tests. Vitest runs in the `node` environment and there is no
 * jsdom/testing-library, so we render components to a static HTML string with
 * `react-dom/server` and assert on the markup: aria labels present, 'SIMULATED'
 * shown only in sandbox, widgets hidden per preset, opaque-backdrop class, and
 * the data-source label.
 */

import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildHudViewModel } from '@game/hud';
import type { HudInput, HudPreset } from '@game/hud';
import { HudRoot } from '@/ui/hud/HudRoot';
import { HUD_OPAQUE_CLASS } from '@/ui/hud/hudStyles';
import { strings } from '@/ui/strings';
import type { WeatherSource } from '@/types/weather';

const DEG = Math.PI / 180;

function baseInput(overrides: Partial<HudInput> = {}): HudInput {
  const input: HudInput = {
    boat: {
      heading: 45 * DEG,
      heel: 12 * DEG,
      pitch: 1 * DEG,
      speed: 3,
      helmLoad: 0.4,
      capsized: false,
      position: { x: 0, y: 0, z: 0 },
    },
    controls: { mainsheet: 0.7, jibsheet: 0.6, traveller: -0.2, board: 1, rudder: 0.1, vang: 0.5 },
    trueWind: { speed: 6, fromBearing: 0 },
    apparentWind: { speed: 9, angle: 30 * DEG },
    courseOverGround: 45 * DEG,
    speedOverGround: 3,
    weatherSource: 'live',
    visibility: 15000,
    current: { speed: 0.4, towardsBearing: 340 * DEG },
    targetSpeed: () => 4,
    nextMark: { id: 'windward', position: { x: 0, y: -500 } },
    sails: [{ sailId: 'main', attachment: 0.9, luffing: false }],
    coaching: { id: 'pinch', message: 'Bear away 5 degrees', severity: 0.6 },
    preset: 'full',
    units: 'knotsNm',
    opaqueBackdrop: false,
  };
  return { ...input, ...overrides };
}

function render(input: HudInput): string {
  const vm = buildHudViewModel(input);
  return renderToStaticMarkup(createElement(HudRoot, { vm }));
}

describe('HudRoot markup — full preset', () => {
  const html = render(baseInput());

  it('renders all panel aria regions', () => {
    for (const label of [
      'Wind indicator',
      'Speed and VMG',
      'Trim',
      'Heel and helm load',
      'Course compass',
      'Conditions',
      'Coaching tips',
    ]) {
      expect(html).toContain(`aria-label="${label}"`);
    }
  });

  it('exposes SVG instruments as role="img" with text alternatives', () => {
    expect(html).toContain('role="img"');
    expect(html).toMatch(/aria-label="Wind\. Apparent/);
    expect(html).toMatch(/aria-label="Compass\. Heading/);
  });

  it('shows the coaching message text (not colour-only)', () => {
    expect(html).toContain('Bear away 5 degrees');
  });

  it('shows maritime abbreviations as visible text', () => {
    expect(html).toContain('SOG');
    expect(html).toContain('VMG');
    expect(html).toContain('HDG');
    expect(html).toContain('TWA');
  });
});

describe('data-source label and SIMULATED badge', () => {
  const sources: WeatherSource[] = ['live', 'cache', 'climatology', 'default', 'sandbox'];

  for (const source of sources) {
    it(`${source}: shows its localized source label`, () => {
      const html = render(baseInput({ weatherSource: source }));
      expect(html).toContain(strings.weather.sourceLabels[source]);
    });
  }

  it('shows SIMULATED only for sandbox', () => {
    const sandbox = render(baseInput({ weatherSource: 'sandbox' }));
    expect(sandbox).toContain('SIMULATED');
    for (const source of ['live', 'cache', 'climatology', 'default'] as WeatherSource[]) {
      const html = render(baseInput({ weatherSource: source }));
      expect(html).not.toContain('SIMULATED');
    }
  });
});

describe('preset visibility', () => {
  function panelCount(preset: HudPreset): number {
    const html = render(baseInput({ preset }));
    return (html.match(/class="hud-panel/g) ?? []).length;
  }

  it('none renders no panels', () => {
    const html = render(baseInput({ preset: 'none' }));
    expect(html).not.toContain('hud-panel');
  });

  it('minimal renders only wind + speed', () => {
    const html = render(baseInput({ preset: 'minimal' }));
    expect(html).toContain('aria-label="Wind indicator"');
    expect(html).toContain('aria-label="Speed and VMG"');
    expect(html).not.toContain('aria-label="Course compass"');
    expect(html).not.toContain('aria-label="Trim"');
    expect(html).not.toContain('aria-label="Conditions"');
  });

  it('panel count is monotone decreasing full ≥ moderate ≥ minimal ≥ none', () => {
    const full = panelCount('full');
    const moderate = panelCount('moderate');
    const minimal = panelCount('minimal');
    const none = panelCount('none');
    expect(full).toBeGreaterThanOrEqual(moderate);
    expect(moderate).toBeGreaterThanOrEqual(minimal);
    expect(minimal).toBeGreaterThanOrEqual(none);
    expect(none).toBe(0);
    expect(full).toBe(7);
  });
});

describe('opaque backdrop option', () => {
  it('adds the opaque class only when enabled', () => {
    const off = render(baseInput({ opaqueBackdrop: false }));
    expect(off).not.toContain(HUD_OPAQUE_CLASS);
    const on = render(baseInput({ opaqueBackdrop: true }));
    expect(on).toContain(HUD_OPAQUE_CLASS);
  });
});

describe('trim gauge luff indicator', () => {
  it('shows LUFF text (not colour-only) when a sail is luffing', () => {
    const html = render(
      baseInput({ sails: [{ sailId: 'main', attachment: 0.1, luffing: true }] }),
    );
    expect(html).toContain('LUFF');
  });

  it('shows percent-set when attached', () => {
    const html = render(baseInput({ sails: [{ sailId: 'main', attachment: 0.9, luffing: false }] }));
    expect(html).toContain('% set');
  });
});

describe('capsize warning', () => {
  it('shows CAPSIZED text when capsized', () => {
    const html = render(baseInput({ boat: { ...baseInput().boat, capsized: true } }));
    expect(html).toContain('CAPSIZED');
  });
});
