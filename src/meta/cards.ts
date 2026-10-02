// Player cards: the club's collection. Stats are 1..99 (FIFA style) plus a real body
// (height / weight), and every one of them feeds the simulation (see toSim()).

import type { Attributes, Role } from '../sim/player';
import { HAIR_COLORS, SKIN_TONES } from '../sim/teams';
import { Rng, clamp } from '../sim/vec';

export type Position = 'GK' | 'CB' | 'LB' | 'RB' | 'CDM' | 'CM' | 'CAM' | 'LM' | 'RM' | 'LW' | 'RW' | 'ST';
export const POSITIONS: Position[] = ['GK', 'CB', 'LB', 'RB', 'CDM', 'CM', 'CAM', 'LM', 'RM', 'LW', 'RW', 'ST'];

export type Rarity = 'common' | 'rare' | 'epic' | 'legendary' | 'icon';
export const RARITIES: Rarity[] = ['common', 'rare', 'epic', 'legendary', 'icon'];
export const RARITY_LABEL: Record<Rarity, string> = {
  common: 'Common',
  rare: 'Rare',
  epic: 'Epic',
  legendary: 'Legendary',
  icon: 'Icon',
};
/** Overall range per rarity. */
const RARITY_OVR: Record<Rarity, [number, number]> = {
  common: [52, 64],
  rare: [64, 74],
  epic: [74, 82],
  legendary: [82, 88],
  icon: [88, 94],
};
export const RARITY_COLOR: Record<Rarity, string> = {
  common: '#c98d55',
  rare: '#cfd8e3',
  epic: '#ffd447',
  legendary: '#c27bff',
  icon: '#7ff6ff',
};

export interface Stats {
  pace: number; // top speed
  accel: number; // first steps
  agility: number; // turning, cutting
  stamina: number; // how long he can sprint
  strength: number; // duels, shielding
  jumping: number; // aerial reach
  power: number; // kick power (shots, clearances, headers)
  passing: number;
  shooting: number; // finishing accuracy
  dribbling: number; // close control, first touch
  defending: number; // tackling, marking
  keeping: number; // goalkeepers
}
export type StatKey = keyof Stats;
export const STAT_KEYS: StatKey[] = ['pace', 'accel', 'agility', 'stamina', 'strength', 'jumping', 'power', 'passing', 'shooting', 'dribbling', 'defending', 'keeping'];
export const STAT_LABEL: Record<StatKey, string> = {
  pace: 'Pace',
  accel: 'Acceleration',
  agility: 'Agility',
  stamina: 'Stamina',
  strength: 'Strength',
  jumping: 'Jumping',
  power: 'Shot power',
  passing: 'Passing',
  shooting: 'Finishing',
  dribbling: 'Dribbling',
  defending: 'Defending',
  keeping: 'Goalkeeping',
};

export interface Card {
  id: string;
  name: string;
  nation: string; // flag emoji
  position: Position;
  rarity: Rarity;
  number: number;
  stats: Stats;
  height: number; // cm
  weight: number; // kg
  foot: 'L' | 'R';
  skin: number;
  hair: number;
  hairStyle: number;
  /** When it joined the club (ms). */
  got: number;
}

// ------------------------------------------------------------------ positions

export function roleOf(pos: Position): Role {
  if (pos === 'GK') return 'GK';
  if (pos === 'CB' || pos === 'LB' || pos === 'RB') return 'DEF';
  if (pos === 'ST' || pos === 'LW' || pos === 'RW') return 'FWD';
  return 'MID';
}

/** Positions a player can cover nearly as well as his own. */
const NEAR: Record<Position, Position[]> = {
  GK: [],
  CB: ['CDM'],
  LB: ['LM', 'CB'],
  RB: ['RM', 'CB'],
  CDM: ['CM', 'CB'],
  CM: ['CDM', 'CAM'],
  CAM: ['CM', 'ST'],
  LM: ['LW', 'LB', 'CM'],
  RM: ['RW', 'RB', 'CM'],
  LW: ['LM', 'ST', 'RW'],
  RW: ['RM', 'ST', 'LW'],
  ST: ['CAM', 'LW', 'RW'],
};

/** 1 = natural, 0.9 = close, 0.75 = out of position, 0.4 = outfield player in goal (or vice versa). */
export function fitFactor(card: Position, slot: Position): number {
  if (card === slot) return 1;
  if (card === 'GK' || slot === 'GK') return 0.4;
  if (NEAR[card].includes(slot)) return 0.9;
  if (roleOf(card) === roleOf(slot)) return 0.85;
  return 0.75;
}

// ------------------------------------------------------------------ overall

const W: Record<Position, Partial<Stats>> = {
  GK: { keeping: 10, jumping: 1, agility: 1 },
  CB: { defending: 5, strength: 3, jumping: 2, pace: 1, passing: 1 },
  LB: { defending: 3, pace: 3, stamina: 2, passing: 2, accel: 1 },
  RB: { defending: 3, pace: 3, stamina: 2, passing: 2, accel: 1 },
  CDM: { defending: 4, passing: 3, stamina: 2, strength: 2 },
  CM: { passing: 4, dribbling: 3, stamina: 2, defending: 1, shooting: 1 },
  CAM: { passing: 4, dribbling: 4, shooting: 2, agility: 1, accel: 1 },
  LM: { pace: 3, passing: 3, dribbling: 3, stamina: 1, accel: 1 },
  RM: { pace: 3, passing: 3, dribbling: 3, stamina: 1, accel: 1 },
  LW: { pace: 3, dribbling: 4, shooting: 2, accel: 2, agility: 1 },
  RW: { pace: 3, dribbling: 4, shooting: 2, accel: 2, agility: 1 },
  ST: { shooting: 5, power: 2, pace: 2, dribbling: 2, accel: 1, jumping: 1 },
};

export function overallAt(stats: Stats, pos: Position): number {
  let s = 0;
  let w = 0;
  for (const [k, v] of Object.entries(W[pos]) as [StatKey, number][]) {
    s += stats[k] * v;
    w += v;
  }
  return Math.round(s / w);
}

export function overall(c: Card): number {
  return overallAt(c.stats, c.position);
}

/** Rating in a given slot (out-of-position players play worse). */
export function ratingIn(c: Card, slot: Position): number {
  const f = fitFactor(c.position, slot);
  return Math.round(overall(c) * (f === 1 ? 1 : 0.55 + 0.45 * f));
}

/** The six headline numbers on the card face. */
export function faceStats(c: Card): [string, number][] {
  const s = c.stats;
  if (c.position === 'GK') {
    return [
      ['DIV', Math.round(s.keeping * 0.7 + s.agility * 0.3)],
      ['HAN', s.keeping],
      ['KIC', Math.round(s.power * 0.6 + s.passing * 0.4)],
      ['REF', Math.round(s.keeping * 0.6 + s.accel * 0.4)],
      ['SPD', Math.round((s.pace + s.accel) / 2)],
      ['POS', Math.round(s.keeping * 0.8 + s.jumping * 0.2)],
    ];
  }
  return [
    ['PAC', Math.round(s.pace * 0.55 + s.accel * 0.45)],
    ['SHO', Math.round(s.shooting * 0.7 + s.power * 0.3)],
    ['PAS', s.passing],
    ['DRI', Math.round(s.dribbling * 0.75 + s.agility * 0.25)],
    ['DEF', s.defending],
    ['PHY', Math.round(s.strength * 0.5 + s.stamina * 0.3 + s.jumping * 0.2)],
  ];
}

/** Short, human description of what makes this player special. */
export function traitsOf(c: Card): string[] {
  const s = c.stats;
  const t: string[] = [];
  if (c.position !== 'GK') {
    if (s.pace >= 85 && s.accel >= 82) t.push('Speedster');
    if (c.height >= 190 && s.jumping >= 75) t.push('Aerial threat');
    if (s.strength >= 85) t.push('Powerhouse');
    if (s.power >= 86) t.push('Rocket shot');
    if (s.dribbling >= 85 && s.agility >= 82) t.push('Magician');
    if (s.passing >= 86) t.push('Playmaker');
    if (s.stamina >= 88) t.push('Engine');
    if (s.defending >= 85) t.push('Wall');
    if (s.shooting >= 87) t.push('Clinical');
  } else {
    if (s.keeping >= 85) t.push('Shot stopper');
    if (c.height >= 194) t.push('Giant');
    if (s.accel >= 70) t.push('Sweeper keeper');
  }
  return t.slice(0, 3);
}

// ------------------------------------------------------------------ simulation

/** 1..99 to the simulation's 0..1 scale (60 -> 0.57, 80 -> 0.78, 90 -> 0.89). */
const unit = (s: number) => Math.pow(clamp(s, 1, 99) / 100, 1.1);

export interface SimPlayer {
  name: string;
  number: number;
  foot: number;
  attrs: Attributes;
  look: { skin: number; hair: number; hairStyle: number; height: number; build: number };
}

/** A card playing in a slot: technique suffers out of position, the body doesn't. */
export function toSim(c: Card, slot: Position): SimPlayer {
  const s = c.stats;
  const f = fitFactor(c.position, slot);
  const tech = (v: number) => unit(v) * (f === 1 ? 1 : 0.7 + 0.3 * f);
  const h = c.height / 100;
  const bmi = c.weight / (h * h);
  return {
    name: c.name,
    number: c.number,
    foot: c.foot === 'L' ? -1 : 1,
    attrs: {
      pace: unit(s.pace),
      accel: unit(s.accel),
      agility: unit(s.agility),
      stamina: unit(s.stamina),
      strength: unit(s.strength),
      jumping: unit(s.jumping),
      power: unit(s.power),
      control: tech(s.dribbling),
      passing: tech(s.passing),
      shooting: tech(s.shooting),
      defending: tech(s.defending),
      keeping: slot === 'GK' ? unit(s.keeping) : 0.2,
      height: h,
      weight: c.weight,
    },
    look: {
      skin: c.skin,
      hair: c.hair,
      hairStyle: c.hairStyle,
      height: h / 1.8,
      build: clamp(0.82 + (bmi - 20) * 0.06, 0.88, 1.16),
    },
  };
}

// ------------------------------------------------------------------ generation

interface Nation {
  flag: string;
  first: string[];
  last: string[];
  skin: number[]; // indices into SKIN_TONES, weighted by repetition
}

const NATIONS: Nation[] = [
  { flag: '🇵🇹', first: ['João', 'Rui', 'Tiago', 'Diogo', 'Nuno', 'Pedro', 'André', 'Bruno', 'Gonçalo', 'Rafael'], last: ['Pais', 'Mendes', 'Carvalho', 'Moreira', 'Ferraz', 'Barros', 'Teixeira', 'Lopes', 'Amaral', 'Coelho'], skin: [0, 1, 1, 2, 3] },
  { flag: '🇪🇸', first: ['Pablo', 'Sergio', 'Iker', 'Álvaro', 'Dani', 'Marcos', 'Adrián', 'Hugo', 'Unai', 'Jorge'], last: ['Ortega', 'Navarro', 'Serrano', 'Molina', 'Castaño', 'Iglesias', 'Romero', 'Vidal', 'Herrero', 'Prieto'], skin: [0, 1, 1, 2] },
  { flag: '🇧🇷', first: ['Thiago', 'Lucas', 'Gabriel', 'Mateus', 'Caio', 'Vinícius', 'Felipe', 'Davi', 'Renan', 'Igor'], last: ['Souza', 'Rocha', 'Almeida', 'Nascimento', 'Ribeiro', 'Cardoso', 'Lima', 'Batista', 'Farias', 'Moura'], skin: [1, 2, 3, 4, 5] },
  { flag: '🇦🇷', first: ['Facundo', 'Lautaro', 'Nicolás', 'Gonzalo', 'Franco', 'Joaquín', 'Tomás', 'Santiago', 'Emiliano', 'Bautista'], last: ['Acosta', 'Benítez', 'Quiroga', 'Ledesma', 'Funes', 'Paredes', 'Villalba', 'Sosa', 'Aguirre', 'Medina'], skin: [0, 1, 1, 2] },
  { flag: '🇫🇷', first: ['Théo', 'Hugo', 'Lucas', 'Antoine', 'Kylian', 'Moussa', 'Jules', 'Bastien', 'Yanis', 'Rayan'], last: ['Lefèvre', 'Garnier', 'Rousseau', 'Diallo', 'Camara', 'Bonnet', 'Fontaine', 'Mercier', 'Traoré', 'Lambert'], skin: [0, 1, 3, 4, 5] },
  { flag: '🇩🇪', first: ['Lukas', 'Jonas', 'Leon', 'Felix', 'Niklas', 'Tim', 'Florian', 'Maximilian', 'Jannik', 'Moritz'], last: ['Becker', 'Hoffmann', 'Wagner', 'Krämer', 'Schulz', 'Neumann', 'Brandt', 'Vogel', 'Hartmann', 'Keller'], skin: [0, 0, 1, 3] },
  { flag: '🏴󠁧󠁢󠁥󠁮󠁧󠁿', first: ['Harry', 'Jack', 'Mason', 'Declan', 'Jude', 'Callum', 'Reece', 'Tyrone', 'Ollie', 'Ben'], last: ['Walker', 'Fletcher', 'Henderson', 'Barnes', 'Clarke', 'Wright', 'Hughes', 'Palmer', 'Shaw', 'Turner'], skin: [0, 0, 1, 3, 4] },
  { flag: '🇮🇹', first: ['Marco', 'Lorenzo', 'Federico', 'Alessandro', 'Davide', 'Matteo', 'Riccardo', 'Gianluca', 'Nicolò', 'Simone'], last: ['Bellini', 'Ricci', 'Conti', 'Esposito', 'Marchetti', 'Ferrara', 'Galli', 'Bianchi', 'Moretti', 'Santoro'], skin: [0, 1, 1, 2] },
  { flag: '🇳🇱', first: ['Daan', 'Sem', 'Bram', 'Jesse', 'Ruben', 'Stijn', 'Milan', 'Thijs', 'Lars', 'Joris'], last: ['de Vries', 'Bakker', 'Visser', 'Smit', 'van Dijkman', 'Mulder', 'de Boer', 'Jansen', 'Kuipers', 'Brouwer'], skin: [0, 0, 1, 4] },
  { flag: '🇳🇬', first: ['Chidi', 'Emeka', 'Tunde', 'Kelechi', 'Samuel', 'Femi', 'Ikenna', 'Obinna', 'Ademola', 'Victor'], last: ['Okafor', 'Adeyemi', 'Nwosu', 'Balogun', 'Eze', 'Okonkwo', 'Afolabi', 'Chukwu', 'Ogunleye', 'Iwobi'], skin: [4, 4, 5, 5] },
  { flag: '🇯🇵', first: ['Haruto', 'Ren', 'Sota', 'Yuto', 'Kaito', 'Daichi', 'Takumi', 'Riku', 'Kenta', 'Shoma'], last: ['Tanaka', 'Suzuki', 'Kobayashi', 'Nakamura', 'Ito', 'Yamamoto', 'Matsuda', 'Inoue', 'Kimura', 'Hayashi'], skin: [0, 1] },
  { flag: '🇸🇳', first: ['Ismaïla', 'Pape', 'Cheikh', 'Moussa', 'Babacar', 'Idrissa', 'Mamadou', 'Lamine', 'Ousmane', 'Abdou'], last: ['Ndiaye', 'Sarr', 'Diop', 'Faye', 'Gueye', 'Mbaye', 'Cissé', 'Fall', 'Seck', 'Niang'], skin: [4, 5, 5] },
  { flag: '🇺🇾', first: ['Matías', 'Federico', 'Rodrigo', 'Agustín', 'Diego', 'Sebastián', 'Maximiliano', 'Facundo', 'Martín', 'Bruno'], last: ['Pereira', 'Cáceres', 'Olivera', 'Rodríguez', 'Arrascaeta', 'Godín', 'Silva', 'Torreira', 'Varela', 'Núñez'], skin: [0, 1, 2] },
  { flag: '🇭🇷', first: ['Luka', 'Ivan', 'Mateo', 'Josip', 'Marko', 'Ante', 'Nikola', 'Dominik', 'Filip', 'Lovro'], last: ['Horvat', 'Kovačić', 'Babić', 'Marić', 'Jurić', 'Novak', 'Perić', 'Vuković', 'Knežević', 'Pavlović'], skin: [0, 0, 1] },
  { flag: '🇰🇷', first: ['Min-jae', 'Heung-min', 'Jae-sung', 'Hwang', 'Seung-ho', 'In-beom', 'Kang-in', 'Woo-young', 'Ji-sung', 'Dong-hyun'], last: ['Kim', 'Lee', 'Park', 'Choi', 'Jung', 'Kang', 'Cho', 'Yoon', 'Jang', 'Lim'], skin: [0, 1] },
  { flag: '🇬🇭', first: ['Kwame', 'Kofi', 'Yaw', 'Kojo', 'Mohammed', 'Abdul', 'Ernest', 'Jordan', 'Thomas', 'Daniel'], last: ['Mensah', 'Asante', 'Boateng', 'Owusu', 'Appiah', 'Agyemang', 'Kudus', 'Partey', 'Amartey', 'Badu'], skin: [4, 5] },
];

/** Stat templates per position (relative strengths around 0). */
const TEMPLATE: Record<Position, Partial<Stats>> = {
  GK: { keeping: 20, pace: -25, accel: -18, dribbling: -25, shooting: -40, passing: -15, defending: -30, jumping: 5, power: 0, agility: -5 },
  CB: { defending: 14, strength: 10, jumping: 8, pace: -6, dribbling: -12, shooting: -22, agility: -8, passing: -5 },
  LB: { defending: 6, pace: 6, stamina: 10, accel: 4, shooting: -16, jumping: -6 },
  RB: { defending: 6, pace: 6, stamina: 10, accel: 4, shooting: -16, jumping: -6 },
  CDM: { defending: 10, stamina: 8, strength: 6, passing: 4, shooting: -10, pace: -6 },
  CM: { passing: 10, dribbling: 5, stamina: 8, shooting: -4, jumping: -6 },
  CAM: { passing: 10, dribbling: 10, agility: 6, defending: -18, strength: -8, shooting: 2 },
  LM: { pace: 8, accel: 6, passing: 4, dribbling: 6, stamina: 6, defending: -12, strength: -6 },
  RM: { pace: 8, accel: 6, passing: 4, dribbling: 6, stamina: 6, defending: -12, strength: -6 },
  LW: { pace: 10, accel: 10, dribbling: 10, agility: 8, defending: -22, strength: -8, jumping: -8 },
  RW: { pace: 10, accel: 10, dribbling: 10, agility: 8, defending: -22, strength: -8, jumping: -8 },
  ST: { shooting: 14, power: 8, pace: 4, defending: -26, passing: -4, jumping: 2 },
};

/** Typical height (cm) by position. */
const HEIGHT: Record<Position, number> = { GK: 191, CB: 188, LB: 178, RB: 178, CDM: 183, CM: 179, CAM: 176, LM: 176, RM: 176, LW: 175, RW: 175, ST: 183 };

let idCounter = 0;
function uid(rng: Rng): string {
  idCounter = (idCounter + 1) % 1e6;
  return Date.now().toString(36) + Math.floor(rng.next() * 1e9).toString(36) + idCounter.toString(36);
}

export function randomPosition(rng: Rng): Position {
  // More midfielders and defenders than keepers, like a real squad.
  const bag: Position[] = ['GK', 'GK', 'CB', 'CB', 'CB', 'LB', 'RB', 'CDM', 'CM', 'CM', 'CAM', 'LM', 'RM', 'LW', 'RW', 'ST', 'ST', 'ST'];
  return bag[Math.floor(rng.next() * bag.length)];
}

/** A new player of the given rarity (and position, random if omitted). */
export function generateCard(rng: Rng, rarity: Rarity, position?: Position, targetOvr?: number): Card {
  const pos = position ?? randomPosition(rng);
  const [lo, hi] = RARITY_OVR[rarity];
  // Skewed toward the bottom of the range: high rolls are the exciting ones.
  const target = targetOvr ?? Math.round(lo + (hi - lo) * Math.pow(rng.next(), 1.6));
  const nation = NATIONS[Math.floor(rng.next() * NATIONS.length)];

  // Body first: height drives jumping / strength / agility.
  const height = Math.round(clamp(HEIGHT[pos] + rng.gauss() * 6, 164, 203));
  const tall = (height - 180) / 10; // ~ -1.5..2.3
  const stocky = rng.gauss() * 0.8;
  const weight = Math.round(clamp(22.8 * (height / 100) ** 2 + stocky * 4 + 2, 60, 102));

  const stats = {} as Stats;
  const tpl = TEMPLATE[pos];
  for (const k of STAT_KEYS) {
    let v = (tpl[k] ?? 0) + rng.gauss() * 6;
    if (k === 'jumping') v += tall * 7;
    if (k === 'strength') v += tall * 4 + stocky * 5;
    if (k === 'agility') v -= tall * 5 + stocky * 2;
    if (k === 'accel') v -= tall * 4;
    if (k === 'pace') v -= stocky * 3;
    if (k === 'keeping' && pos !== 'GK') v = -60 + rng.next() * 10;
    stats[k] = v;
  }
  // Archetype spice: some players have one standout trait.
  const spike = rng.next();
  if (spike < 0.18) stats.pace += 8, stats.accel += 8;
  else if (spike < 0.3) stats.power += 10;
  else if (spike < 0.4) stats.stamina += 10;
  else if (spike < 0.5) stats.strength += 10;

  // Shift everything so the overall lands on target, then clamp.
  const base = 0;
  const probe = (shift: number) => {
    const s = {} as Stats;
    for (const k of STAT_KEYS) s[k] = clamp(Math.round(stats[k] + shift + base), k === 'keeping' && pos !== 'GK' ? 5 : 25, 99);
    return s;
  };
  let shift = target;
  for (let i = 0; i < 12; i++) {
    const o = overallAt(probe(shift), pos);
    if (o === target) break;
    shift += target - o;
  }
  const final = probe(shift);

  return {
    id: uid(rng),
    name: `${nation.first[Math.floor(rng.next() * nation.first.length)]} ${nation.last[Math.floor(rng.next() * nation.last.length)]}`,
    nation: nation.flag,
    position: pos,
    rarity,
    number: pos === 'GK' ? (rng.next() < 0.7 ? 1 : 12 + Math.floor(rng.next() * 3) * 10) : 2 + Math.floor(rng.next() * 30),
    stats: final,
    height,
    weight,
    foot: rng.next() < 0.24 ? 'L' : 'R',
    skin: SKIN_TONES[nation.skin[Math.floor(rng.next() * nation.skin.length)]],
    hair: HAIR_COLORS[Math.floor(rng.next() * HAIR_COLORS.length)],
    hairStyle: Math.floor(rng.next() * 4),
    got: Date.now(),
  };
}

/** Coins for quick-selling a card. */
export function sellValue(c: Card): number {
  const o = overall(c);
  return Math.round((40 + Math.pow(Math.max(0, o - 45), 2.1) * 1.4) / 10) * 10;
}
