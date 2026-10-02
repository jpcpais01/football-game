import { type Card, RARITIES, RARITY_COLOR, RARITY_LABEL, overall, traitsOf } from '../meta/cards';
import { FREE_PACK_HOURS } from '../meta/club';
import { PACKS, type PackDef, openPack } from '../meta/packs';
import { cardBackHTML, cardHTML, esc } from './cardView';
import { Fx, Rays } from './fx';
import { fmt, fmtTime, freePackIn, type HomeUI } from './home';

function packArt(p: PackDef, cls = ''): string {
  const [c1, c2, c3] = p.colors;
  const emblem = { free: '◆', bronze: '●', silver: '★', gold: '★', legend: '✦' }[p.id] ?? '★';
  return `<div class="pack-art ${cls}" style="--c1:${c1};--c2:${c2};--c3:${c3}">
    <div class="pack-foil"></div>
    <div class="pack-emblem">${emblem}</div>
    <div class="pack-label">${p.name.split(' ')[0].toUpperCase()}</div>
    <div class="pack-count">${p.cards} players</div>
  </div>`;
}

export class StoreScreen {
  readonly el = document.createElement('div');

  constructor(private ui: HomeUI) {
    this.el.className = 'screen screen-store';
  }

  private get club() {
    return this.ui.club;
  }

  render(): void {
    const coins = this.club.state.coins;
    const freeMs = freePackIn(this.club);
    this.el.innerHTML = `
      <header class="topbar">
        <button class="back" aria-label="Back">‹</button>
        <h2 class="scr-title">Store</h2>
        <div class="grow"></div>
        <div class="coins-slot">${this.ui.coinsHTML()}</div>
      </header>
      <main class="shelf">
        ${PACKS.map((p) => {
          const free = p.price === 0;
          const can = free ? freeMs === 0 : coins >= p.price;
          return `<div class="pack-tile ${free ? 'free' : ''}" data-pack="${p.id}">
            <div class="pt-art">${packArt(p)}</div>
            <h3>${p.name}</h3>
            <p>${p.tagline}</p>
            <div class="pt-odds">${RARITIES.filter((r) => p.odds[r] > 0)
              .map((r) => `<span class="r-${r}" title="${RARITY_LABEL[r]}"><i></i>${p.odds[r] >= 1 ? Math.round(p.odds[r]) : p.odds[r]}%</span>`)
              .join('')}</div>
            <button class="buy ${can ? '' : 'locked'}" data-buy="${p.id}">
              ${free ? (freeMs === 0 ? 'Open free' : `<span class="free-t">${fmtTime(freeMs)}</span>`) : `<i class="coin"></i>${fmt(p.price)}`}
            </button>
          </div>`;
        }).join('')}
      </main>`;
    this.el.querySelector('.back')!.addEventListener('click', () => this.ui.go('home'));
    this.el.querySelectorAll<HTMLElement>('[data-buy]').forEach((b) => b.addEventListener('click', () => this.buy(b.dataset.buy!)));
    // Packs tilt toward the pointer.
    this.el.querySelectorAll<HTMLElement>('.pt-art').forEach((a) => {
      a.addEventListener('pointermove', (e) => {
        const r = a.getBoundingClientRect();
        const x = (e.clientX - r.left) / r.width - 0.5;
        const y = (e.clientY - r.top) / r.height - 0.5;
        a.style.setProperty('--rx', `${(-y * 18).toFixed(1)}deg`);
        a.style.setProperty('--ry', `${(x * 22).toFixed(1)}deg`);
      });
      a.addEventListener('pointerleave', () => {
        a.style.setProperty('--rx', '0deg');
        a.style.setProperty('--ry', '0deg');
      });
      a.addEventListener('click', () => this.buy(a.parentElement!.dataset.pack!));
    });
  }

  renderCoins(): void {
    const slot = this.el.querySelector('.coins-slot');
    if (slot) slot.innerHTML = this.ui.coinsHTML();
    const coins = this.club.state.coins;
    for (const p of PACKS) {
      if (p.price === 0) continue;
      this.el.querySelector(`[data-buy="${p.id}"]`)?.classList.toggle('locked', coins < p.price);
    }
  }

  tick(): void {
    const t = this.el.querySelector('.free-t');
    if (!t) return;
    const ms = freePackIn(this.club);
    if (ms === 0) this.render();
    else t.textContent = fmtTime(ms);
  }

  private buy(id: string): void {
    const p = PACKS.find((x) => x.id === id)!;
    const club = this.club;
    if (p.price === 0) {
      const ms = freePackIn(club);
      if (ms > 0) return this.ui.toast(`Next free pack in ${fmtTime(ms)}`);
      club.state.freePackAt = Date.now() + FREE_PACK_HOURS * 3600e3;
    } else if (!club.spend(p.price)) {
      return this.ui.toast(`Not enough coins · play a match to earn more`);
    }
    const cards = openPack(p);
    // Into the club straight away: closing the app mid-reveal never loses a pull.
    club.state.packsOpened++;
    club.addCards(cards);
    new Opening(this.ui, p, cards, () => this.render());
  }
}

// ==================================================================== the opening

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

class Opening {
  private el = document.createElement('div');
  private fx = new Fx();
  private rays = new Rays();
  private taps = 0;
  private phase: 'tease' | 'burst' | 'reveal' | 'await' | 'summary' = 'tease';
  private hurry: (() => void) | null = null;
  private next: (() => void) | null = null;
  private skipAll = false;
  private best: Card;
  private tier: number;

  constructor(
    private ui: HomeUI,
    private pack: PackDef,
    private cards: Card[],
    private onClose: () => void,
  ) {
    this.best = cards[cards.length - 1];
    this.tier = RARITIES.indexOf(this.best.rarity);
    this.el.className = 'opening';
    this.tint('#ffffff');
    this.el.innerHTML = `
      <div class="op-bg"></div>
      <div class="op-rays-slot"></div>
      <div class="op-spot"></div>
      <div class="op-stage">
        <div class="op-pack"><div class="op-aura"></div>${packArt(pack, 'big')}<div class="op-crack"></div></div>
        <div class="op-hint">Tap to open</div>
      </div>
      <div class="op-walkout"><div class="wo-item wo-flag"></div><div class="wo-item wo-pos"></div><div class="wo-item wo-ovr"></div></div>
      <div class="op-reveal">
        <div class="op-cardwrap"><div class="op-flip"><div class="op-front"></div><div class="op-backf"></div></div></div>
        <div class="op-caption"></div>
      </div>
      <div class="op-progress"></div>
      <button class="op-skip silent">Skip ›</button>
      <div class="op-summary"></div>
      <div class="op-flash"></div>`;
    this.el.querySelector('.op-bg')!.after(this.fx.canvas);
    this.el.querySelector('.op-rays-slot')!.replaceWith(this.rays.canvas);
    ui.root.appendChild(this.el);
    ui.audio.setAmbience(0);
    requestAnimationFrame(() => this.el.classList.add('in'));

    this.el.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).closest('button')) return;
      this.onTap();
    });
    this.el.querySelector('.op-skip')!.addEventListener('click', () => {
      this.skipAll = true;
      this.hurry?.();
      this.next?.();
      if (this.phase === 'tease') this.burst();
    });
  }

  /** The scene's light colour: background glow, rays, card glow. */
  private tint(color: string): void {
    this.el.style.setProperty('--rc', color);
    this.rays.set(color);
  }

  private q<T extends HTMLElement = HTMLElement>(s: string): T {
    return this.el.querySelector(s) as T;
  }

  /** A pause that a tap (or Skip) cuts short. */
  private beat(ms: number): Promise<void> {
    if (this.skipAll) return Promise.resolve();
    return new Promise((r) => {
      const t = setTimeout(done, ms);
      const self = this;
      function done() {
        clearTimeout(t);
        if (self.hurry === done) self.hurry = null;
        r();
      }
      this.hurry = done;
    });
  }

  private waitTap(): Promise<void> {
    if (this.skipAll) return Promise.resolve();
    this.phase = 'await';
    return new Promise((r) => {
      this.next = () => {
        this.next = null;
        r();
      };
    });
  }

  private center(sel: string): [number, number] {
    const r = this.q(sel).getBoundingClientRect();
    return [r.left + r.width / 2, r.top + r.height / 2];
  }

  private onTap(): void {
    if (this.phase === 'tease') this.charge();
    else if (this.phase === 'reveal') this.hurry?.();
    else if (this.phase === 'await') this.next?.();
  }

  // ---------------------------------------------------------------- tease: tap to charge

  private charge(): void {
    this.taps++;
    const pack = this.q('.op-pack');
    const [x, y] = this.center('.op-pack');
    // The glow hints at what's inside: white, then (for good packs) the best colour.
    const hint = this.taps >= 2 && this.tier >= 2 ? RARITY_COLOR[this.best.rarity] : this.tier >= 1 && this.taps >= 2 ? '#e6f1ff' : '#ffffff';
    this.tint(hint);
    pack.classList.remove('shake');
    void pack.offsetWidth;
    pack.classList.add('shake');
    pack.dataset.charge = String(this.taps);
    this.ui.audio.packShake(this.taps);
    this.fx.embers(x, y, hint, 6 + this.taps * 5, 220);
    this.fx.ring(x, y, hint, 160 + this.taps * 60, 0.5);
    navigator.vibrate?.(20 + this.taps * 20);
    if (this.taps >= 3) this.burst();
    else this.q('.op-hint').textContent = this.taps === 1 ? 'Again!' : 'One more!';
  }

  private async burst(): Promise<void> {
    if (this.phase !== 'tease') return;
    this.phase = 'burst';
    const color = this.tier >= 2 ? RARITY_COLOR[this.best.rarity] : '#ffffff';
    this.tint(color);
    const [x, y] = this.center('.op-pack');
    this.el.classList.add('burst');
    this.ui.audio.packBurst(this.tier);
    this.flash();
    this.fx.burst(x, y, [color, '#ffffff', color], 90 + this.tier * 30, 1100 + this.tier * 150);
    this.fx.ring(x, y, color, Math.max(innerWidth, innerHeight) * 0.8, 0.9);
    navigator.vibrate?.([60, 40, 120]);
    await wait(this.skipAll ? 50 : 700);
    this.el.classList.add('revealing');
    for (let i = 0; i < this.cards.length && !this.skipAll; i++) {
      await this.reveal(this.cards[i], i);
      await this.waitTap();
    }
    this.summary();
  }

  private flash(strength = 1): void {
    const f = this.q('.op-flash');
    f.style.setProperty('--f', String(strength));
    f.classList.remove('go');
    void f.offsetWidth;
    f.classList.add('go');
  }

  // ---------------------------------------------------------------- one card

  private async reveal(c: Card, i: number): Promise<void> {
    this.phase = 'reveal';
    const tier = RARITIES.indexOf(c.rarity);
    const color = RARITY_COLOR[c.rarity];
    const audio = this.ui.audio;
    const kit = this.ui.kit;
    this.q('.op-progress').textContent = `${i + 1} / ${this.cards.length}`;
    this.tint(tier >= 1 ? color : '#ffffff');
    this.el.dataset.tier = String(tier);

    const wrap = this.q('.op-cardwrap');
    const flip = this.q('.op-flip');
    const caption = this.q('.op-caption');
    caption.classList.remove('show');
    flip.classList.remove('flipped');
    wrap.className = 'op-cardwrap';
    this.q('.op-front').innerHTML = cardHTML(c, kit, 'xl');
    this.q('.op-backf').innerHTML = cardBackHTML(c.rarity);

    // Walkout for the good ones: nation, position, rating, each with a hit.
    if (tier >= 2) {
      this.el.classList.add('walkout');
      const steps: [string, string][] = [
        ['.wo-flag', c.nation],
        ['.wo-pos', c.position],
      ];
      if (tier >= 3) steps.push(['.wo-ovr', String(overall(c))]);
      for (let s = 0; s < steps.length; s++) {
        const [sel, txt] = steps[s];
        const item = this.q(sel);
        item.textContent = txt;
        item.classList.add('show');
        audio.stinger(s);
        this.flash(0.35);
        const [x, y] = this.center(sel);
        this.fx.ring(x, y, color, 260, 0.6);
        this.fx.embers(x, y, color, 10, 160);
        await this.beat(tier >= 3 ? 1150 : 950);
        item.classList.remove('show');
      }
      this.el.classList.remove('walkout');
    }

    // Card flies in face down.
    audio.whoosh();
    wrap.classList.add('enter');
    await this.beat(tier >= 2 ? 700 : 380);
    if (tier >= 2) {
      wrap.classList.add('charged');
      await this.beat(600);
    }

    // Flip!
    flip.classList.add('flipped');
    wrap.classList.add('landed');
    audio.reveal(tier);
    const [x, y] = this.center('.op-cardwrap');
    const colors = tier >= 4 ? ['#7ff6ff', '#ff7ae6', '#fff27a', '#ffffff'] : [color, '#ffffff'];
    this.fx.burst(x, y, colors, 40 + tier * 30, 650 + tier * 200);
    this.fx.ring(x, y, color, 220 + tier * 120, 0.7);
    if (tier >= 2) this.flash(0.5 + tier * 0.12);
    if (tier >= 3) {
      this.el.classList.remove('quake');
      void this.el.offsetWidth;
      this.el.classList.add('quake');
      this.fx.confetti(colors, 80 + tier * 20);
      this.fx.fountain(x, y + 120, colors, 30 + tier * 10);
      navigator.vibrate?.([80, 50, 160]);
    }
    const traits = traitsOf(c);
    caption.innerHTML = `<div class="cap-rar">${RARITY_LABEL[c.rarity]}${c.position === 'GK' ? ' · Goalkeeper' : ''}</div>
      <div class="cap-name">${esc(c.name)}</div>
      <div class="cap-body">${c.height} cm · ${c.weight} kg</div>
      ${traits.length ? `<div class="traits">${traits.map((t) => `<em>${t}</em>`).join('')}</div>` : ''}
      <div class="cap-tap">${i < this.cards.length - 1 ? 'Tap for next' : 'Tap to finish'}</div>`;
    await this.beat(260);
    caption.classList.add('show');
  }

  // ---------------------------------------------------------------- summary

  private summary(): void {
    this.phase = 'summary';
    this.el.classList.remove('walkout', 'revealing');
    this.el.classList.add('done');
    this.tint(RARITY_COLOR[this.best.rarity]);
    const kit = this.ui.kit;
    const again = this.pack.price > 0 && this.ui.club.state.coins >= this.pack.price;
    const s = this.q('.op-summary');
    s.innerHTML = `
      <h2>${esc(this.pack.name)}</h2>
      <div class="sum-grid">${[...this.cards]
        .reverse()
        .map((c, i) => `<div class="sum-item" style="--d:${i * 90}ms">${cardHTML(c, kit, i === 0 ? 'best' : '')}</div>`)
        .join('')}</div>
      <div class="sum-actions">
        <button class="btn-ghost sum-done">Done</button>
        ${again ? `<button class="btn-primary sum-again">Open another · <i class="coin"></i>${fmt(this.pack.price)}</button>` : ''}
        <button class="btn-ghost sum-squad">Go to squad</button>
      </div>`;
    if (this.skipAll) this.ui.audio.reveal(this.tier);
    s.querySelector('.sum-done')!.addEventListener('click', () => this.close());
    s.querySelector('.sum-squad')!.addEventListener('click', () => {
      this.close();
      this.ui.go('squad');
    });
    s.querySelector('.sum-again')?.addEventListener('click', () => {
      this.close();
      const p = this.pack;
      if (this.ui.club.spend(p.price)) {
        const cards = openPack(p);
        this.ui.club.state.packsOpened++;
        this.ui.club.addCards(cards);
        new Opening(this.ui, p, cards, this.onClose);
      }
    });
    s.querySelectorAll<HTMLElement>('.pcard').forEach((el) =>
      el.addEventListener('click', () => {
        const c = this.ui.club.card(el.dataset.card!);
        if (c) this.ui.openPlayer(c);
      }),
    );
  }

  private close(): void {
    this.fx.clear();
    this.el.classList.remove('in');
    setTimeout(() => this.el.remove(), 300);
    this.ui.audio.setAmbience(0.4);
    this.onClose();
  }
}
