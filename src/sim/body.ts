/**
 * Body types. Every player has one of five, read from his real height, weight and
 * strength (so a 1.95 m 90 kg striker looks like one), and a body shape from it: limb
 * lengths and thicknesses, shoulders, chest, neck — with a little personal variation so no
 * two players are cut from the same mould. Only the look uses the shape; the simulation
 * keeps using the real height and weight.
 */

export const BodyType = { Lean: 0, Athletic: 1, Muscular: 2, Stocky: 3, Lanky: 4 } as const;
export type BodyType = (typeof BodyType)[keyof typeof BodyType];

export const BODY_NAMES = ['Lean', 'Athletic', 'Muscular', 'Stocky', 'Tall & lanky'];

/** Weight for height of a typical footballer (BMI), the middle the types are read from. */
const BMI_MID = 23.4;

export function bodyType(heightM: number, weightKg: number, strength: number): BodyType {
  const heavy = weightKg / (heightM * heightM) - BMI_MID;
  if (heightM >= 1.87 && heavy < 0.6) return BodyType.Lanky;
  if (heightM < 1.78 && heavy > 0.5) return BodyType.Stocky;
  if (heavy > 0.9 || (heavy > 0.3 && strength > 0.72)) return BodyType.Muscular;
  if (heavy < -0.75) return BodyType.Lean;
  return BodyType.Athletic;
}

/** Proportions relative to the base (athletic) body. */
export interface BodyShape {
  type: BodyType;
  /** Leg length (thigh + shin). */
  leg: number;
  /** Arm length. */
  armLen: number;
  /** Torso width (and the pelvis), depth (chest), length. */
  torsoW: number;
  torsoD: number;
  torsoL: number;
  /** Shoulder spread. */
  shoulder: number;
  /** Girths: upper and lower arm, thigh, calf, neck. */
  arm: number;
  thigh: number;
  calf: number;
  neck: number;
  /** Neck length. */
  neckLen: number;
}

const SHAPES: Omit<BodyShape, 'type'>[] = [
  // Lean: slim limbs and trunk, narrow shoulders, long legs.
  { leg: 1.035, armLen: 1.02, torsoW: 0.88, torsoD: 0.88, torsoL: 1.0, shoulder: 0.93, arm: 0.84, thigh: 0.85, calf: 0.88, neck: 0.9, neckLen: 1.05 },
  // Athletic: the base.
  { leg: 1, armLen: 1, torsoW: 1, torsoD: 1, torsoL: 1, shoulder: 1, arm: 1, thigh: 1, calf: 1, neck: 1, neckLen: 1 },
  // Muscular: broad shoulders, big arms and thighs, a deep chest, a thick neck.
  { leg: 1, armLen: 1, torsoW: 1.12, torsoD: 1.14, torsoL: 1.0, shoulder: 1.1, arm: 1.24, thigh: 1.16, calf: 1.1, neck: 1.22, neckLen: 0.94 },
  // Stocky: short and wide, short thick legs, a low centre of gravity.
  { leg: 0.92, armLen: 0.96, torsoW: 1.13, torsoD: 1.16, torsoL: 0.97, shoulder: 1.05, arm: 1.14, thigh: 1.2, calf: 1.16, neck: 1.2, neckLen: 0.85 },
  // Tall & lanky: long limbs and neck, a narrow frame.
  { leg: 1.07, armLen: 1.06, torsoW: 0.92, torsoD: 0.9, torsoL: 1.02, shoulder: 0.97, arm: 0.9, thigh: 0.9, calf: 0.9, neck: 0.92, neckLen: 1.12 },
];

/** Stable 0..1 per player and channel. */
function vary(seed: number, k: number): number {
  const s = Math.sin(seed * 91.7 + k * 47.3) * 43758.5453;
  return s - Math.floor(s);
}

export function bodyShape(heightM: number, weightKg: number, strength: number, seed: number): BodyShape {
  const type = bodyType(heightM, weightKg, strength);
  const b = SHAPES[type];
  // Within the type: a few per cent either way, and the weight for the height nudging the
  // trunk and thighs (two athletic players aren't the same).
  const bmi = weightKg / (heightM * heightM);
  const mass = Math.max(-0.05, Math.min(0.05, (bmi - BMI_MID) * 0.012));
  const j = (k: number, amt: number) => 1 + (vary(seed, k) - 0.5) * 2 * amt;
  return {
    type,
    leg: b.leg * j(1, 0.02),
    armLen: b.armLen * j(2, 0.02),
    torsoW: b.torsoW * j(3, 0.03) * (1 + mass),
    torsoD: b.torsoD * j(4, 0.03) * (1 + mass),
    torsoL: b.torsoL * j(5, 0.02),
    shoulder: b.shoulder * j(6, 0.025),
    arm: b.arm * j(7, 0.04),
    thigh: b.thigh * j(8, 0.04) * (1 + mass * 0.8),
    calf: b.calf * j(9, 0.04),
    neck: b.neck * j(10, 0.04),
    neckLen: b.neckLen * j(11, 0.04),
  };
}
