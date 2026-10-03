import { PATCH_NOTES } from './patchNotes';
import '@fontsource/jersey-10/latin-400.css';
import '@fontsource/silkscreen/latin-400.css';
import './home.css';
import './retro.css';
import type { Club } from '../meta/club';
import { FREE_PACK_HOURS, GROUNDS, type Ground } from '../meta/club';
import { type Card, STAT_LABEL, type StatKey, overall, sellValue, traitsOf, RARITY_LABEL, bodyName } from '../meta/cards';
import type { TeamInfo } from '../sim/teams';
import type { GameAudio } from '../ui/audio';
import { avatarSVG, cardHTML, crestSVG, esc } from './cardView';
import { SquadScreen } from './squad';
import { ClubScreen } from './clubScreen';
import { crestSVG as clubCrestSVG } from '../meta/crest';
import { StoreScreen } from './store';
import type { TifoKind } from '../ui/tifos';

export interface HomeHooks {
  /** Start the demo match with this seed (the opponent shown on the home screen). */
  onPlay(seed: number): void;
  /** A tifo picture was uploaded (or taken down: null) in the club studio. `rebuild` false
   * when the stadium is about to be rebuilt anyway. */
  onTifo(kind: TifoKind, img: HTMLCanvasElement | null, rebuild?: boolean): void;
  /** Kit or crest changed: re-dress the players and the stadium. */
  onIdentity(): void;
  /** A ground was picked before kick-off: build it behind the menu (a live preview). */
  onGround(g: Ground): void;
}

type ScreenName = 'home' | 'squad' | 'store' | 'club';

export const fmt = (n: number) => n.toLocaleString('en-US');

export function freePackIn(club: Club): number {
  return Math.max(0, club.state.freePackAt - Date.now());
}

export function fmtTime(ms: number): string {
  const s = Math.ceil(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}:${String(ss).padStart(2, '0')}`;
}

/** The whole out-of-match app: home, squad, store, pack openings. */
export class HomeUI {
  readonly root = document.createElement('div');
  private homeEl = document.createElement('div');
  private squad: SquadScreen;
  private store: StoreScreen;
  private clubScreen: ClubScreen;
  private identityTimer = 0;
  private current: ScreenName = 'home';
  private modal = document.createElement('div');
  private toastEl = document.createElement('div');
  private timer = 0;
  /** Seed of the next match (the opponent previewed on the hero tile). */
  nextSeed = (Date.now() & 0xffff) + 1;

  constructor(
    parent: HTMLElement,
    readonly club: Club,
    readonly audio: GameAudio,
    readonly hooks: HomeHooks,
  ) {
    this.root.className = 'shell';
    this.homeEl.className = 'screen screen-home';
    this.squad = new SquadScreen(this);
    this.store = new StoreScreen(this);
    this.clubScreen = new ClubScreen(this);
    this.modal.className = 'modal hidden';
    this.toastEl.className = 'toast';
    this.root.append(this.homeEl, this.squad.el, this.store.el, this.clubScreen.el, this.modal, this.toastEl);
    parent.appendChild(this.root);

    // First touch anywhere unlocks audio (browsers need a gesture).
    this.root.addEventListener('pointerdown', () => this.audio.unlock(), { once: true });
    this.root.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest('button');
      if (t && !t.classList.contains('silent')) this.audio.uiTap();
    });
    this.modal.addEventListener('click', (e) => {
      if (e.target === this.modal || (e.target as HTMLElement).closest('.m-close')) this.closeModal();
    });

    club.onChange(() => this.refresh());
    this.renderHome();
    this.go('home');
    this.timer = window.setInterval(() => this.tickTimers(), 1000);
  }

  /** True while a full-screen panel covers the 3D background (skip rendering it). */
  get opaque(): boolean {
    return this.root.classList.contains('show') && this.current !== 'home';
  }

  get visible(): boolean {
    return this.root.classList.contains('show');
  }

  show(): void {
    this.root.classList.add('show');
    this.renderHome();
    this.audio.setAmbience(this.current === 'home' ? 1 : 0.4);
  }

  hide(): void {
    this.root.classList.remove('show');
    this.closeModal();
  }

  go(name: ScreenName): void {
    this.current = name;
    this.homeEl.classList.toggle('active', name === 'home');
    this.squad.el.classList.toggle('active', name === 'squad');
    this.store.el.classList.toggle('active', name === 'store');
    this.clubScreen.el.classList.toggle('active', name === 'club');
    if (name === 'club') this.clubScreen.render();
    if (name === 'squad') this.squad.render();
    if (name === 'store') this.store.render();
    if (name === 'home') this.renderHome();
    this.audio.setAmbience(name === 'home' ? 1 : 0.4);
  }

  private refresh(): void {
    if (this.current === 'home') this.renderHome();
    if (this.current === 'squad') this.squad.render();
    if (this.current === 'store') this.store.renderCoins();
  }

  private tickTimers(): void {
    if (!this.visible) return;
    if (this.current === 'home') {
      const el = this.homeEl.querySelector('.st-free');
      if (el) {
        const ms = freePackIn(this.club);
        el.textContent = ms > 0 ? `Free pack in ${fmtTime(ms)}` : 'Free pack ready!';
        el.classList.toggle('ready', ms === 0);
      }
    } else if (this.current === 'store') this.store.tick();
  }

  // ---------------------------------------------------------------- shared bits

  coinsHTML(): string {
    return `<div class="coins"><i class="coin"></i><b>${fmt(this.club.state.coins)}</b></div>`;
  }

  get kit() {
    return this.club.info().kit;
  }

  /** The club's crest as SVG. */
  crest(cls = 'crest'): string {
    return clubCrestSVG(this.club.state.crest, cls);
  }

  /** Kit / crest edits settle for a moment before the stadium is rebuilt. */
  identityChanged(): void {
    clearTimeout(this.identityTimer);
    this.identityTimer = window.setTimeout(() => this.hooks.onIdentity(), 450);
  }

  toast(msg: string): void {
    this.toastEl.textContent = msg;
    this.toastEl.classList.remove('show');
    void this.toastEl.offsetWidth;
    this.toastEl.classList.add('show');
  }

  openModal(html: string, cls = ''): HTMLElement {
    this.modal.className = `modal ${cls}`;
    this.modal.innerHTML = `<div class="m-box">${html}</div>`;
    return this.modal.firstElementChild as HTMLElement;
  }

  closeModal(): void {
    this.modal.className = 'modal hidden';
    this.modal.innerHTML = '';
  }

  // ---------------------------------------------------------------- home

  renderHome(): void {
    const c = this.club;
    const info = c.info();
    const opp = c.opponentInfo();
    const r = c.state.record;
    const myOvr = c.teamRating();
    const oppOvr = c.opponentLevel(this.nextSeed);
    const best = [...c.starters()].filter((x): x is Card => !!x).sort((a, b) => overall(b) - overall(a)).slice(0, 3);
    const freeMs = freePackIn(c);
    this.homeEl.innerHTML = `
      <header class="topbar">
        <button class="club-btn" aria-label="Club settings">
          ${this.crest()}
          <span><small>Your club · edit</small><b>${esc(info.name)}</b></span>
        </button>
        <div class="record" title="Won · Drawn · Lost">
          <span><b>${r.won}</b>W</span><span><b>${r.drawn}</b>D</span><span><b>${r.lost}</b>L</span>
        </div>
        <div class="grow"></div>
        ${this.coinsHTML()}
      </header>
      <main class="home-grid">
        <section class="tile hero">
          <div class="hero-stripes"></div>
          <div class="hero-glow"></div>
          <div class="kicker">Friendly · Demo match</div>
          <h1 class="hero-title">Kick Off</h1>
          <div class="matchup">
            <div class="mu-team">
              ${this.crest()}
              <div><b>${esc(info.name)}</b><span>${myOvr} OVR</span></div>
            </div>
            <div class="mu-vs">VS</div>
            <div class="mu-team away">
              ${crestSVG(opp.kit.shirt, opp.kit.shirt2, opp.short)}
              <div><b>${esc(opp.name)}</b><span>${oppOvr} OVR</span></div>
            </div>
          </div>
          <button class="play-btn"><span>Play match</span><i>▶</i></button>
          <div class="hero-reward">Win <b>+1,500</b> · Draw <b>+800</b> · <b>+150</b> per goal</div>
        </section>
        <button class="tile squad-tile">
          <div class="tile-head"><h2>Squad</h2><span class="chev">›</span></div>
          <div class="sq-ovr"><b>${myOvr}</b><span>Team<br>rating</span></div>
          <div class="sq-meta">${c.formation.name} · ${c.state.cards.length} players</div>
          <div class="sq-stars">
            ${best
              .map(
                (p) => `<div class="sq-star r-${p.rarity}"><div class="sq-face">${avatarSVG(p, this.kit.shirt, this.kit.shirt2, this.kit.gkShirt)}</div><b>${overall(p)}</b></div>`,
              )
              .join('')}
          </div>
        </button>
        <button class="tile store-tile">
          <div class="tile-head"><h2>Store</h2><span class="chev">›</span></div>
          <div class="st-pack">
            <div class="pack-art mini" style="--c1:#f4c542;--c2:#7a5410;--c3:#fff1b8"><div class="pack-foil"></div><div class="pack-emblem">★</div><div class="pack-label">GOLD</div></div>
            <div class="pack-art mini back2" style="--c1:#b05cff;--c2:#2a0f55;--c3:#f0d6ff"><div class="pack-foil"></div><div class="pack-emblem">✦</div></div>
          </div>
          <div class="st-free ${freeMs === 0 ? 'ready' : ''}">${freeMs > 0 ? `Free pack in ${fmtTime(freeMs)}` : 'Free pack ready!'}</div>
        </button>
      </main>
      <footer class="home-foot">
        <span class="hint">Landscape · joystick to move · Pass / Through / Shoot</span>
        <span class="grow"></span>
        <span class="ver">v${__APP_VERSION__}</span>
        <button class="notes" aria-label="Patch notes">Patch notes</button>
        <button class="update" aria-label="Check for update">Update ⟳</button>
      </footer>`;
    const q = (s: string) => this.homeEl.querySelector(s) as HTMLElement;
    q('.play-btn').addEventListener('click', () => this.pickGround());
    q('.squad-tile').addEventListener('click', () => this.go('squad'));
    q('.store-tile').addEventListener('click', () => this.go('store'));
    q('.club-btn').addEventListener('click', () => this.go('club'));
    q('.notes').addEventListener('click', () => this.patchNotes());
    q('.update').addEventListener('click', async (e) => {
      (e.currentTarget as HTMLButtonElement).textContent = 'Updating…';
      try {
        const regs = (await navigator.serviceWorker?.getRegistrations()) ?? [];
        await Promise.all(regs.map((x) => x.unregister()));
        if ('caches' in window) await Promise.all((await caches.keys()).map((k) => caches.delete(k)));
      } finally {
        location.reload();
      }
    });
  }

  /** Before kick-off: where to play. The last ground played at is preselected, and each
   * pick is built behind the menu so you see it before you start. */
  pickGround(): void {
    const pick = (g: Ground) => {
      this.club.setGround(g);
      this.hooks.onGround(g);
      box.querySelectorAll<HTMLElement>('[data-g]').forEach((b) => b.classList.toggle('on', b.dataset.g === g));
    };
    const cur = this.club.state.ground ?? 'stadium';
    const box = this.openModal(
      `<button class="m-close" aria-label="Close">✕</button>
      <div class="kicker">Before kick-off</div>
      <h3>Choose ground</h3>
      <div class="ground-list">${GROUNDS.map(
        (g) => `<button class="chip ground-opt ${g.id === cur ? 'on' : ''}" data-g="${g.id}"><b>${g.name}</b><span>${g.about}</span></button>`,
      ).join('')}</div>
      <div class="m-row"><button class="btn-primary kick-off">Kick off ▶</button></div>`,
      'small ground-modal',
    );
    box.querySelectorAll<HTMLElement>('[data-g]').forEach((b) => b.addEventListener('click', () => pick(b.dataset.g as Ground)));
    box.querySelector('.kick-off')!.addEventListener('click', () => {
      this.closeModal();
      this.hooks.onPlay(this.nextSeed);
    });
  }

  /** What's new: the patch notes, newest first. */
  patchNotes(): void {
    this.openModal(
      `<button class="m-close" aria-label="Close">✕</button>
      <h3>Patch notes</h3>
      <ul class="notes-list">${PATCH_NOTES.map((n) => `<li><b>v${n.v}</b><span>${esc(n.note)}</span></li>`).join('')}</ul>`,
      'small notes-modal',
    );
  }

  clubSettings(): void {
    const box = this.openModal(
      `<button class="m-close" aria-label="Close">✕</button>
      <h3>Club</h3>
      <label class="field"><span>Club name</span><input class="club-name" maxlength="24" value="${esc(this.club.state.name)}"></label>
      <div class="m-row">
        <button class="btn-primary save-name">Save</button>
      </div>
      <div class="m-stats">
        <span>Played <b>${this.club.state.record.played}</b></span>
        <span>Goals <b>${this.club.state.record.gf}–${this.club.state.record.ga}</b></span>
        <span>Packs opened <b>${this.club.state.packsOpened}</b></span>
      </div>
      <button class="btn-danger reset">Start a new club…</button>`,
      'small',
    );
    const input = box.querySelector('.club-name') as HTMLInputElement;
    box.querySelector('.save-name')!.addEventListener('click', () => {
      this.club.rename(input.value);
      this.closeModal();
    });
    const reset = box.querySelector('.reset') as HTMLButtonElement;
    reset.addEventListener('click', () => {
      if (!reset.classList.contains('armed')) {
        reset.classList.add('armed');
        reset.textContent = 'Tap again: lose every player and coin';
        return;
      }
      this.club.reset();
      this.closeModal();
      this.toast('New club founded');
    });
  }

  // ---------------------------------------------------------------- player detail

  openPlayer(c: Card): void {
    const starter = this.club.isStarter(c.id);
    const groups: [string, StatKey[]][] = [
      ['Physical', ['pace', 'accel', 'agility', 'stamina', 'strength', 'jumping']],
      ['Technical', ['power', 'shooting', 'passing', 'dribbling', 'defending', 'keeping']],
    ];
    const bar = (k: StatKey) => {
      const v = c.stats[k];
      const tier = v >= 85 ? 'hi' : v >= 70 ? 'mid' : v >= 55 ? 'lo' : 'bad';
      return `<div class="sbar"><span>${STAT_LABEL[k]}</span><i class="${tier}" style="--v:${v}%"></i><b>${v}</b></div>`;
    };
    const traits = traitsOf(c);
    const box = this.openModal(
      `<button class="m-close" aria-label="Close">✕</button>
      <div class="pd">
        <div class="pd-card">${cardHTML(c, this.kit, 'big')}</div>
        <div class="pd-info">
          <div class="pd-head">
            <h3>${esc(c.name)}</h3>
            <div class="pd-sub">${c.nation} · ${c.position} · ${RARITY_LABEL[c.rarity]} · #${c.number}</div>
            <div class="pd-body"><span><b>${c.height}</b> cm</span><span><b>${c.weight}</b> kg</span><span><b>${bodyName(c)}</b></span><span>Foot <b>${c.foot === 'L' ? 'Left' : 'Right'}</b></span></div>
            ${traits.length ? `<div class="traits">${traits.map((t) => `<em>${t}</em>`).join('')}</div>` : ''}
          </div>
          <div class="pd-stats">
            ${groups.map(([g, ks]) => `<div class="pd-group"><h4>${g}</h4>${ks.map(bar).join('')}</div>`).join('')}
          </div>
          <div class="m-row">
            ${
              starter
                ? `<span class="note">In your starting XI</span>`
                : `<button class="btn-ghost sell">Quick sell <i class="coin"></i>${fmt(sellValue(c))}</button>`
            }
          </div>
        </div>
      </div>`,
      'player',
    );
    const sell = box.querySelector('.sell') as HTMLButtonElement | null;
    sell?.addEventListener('click', () => {
      if (!sell.classList.contains('armed')) {
        sell.classList.add('armed');
        sell.innerHTML = `Confirm sell · <i class="coin"></i>${fmt(sellValue(c))}`;
        return;
      }
      const v = this.club.sell(c.id);
      this.audio.coins();
      this.closeModal();
      this.toast(`Sold ${c.name} for ${fmt(v)} coins`);
    });
  }

  // ---------------------------------------------------------------- full time

  showResult(gf: number, ga: number, home: TeamInfo, away: TeamInfo, onDone: () => void): void {
    const { coins, result } = this.club.recordResult(gf, ga);
    this.nextSeed = (Date.now() & 0xffff) + 1;
    const label = result === 'W' ? 'Victory' : result === 'D' ? 'Draw' : 'Defeat';
    const box = this.openModal(
      `<div class="res res-${result}">
        <div class="kicker">Full time</div>
        <h2 class="res-title">${label}</h2>
        <div class="res-score">
          <div class="res-team">${this.crest()}<span>${esc(home.name)}</span></div>
          <div class="res-num"><b>${gf}</b><em>–</em><b>${ga}</b></div>
          <div class="res-team">${crestSVG(away.kit.shirt, away.kit.shirt2, away.short)}<span>${esc(away.name)}</span></div>
        </div>
        <div class="res-coins"><i class="coin"></i>+<b class="res-count">0</b></div>
        <button class="btn-primary res-go">Continue</button>
      </div>`,
      'result',
    );
    const count = box.querySelector('.res-count') as HTMLElement;
    const t0 = performance.now();
    const step = (now: number) => {
      const k = Math.min(1, (now - t0 - 500) / 1200);
      count.textContent = fmt(Math.round(coins * Math.max(0, 1 - Math.pow(1 - Math.max(0, k), 3))));
      if (k < 1) requestAnimationFrame(step);
      else this.audio.coins();
    };
    requestAnimationFrame(step);
    box.querySelector('.res-go')!.addEventListener('click', () => {
      this.closeModal();
      onDone();
    });
  }

  dispose(): void {
    clearInterval(this.timer);
  }
}

export { FREE_PACK_HOURS };
