// The player's club: collection, line-up, coins. Saved on this device.

import { TEAMS, type Kit, type TeamInfo } from '../sim/teams';
import { type Crest, defaultCrest } from './crest';
import type { MatchSetup, TeamSetup } from '../sim/match';
import { Rng, clamp } from '../sim/vec';
import { type Card, type Position, type Rarity, generateCard, overall, ratingIn, roleOf, toSim, sellValue } from './cards';
import { FORMATIONS, SLOT_BOUNDS, formationById, type FSlot } from './formations';

const KEY = 'gamenight-club-v1';
export const START_COINS = 6000;
export const FREE_PACK_HOURS = 4;

export interface Lineup {
  formation: string;
  /** Card id per slot (11). */
  slots: (string | null)[];
  /** Custom slot placement per index (null = formation default). */
  custom: (FSlot | null)[];
}

/** The club's own kit: shirt design and colours. */
export interface ClubKit {
  pattern: number;
  main: number;
  secondary: number;
  shorts: number;
}

export function defaultKit(): ClubKit {
  const k = TEAMS[0].kit;
  return { pattern: 0, main: k.shirt, secondary: k.shirt2, shorts: k.shorts };
}

export interface ClubState {
  v: 1;
  name: string;
  coins: number;
  cards: Card[];
  lineup: Lineup;
  record: { played: number; won: number; drawn: number; lost: number; gf: number; ga: number };
  packsOpened: number;
  kit: ClubKit;
  crest: Crest;
  freePackAt: number; // ms timestamp when the free pack is next available
}

type Listener = () => void;

export class Club {
  state: ClubState;
  private listeners = new Set<Listener>();

  constructor() {
    this.state = this.load() ?? this.fresh();
    this.repair();
    this.save();
  }

  // ---------------------------------------------------------------- persistence

  private fresh(): ClubState {
    const rng = new Rng((Date.now() ^ 0x5bd1e995) & 0x7fffffff);
    // Starter squad: a full, mostly-common team with a couple of rares to build around.
    const want: [Position, Rarity][] = [
      ['GK', 'common'], ['GK', 'common'],
      ['CB', 'common'], ['CB', 'common'], ['CB', 'rare'], ['LB', 'common'], ['RB', 'common'],
      ['CDM', 'common'], ['CM', 'common'], ['CM', 'common'], ['CAM', 'common'], ['LM', 'common'], ['RM', 'common'],
      ['LW', 'common'], ['RW', 'common'], ['ST', 'rare'], ['ST', 'common'],
    ];
    const cards = want.map(([p, r]) => generateCard(rng, r, p));
    const s: ClubState = {
      v: 1,
      name: TEAMS[0].name,
      coins: START_COINS,
      cards,
      lineup: { formation: '433', slots: Array(11).fill(null), custom: Array(11).fill(null) },
      record: { played: 0, won: 0, drawn: 0, lost: 0, gf: 0, ga: 0 },
      packsOpened: 0,
      kit: defaultKit(),
      crest: defaultCrest(),
      freePackAt: 0,
    };
    this.state = s;
    this.autoPick();
    return s;
  }

  private load(): ClubState | null {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return null;
      const s = JSON.parse(raw) as ClubState;
      return s && s.v === 1 && Array.isArray(s.cards) ? s : null;
    } catch {
      return null;
    }
  }

  /** Keep a loaded save consistent (missing cards, wrong lengths). */
  private repair(): void {
    this.state.kit = { ...defaultKit(), ...(this.state.kit ?? {}) };
    this.state.crest = { ...defaultCrest(), ...(this.state.crest ?? {}) };
    const l = this.state.lineup;
    l.slots = Array.from({ length: 11 }, (_, i) => l.slots?.[i] ?? null);
    l.custom = Array.from({ length: 11 }, (_, i) => l.custom?.[i] ?? null);
    const ids = new Set(this.state.cards.map((c) => c.id));
    const seen = new Set<string>();
    l.slots = l.slots.map((id) => (id && ids.has(id) && !seen.has(id) ? (seen.add(id), id) : null));
    if (l.slots.some((s) => s === null)) this.fillGaps();
  }

  save(): void {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.state));
    } catch {
      /* storage full / unavailable: keep playing in memory */
    }
    for (const f of this.listeners) f();
  }

  onChange(f: Listener): () => void {
    this.listeners.add(f);
    return () => this.listeners.delete(f);
  }

  reset(): void {
    try {
      localStorage.removeItem(KEY);
    } catch {
      /* ignore */
    }
    this.state = this.fresh();
    this.save();
  }

  // ---------------------------------------------------------------- queries

  card(id: string | null): Card | null {
    return id ? (this.state.cards.find((c) => c.id === id) ?? null) : null;
  }

  get formation() {
    return formationById(this.state.lineup.formation);
  }

  /** Effective slot (custom placement or the formation default). */
  slot(i: number): FSlot {
    return this.state.lineup.custom[i] ?? this.formation.slots[i];
  }

  starters(): (Card | null)[] {
    return this.state.lineup.slots.map((id) => this.card(id));
  }

  isStarter(id: string): boolean {
    return this.state.lineup.slots.includes(id);
  }

  bench(): Card[] {
    return this.state.cards.filter((c) => !this.isStarter(c.id)).sort((a, b) => overall(b) - overall(a));
  }

  /** Team rating: average of the starters in their slots. */
  teamRating(): number {
    const s = this.starters();
    let sum = 0;
    for (let i = 0; i < 11; i++) {
      const c = s[i];
      sum += c ? ratingIn(c, this.slot(i).pos) : 30;
    }
    return Math.round(sum / 11);
  }

  // ---------------------------------------------------------------- line-up edits

  setFormation(id: string): void {
    if (!FORMATIONS.some((f) => f.id === id)) return;
    const old = this.starters();
    this.state.lineup.formation = id;
    this.state.lineup.custom = Array(11).fill(null);
    // Re-seat the same eleven where they fit best (keeper stays in goal).
    const pool = old.filter((c): c is Card => !!c);
    const slots: (string | null)[] = Array(11).fill(null);
    const order = this.formation.slots.map((_, i) => i).sort((a, b) => (this.formation.slots[a].pos === 'GK' ? -1 : 0) - (this.formation.slots[b].pos === 'GK' ? -1 : 0));
    for (const i of order) {
      const pos = this.formation.slots[i].pos;
      let best = -1;
      let bestR = -1;
      pool.forEach((c, k) => {
        const r = ratingIn(c, pos);
        if (r > bestR) (bestR = r), (best = k);
      });
      if (best >= 0) slots[i] = pool.splice(best, 1)[0].id;
    }
    this.state.lineup.slots = slots;
    this.save();
  }

  /** Put a card in a slot. If it was already in another slot, the two swap. */
  assign(slotIndex: number, cardId: string): void {
    const l = this.state.lineup.slots;
    const from = l.indexOf(cardId);
    const prev = l[slotIndex];
    l[slotIndex] = cardId;
    if (from >= 0 && from !== slotIndex) l[from] = prev;
    this.save();
  }

  swapSlots(a: number, b: number): void {
    const l = this.state.lineup.slots;
    [l[a], l[b]] = [l[b], l[a]];
    this.save();
  }

  /** Move a slot on the board; its position label follows the zone it lands in. */
  moveSlot(i: number, x: number, z: number): void {
    const base = this.formation.slots[i];
    if (base.pos === 'GK') return;
    x = clamp(x, SLOT_BOUNDS.minX, SLOT_BOUNDS.maxX);
    z = clamp(z, SLOT_BOUNDS.minZ, SLOT_BOUNDS.maxZ);
    this.state.lineup.custom[i] = { pos: zonePosition(x, z), x, z };
    this.save();
  }

  resetPositions(): void {
    this.state.lineup.custom = Array(11).fill(null);
    this.save();
  }

  /** Best available eleven for the current formation. */
  autoPick(): void {
    const slots: (string | null)[] = Array(11).fill(null);
    const pool = [...this.state.cards];
    const f = this.formation;
    // Hardest-to-fill slots first: keeper, then by scarcity of natural players.
    const order = f.slots
      .map((_, i) => ({ i, pos: this.slot(i).pos, n: pool.filter((c) => c.position === this.slot(i).pos).length }))
      .sort((a, b) => (a.pos === 'GK' ? -1 : b.pos === 'GK' ? 1 : a.n - b.n));
    for (const { i, pos } of order) {
      let best = -1;
      let bestR = -1;
      pool.forEach((c, k) => {
        const r = ratingIn(c, pos);
        if (r > bestR) (bestR = r), (best = k);
      });
      if (best >= 0) slots[i] = pool.splice(best, 1)[0].id;
    }
    // Polish the greedy pick: swap any two starters, or a starter with a bench player,
    // while it raises the total (natural positions win ties, so nobody plays out of
    // position for no gain).
    const score = (c: Card | null, i: number) => (c ? ratingIn(c, this.slot(i).pos) + (c.position === this.slot(i).pos ? 0.5 : 0) : 0);
    const card = (id: string | null) => this.card(id);
    for (let pass = 0, improved = true; improved && pass < 8; pass++) {
      improved = false;
      for (let a = 0; a < 11; a++) {
        for (let b = a + 1; b < 11; b++) {
          const ca = card(slots[a]);
          const cb = card(slots[b]);
          if (score(cb, a) + score(ca, b) > score(ca, a) + score(cb, b) + 0.01) {
            [slots[a], slots[b]] = [slots[b], slots[a]];
            improved = true;
          }
        }
        for (let k = 0; k < pool.length; k++) {
          const ca = card(slots[a]);
          if (score(pool[k], a) > score(ca, a) + 0.01) {
            const out = ca;
            slots[a] = pool[k].id;
            if (out) pool[k] = out;
            else pool.splice(k, 1);
            improved = true;
          }
        }
      }
    }
    this.state.lineup.slots = slots;
    this.save();
  }

  private fillGaps(): void {
    const l = this.state.lineup.slots;
    const pool = this.state.cards.filter((c) => !l.includes(c.id));
    for (let i = 0; i < 11; i++) {
      if (l[i]) continue;
      const pos = this.slot(i).pos;
      let best = -1;
      let bestR = -1;
      pool.forEach((c, k) => {
        const r = ratingIn(c, pos);
        if (r > bestR) (bestR = r), (best = k);
      });
      if (best >= 0) l[i] = pool.splice(best, 1)[0].id;
    }
  }

  // ---------------------------------------------------------------- collection

  addCards(cards: Card[]): void {
    this.state.cards.push(...cards);
    this.save();
  }

  /** Quick-sell a card from the bench (starters can't be sold). */
  sell(id: string): number {
    if (this.isStarter(id)) return 0;
    const c = this.card(id);
    if (!c) return 0;
    const v = sellValue(c);
    this.state.cards = this.state.cards.filter((x) => x.id !== id);
    this.state.coins += v;
    this.save();
    return v;
  }

  spend(coins: number): boolean {
    if (this.state.coins < coins) return false;
    this.state.coins -= coins;
    this.save();
    return true;
  }

  rename(name: string): void {
    const n = name.trim().slice(0, 24);
    if (n) this.state.name = n;
    this.save();
  }

  // ---------------------------------------------------------------- matches

  info(): TeamInfo {
    const name = this.state.name;
    const words = name.toUpperCase().replace(/[^A-Z ]/g, '').split(/\s+/).filter(Boolean);
    const short = words.length >= 3 ? words.slice(0, 3).map((w) => w[0]).join('') : (words[0] ?? 'GNC').slice(0, 3);
    const k = this.state.kit;
    const kit: Kit = { ...TEAMS[0].kit, shirt: k.main, shirt2: k.secondary, shorts: k.shorts, socks: k.main, pattern: k.pattern };
    return { ...TEAMS[0], name, short, kit };
  }

  setKit(k: Partial<ClubKit>): void {
    this.state.kit = { ...this.state.kit, ...k };
    this.save();
  }

  setCrest(c: Partial<Crest>): void {
    this.state.crest = { ...this.state.crest, ...c };
    this.save();
  }

  /** The opponent's kit: their usual one, or the change kit if it would clash with ours. */
  opponentInfo(): TeamInfo {
    const base = TEAMS[1];
    const ours = this.state.kit;
    const dist = (a: number, b: number) => Math.hypot(((a >> 16) & 255) - ((b >> 16) & 255), ((a >> 8) & 255) - ((b >> 8) & 255), (a & 255) - (b & 255));
    if (dist(ours.main, base.kit.shirt) > 120 && dist(ours.shorts, base.kit.shorts) > 60) return base;
    const change: Kit = { ...base.kit, shirt: 0x1f6b4a, shirt2: 0xf1ebdc, shorts: 0xf1ebdc, socks: 0x1f6b4a };
    if (dist(ours.main, change.shirt) < 120) Object.assign(change, { shirt: 0x2a2440, socks: 0x2a2440, shirt2: 0xffd447, shorts: 0x2a2440 });
    return { ...base, kit: change };
  }

  teamSetup(): TeamSetup {
    const s = this.starters();
    return {
      info: this.info(),
      players: s.map((c, i) => {
        const slot = this.slot(i);
        const fallback = c ?? generateCard(new Rng(i + 1), 'common', slot.pos, 45);
        return { ...toSim(fallback, slot.pos), role: roleOf(slot.pos), x: slot.x, z: slot.z };
      }),
    };
  }

  /** Today's opponent: built around our level so matches stay competitive. */
  opponentLevel(seed: number): number {
    return clamp(this.teamRating() + Math.round(new Rng(seed).gauss() * 2) + 1, 55, 92);
  }

  opponent(seed: number): TeamSetup {
    const rng = new Rng(seed);
    const level = this.opponentLevel(seed);
    rng.gauss();
    const f = FORMATIONS[Math.floor(rng.next() * 3)];
    const rarityFor = (o: number): Rarity => (o >= 88 ? 'icon' : o >= 82 ? 'legendary' : o >= 74 ? 'epic' : o >= 64 ? 'rare' : 'common');
    return {
      info: this.opponentInfo(),
      players: f.slots.map((slot) => {
        const o = clamp(Math.round(level + rng.gauss() * 3), 45, 95);
        const c = generateCard(rng, rarityFor(o), slot.pos, o);
        return { ...toSim(c, slot.pos), role: roleOf(slot.pos), x: slot.x, z: slot.z };
      }),
    };
  }

  matchSetup(seed: number): MatchSetup {
    return { teams: [this.teamSetup(), this.opponent(seed)] };
  }

  /** Walked off: booked as a 0-3 defeat, no coins. */
  recordForfeit(): void {
    const r = this.state.record;
    r.played++;
    r.lost++;
    r.ga += 3;
    this.save();
  }

  /** Book a finished match; returns the coins earned. */
  recordResult(gf: number, ga: number): { coins: number; result: 'W' | 'D' | 'L' } {
    const r = this.state.record;
    r.played++;
    r.gf += gf;
    r.ga += ga;
    const result = gf > ga ? 'W' : gf === ga ? 'D' : 'L';
    if (result === 'W') r.won++;
    else if (result === 'D') r.drawn++;
    else r.lost++;
    const coins = (result === 'W' ? 1500 : result === 'D' ? 800 : 400) + gf * 150;
    this.state.coins += coins;
    this.save();
    return { coins, result };
  }
}

/** Position label for a spot on the board (team frame). */
export function zonePosition(x: number, z: number): Position {
  const side = z < 0 ? 'L' : 'R';
  const wide = Math.abs(z);
  if (x < -0.52) return wide > 0.5 ? (`${side}B` as Position) : 'CB';
  if (x < -0.3) return wide > 0.55 ? (`${side}M` as Position) : 'CDM';
  if (x < -0.1) return wide > 0.55 ? (`${side}M` as Position) : 'CM';
  if (x < 0.1) return wide > 0.5 ? (`${side}M` as Position) : 'CAM';
  return wide > 0.42 ? (`${side}W` as Position) : 'ST';
}
