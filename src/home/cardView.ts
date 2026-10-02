import { type Card, RARITY_LABEL, faceStats, overall, ratingIn, fitFactor, type Position } from '../meta/cards';

export const hex = (c: number) => '#' + c.toString(16).padStart(6, '0');

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}

function shade(c: number, k: number): string {
  const r = Math.min(255, Math.round(((c >> 16) & 255) * k));
  const g = Math.min(255, Math.round(((c >> 8) & 255) * k));
  const b = Math.min(255, Math.round((c & 255) * k));
  return `rgb(${r},${g},${b})`;
}

const HAIR: ((h: string) => string)[] = [
  // Short crop
  (h) => `<path d="M30 40 Q30 18 50 17 Q70 18 70 40 Q66 30 50 29 Q34 30 30 40Z" fill="${h}"/>`,
  // Buzz / fade
  (h) => `<path d="M32 38 Q33 21 50 20 Q67 21 68 38 Q64 28 50 27 Q36 28 32 38Z" fill="${h}" opacity=".85"/>`,
  // Curls / afro
  (h) =>
    `<g fill="${h}"><circle cx="36" cy="28" r="9"/><circle cx="50" cy="21" r="11"/><circle cx="64" cy="28" r="9"/><circle cx="30" cy="38" r="6"/><circle cx="70" cy="38" r="6"/><circle cx="43" cy="23" r="9"/><circle cx="57" cy="23" r="9"/></g>`,
  // Swept quiff, longer at the back
  (h) => `<path d="M28 46 Q25 16 52 14 Q74 15 72 42 Q70 30 60 26 Q55 33 38 31 Q31 36 28 46Z" fill="${h}"/><path d="M28 44 Q27 56 31 60 L33 46Z" fill="${h}"/><path d="M72 42 Q73 56 69 60 L67 46Z" fill="${h}"/>`,
];

/** Little portrait: kit, skin, hair. Same palette as the 3D player. */
export function avatarSVG(c: Pick<Card, 'skin' | 'hair' | 'hairStyle' | 'position'>, shirt: number, trim: number, gkShirt: number): string {
  const s = hex(c.skin);
  const sd = shade(c.skin, 0.82);
  const h = hex(c.hair);
  const kit = c.position === 'GK' ? gkShirt : shirt;
  return `<svg viewBox="0 0 100 100" class="avatar" aria-hidden="true">
    <path d="M10 100 Q12 74 34 68 L50 76 L66 68 Q88 74 90 100Z" fill="${hex(kit)}"/>
    <path d="M34 68 L50 76 L66 68 L62 66 L50 72 L38 66Z" fill="${hex(trim)}"/>
    <path d="M10 100 Q12 80 24 72 L26 100Z" fill="rgba(0,0,0,.12)"/>
    <rect x="42" y="54" width="16" height="17" rx="5" fill="${sd}"/>
    <ellipse cx="50" cy="42" rx="19" ry="22" fill="${s}"/>
    <ellipse cx="31" cy="44" rx="3.5" ry="5" fill="${sd}"/><ellipse cx="69" cy="44" rx="3.5" ry="5" fill="${sd}"/>
    <path d="M34 54 Q50 70 66 54 Q62 64 50 64 Q38 64 34 54Z" fill="rgba(0,0,0,.08)"/>
    ${HAIR[c.hairStyle % HAIR.length](h)}
    <path d="M40 39 h7 M53 39 h7" stroke="${shade(c.hair, 0.9)}" stroke-width="2.2" stroke-linecap="round"/>
    <circle cx="43.5" cy="44" r="1.9" fill="#1b1410"/><circle cx="56.5" cy="44" r="1.9" fill="#1b1410"/>
    <path d="M45 54 Q50 57 55 54" stroke="${sd}" stroke-width="1.8" fill="none" stroke-linecap="round"/>
  </svg>`;
}

export interface Kitish {
  shirt: number;
  shirt2: number;
  gkShirt: number;
}

/** A full player card (FUT style). Size is set by the font-size of .pcard (1em = 1/10 width). */
export function cardHTML(c: Card, kit: Kitish, extra = ''): string {
  const fs = faceStats(c);
  return `<div class="pcard r-${c.rarity} ${extra}" data-card="${c.id}">
    <div class="pc-bg"></div>
    <div class="pc-top">
      <div class="pc-ovr">${overall(c)}</div>
      <div class="pc-pos">${c.position}</div>
      <div class="pc-flag">${c.nation}</div>
    </div>
    <div class="pc-face">${avatarSVG(c, kit.shirt, kit.shirt2, kit.gkShirt)}</div>
    <div class="pc-bottom">
      <div class="pc-name">${esc(c.name.split(' ').slice(-1)[0])}</div>
      <div class="pc-stats">${fs.map(([k, v]) => `<span><b>${v}</b>${k}</span>`).join('')}</div>
    </div>
    <div class="pc-rar">${RARITY_LABEL[c.rarity]}</div>
    <div class="pc-shine"></div>
  </div>`;
}

/** Face-down card back for reveals. */
export function cardBackHTML(rarity: string): string {
  return `<div class="pcard back r-${rarity}"><div class="pc-bg"></div><div class="pc-back-emblem">GN</div><div class="pc-shine"></div></div>`;
}

/** Mini token for the tactics board. */
export function tokenHTML(c: Card | null, slotPos: Position, kit: Kitish): string {
  if (!c) return `<div class="tk-card empty"><span class="tk-plus">+</span></div><div class="tk-name">${slotPos}</div>`;
  const f = fitFactor(c.position, slotPos);
  const fit = f === 1 ? 'good' : f >= 0.85 ? 'ok' : 'bad';
  return `<div class="tk-card r-${c.rarity}">
      <div class="tk-ovr">${ratingIn(c, slotPos)}</div>
      <div class="tk-face">${avatarSVG(c, kit.shirt, kit.shirt2, kit.gkShirt)}</div>
      <i class="tk-fit ${fit}"></i>
    </div>
    <div class="tk-name"><em>${slotPos}</em> ${esc(c.name.split(' ').slice(-1)[0])}</div>`;
}

/** Club crest in the kit colours. */
export function crestSVG(main: number, second: number, short: string): string {
  return `<svg viewBox="0 0 100 116" class="crest" aria-hidden="true">
    <path d="M50 3 L94 16 Q94 74 50 113 Q6 74 6 16Z" fill="${hex(second)}"/>
    <path d="M50 10 L87 21 Q86 70 50 104 Q14 70 13 21Z" fill="${hex(main)}"/>
    <path d="M50 10 L50 104 Q14 70 13 21Z" fill="rgba(0,0,0,.14)"/>
    <path d="M24 34 H76" stroke="${hex(second)}" stroke-width="5"/>
    <text x="50" y="72" text-anchor="middle" font-family="Barlow Condensed, Arial Narrow, sans-serif" font-weight="800" font-size="27" fill="#fff" letter-spacing="1">${esc(short)}</text>
  </svg>`;
}
