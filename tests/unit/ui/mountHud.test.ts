/**
 * `ensureHudStyles` idempotency test. There is no jsdom in this project, so we
 * inject a minimal fake `Document` that models only the DOM surface the function
 * uses (`getElementById`, `createElement`, `head.appendChild`). This verifies the
 * stylesheet is injected exactly once and carries the HUD CSS, without a browser.
 */

import { describe, it, expect } from 'vitest';
import { ensureHudStyles } from '@/ui/hud/mountHud';
import { HUD_STYLE_ELEMENT_ID, HUD_CSS } from '@/ui/hud/hudStyles';

interface FakeEl {
  id: string;
  textContent: string;
}

function makeFakeDocument(): { doc: Document; styles: FakeEl[] } {
  const styles: FakeEl[] = [];
  const byId = new Map<string, FakeEl>();
  const doc = {
    getElementById(id: string): FakeEl | null {
      return byId.get(id) ?? null;
    },
    createElement(_tag: string): FakeEl {
      return { id: '', textContent: '' };
    },
    head: {
      appendChild(el: FakeEl): void {
        styles.push(el);
        if (el.id !== '') byId.set(el.id, el);
      },
    },
  } as unknown as Document;
  return { doc, styles };
}

describe('ensureHudStyles', () => {
  it('injects a single <style> element carrying the HUD CSS', () => {
    const { doc, styles } = makeFakeDocument();
    ensureHudStyles(doc);
    expect(styles).toHaveLength(1);
    expect(styles[0]?.id).toBe(HUD_STYLE_ELEMENT_ID);
    expect(styles[0]?.textContent).toBe(HUD_CSS);
  });

  it('is idempotent — a second call does not inject again', () => {
    const { doc, styles } = makeFakeDocument();
    ensureHudStyles(doc);
    ensureHudStyles(doc);
    ensureHudStyles(doc);
    expect(styles).toHaveLength(1);
  });
});
