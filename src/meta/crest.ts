// Club crest: a shield shape, a field division, an emblem, lettering and trim, in three
// colours. Rendered to SVG (menus) and to a canvas (stadium flags, tifo, banners).

export interface Crest {
  shape: number; // CREST_SHAPES
  division: number; // CREST_DIVISIONS
  emblem: number; // CREST_EMBLEMS
  text: string; // up to 4 letters
  textStyle: number; // CREST_TEXT_STYLES
  border: number; // CREST_BORDERS
  stars: number; // 0..5 champion stars above the crest
  year: string; // founding year on the ribbon ('' = none)
  primary: number;
  secondary: number;
  accent: number;
}

export const CREST_SHAPES = ['Classic', 'Heater', 'Round', 'Roundel', 'Swiss', 'Diamond', 'Hexagon', 'French', 'Pennant'];
export const CREST_DIVISIONS = ['Plain', 'Halves', 'Split', 'Quarters', 'Stripes', 'Hoops', 'Bend', 'Chevron', 'Saltire', 'Cross', 'Chief', 'Gyronny'];
export const CREST_EMBLEMS = ['None', 'Star', 'Ball', 'Crown', 'Bolt', 'Castle', 'Anchor', 'Flame', 'Wings', 'Eagle', 'Lion', 'Oak', 'Wolf', 'Sun', 'Three stars'];
export const CREST_TEXT_STYLES = ['Centre', 'Ribbon', 'Top band', 'Hidden'];
export const CREST_BORDERS = ['None', 'Thin', 'Bold', 'Double', 'Gold'];

export function defaultCrest(): Crest {
  return { shape: 0, division: 1, emblem: 2, text: 'ROS', textStyle: 1, border: 2, stars: 0, year: '1899', primary: 0xc8393b, secondary: 0x14121c, accent: 0xf3ede0 };
}

const hex = (c: number) => '#' + c.toString(16).padStart(6, '0');
const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

/** Outline paths in a 100 x 120 box (the top 0..14 is left for stars). */
const SHAPES: string[] = [
  'M12 22 H88 V62 Q88 96 50 114 Q12 96 12 62 Z', // classic
  'M10 20 Q50 14 90 20 Q92 78 50 114 Q8 78 10 20 Z', // heater
  'M50 18 C76 18 90 36 90 62 C90 92 72 112 50 114 C28 112 10 92 10 62 C10 36 24 18 50 18 Z', // round
  'M50 20 A46 46 0 1 1 49.9 20 Z', // roundel
  'M14 20 H86 Q90 20 90 26 V70 Q90 100 50 114 Q10 100 10 70 V26 Q10 20 14 20 Z', // swiss
  'M50 16 L92 64 L50 114 L8 64 Z', // diamond
  'M50 16 L91 38 V90 L50 114 L9 90 V38 Z', // hexagon
  'M12 20 H88 V84 Q88 98 70 100 Q56 102 50 114 Q44 102 30 100 Q12 98 12 84 Z', // french
  'M10 20 H90 V96 L50 114 L10 96 Z', // pennant
];

/** Field divisions: secondary-coloured areas drawn over the primary field. */
function division(d: number, sec: string): string {
  switch (d) {
    case 1: return `<rect x="50" y="0" width="60" height="130" fill="${sec}"/>`;
    case 2: return `<rect x="0" y="66" width="110" height="70" fill="${sec}"/>`;
    case 3: return `<rect x="50" y="0" width="60" height="66" fill="${sec}"/><rect x="0" y="66" width="50" height="70" fill="${sec}"/>`;
    case 4: return [18, 42, 66].map((x) => `<rect x="${x}" y="0" width="12" height="130" fill="${sec}"/>`).join('');
    case 5: return [34, 58, 82].map((y) => `<rect x="0" y="${y}" width="110" height="12" fill="${sec}"/>`).join('');
    case 6: return `<path d="M-10 30 L30 -10 L120 80 L80 120 Z" fill="${sec}" transform="translate(0 10)"/>`;
    case 7: return `<path d="M0 84 L50 50 L100 84 V104 L50 70 L0 104 Z" fill="${sec}"/>`;
    case 8: return `<path d="M0 10 L14 10 L100 116 L86 126 Z M100 10 L86 10 L0 116 L14 126 Z" fill="${sec}"/>`;
    case 9: return `<rect x="42" y="0" width="16" height="130" fill="${sec}"/><rect x="0" y="54" width="110" height="16" fill="${sec}"/>`;
    case 10: return `<rect x="0" y="0" width="110" height="44" fill="${sec}"/>`;
    case 11: return [0, 90, 180, 270].map((a) => `<path d="M50 64 L50 -40 L150 -40 Z" fill="${sec}" transform="rotate(${a} 50 64)"/>`).join('');
    default: return '';
  }
}

/** Emblems, drawn around (0, 0) at roughly 40 units across. */
function emblem(e: number, c: string, dark: string): string {
  const st = `stroke="${dark}" stroke-width="1.6" stroke-linejoin="round"`;
  const star = (x: number, y: number, r: number) => {
    let d = '';
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI / 2 + (i * Math.PI) / 5;
      const rr = i % 2 ? r * 0.42 : r;
      d += `${i ? 'L' : 'M'}${(x + Math.cos(a) * rr).toFixed(1)} ${(y + Math.sin(a) * rr).toFixed(1)} `;
    }
    return `<path d="${d}Z" fill="${c}" ${st}/>`;
  };
  switch (e) {
    case 1: return star(0, 0, 20);
    case 2:
      return `<circle r="18" fill="#f8f6f0" ${st}/><path d="M0 -7 L6.7 -2.2 L4.1 5.7 L-4.1 5.7 L-6.7 -2.2 Z" fill="${dark}"/>
        <path d="M0 -7 V-18 M6.7 -2.2 L16.5 -5.5 M4.1 5.7 L10.6 14.6 M-4.1 5.7 L-10.6 14.6 M-6.7 -2.2 L-16.5 -5.5" stroke="${dark}" stroke-width="1.6"/>`;
    case 3: return `<path d="M-20 10 L-22 -12 L-10 -2 L0 -18 L10 -2 L22 -12 L20 10 Z" fill="${c}" ${st}/><rect x="-20" y="10" width="40" height="7" rx="1.5" fill="${c}" ${st}/><circle cy="-18" r="2.6" fill="${c}" ${st}/>`;
    case 4: return `<path d="M5 -22 L-13 3 H-1 L-6 22 L14 -5 H2 Z" fill="${c}" ${st}/>`;
    case 5: return `<path d="M-18 18 V-8 H-12 V-16 H-6 V-8 H-2 V-16 H2 V-8 H6 V-16 H12 V-8 H18 V18 H5 V6 A5 5 0 0 0 -5 6 V18 Z" fill="${c}" ${st}/>`;
    case 6: return `<g fill="none" stroke="${c}" stroke-width="5" stroke-linecap="round"><circle cy="-15" r="4.5"/><path d="M0 -10 V18 M-11 -3 H11 M-17 6 Q-15 20 0 19 Q15 20 17 6"/></g>`;
    case 7: return `<path d="M0 22 C-15 22 -18 8 -12 -2 C-10 4 -6 6 -5 3 C-8 -8 -2 -16 4 -22 C3 -12 13 -8 14 4 C15 14 9 22 0 22 Z" fill="${c}" ${st}/><path d="M0 19 C-6 19 -7 12 -3 6 C-2 10 1 10 1 8 C4 11 6 13 5 16 C4 18 2 19 0 19 Z" fill="${dark}" opacity=".55"/>`;
    case 8: return `<path d="M0 6 C-6 -10 -20 -14 -24 -6 C-20 -6 -18 -2 -18 0 C-22 0 -24 4 -22 8 C-18 6 -14 8 -14 10 C-10 8 -4 10 0 14 C4 10 10 8 14 10 C14 8 18 6 22 8 C24 4 22 0 18 0 C18 -2 20 -6 24 -6 C20 -14 6 -10 0 6 Z" fill="${c}" ${st}/>`;
    case 9: return `<path d="M0 -18 C5 -18 8 -14 7 -9 L12 -10 L9 -5 C16 -8 24 -12 26 -4 C20 -4 16 0 14 4 C10 2 8 6 8 10 L4 20 L0 14 L-4 20 L-8 10 C-8 6 -10 2 -14 4 C-16 0 -20 -4 -26 -4 C-24 -12 -16 -8 -9 -5 C-10 -14 -5 -18 0 -18 Z" fill="${c}" ${st}/><circle cx="2" cy="-12" r="1.4" fill="${dark}"/>`;
    case 10: return `<path d="M-4 -20 C10 -22 20 -12 18 2 C24 6 22 14 16 14 C14 20 6 22 0 20 C-6 22 -14 20 -16 14 C-22 14 -24 6 -18 2 C-20 -10 -14 -18 -4 -20 Z" fill="${c}" ${st}/><path d="M-7 -4 L-3 -2 M7 -4 L3 -2 M-5 8 Q0 12 5 8 M0 2 V7" stroke="${dark}" stroke-width="1.8" fill="none" stroke-linecap="round"/>`;
    case 11: return `<path d="M0 -22 C6 -16 14 -16 12 -8 C20 -8 20 2 14 4 C20 8 14 16 8 12 C6 18 -6 18 -8 12 C-14 16 -20 8 -14 4 C-20 2 -20 -8 -12 -8 C-14 -16 -6 -16 0 -22 Z" fill="${c}" ${st}/><path d="M0 -10 V22" stroke="${dark}" stroke-width="2.2"/>`;
    case 12: return `<path d="M-14 -20 L-6 -8 H6 L14 -20 L16 0 C16 12 8 20 0 22 C-8 20 -16 12 -16 0 Z" fill="${c}" ${st}/><path d="M-8 2 L-3 4 M8 2 L3 4 M-4 14 L0 17 L4 14" stroke="${dark}" stroke-width="1.8" fill="none" stroke-linecap="round"/>`;
    case 13: return `<g fill="${c}" ${st}>${Array.from({ length: 12 }, (_, i) => `<path d="M-3 -14 L0 -23 L3 -14 Z" transform="rotate(${i * 30})"/>`).join('')}<circle r="12"/></g>`;
    case 14: return star(-14, 4, 9) + star(14, 4, 9) + star(0, -8, 11);
    default: return '';
  }
}

/** Light or dark ink for text on a colour. */
function ink(c: number): string {
  const r = (c >> 16) & 255, g = (c >> 8) & 255, b = c & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? '#14121c' : '#ffffff';
}

let uid = 0;

/** The crest as an SVG string (viewBox 0 0 100 124). */
export function crestSVG(c: Crest, cls = 'crest'): string {
  const id = `cr${++uid}`;
  const shape = SHAPES[c.shape % SHAPES.length];
  const P = hex(c.primary);
  const S = hex(c.secondary);
  const A = hex(c.accent);
  const dark = ink(c.accent) === '#ffffff' ? hex(c.accent) : '#14121c';
  const text = esc(c.text.toUpperCase().slice(0, 4));
  const ts = c.textStyle;
  // Emblem placement leaves room for the lettering.
  const ey = ts === 0 ? 52 : ts === 1 ? 58 : ts === 2 ? 72 : 64;
  const es = text && ts === 0 ? 0.85 : 1.1;
  const borderW = [0, 2.5, 5, 2.5, 4][c.border % 5];
  const borderC = c.border === 4 ? '#e8c35a' : A;
  const stars = Math.max(0, Math.min(5, c.stars));
  const starRow = Array.from({ length: stars }, (_, i) => {
    const x = 50 + (i - (stars - 1) / 2) * 11;
    let d = '';
    for (let k = 0; k < 10; k++) {
      const a = -Math.PI / 2 + (k * Math.PI) / 5;
      const r = k % 2 ? 1.9 : 4.5;
      d += `${k ? 'L' : 'M'}${(x + Math.cos(a) * r).toFixed(1)} ${(8 + Math.sin(a) * r).toFixed(1)} `;
    }
    return `<path d="${d}Z" fill="#e8c35a"/>`;
  }).join('');
  let letters = '';
  if (text && ts === 0) {
    letters = `<text x="50" y="${ey + 36}" text-anchor="middle" font-family="Barlow Condensed, Arial Narrow, Arial, sans-serif" font-weight="800" font-size="${text.length > 3 ? 17 : 20}" fill="${A}" stroke="${dark}" stroke-width="0.8" paint-order="stroke" letter-spacing="1">${text}</text>`;
  } else if (text && ts === 2) {
    letters = `<rect x="0" y="22" width="100" height="26" fill="${A}" clip-path="url(#${id})"/><text x="50" y="42" text-anchor="middle" font-family="Barlow Condensed, Arial Narrow, Arial, sans-serif" font-weight="800" font-size="19" fill="${ink(c.accent)}" letter-spacing="1.5">${text}</text>`;
  }
  // The ribbon sits across the lower part of the shield, over the border.
  const ribbon =
    ts === 1 && (text || c.year)
      ? `<path d="M2 84 L14 80 L14 98 L2 101 L7 92 Z M98 84 L86 80 L86 98 L98 101 L93 92 Z" fill="${S}" stroke="${dark}" stroke-width="1"/>
         <path d="M12 78 Q50 70 88 78 V96 Q50 88 12 96 Z" fill="${A}" stroke="${dark}" stroke-width="1.2"/>
         <text x="50" y="${c.year && text ? 89 : 91}" text-anchor="middle" font-family="Barlow Condensed, Arial Narrow, Arial, sans-serif" font-weight="800" font-size="${text ? 13 : 9}" fill="${ink(c.accent)}" letter-spacing="1.2">${text || esc(c.year)}</text>
         ${text && c.year ? `<text x="50" y="${108}" text-anchor="middle" font-family="Arial, sans-serif" font-weight="700" font-size="6.5" fill="${A}" letter-spacing="1.5">EST. ${esc(c.year)}</text>` : ''}`
      : '';
  const yearPlain = ts !== 1 && c.year ? `<text x="50" y="${ts === 2 ? 104 : 106}" text-anchor="middle" font-family="Arial, sans-serif" font-weight="700" font-size="6.5" fill="${A}" letter-spacing="1.5" opacity=".9">${esc(c.year)}</text>` : '';
  return `<svg viewBox="0 0 100 124" class="${cls}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <defs><clipPath id="${id}"><path d="${shape}"/></clipPath>
      <linearGradient id="${id}g" x1="0" y1="0" x2="0.4" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".22"/><stop offset=".5" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".18"/></linearGradient></defs>
    ${starRow}
    <g clip-path="url(#${id})"><rect width="100" height="130" fill="${P}"/>${division(c.division, S)}<rect width="100" height="130" fill="url(#${id}g)"/></g>
    ${letters}
    ${c.emblem ? `<g transform="translate(50 ${ey}) scale(${es})">${emblem(c.emblem, A, dark)}</g>` : ''}
    ${yearPlain}
    ${borderW ? `<path d="${shape}" fill="none" stroke="${borderC}" stroke-width="${borderW}"/>` : ''}
    ${c.border === 3 ? `<path d="${shape}" fill="none" stroke="${borderC}" stroke-width="1.4" transform="translate(50 64) scale(0.88) translate(-50 -64)"/>` : ''}
    <path d="${shape}" fill="none" stroke="rgba(0,0,0,.35)" stroke-width="0.8"/>
    ${ribbon}
  </svg>`;
}

/** Draw the crest into a canvas (for textures). Resolves once the image has rendered. */
export function crestCanvas(c: Crest, size = 256): Promise<HTMLCanvasElement> {
  const cv = document.createElement('canvas');
  cv.width = size;
  cv.height = Math.round(size * 1.24);
  const img = new Image();
  const svg = crestSVG(c).replace('class="crest"', `width="${cv.width}" height="${cv.height}"`);
  return new Promise((resolve) => {
    img.onload = () => {
      cv.getContext('2d')!.drawImage(img, 0, 0, cv.width, cv.height);
      resolve(cv);
    };
    img.onerror = () => resolve(cv);
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  });
}
