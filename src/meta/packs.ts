import { Rng } from '../sim/vec';
import { type Card, type Rarity, RARITIES, generateCard, overall } from './cards';

export interface PackDef {
  id: string;
  name: string;
  tagline: string;
  price: number; // 0 = the free pack (on a timer)
  cards: number;
  /** Chance weights per rarity for each card. */
  odds: Record<Rarity, number>;
  /** At least one card of this rarity or better. */
  guarantee?: Rarity;
  /** Pack art colours. */
  colors: [string, string, string];
}

export const PACKS: PackDef[] = [
  {
    id: 'free',
    name: 'Daily Pack',
    tagline: 'Free every few hours',
    price: 0,
    cards: 3,
    odds: { common: 80, rare: 17, epic: 2.7, legendary: 0.3, icon: 0 },
    colors: ['#3b7a57', '#1e3f2e', '#9be0b4'],
  },
  {
    id: 'bronze',
    name: 'Bronze Pack',
    tagline: '5 players',
    price: 750,
    cards: 5,
    odds: { common: 72, rare: 23, epic: 4.4, legendary: 0.55, icon: 0.05 },
    colors: ['#b8763f', '#5a3216', '#f0c08a'],
  },
  {
    id: 'silver',
    name: 'Silver Pack',
    tagline: '5 players · 1 Rare+',
    price: 2000,
    cards: 5,
    odds: { common: 45, rare: 43, epic: 10.5, legendary: 1.3, icon: 0.2 },
    guarantee: 'rare',
    colors: ['#aab7c7', '#3d4a5c', '#f2f6fb'],
  },
  {
    id: 'gold',
    name: 'Gold Pack',
    tagline: '6 players · 1 Epic+',
    price: 5000,
    cards: 6,
    odds: { common: 20, rare: 50, epic: 25, legendary: 4.4, icon: 0.6 },
    guarantee: 'epic',
    colors: ['#f4c542', '#7a5410', '#fff1b8'],
  },
  {
    id: 'legend',
    name: 'Legend Pack',
    tagline: '3 players · 1 Legend+',
    price: 12000,
    cards: 3,
    odds: { common: 0, rare: 35, epic: 45, legendary: 17, icon: 3 },
    guarantee: 'legendary',
    colors: ['#b05cff', '#2a0f55', '#f0d6ff'],
  },
];

function roll(rng: Rng, odds: Record<Rarity, number>): Rarity {
  let total = 0;
  for (const r of RARITIES) total += odds[r];
  let x = rng.next() * total;
  for (const r of RARITIES) {
    x -= odds[r];
    if (x <= 0) return r;
  }
  return 'common';
}

/** Open a pack: cards sorted so the best one is revealed last. */
export function openPack(def: PackDef, seed = Date.now()): Card[] {
  const rng = new Rng((seed ^ 0x9e3779b9) >>> 0);
  const rarities: Rarity[] = [];
  for (let i = 0; i < def.cards; i++) rarities.push(roll(rng, def.odds));
  if (def.guarantee) {
    const min = RARITIES.indexOf(def.guarantee);
    if (!rarities.some((r) => RARITIES.indexOf(r) >= min)) {
      // Upgrade one card: usually exactly to the guarantee, sometimes beyond.
      let r = min;
      while (r < RARITIES.length - 1 && rng.next() < 0.12) r++;
      rarities[0] = RARITIES[r];
    }
  }
  const cards = rarities.map((r) => generateCard(rng, r));
  return cards.sort((a, b) => RARITIES.indexOf(a.rarity) - RARITIES.indexOf(b.rarity) || overall(a) - overall(b));
}
