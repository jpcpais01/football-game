import { type Card, faceStats, overall, ratingIn, roleOf, fitFactor, bodyName } from '../meta/cards';
import { FORMATIONS } from '../meta/formations';
import { esc, tokenHTML } from './cardView';
import type { HomeUI } from './home';

type Filter = 'ALL' | 'GK' | 'DEF' | 'MID' | 'FWD';

/** Board coordinates: x (team frame, -1..~0.45) runs left -> right, z top -> bottom. */
const X0 = -1;
const X1 = 0.5;
const toLeft = (x: number) => 7 + ((x - X0) / (X1 - X0)) * 86;
const toTop = (z: number) => 6 + ((z + 1) / 2) * 88;
const fromLeft = (l: number) => X0 + ((l - 7) / 86) * (X1 - X0);
const fromTop = (t: number) => ((t - 6) / 88) * 2 - 1;

type DragSrc = { kind: 'slot'; i: number } | { kind: 'card'; id: string };

export class SquadScreen {
  readonly el = document.createElement('div');
  private selected = -1;
  private filter: Filter = 'ALL';
  private drag: {
    src: DragSrc;
    x0: number;
    y0: number;
    id: number;
    active: boolean;
    ghost: HTMLElement | null;
    over: HTMLElement | null;
  } | null = null;

  constructor(private ui: HomeUI) {
    this.el.className = 'screen screen-squad';
    this.el.addEventListener('pointerdown', (e) => this.onDown(e));
    this.el.addEventListener('pointermove', (e) => this.onMove(e));
    this.el.addEventListener('pointerup', (e) => this.onUp(e));
    this.el.addEventListener('pointercancel', () => this.cancelDrag());
  }

  private get club() {
    return this.ui.club;
  }

  render(): void {
    const c = this.club;
    const f = c.formation;
    const starters = c.starters();
    const kit = this.ui.kit;
    const sel = this.selected;
    const hasCustom = c.state.lineup.custom.some(Boolean);
    this.el.innerHTML = `
      <header class="topbar">
        <button class="back" aria-label="Back">‹</button>
        <h2 class="scr-title">Squad</h2>
        <div class="forms" role="tablist">
          ${FORMATIONS.map((x) => `<button class="chip ${x.id === f.id ? 'on' : ''}" data-form="${x.id}">${x.name}</button>`).join('')}
        </div>
        <div class="grow"></div>
        <div class="team-ovr"><b>${c.teamRating()}</b><span>OVR</span></div>
      </header>
      <main class="squad-main">
        <section class="board">
          <div class="pitch-wrap"><div class="pitch">
            <div class="pl pl-half"></div><div class="pl pl-circle"></div><div class="pl pl-box l"></div><div class="pl pl-box r"></div>
            <div class="pl pl-six l"></div><div class="pl pl-six r"></div><div class="attack">Attack ›</div>
            ${starters
              .map((p, i) => {
                const s = c.slot(i);
                return `<div class="token ${i === sel ? 'sel' : ''} ${s.pos === 'GK' ? 'gk' : ''}" data-slot="${i}" style="left:${toLeft(s.x)}%;top:${toTop(s.z)}%">${tokenHTML(p, s.pos, kit)}</div>`;
              })
              .join('')}
          </div></div>
          <div class="board-tools">
            <button class="tool auto">Auto-pick best XI</button>
            ${hasCustom ? '<button class="tool resetpos">Reset positions</button>' : ''}
            <span class="tip">${sel >= 0 ? `Pick a player for <b>${c.slot(sel).pos}</b> →` : 'Drag players to swap or move them · tap to change'}</span>
          </div>
        </section>
        <aside class="roster">
          ${this.rosterHTML(starters)}
        </aside>
      </main>`;
    const q = (s: string) => this.el.querySelector(s) as HTMLElement | null;
    q('.back')!.addEventListener('click', () => {
      this.selected = -1;
      this.ui.go('home');
    });
    this.el.querySelectorAll<HTMLElement>('[data-form]').forEach((b) =>
      b.addEventListener('click', () => {
        this.selected = -1;
        c.setFormation(b.dataset.form!);
      }),
    );
    q('.auto')!.addEventListener('click', () => {
      this.selected = -1;
      c.autoPick();
      this.ui.toast(`Best XI picked · ${c.teamRating()} OVR`);
    });
    q('.resetpos')?.addEventListener('click', () => c.resetPositions());
    this.el.querySelectorAll<HTMLElement>('[data-filter]').forEach((b) =>
      b.addEventListener('click', () => {
        this.filter = b.dataset.filter as Filter;
        this.render();
      }),
    );
    q('.cancel-sel')?.addEventListener('click', () => {
      this.selected = -1;
      this.render();
    });
  }

  private rosterHTML(starters: (Card | null)[]): string {
    const c = this.club;
    const sel = this.selected;
    const slotPos = sel >= 0 ? c.slot(sel).pos : null;
    let list = [...c.state.cards];
    if (slotPos) {
      // Choosing for a slot: best fits first, current occupant excluded.
      const cur = starters[sel]?.id;
      list = list.filter((x) => x.id !== cur).sort((a, b) => ratingIn(b, slotPos) - ratingIn(a, slotPos));
    } else {
      if (this.filter !== 'ALL') list = list.filter((x) => roleOf(x.position) === this.filter);
      list.sort((a, b) => Number(c.isStarter(b.id)) - Number(c.isStarter(a.id)) || overall(b) - overall(a));
    }
    const head = slotPos
      ? `<div class="ro-head picking"><span>Choose <b>${slotPos}</b></span><button class="chip cancel-sel">Cancel</button></div>`
      : `<div class="ro-head">${(['ALL', 'GK', 'DEF', 'MID', 'FWD'] as Filter[])
          .map((f) => `<button class="chip ${f === this.filter ? 'on' : ''}" data-filter="${f}">${f === 'ALL' ? `All ${c.state.cards.length}` : f}</button>`)
          .join('')}</div>`;
    const rows = list
      .map((p) => {
        const starter = c.isStarter(p.id);
        const r = slotPos ? ratingIn(p, slotPos) : overall(p);
        const fit = slotPos ? fitFactor(p.position, slotPos) : 1;
        const fs = faceStats(p);
        return `<div class="row r-${p.rarity} ${starter ? 'starter' : ''}" data-card="${p.id}">
          <div class="ro-ovr"><b>${r}</b><span>${p.position}</span></div>
          <div class="ro-main">
            <div class="ro-name">${p.nation} ${esc(p.name)} ${starter ? '<em>XI</em>' : ''} ${slotPos && fit < 1 ? `<i class="fitw ${fit >= 0.85 ? 'ok' : 'bad'}">${fit >= 0.85 ? 'Close fit' : 'Out of position'}</i>` : ''}</div>
            <div class="ro-stats">${fs.map(([k, v]) => `<span class="${v >= 80 ? 'hi' : v < 55 ? 'lo' : ''}">${k} <b>${v}</b></span>`).join('')}<span class="body">${p.height}cm · ${p.weight}kg · ${bodyName(p)}</span></div>
          </div>
        </div>`;
      })
      .join('');
    return `${head}<div class="ro-list">${rows || '<p class="empty-note">No players here yet. Open packs in the Store!</p>'}</div>`;
  }

  // ---------------------------------------------------------------- pointer handling

  private onDown(e: PointerEvent): void {
    if (e.button !== 0 || this.drag) return;
    const t = e.target as HTMLElement;
    const tok = t.closest<HTMLElement>('.token');
    const row = t.closest<HTMLElement>('.row');
    let src: DragSrc | null = null;
    if (tok) src = { kind: 'slot', i: Number(tok.dataset.slot) };
    else if (row) src = { kind: 'card', id: row.dataset.card! };
    else if (t.closest('.pitch') && this.selected >= 0) {
      this.selected = -1;
      this.render();
      return;
    }
    if (!src) return;
    this.drag = { src, x0: e.clientX, y0: e.clientY, id: e.pointerId, active: false, ghost: null, over: null };
  }

  private onMove(e: PointerEvent): void {
    const d = this.drag;
    if (!d || e.pointerId !== d.id) return;
    const dx = e.clientX - d.x0;
    const dy = e.clientY - d.y0;
    if (!d.active) {
      // Rows only start a drag on a mostly-horizontal move (vertical = scroll the list).
      const far = Math.hypot(dx, dy) > 8;
      if (!far) return;
      if (d.src.kind === 'card' && Math.abs(dy) > Math.abs(dx)) {
        this.drag = null;
        return;
      }
      d.active = true;
      this.el.setPointerCapture?.(e.pointerId);
      d.ghost = this.makeGhost(d.src);
      this.el.classList.add('dragging');
    }
    if (d.ghost) d.ghost.style.transform = `translate(${e.clientX}px, ${e.clientY}px) translate(-50%, -60%) scale(1.12)`;
    const over = this.dropTarget(e.clientX, e.clientY, d.src);
    if (over !== d.over) {
      d.over?.classList.remove('drop');
      over?.classList.add('drop');
      d.over = over;
    }
  }

  private onUp(e: PointerEvent): void {
    const d = this.drag;
    if (!d || e.pointerId !== d.id) return;
    this.drag = null;
    d.ghost?.remove();
    d.over?.classList.remove('drop');
    this.el.classList.remove('dragging');
    const c = this.club;
    if (!d.active) {
      this.tap(d.src);
      return;
    }
    const target = this.dropTarget(e.clientX, e.clientY, d.src);
    const tSlot = target?.classList.contains('token') ? Number(target.dataset.slot) : -1;
    const tCard = target?.classList.contains('row') ? target.dataset.card! : null;
    this.selected = -1;
    if (d.src.kind === 'slot') {
      const i = d.src.i;
      if (tSlot >= 0 && tSlot !== i) c.swapSlots(i, tSlot);
      else if (tCard) {
        const fromCard = c.state.lineup.slots[i];
        if (tCard !== fromCard) c.assign(i, tCard);
      } else if (target?.classList.contains('pitch')) {
        const r = target.getBoundingClientRect();
        const l = ((e.clientX - r.left) / r.width) * 100;
        const t = ((e.clientY - r.top) / r.height) * 100;
        if (c.slot(i).pos === 'GK') this.ui.toast('The keeper stays in goal');
        else c.moveSlot(i, fromLeft(l), fromTop(t));
      } else this.render();
    } else {
      if (tSlot >= 0) c.assign(tSlot, d.src.id);
      else this.render();
    }
  }

  private cancelDrag(): void {
    if (!this.drag) return;
    this.drag.ghost?.remove();
    this.drag.over?.classList.remove('drop');
    this.el.classList.remove('dragging');
    this.drag = null;
  }

  private tap(src: DragSrc): void {
    const c = this.club;
    if (src.kind === 'slot') {
      if (this.selected === src.i) {
        // Second tap: open the player.
        const p = c.card(c.state.lineup.slots[src.i]);
        this.selected = -1;
        this.render();
        if (p) this.ui.openPlayer(p);
        return;
      }
      this.selected = src.i;
      this.render();
      return;
    }
    if (this.selected >= 0) {
      const i = this.selected;
      this.selected = -1;
      c.assign(i, src.id);
      return;
    }
    const p = c.card(src.id);
    if (p) this.ui.openPlayer(p);
  }

  private dropTarget(x: number, y: number, src: DragSrc): HTMLElement | null {
    const el = document.elementFromPoint(x, y) as HTMLElement | null;
    if (!el) return null;
    const tok = el.closest<HTMLElement>('.token');
    if (tok) return src.kind === 'slot' && Number(tok.dataset.slot) === src.i ? (tok.parentElement as HTMLElement) : tok;
    if (src.kind === 'slot') {
      const row = el.closest<HTMLElement>('.row');
      if (row) return row;
      const pitch = el.closest<HTMLElement>('.pitch');
      if (pitch) return pitch;
    }
    return null;
  }

  private makeGhost(src: DragSrc): HTMLElement {
    const g = document.createElement('div');
    g.className = 'drag-ghost';
    const c = this.club;
    if (src.kind === 'slot') {
      const tok = this.el.querySelector<HTMLElement>(`.token[data-slot="${src.i}"]`);
      g.innerHTML = tok?.innerHTML ?? '';
      tok?.classList.add('lifted');
    } else {
      const p = c.card(src.id)!;
      g.innerHTML = tokenHTML(p, p.position, this.ui.kit);
    }
    document.body.appendChild(g);
    return g;
  }
}
