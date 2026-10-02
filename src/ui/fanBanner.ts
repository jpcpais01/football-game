/**
 * "Your banner": the player picks a photo and the fans hold it up in the stands.
 * The photo is cropped to the banner's 2:1 shape, shrunk, and kept on this device so it's
 * still there next time.
 */

const KEY = 'fanBanner';
const W = 640;
const H = 320;

/** Crop-to-fill a source image into a W×H canvas. */
function toCanvas(src: CanvasImageSource, sw: number, sh: number): HTMLCanvasElement {
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const s = Math.max(W / sw, H / sh);
  const dw = sw * s;
  const dh = sh * s;
  cv.getContext('2d')!.drawImage(src, (W - dw) / 2, (H - dh) / 2, dw, dh);
  return cv;
}

async function decode(file: Blob): Promise<HTMLCanvasElement> {
  if ('createImageBitmap' in window) {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
      const cv = toCanvas(bmp, bmp.width, bmp.height);
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
    return toCanvas(img, img.naturalWidth, img.naturalHeight);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** The saved banner, if any. */
export async function loadFanBanner(): Promise<HTMLCanvasElement | null> {
  let data: string | null = null;
  try {
    data = localStorage.getItem(KEY);
  } catch {
    return null;
  }
  if (!data) return null;
  try {
    return await decode(await (await fetch(data)).blob());
  } catch {
    return null;
  }
}

/** Opens the photo picker; resolves with the new banner (saved), or null if cancelled. */
export function pickFanBanner(): Promise<HTMLCanvasElement | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      try {
        const cv = await decode(file);
        try {
          localStorage.setItem(KEY, cv.toDataURL('image/jpeg', 0.85));
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

export function clearFanBanner(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
