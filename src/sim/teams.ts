import type { Attributes, Role } from './player';
import { Rng } from './vec';

export interface Kit {
  shirt: number;
  shirt2: number; // trim / sleeves
  shorts: number;
  socks: number;
  gkShirt: number;
  gkShorts: number;
  /** Shirt design, index into KIT_PATTERNS (0 = plain). */
  pattern?: number;
}

export const KIT_PATTERNS = ['Plain', 'Stripes', 'Hoops', 'Pinstripes', 'Halves', 'Sash', 'Chevron', 'Quarters', 'Centre band', 'Fade'];

export interface TeamInfo {
  name: string;
  short: string;
  kit: Kit;
}

export const TEAMS: TeamInfo[] = [
  {
    name: 'Rossoneri Athletic',
    short: 'ROS',
    kit: { shirt: 0xc8393b, shirt2: 0x8f1f24, shorts: 0xf3ede0, socks: 0xc8393b, gkShirt: 0xe9c24a, gkShorts: 0x2a2a2a },
  },
  {
    name: 'Atlantic Rovers',
    short: 'ATL',
    kit: { shirt: 0xf1ebdc, shirt2: 0x23345e, shorts: 0x23345e, socks: 0xf1ebdc, gkShirt: 0x2ba59a, gkShorts: 0x163a36 },
  },
];

export interface Slot {
  role: Role;
  x: number;
  z: number;
}

// 4-3-3 in team frame: x from -1 (own goal line) to +1 (opponent goal line).
export const FORMATION_433: Slot[] = [
  { role: 'GK', x: -0.96, z: 0 },
  { role: 'DEF', x: -0.62, z: -0.7 },
  { role: 'DEF', x: -0.7, z: -0.24 },
  { role: 'DEF', x: -0.7, z: 0.24 },
  { role: 'DEF', x: -0.62, z: 0.7 },
  { role: 'MID', x: -0.4, z: 0 },
  { role: 'MID', x: -0.2, z: -0.4 },
  { role: 'MID', x: -0.2, z: 0.4 },
  { role: 'FWD', x: 0.2, z: -0.72 },
  { role: 'FWD', x: 0.3, z: 0 },
  { role: 'FWD', x: 0.2, z: 0.72 },
];

export const SKIN_TONES = [0xf1c9a5, 0xe0ac7e, 0xc68a5c, 0x9a6440, 0x6e4529, 0x4b2e1c];
export const HAIR_COLORS = [0x1b1410, 0x2e1f15, 0x4a3020, 0x7a5532, 0xc9a35e, 0x0e0e0e];

export function makeAttributes(role: Role, rng: Rng): Attributes {
  const r = (a: number, b: number) => rng.range(a, b);
  const base: Attributes = {
    pace: r(0.5, 0.85),
    accel: r(0.5, 0.85),
    control: r(0.55, 0.85),
    passing: r(0.55, 0.85),
    shooting: r(0.4, 0.7),
    strength: r(0.5, 0.85),
    defending: r(0.4, 0.7),
    keeping: 0.2,
    // Neutral values (no extra rng draws, so seeded matches stay reproducible).
    agility: 0.6,
    stamina: 0.55,
    jumping: role === 'DEF' || role === 'GK' ? 0.6 : 0.5,
    power: role === 'FWD' ? 0.6 : 0.5,
    height: 1.8,
    weight: 76,
  };
  if (role === 'GK') {
    base.keeping = r(0.7, 0.9);
    base.pace = r(0.35, 0.55);
    base.control = r(0.45, 0.65);
  } else if (role === 'DEF') {
    base.defending = r(0.7, 0.9);
    base.strength = r(0.7, 0.9);
    base.shooting = r(0.3, 0.55);
  } else if (role === 'MID') {
    base.passing = r(0.72, 0.92);
    base.control = r(0.7, 0.9);
    base.defending = r(0.5, 0.75);
  } else {
    base.shooting = r(0.72, 0.92);
    base.pace = r(0.7, 0.95);
    base.accel = r(0.7, 0.95);
    base.control = r(0.7, 0.9);
  }
  base.agility = base.accel * 0.9;
  return base;
}
