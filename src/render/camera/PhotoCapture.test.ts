import { describe, expect, it } from 'vitest';
import { capturePhoto, type BlobCapableCanvas } from './PhotoCapture';

/** A fake canvas whose toBlob returns a blob with the requested type. */
function fakeCanvas(behaviour: 'ok' | 'null'): BlobCapableCanvas {
  return {
    toBlob(cb: (blob: Blob | null) => void, type?: string): void {
      if (behaviour === 'null') {
        cb(null);
        return;
      }
      // Construct a tiny blob tagged with the requested type.
      cb(new Blob([new Uint8Array([1, 2, 3])], { type: type ?? 'image/png' }));
    },
  };
}

describe('capturePhoto', () => {
  it('resolves to a PNG blob by default', async () => {
    const blob = await capturePhoto(fakeCanvas('ok'));
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe('image/png');
    expect(blob.size).toBeGreaterThan(0);
  });

  it('honours a lossy type + quality', async () => {
    let seenType: string | undefined;
    let seenQuality: number | undefined;
    const canvas: BlobCapableCanvas = {
      toBlob(cb, type, quality) {
        seenType = type;
        seenQuality = quality;
        cb(new Blob([], { type: type ?? 'image/png' }));
      },
    };
    const blob = await capturePhoto(canvas, { type: 'image/jpeg', quality: 0.8 });
    expect(blob.type).toBe('image/jpeg');
    expect(seenType).toBe('image/jpeg');
    expect(seenQuality).toBe(0.8);
  });

  it('rejects when the environment lacks toBlob', async () => {
    // A canvas-like object with no toBlob (e.g. server / old runtime).
    const noBlob = {} as unknown as BlobCapableCanvas;
    await expect(capturePhoto(noBlob)).rejects.toThrow(/toBlob is not available/);
  });

  it('rejects when toBlob yields null (encode failure)', async () => {
    await expect(capturePhoto(fakeCanvas('null'))).rejects.toThrow(/returned null/);
  });
});
