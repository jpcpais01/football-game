import { COACH_BUILDS, COACH_HAIRS, COACH_HAIR_STYLES, COACH_SKINS, COACH_STYLES, COACH_TEMPERS, coachOutfit, type Club, type Coach } from '../meta/club';
import type { Kit } from '../sim/teams';
import { esc } from './cardView';

const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;

/** You on the touchline, full length in pixels: hair, face, coat with its trim, trousers, shoes. */
export function coachSVG(c: Coach, kit: Kit): string {
  const o = coachOutfit(c.style, kit);
  const w = [0.88, 1, 1.16][c.build] ?? 1;
  const h = c.height / 1.8;
  const skin = hex(c.skin);
  const coatLen = c.style === 'coat' || c.style === 'puffer' ? 58 : 48;
  const trim =
    o.pattern === 8
      ? `<rect x="18" y="23" width="4" height="${c.style === 'coat' ? 30 : 22}" fill="${hex(o.trim)}"/>`
      : o.pattern === 2
        ? [29, 35, 41, 47, 53].map((y) => `<rect x="10" y="${y}" width="20" height="1" fill="${hex(o.trim)}"/>`).join('')
        : `<rect x="10" y="23" width="1.5" height="${coatLen - 23}" fill="${hex(o.trim)}"/><rect x="28.5" y="23" width="1.5" height="${coatLen - 23}" fill="${hex(o.trim)}"/>`;
  const hairCol = c.hair < 0 ? 'none' : hex(c.hair);
  const hair =
    c.hair < 0
      ? ''
      : c.hairStyle === 2
        ? `<rect x="13" y="3" width="14" height="6" fill="${hairCol}"/><rect x="12" y="5" width="2" height="7" fill="${hairCol}"/><rect x="26" y="5" width="2" height="7" fill="${hairCol}"/>`
        : c.hairStyle === 3
          ? `<rect x="17" y="0" width="6" height="4" fill="${hairCol}"/><rect x="13" y="4" width="14" height="4" fill="${hairCol}"/><rect x="13" y="6" width="2" height="5" fill="${hairCol}"/><rect x="25" y="6" width="2" height="5" fill="${hairCol}"/>`
          : `<rect x="13" y="4" width="14" height="4" fill="${hairCol}"/><rect x="13" y="6" width="2" height="4" fill="${hairCol}"/><rect x="25" y="6" width="2" height="4" fill="${hairCol}"/>`;
  return `<svg class="coach-fig" viewBox="-4 -2 48 84" shape-rendering="crispEdges" aria-hidden="true">
    <ellipse cx="20" cy="79" rx="${12 * w}" ry="2" fill="rgba(0,0,0,0.35)"/>
    <g transform="translate(20 80) scale(${w} ${h}) translate(-20 -80)">
      <rect x="13" y="46" width="6" height="30" fill="${hex(o.trousers)}"/>
      <rect x="21" y="46" width="6" height="30" fill="${hex(o.trousers)}"/>
      <rect x="12" y="76" width="7" height="3" fill="${hex(o.shoes)}"/><rect x="21" y="76" width="7" height="3" fill="${hex(o.shoes)}"/>
      <rect x="12" y="78" width="7" height="1" fill="${hex(o.sole)}"/><rect x="21" y="78" width="7" height="1" fill="${hex(o.sole)}"/>
      <rect x="6" y="23" width="4.5" height="23" fill="${hex(o.coat)}"/><rect x="29.5" y="23" width="4.5" height="23" fill="${hex(o.coat)}"/>
      <rect x="6" y="44" width="4.5" height="2" fill="${hex(o.cuff)}"/><rect x="29.5" y="44" width="4.5" height="2" fill="${hex(o.cuff)}"/>
      <rect x="6.5" y="46" width="3.5" height="4" fill="${skin}"/><rect x="30" y="46" width="3.5" height="4" fill="${skin}"/>
      <rect x="10" y="22" width="20" height="${coatLen - 22}" fill="${hex(o.coat)}"/>
      ${trim}
      <rect x="17" y="18" width="6" height="5" fill="${skin}"/>
      <rect x="14" y="5" width="12" height="15" fill="${skin}"/>
      <rect x="16.5" y="11" width="2" height="2" fill="#1a1410"/><rect x="21.5" y="11" width="2" height="2" fill="#1a1410"/>
      <rect x="18" y="16" width="4" height="1" fill="rgba(60,25,15,0.6)"/>
      ${hair}
    </g>
  </svg>`;
}

/** The Manager screen: your name and look, and how you take it on the touchline. */
export function openCoachEditor(
  open: (html: string, cls: string) => HTMLElement,
  club: Club,
  kit: Kit,
  changed: () => void,
): void {
  const c = club.coach();
  const chips = <T>(key: string, opts: [T, string][], cur: T) =>
    `<div class="chip-row">${opts.map(([v, n]) => `<button class="chip ${v === cur ? 'on' : ''}" data-k="${key}" data-v="${v}">${n}</button>`).join('')}</div>`;
  const sw = (key: string, cols: number[], cur: number) =>
    `<div class="swatches coach-sw">${cols
      .map((col) => `<button class="sw ${col === cur ? 'on' : ''} ${col < 0 ? 'bald' : ''}" data-k="${key}" data-v="${col}" style="background:${col < 0 ? 'transparent' : hex(col)}" aria-label="${col < 0 ? 'Bald' : hex(col)}">${col < 0 ? '∅' : ''}</button>`)
      .join('')}</div>`;
  const box = open(
    `<button class="m-close" aria-label="Close">✕</button>
    <div class="kicker">On the touchline</div>
    <h3>Manager</h3>
    <div class="coach-ed">
      <div class="coach-prev">${coachSVG(c, kit)}<b class="coach-name-tag">${esc(c.name)}</b></div>
      <div class="coach-opts">
        <label class="field"><span>Name</span><input class="coach-name" maxlength="20" value="${esc(c.name)}"></label>
        <h4>Skin</h4>${sw('skin', COACH_SKINS, c.skin)}
        <h4>Hair</h4>${sw('hair', COACH_HAIRS, c.hair)}
        ${chips('hairStyle', COACH_HAIR_STYLES, c.hairStyle)}
        <h4>Height <em class="coach-h">${Math.round(c.height * 100)} cm</em></h4>
        <input type="range" class="coach-height" min="165" max="200" step="1" value="${Math.round(c.height * 100)}">
        <h4>Build</h4>${chips('build', COACH_BUILDS.map((n, i) => [i, n] as [number, string]), c.build)}
        <h4>Outfit</h4>${chips('style', COACH_STYLES, c.style)}
        <h4>Temper</h4>${chips('temper', COACH_TEMPERS.map(([v, n]) => [v, n] as [string, string]), c.temper)}
        <p class="coach-about">${COACH_TEMPERS.find((t) => t[0] === c.temper)![2]}</p>
      </div>
    </div>`,
    'coach-modal',
  );
  const prev = box.querySelector('.coach-prev') as HTMLElement;
  const redraw = () => {
    const now = club.coach();
    prev.innerHTML = `${coachSVG(now, kit)}<b class="coach-name-tag">${esc(now.name)}</b>`;
    (box.querySelector('.coach-about') as HTMLElement).textContent = COACH_TEMPERS.find((t) => t[0] === now.temper)![2];
    changed();
  };
  const set = (patch: Partial<Coach>) => {
    club.setCoach(patch);
    redraw();
  };
  box.querySelectorAll<HTMLElement>('[data-k]').forEach((el) =>
    el.addEventListener('click', () => {
      const k = el.dataset.k as keyof Coach;
      const raw = el.dataset.v!;
      const v = k === 'style' || k === 'temper' ? raw : Number(raw);
      box.querySelectorAll<HTMLElement>(`[data-k="${k}"]`).forEach((o) => o.classList.toggle('on', o === el));
      set({ [k]: v } as Partial<Coach>);
    }),
  );
  const name = box.querySelector('.coach-name') as HTMLInputElement;
  name.addEventListener('input', () => set({ name: name.value.trim() || 'The Gaffer' }));
  const height = box.querySelector('.coach-height') as HTMLInputElement;
  height.addEventListener('input', () => {
    (box.querySelector('.coach-h') as HTMLElement).textContent = `${height.value} cm`;
    set({ height: Number(height.value) / 100 });
  });
}
