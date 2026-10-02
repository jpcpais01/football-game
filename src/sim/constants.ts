// World units are metres and seconds. X runs along the pitch length, Z across it, Y is up.

export const SIM_HZ = 120;
export const DT = 1 / SIM_HZ;

export const PITCH = {
  length: 105,
  width: 68,
  halfL: 52.5,
  halfW: 34,
  goalHalfWidth: 7.32 / 2,
  goalHeight: 2.44,
  goalDepth: 2.0,
  postRadius: 0.06,
  boxDepth: 16.5,
  boxHalfWidth: 20.16,
  sixDepth: 5.5,
  sixHalfWidth: 9.16,
  penaltySpot: 11,
  circleRadius: 9.15,
} as const;

export const GRAVITY = 9.81;
export const AIR_DENSITY = 1.2;

export const BALL = {
  radius: 0.11,
  mass: 0.43,
  // Thin shell: I = 2/3 m r^2
  inertiaFactor: 2 / 3,
  area: Math.PI * 0.11 * 0.11,
  // Drag coefficient below / above the drag crisis
  cdLow: 0.47,
  cdHigh: 0.18,
  crisisSpeed: 14,
  crisisWidth: 3,
  // Air spin decay time constant (s)
  spinDecay: 7,
  restitution: 0.62,
  groundFriction: 0.55,
  // Rolling resistance on grass (m/s^2). Air drag is applied on top.
  rollDecel: 0.75,
  postRestitution: 0.65,
} as const;

export const PLAYER = {
  radius: 0.32,
  height: 1.8,
  reach: 0.85,
  controlHeight: 1.05,
  headMin: 1.35,
  headMax: 2.25,
  topSpeed: 8.6,
  jogSpeed: 5.6,
  accel: 6.5,
  brake: 9.5,
  lateral: 9,
  dribbleSpeedFactor: 0.9,
} as const;

export const MATCH = {
  // Real seconds per half
  halfSeconds: 150,
} as const;
