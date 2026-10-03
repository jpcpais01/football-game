import { KIT_PATTERNS } from '../sim/teams';
import { type ClubKit } from '../meta/club';
import { CREST_BORDERS, CREST_DIVISIONS, CREST_EMBLEMS, CREST_SHAPES, CREST_TEXT_STYLES, type Crest, crestSVG } from '../meta/crest';
import { esc } from './cardView';
import type { HomeUI } from './home';
import { TIFOS, type TifoKind, clearTifo, loadTifo, pickTifo, restoreTifos, saveTifos, storedTifo } from '../ui/tifos';

const hex = (c: number) => '#' + c.toString(16).padStart(6, '0');

/** Curated swatches: club colours that look good together, plus a custom picker. */
const PALETTE = [
  0xc8393b, 0x8f1f24, 0xe0522b, 0xf28c28, 0xffd447, 0xe8c35a, 0x3ddc84, 0x1f6b4a, 0x0f3d2e, 0x2fb6a8,
  0x7ff6ff, 0x4aa3ff, 0x2457d6, 0x23345e, 0x14123a, 0x6a3fd1, 0xb05cff, 0xe0559b, 0xf3ede0, 0xffffff,
  0xb9bdc4, 0x6b6f78, 0x2a2a2a, 0x0e0e10,
];

let uid = 0;

/** Front view of the shirt and shorts with the chosen design (matches the 3D shader). */
export function jerseySVG(k: ClubKit, crest: Crest | null, cls = 'jersey'): string {
  const id = `js${++uid}`;
  const M = hex(k.main);
  const S = hex(k.secondary);
  const shirt = 'M30 14 L44 8 Q50 14 56 8 L70 14 L88 30 L78 44 L70 38 L70 92 Q50 96 30 92 L30 38 L22 44 L12 30 Z';
  const body = 'M30 14 L44 8 Q50 14 56 8 L70 14 L70 92 Q50 96 30 92 Z';
  const p = k.pattern;
  let over = '';
  if (p === 1) over = [0, 1, 2, 3, 4, 5].map((i) => `<rect x="${22 + i * 10}" y="0" width="5" height="100" fill="${S}"/>`).join('');
  else if (p === 2) over = [0, 1, 2, 3, 4].map((i) => `<rect x="0" y="${16 + i * 17}" width="100" height="8.5" fill="${S}"/>`).join('');
  else if (p === 3) over = Array.from({ length: 12 }, (_, i) => `<rect x="${21 + i * 5}" y="0" width="1" height="100" fill="${S}"/>`).join('');
  else if (p === 4) over = `<rect x="50" y="0" width="50" height="100" fill="${S}"/>`;
  else if (p === 5) over = `<path d="M24 10 L36 6 L82 94 L68 98 Z" fill="${S}"/>`;
  else if (p === 6) over = `<path d="M30 30 L50 46 L70 30 L70 38 L50 54 L30 38 Z" fill="${S}"/>`;
  else if (p === 7) over = `<rect x="50" y="0" width="50" height="50" fill="${S}"/><rect x="0" y="50" width="50" height="50" fill="${S}"/>`;
  else if (p === 8) over = `<rect x="44" y="0" width="12" height="100" fill="${S}"/>`;
  else if (p === 9) over = `<rect x="0" y="0" width="100" height="100" fill="url(#${id}f)"/>`;
  const badge = crest ? `<svg x="57" y="22" width="9" height="11.2" viewBox="0 0 100 124">${crestSVG(crest, 'b').replace(/^<svg[^>]*>|<\/svg>\s*$/g, '')}</svg>` : '';
  return `<svg viewBox="0 0 100 130" class="${cls}" aria-hidden="true">
    <defs>
      <clipPath id="${id}"><path d="${shirt}"/></clipPath>
      <clipPath id="${id}b"><path d="${body}"/></clipPath>
      <linearGradient id="${id}f" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="${S}"/><stop offset="0.85" stop-color="${S}" stop-opacity="0"/></linearGradient>
      <linearGradient id="${id}s" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#000" stop-opacity=".22"/><stop offset=".3" stop-color="#fff" stop-opacity=".1"/><stop offset=".7" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".25"/></linearGradient>
    </defs>
    <path d="M32 92 L68 92 L71 120 L53 122 L50 108 L47 122 L29 120 Z" fill="${hex(k.shorts)}"/>
    <path d="M29 118 L47 120 M53 120 L71 118" stroke="${S}" stroke-width="2.2"/>
    <g clip-path="url(#${id})">
      <rect width="100" height="100" fill="${M}"/>
      <g clip-path="url(#${id}b)">${over}</g>
      <path d="M12 30 L22 44 L25 41 L15 27 Z M88 30 L78 44 L75 41 L85 27 Z" fill="${S}"/>
      <rect width="100" height="100" fill="url(#${id}s)"/>
    </g>
    <path d="M44 8 Q50 16 56 8 L58 9 Q50 20 42 9 Z" fill="${S}"/>
    ${badge}
    <path d="${shirt}" fill="none" stroke="rgba(0,0,0,.35)" stroke-width="0.8"/>
  </svg>`;
}

type Tab = 'kit' | 'crest' | 'tifos';

/** The club studio: name, kit designer, crest maker and the fans' tifos and banner. */
export class ClubScreen {
  readonly el = document.createElement('div');
  private tab: Tab = 'kit';
  /** Which colour slot the swatches edit. */
  private kitSlot: 'main' | 'secondary' | 'shorts' = 'main';
  private crestSlot: 'primary' | 'secondary' | 'accent' = 'primary';
  private crestPart: 'shape' | 'division' | 'emblem' | 'text' = 'shape';

  constructor(private ui: HomeUI) {
    this.el.className = 'screen screen-club';
  }

  private get club() {
    return this.ui.club;
  }

  render(): void {
    const st = this.club.state;
    this.el.innerHTML = `
      <header class="topbar">
        <button class="back" aria-label="Back">‹</button>
        <h2 class="scr-title">Club</h2>
        <div class="forms" role="tablist">
          <button class="chip ${this.tab === 'kit' ? 'on' : ''}" data-tab="kit">Kit</button>
          <button class="chip ${this.tab === 'crest' ? 'on' : ''}" data-tab="crest">Crest</button>
          <button class="chip ${this.tab === 'tifos' ? 'on' : ''}" data-tab="tifos">Tifos</button>
        </div>
        <div class="grow"></div>
        <button class="tool save-look" title="Keep this look to come back to">${this.club.lookSaved() ? 'Saved ✓' : 'Save look'}</button>
        ${st.look && !this.club.lookSaved() ? '<button class="tool restore-look">Back to saved</button>' : ''}
        <button class="tool random">Surprise me</button>
        <button class="tool settings" aria-label="Club settings">⚙</button>
      </header>
      <main class="studio">
        <section class="studio-stage">
          <div class="stage-glow" style="--c1:${hex(st.kit.main)};--c2:${hex(st.crest.primary)}"></div>
          <div class="stage-main">${this.tab === 'kit' ? jerseySVG(st.kit, st.crest, 'jersey big') : this.tab === 'crest' ? crestSVG(st.crest, 'crest big') : this.tifoStage()}</div>
          <div class="stage-side">${this.tab === 'kit' ? crestSVG(st.crest, 'crest small') : jerseySVG(st.kit, st.crest, 'jersey small')}</div>
          <div class="name-row">
            <label class="name-field"><span>Club name</span><input class="club-name" maxlength="24" value="${esc(st.name)}"></label>
            <label class="name-field short-field" title="Scoreboard code"><span>Code</span><input class="club-short" maxlength="3" value="${esc(this.club.info().short)}" autocapitalize="characters" spellcheck="false"></label>
          </div>
        </section>
        <section class="studio-panel">${this.tab === 'kit' ? this.kitPanel() : this.tab === 'crest' ? this.crestPanel() : this.tifoPanel()}</section>
      </main>`;
    this.bind();
  }

  // ---------------------------------------------------------------- kit

  private kitPanel(): string {
    const k = this.club.state.kit;
    const slots: [typeof this.kitSlot, string, number][] = [
      ['main', 'Main', k.main],
      ['secondary', 'Secondary', k.secondary],
      ['shorts', 'Shorts', k.shorts],
    ];
    return `
      <h4>Design</h4>
      <div class="opt-grid patterns">
        ${KIT_PATTERNS.map((name, i) => `<button class="opt ${k.pattern === i ? 'on' : ''}" data-pattern="${i}" title="${name}">${jerseySVG({ ...k, pattern: i }, null, 'jersey thumb')}<span>${name}</span></button>`).join('')}
      </div>
      <h4>Colours</h4>
      <div class="slot-row">${slots.map(([key, label, c]) => `<button class="slot ${this.kitSlot === key ? 'on' : ''}" data-kslot="${key}"><i style="background:${hex(c)}"></i>${label}</button>`).join('')}</div>
      ${this.swatches(slots.find((x) => x[0] === this.kitSlot)![2])}`;
  }

  // ---------------------------------------------------------------- tifos

  /** The giant tifo as it hangs: the uploaded picture, or the club design in miniature. */
  private tifoStage(): string {
    const url = storedTifo('giant');
    if (url) return `<img class="tifo-big" src="${url}" alt="Giant tifo">`;
    const st = this.club.state;
    return `<div class="tifo-big made" style="background:${hex(st.kit.main)}">
      <b>${esc(st.name)}</b>${crestSVG(st.crest, 'crest')}<span>${esc(st.banner.text || 'ONE CLUB · ONE NIGHT')}</span></div>`;
  }

  /** A picture for each tifo (or the club's own design), and the drop banner's words. */
  private tifoPanel(): string {
    const row = (t: (typeof TIFOS)[number]) => {
      const url = storedTifo(t.id);
      const none = t.id === 'fan' ? 'None' : 'Club design';
      return `<div class="tifo-row" data-t="${t.id}">
        <div class="tifo-prev" style="aspect-ratio:${t.w}/${t.h}">${url ? `<img src="${url}" alt="">` : `<span>${none}</span>`}</div>
        <div class="tifo-info">
          <b>${t.name}</b><span>${t.about}</span>
          <div class="tifo-btns">
            <button class="btn-ghost up">${url ? 'Change' : 'Upload'}</button>
            ${url ? `<button class="btn-ghost off">${t.id === 'fan' ? 'Remove' : 'Use club design'}</button>` : ''}
          </div>
        </div>
      </div>`;
    };
    return `<h4>Tifos</h4><div class="tifo-list">${TIFOS.map(row).join('')}</div>${this.bannerSection()}`;
  }

  /** The big drop banner the fans hang over the home end. */
  private bannerSection(): string {
    const b = this.club.state.banner;
    const c = this.club.bannerColors();
    const choices: [typeof b.color, string][] = [
      ['main', 'Main colour'],
      ['secondary', 'Secondary'],
      ['dark', 'Night'],
    ];
    return `
      <h4>Stand banner</h4>
      <div class="banner-preview" style="background:${hex(c.bg)};color:${hex(c.fg)};border-color:${hex(c.fg)}">
        <i>${crestSVG(this.club.state.crest, 'crest tiny')}</i><b class="banner-words">${esc(b.text || 'ONE CLUB · ONE NIGHT')}</b><i>${crestSVG(this.club.state.crest, 'crest tiny')}</i>
      </div>
      <label class="name-field banner-field"><span>Words</span><input class="banner-text" maxlength="28" value="${esc(b.text)}" placeholder="ONE CLUB · ONE NIGHT"></label>
      <div class="chip-row">${choices.map(([k, n]) => `<button class="chip ${b.color === k ? 'on' : ''}" data-bcolor="${k}">${n}</button>`).join('')}</div>`;
  }

  // ---------------------------------------------------------------- crest

  private crestPanel(): string {
    const c = this.club.state.crest;
    const parts: [typeof this.crestPart, string][] = [
      ['shape', 'Shape'],
      ['division', 'Field'],
      ['emblem', 'Emblem'],
      ['text', 'Lettering'],
    ];
    const slots: [typeof this.crestSlot, string, number][] = [
      ['primary', 'Field', c.primary],
      ['secondary', 'Second', c.secondary],
      ['accent', 'Detail', c.accent],
    ];
    const thumbs = (list: string[], key: keyof Crest) =>
      `<div class="opt-grid crests">${list
        .map((name, i) => `<button class="opt ${c[key] === i ? 'on' : ''}" data-crest="${key}" data-v="${i}" title="${name}">${crestSVG({ ...c, [key]: i }, 'crest thumb')}<span>${name}</span></button>`)
        .join('')}</div>`;
    let body = '';
    if (this.crestPart === 'shape') body = thumbs(CREST_SHAPES, 'shape');
    else if (this.crestPart === 'division') body = thumbs(CREST_DIVISIONS, 'division');
    else if (this.crestPart === 'emblem') body = thumbs(CREST_EMBLEMS, 'emblem');
    else {
      body = `
        <div class="text-row">
          <label class="mini-field"><span>Letters</span><input class="crest-text" maxlength="4" value="${esc(c.text)}"></label>
          <label class="mini-field"><span>Founded</span><input class="crest-year" maxlength="4" inputmode="numeric" value="${esc(c.year)}"></label>
          <div class="mini-field"><span>Stars</span><div class="stepper"><button class="chip" data-stars="-1">−</button><b>${c.stars}</b><button class="chip" data-stars="1">+</button></div></div>
        </div>
        <h4>Lettering</h4>
        <div class="chip-row">${CREST_TEXT_STYLES.map((n, i) => `<button class="chip ${c.textStyle === i ? 'on' : ''}" data-crest="textStyle" data-v="${i}">${n}</button>`).join('')}</div>
        <h4>Border</h4>
        <div class="chip-row">${CREST_BORDERS.map((n, i) => `<button class="chip ${c.border === i ? 'on' : ''}" data-crest="border" data-v="${i}">${n}</button>`).join('')}</div>`;
    }
    return `
      <div class="chip-row parts">${parts.map(([k, n]) => `<button class="chip ${this.crestPart === k ? 'on' : ''}" data-part="${k}">${n}</button>`).join('')}
        <button class="chip ghosty match-kit">Use kit colours</button></div>
      ${body}
      <h4>Colours</h4>
      <div class="slot-row">${slots.map(([key, label, col]) => `<button class="slot ${this.crestSlot === key ? 'on' : ''}" data-cslot="${key}"><i style="background:${hex(col)}"></i>${label}</button>`).join('')}</div>
      ${this.swatches(slots.find((x) => x[0] === this.crestSlot)![2])}`;
  }

  private swatches(current: number): string {
    return `<div class="swatches">${PALETTE.map((c) => `<button class="sw ${c === current ? 'on' : ''}" data-color="${c}" style="background:${hex(c)}" aria-label="${hex(c)}"></button>`).join('')}
      <label class="sw custom" title="Any colour"><input type="color" class="color-in" value="${hex(current)}"><span>+</span></label></div>`;
  }

  // ---------------------------------------------------------------- events

  private bind(): void {
    const q = (s: string) => this.el.querySelector(s) as HTMLElement | null;
    const all = (s: string) => this.el.querySelectorAll<HTMLElement>(s);
    q('.back')!.addEventListener('click', () => this.ui.go('home'));
    all('[data-tab]').forEach((b) => b.addEventListener('click', () => ((this.tab = b.dataset.tab as Tab), this.render())));
    q('.random')!.addEventListener('click', () => this.randomize());
    q('.save-look')?.addEventListener('click', () => {
      this.club.saveLook();
      saveTifos();
      this.ui.toast('Club look saved');
      this.render();
    });
    q('.restore-look')?.addEventListener('click', () => void this.restoreLook());
    all('.tifo-row').forEach((r) => {
      const k = r.dataset.t as TifoKind;
      r.querySelector('.up')!.addEventListener('click', async () => {
        const img = await pickTifo(k);
        if (!img) return;
        this.ui.hooks.onTifo(k, img);
        this.render();
      });
      r.querySelector('.off')?.addEventListener('click', () => {
        clearTifo(k);
        this.ui.hooks.onTifo(k, null);
        this.render();
      });
    });
    q('.settings')!.addEventListener('click', () => this.ui.clubSettings());
    const name = q('.club-name') as HTMLInputElement;
    name.addEventListener('change', () => this.club.rename(name.value));
    name.addEventListener('keydown', (e) => e.key === 'Enter' && name.blur());
    name.addEventListener('change', () => {
      // A new name with no code of its own: show the code it now gives.
      if (!this.club.state.short) (q('.club-short') as HTMLInputElement).value = this.club.info().short;
    });
    const short = q('.club-short') as HTMLInputElement;
    short.addEventListener('input', () => {
      const v = short.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3);
      if (short.value !== v) short.value = v;
    });
    short.addEventListener('change', () => {
      this.club.setShort(short.value);
      short.value = this.club.info().short;
      this.ui.identityChanged();
    });
    short.addEventListener('keydown', (e) => e.key === 'Enter' && short.blur());

    const bt = q('.banner-text') as HTMLInputElement | null;
    bt?.addEventListener('input', () => {
      this.club.setBanner({ text: bt.value.toUpperCase().slice(0, 28) });
      const w = this.el.querySelector('.banner-words');
      if (w) w.textContent = this.club.state.banner.text || 'ONE CLUB · ONE NIGHT';
      this.ui.identityChanged();
    });
    bt?.addEventListener('keydown', (e) => e.key === 'Enter' && bt.blur());
    all('[data-bcolor]').forEach((b) =>
      b.addEventListener('click', () => {
        this.club.setBanner({ color: b.dataset.bcolor as 'main' | 'secondary' | 'dark' });
        this.ui.identityChanged();
        this.render();
      }),
    );
    all('[data-pattern]').forEach((b) => b.addEventListener('click', () => this.setKit({ pattern: Number(b.dataset.pattern) })));
    all('[data-kslot]').forEach((b) => b.addEventListener('click', () => ((this.kitSlot = b.dataset.kslot as typeof this.kitSlot), this.render())));
    all('[data-cslot]').forEach((b) => b.addEventListener('click', () => ((this.crestSlot = b.dataset.cslot as typeof this.crestSlot), this.render())));
    all('[data-part]').forEach((b) => b.addEventListener('click', () => ((this.crestPart = b.dataset.part as typeof this.crestPart), this.render())));
    all('[data-crest]').forEach((b) => b.addEventListener('click', () => this.setCrest({ [b.dataset.crest!]: Number(b.dataset.v) })));
    all('[data-stars]').forEach((b) => b.addEventListener('click', () => this.setCrest({ stars: Math.max(0, Math.min(5, this.club.state.crest.stars + Number(b.dataset.stars))) })));
    const pick = (c: number) => (this.tab === 'kit' ? this.setKit({ [this.kitSlot]: c }) : this.setCrest({ [this.crestSlot]: c }));
    all('[data-color]').forEach((b) => b.addEventListener('click', () => pick(Number(b.dataset.color))));
    const ci = q('.color-in') as HTMLInputElement | null;
    ci?.addEventListener('change', () => pick(parseInt(ci.value.slice(1), 16)));
    const text = q('.crest-text') as HTMLInputElement | null;
    text?.addEventListener('input', () => this.setCrest({ text: text.value.toUpperCase().replace(/[^A-Z0-9&.]/g, '').slice(0, 4) }, false));
    text?.addEventListener('change', () => this.render());
    const year = q('.crest-year') as HTMLInputElement | null;
    year?.addEventListener('input', () => this.setCrest({ year: year.value.replace(/\D/g, '').slice(0, 4) }, false));
    year?.addEventListener('change', () => this.render());
    q('.match-kit')?.addEventListener('click', () => {
      const k = this.club.state.kit;
      this.setCrest({ primary: k.main, secondary: k.secondary, accent: k.secondary === 0xffffff || k.main === 0xffffff ? 0x14121c : 0xffffff });
    });
  }

  private setKit(k: Partial<ClubKit>): void {
    this.club.setKit(k);
    this.ui.identityChanged();
    this.render();
  }

  /** `rerender` false while typing so the input keeps focus (the preview still updates). */
  private setCrest(c: Partial<Crest>, rerender = true): void {
    this.club.setCrest(c);
    this.ui.identityChanged();
    if (rerender) this.render();
    else {
      const stage = this.el.querySelector('.stage-main');
      if (stage) stage.innerHTML = crestSVG(this.club.state.crest, 'crest big');
    }
  }

  /** Back to the saved look: name, code, kit, crest, banner and tifo pictures. */
  private async restoreLook(): Promise<void> {
    if (!this.club.restoreLook()) return;
    restoreTifos();
    const imgs = await Promise.all(TIFOS.map((t) => loadTifo(t.id)));
    TIFOS.forEach((t, i) => this.ui.hooks.onTifo(t.id, imgs[i], false));
    this.ui.identityChanged();
    this.ui.toast('Back to your saved look');
    this.render();
  }

  private randomize(): void {
    const r = (n: number) => Math.floor(Math.random() * n);
    const pickC = () => PALETTE[r(PALETTE.length)];
    let a = pickC();
    let b = pickC();
    while (b === a) b = pickC();
    if (this.tab === 'tifos') {
      const colors = ['main', 'secondary', 'dark'] as const;
      this.club.setBanner({ color: colors[r(3)] });
      this.ui.identityChanged();
      this.render();
    } else if (this.tab === 'kit') this.setKit({ pattern: r(KIT_PATTERNS.length), main: a, secondary: b, shorts: Math.random() < 0.5 ? a : Math.random() < 0.5 ? b : 0xf3ede0 });
    else {
      let acc = pickC();
      while (acc === a || acc === b) acc = pickC();
      this.setCrest({ shape: r(CREST_SHAPES.length), division: r(CREST_DIVISIONS.length), emblem: 1 + r(CREST_EMBLEMS.length - 1), textStyle: r(3), border: 1 + r(4), stars: Math.random() < 0.3 ? 1 + r(3) : 0, primary: a, secondary: b, accent: acc });
    }
  }
}
