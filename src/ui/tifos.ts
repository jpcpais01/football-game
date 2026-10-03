/**
 * The club's tifos: pictures the player uploads for the giant hanging tifo, the home end's
 * card display and the fan banner held up on poles. Each is cropped to its own shape,
 * shrunk, and kept on this device. Without one, the ground paints the club's own design
 * (the fan banner just isn't there).
 */

export type TifoKind = 'giant' | 'end' | 'fan';

export const TIFOS: { id: TifoKind; name: string; about: string; w: number; h: number; key: string }[] = [
  { id: 'giant', name: 'Giant tifo', about: 'Dropped from the main stand roof before kick-off (big stadium)', w: 432, h: 512, key: 'tifoGiant' },
  { id: 'end', name: 'Home end tifo', about: 'The card display behind the home goal at each kick-off', w: 512, h: 160, key: 'tifoEnd' },
  { id: 'fan', name: 'Fan banner', about: 'A banner the fans hold up on poles, every match', w: 640, h: 320, key: 'fanBanner' },
];

const spec = (k: TifoKind) => TIFOS.find((t) => t.id === k)!;

/** Crop-to-fill a source image into the tifo's shape. */
function toCanvas(k: TifoKind, src: CanvasImageSource, sw: number, sh: number): HTMLCanvasElement {
  const { w: W, h: H } = spec(k);
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const s = Math.max(W / sw, H / sh);
  const dw = sw * s;
  const dh = sh * s;
  cv.getContext('2d')!.drawImage(src, (W - dw) / 2, (H - dh) / 2, dw, dh);
  return cv;
}

async function decode(k: TifoKind, file: Blob): Promise<HTMLCanvasElement> {
  if ('createImageBitmap' in window) {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
      const cv = toCanvas(k, bmp, bmp.width, bmp.height);
      bmp.close();
      return cv;
    } catch {
      /* fall back to <img> */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return toCanvas(k, img, img.naturalWidth, img.naturalHeight);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** The saved picture as a data URL (for previews), if any. */
export function storedTifo(k: TifoKind): string | null {
  try {
    return localStorage.getItem(spec(k).key);
  } catch {
    return null;
  }
}

/** The saved picture, if any. */
export async function loadTifo(k: TifoKind): Promise<HTMLCanvasElement | null> {
  const data = storedTifo(k);
  if (!data) return null;
  try {
    return await decode(k, await (await fetch(data)).blob());
  } catch {
    return null;
  }
}

/** Opens the photo picker; resolves with the new picture (saved), or null if cancelled. */
export function pickTifo(k: TifoKind): Promise<HTMLCanvasElement | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      try {
        const cv = await decode(k, file);
        try {
          localStorage.setItem(spec(k).key, cv.toDataURL('image/jpeg', 0.85));
        } catch {
          /* storage full or blocked: still use it for this session */
        }
        resolve(cv);
      } catch {
        resolve(null);
      }
    });
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
}

export function clearTifo(k: TifoKind): void {
  try {
    localStorage.removeItem(spec(k).key);
  } catch {
    /* ignore */
  }
}
