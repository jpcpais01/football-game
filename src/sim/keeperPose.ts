import type { Player } from './player';
import { clamp, lerp, smoothstep } from './vec';

/**
 * Goalkeeper dive pose, shared by the physics (hand/body capsule) and the renderer
 * (body roll and lift), so what you see is exactly what can stop the ball.
 *
 * The keeper rotates about his feet: `roll` is the body's tilt from vertical toward the
 * dive side, `lift` raises the feet off the ground. A point at distance L along the body
 * axis sits at height lift + L·cos(roll), and L·sin(roll) to the side.
 */
export interface DivePose {
  roll: number;
  lift: number;
}

/** Distance along the body axis from feet to outstretched hands, per metre of height scale. */
export const DIVE_HANDS = 2.15;
export const DIVE_HIPS = 0.55;
export const DIVE_RADIUS = 0.34;

/** Chooses the dive (roll, lift) whose body line passes through a ball at lateral offset a, height y. */
export function planDive(a: number, y: number, height: number): { roll: number; lift: number; reach: number } {
  const lift = clamp(y - 1.9, 0, 0.5);
  const up = Math.max(0.08, y - lift);
  const L = 1.85 * height; // aim the forearms, not the fingertips
  const reach = Math.sqrt(Math.max(0, L * L - up * up));
  const lateral = Math.min(a, reach);
  const roll = clamp(Math.atan2(Math.max(0.2, lateral), up), 0.35, 1.5);
  return { roll, lift, reach };
}

export function divePose(k: Player, targetRoll: number, targetLift: number, out: DivePose): DivePose {
  const pr = k.actionDur > 0 ? clamp(k.actionT / k.actionDur, 0, 1) : 0;
  const reachOut = smoothstep(0, 0.22, pr);
  const land = smoothstep(0.55, 0.85, pr);
  out.roll = lerp(targetRoll * reachOut, Math.max(targetRoll, 1.5), land);
  out.lift = targetLift * reachOut * (1 - land);
  return out;
}
