/**
 * Fixed palettes for the "Palette" pixel-art look. Every art pixel snaps to the nearest
 * palette colour (in OKLab, so matches look right to the eye), with an ordered dither
 * between the two nearest for gradients — like hand-made pixel art.
 *
 * Each palette has to cover a football match: several grass greens, skin tones from light
 * to dark, creams and whites, kit reds / blues / yellows, the evening's purples and the
 * darks the outlines snap to.
 */
export interface Palette {
  name: string;
  colors: string[];
  /** Ordered-dither strength between the two nearest colours (0 = flat bands). */
  dither: number;
  /** Grade before snapping: saturation and contrast around mid-grey. */
  sat: number;
  contrast: number;
  /** Paper grain (printed looks). */
  grain: number;
}

export const PALETTES: Palette[] = [
  {
    // Soft and natural: lush greens, cream light, teal shade, warm skin.
    name: 'Meadow',
    dither: 0.75,
    sat: 1.0,
    contrast: 1.0,
    grain: 0,
    colors: [
      '#16172b', '#2a2b45', '#45405e',
      '#22406e', '#3d68a3', '#78a6d6', '#bcdcf0',
      '#1d3a26', '#2b5433', '#3b6f3d', '#4f8a45', '#6aa64f', '#8fc163', '#bcdc8a',
      '#2f6f6e', '#5fa79a',
      '#4a3024', '#7a4f36', '#a9714c', '#d6a174', '#f0cfa6',
      '#fbf6e6', '#e2dccb', '#a8a497',
      '#6e1c27', '#a62c35', '#d9503f',
      '#e8963b', '#f5d063',
      '#7a63a8', '#5e626b',
    ],
  },
  {
    // Late sun: amber light, olive grass, plum shadows.
    name: 'Golden Hour',
    dither: 0.75,
    sat: 1.05,
    contrast: 1.02,
    grain: 0,
    colors: [
      '#1c1220', '#38213a', '#5a3350', '#874b5a',
      '#283a66', '#4f63a0', '#93a5d4',
      '#233a1d', '#365424', '#4f722c', '#6d8f35', '#93ad46', '#c2c76a',
      '#5e3326', '#94553a', '#c9875c', '#efbf8c',
      '#c85a2a', '#ec8f34', '#f8bf54', '#fde49a',
      '#851b2b', '#c0303a',
      '#fff6e4', '#e6d6b8', '#b7a58e',
      '#3a716c', '#73a596',
      '#6d6070',
    ],
  },
  {
    // Under the floodlights: emerald grass, deep navy, cool whites, warm lamps.
    name: 'Moonlit',
    dither: 0.7,
    sat: 1.0,
    contrast: 1.04,
    grain: 0,
    colors: [
      '#090c1a', '#121a32', '#1e2a52', '#2f4078',
      '#4762a3', '#7896d0', '#b6cbef', '#e9f1ff',
      '#0e271f', '#153b2f', '#1d523b', '#2b6d45', '#428c52', '#6fb266',
      '#432a2b', '#76493f', '#ad7c61', '#dcb08e',
      '#5e1424', '#9a2337', '#d2444b',
      '#e3c05a', '#fff1b8',
      '#433566', '#735da0',
      '#f6f2ea', '#c3cad8', '#8890a3',
      '#d0773a', '#535a6b',
    ],
  },
  {
    // Neon night: magenta and cyan on deep violet, teal turf.
    name: 'Synthwave',
    dither: 1.0,
    sat: 1.3,
    contrast: 1.15,
    grain: 0,
    colors: [
      '#0b0420', '#170a33', '#26104f', '#3c1670', '#5e1f98', '#8a2bc0',
      '#ff2e7e', '#ff76b8', '#ffc6e6',
      '#00c8e0', '#45f0ff', '#bffbff',
      '#0a1a66', '#2a49c9', '#5f86ff',
      '#06302f', '#0c5a55', '#138a78', '#35c193',
      '#ff9f1c', '#ff6b3d', '#ffe36e',
      '#6e2f4e', '#b9606a', '#f0a08c',
      '#f6f0ff',
    ],
  },
  {
    // A risograph print: five inks (pink, blue, yellow, green, black), their overprints
    // and tints, on cream paper.
    name: 'Risograph',
    dither: 1.0,
    sat: 1.1,
    contrast: 1.05,
    grain: 0.035,
    colors: [
      '#f2ead3', '#ddd2b6',
      '#ff48b0', '#ffb0d6',
      '#0078bf', '#8cc6e8', '#1c3f7a',
      '#ffe800', '#fff3a6',
      '#00a95c', '#90d8ac', '#1f6b45', '#163d2c', '#0f5a63',
      '#ff6c3a', '#ffb08f',
      '#6b3b9e', '#3a1f5e',
      '#2b2a2e', '#7a746c',
      '#e89a7c', '#8a4b3a',
    ],
  },
];

/** sRGB hex -> display (gamma) RGB 0..1. */
export function hexRGB(h: string): [number, number, number] {
  const n = parseInt(h.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** Display RGB -> OKLab, with the same gamma-2.2 approximation the shader uses. */
export function oklab([r, g, b]: [number, number, number]): [number, number, number] {
  const lr = Math.pow(r, 2.2);
  const lg = Math.pow(g, 2.2);
  const lb = Math.pow(b, 2.2);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}
