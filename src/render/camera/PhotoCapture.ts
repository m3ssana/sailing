/**
 * PhotoCapture (H.4) — DOM-side canvas snapshot for photo mode.
 *
 * The pure photo model (`src/game/camera/photo.ts`) produces a `CaptureRequest`;
 * this module performs the actual pixel grab from the WebGPU/WebGL canvas. It
 * lives in the render layer because it touches the DOM (`HTMLCanvasElement`).
 *
 * `capturePhoto(canvas)` resolves to a PNG `Blob`. It is guarded for
 * environments where `toBlob` is unavailable (older canvases, server/test
 * environments), where it rejects with a clear error rather than throwing
 * synchronously — so a caller can fall back to `toDataURL` or surface a message.
 *
 * ## Capturing the rendered frame
 *
 * `toBlob` reads the canvas backing store. For a WebGL/WebGPU canvas this
 * requires `preserveDrawingBuffer: true` OR capturing within the same frame as
 * the draw (before the buffer is cleared). The caller is responsible for timing
 * the call correctly (e.g. right after `renderer.render(...)` in the photo-mode
 * frame); this helper only performs the read.
 */

/** Minimal structural type so this is testable with a fake canvas. */
export interface BlobCapableCanvas {
  toBlob(callback: (blob: Blob | null) => void, type?: string, quality?: number): void;
}

/** Options for a capture. */
export interface CapturePhotoOptions {
  /** MIME type. Defaults to 'image/png' (lossless, no quality arg). */
  type?: string;
  /** Quality 0..1 for lossy types ('image/jpeg', 'image/webp'). Ignored for PNG. */
  quality?: number;
}

/**
 * Snapshot a canvas to a `Blob`. Resolves with the blob, rejects when the
 * environment lacks `toBlob` or the encode fails (returns null).
 */
export function capturePhoto(
  canvas: BlobCapableCanvas,
  options: CapturePhotoOptions = {},
): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    if (typeof canvas.toBlob !== 'function') {
      reject(
        new Error(
          'capturePhoto: canvas.toBlob is not available in this environment; ' +
            'fall back to toDataURL or a manual readPixels encode.',
        ),
      );
      return;
    }
    const type = options.type ?? 'image/png';
    const done = (blob: Blob | null): void => {
      if (blob === null) {
        reject(new Error(`capturePhoto: toBlob returned null for type "${type}".`));
        return;
      }
      resolve(blob);
    };
    // PNG ignores the quality argument; pass it only for lossy types.
    if (options.quality !== undefined && type !== 'image/png') {
      canvas.toBlob(done, type, options.quality);
    } else {
      canvas.toBlob(done, type);
    }
  });
}
