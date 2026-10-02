import type { Position } from './cards';

/**
 * A formation slot in team frame: x from -1 (own goal line) to +1 (opponent goal line),
 * z from -1 (left touchline, facing the attack) to +1 (right).
 *
 * The slot ORDER matters: the match engine gives each shirt index a job (0 keeper,
 * 1 / 4 full-backs, 2 / 3 centre-backs, 5 holding mid, 6 / 7 midfielders, 8 / 10 wide
 * forwards, 9 the striker who kicks off). Every formation keeps that order.
 */
export interface FSlot {
  pos: Position;
  x: number;
  z: number;
}

export interface Formation {
  id: string;
  name: string;
  slots: FSlot[];
}

export const FORMATIONS: Formation[] = [
  {
    id: '433',
    name: '4-3-3',
    slots: [
      { pos: 'GK', x: -0.96, z: 0 },
      { pos: 'LB', x: -0.62, z: -0.7 },
      { pos: 'CB', x: -0.7, z: -0.24 },
      { pos: 'CB', x: -0.7, z: 0.24 },
      { pos: 'RB', x: -0.62, z: 0.7 },
      { pos: 'CDM', x: -0.4, z: 0 },
      { pos: 'CM', x: -0.2, z: -0.4 },
      { pos: 'CM', x: -0.2, z: 0.4 },
      { pos: 'LW', x: 0.2, z: -0.72 },
      { pos: 'ST', x: 0.3, z: 0 },
      { pos: 'RW', x: 0.2, z: 0.72 },
    ],
  },
  {
    id: '442',
    name: '4-4-2',
    slots: [
      { pos: 'GK', x: -0.96, z: 0 },
      { pos: 'LB', x: -0.64, z: -0.7 },
      { pos: 'CB', x: -0.7, z: -0.24 },
      { pos: 'CB', x: -0.7, z: 0.24 },
      { pos: 'RB', x: -0.64, z: 0.7 },
      { pos: 'CM', x: -0.32, z: -0.2 },
      { pos: 'LM', x: -0.22, z: -0.72 },
      { pos: 'CM', x: -0.32, z: 0.2 },
      { pos: 'RM', x: -0.22, z: 0.72 },
      { pos: 'ST', x: 0.28, z: -0.16 },
      { pos: 'ST', x: 0.22, z: 0.18 },
    ],
  },
  {
    id: '4231',
    name: '4-2-3-1',
    slots: [
      { pos: 'GK', x: -0.96, z: 0 },
      { pos: 'LB', x: -0.62, z: -0.7 },
      { pos: 'CB', x: -0.7, z: -0.24 },
      { pos: 'CB', x: -0.7, z: 0.24 },
      { pos: 'RB', x: -0.62, z: 0.7 },
      { pos: 'CDM', x: -0.44, z: -0.18 },
      { pos: 'CDM', x: -0.44, z: 0.18 },
      { pos: 'CAM', x: -0.08, z: 0 },
      { pos: 'LM', x: 0.0, z: -0.68 },
      { pos: 'ST', x: 0.3, z: 0 },
      { pos: 'RM', x: 0.0, z: 0.68 },
    ],
  },
  {
    id: '352',
    name: '3-5-2',
    slots: [
      { pos: 'GK', x: -0.96, z: 0 },
      { pos: 'LM', x: -0.36, z: -0.78 },
      { pos: 'CB', x: -0.7, z: -0.36 },
      { pos: 'CB', x: -0.7, z: 0.36 },
      { pos: 'RM', x: -0.36, z: 0.78 },
      { pos: 'CB', x: -0.74, z: 0 },
      { pos: 'CM', x: -0.3, z: -0.3 },
      { pos: 'CM', x: -0.3, z: 0.3 },
      { pos: 'CAM', x: -0.04, z: 0 },
      { pos: 'ST', x: 0.28, z: -0.18 },
      { pos: 'ST', x: 0.24, z: 0.2 },
    ],
  },
  {
    id: '532',
    name: '5-3-2',
    slots: [
      { pos: 'GK', x: -0.96, z: 0 },
      { pos: 'LB', x: -0.56, z: -0.78 },
      { pos: 'CB', x: -0.72, z: -0.34 },
      { pos: 'CB', x: -0.72, z: 0.34 },
      { pos: 'RB', x: -0.56, z: 0.78 },
      { pos: 'CB', x: -0.75, z: 0 },
      { pos: 'CM', x: -0.32, z: -0.36 },
      { pos: 'CM', x: -0.36, z: 0.0 },
      { pos: 'CM', x: -0.32, z: 0.36 },
      { pos: 'ST', x: 0.26, z: -0.18 },
      { pos: 'ST', x: 0.22, z: 0.2 },
    ],
  },
  {
    id: '4141',
    name: '4-1-4-1',
    slots: [
      { pos: 'GK', x: -0.96, z: 0 },
      { pos: 'LB', x: -0.62, z: -0.7 },
      { pos: 'CB', x: -0.7, z: -0.24 },
      { pos: 'CB', x: -0.7, z: 0.24 },
      { pos: 'RB', x: -0.62, z: 0.7 },
      { pos: 'CDM', x: -0.46, z: 0 },
      { pos: 'CM', x: -0.2, z: -0.24 },
      { pos: 'CM', x: -0.2, z: 0.24 },
      { pos: 'LM', x: -0.12, z: -0.72 },
      { pos: 'ST', x: 0.3, z: 0 },
      { pos: 'RM', x: -0.12, z: 0.72 },
    ],
  },
];

export function formationById(id: string): Formation {
  return FORMATIONS.find((f) => f.id === id) ?? FORMATIONS[0];
}

/** Limits for dragging slots around on the tactics board. */
export const SLOT_BOUNDS = { minX: -0.82, maxX: 0.4, minZ: -0.88, maxZ: 0.88 };
