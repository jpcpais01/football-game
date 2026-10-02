/** Buttons are contextual: the same physical button means different things in attack and defence. */
export const Btn = {
  /** Attack: Pass · Defence: Switch */
  A: 0,
  /** Attack: Through ball · Defence: Press */
  B: 1,
  /** Attack: Shoot · Defence: Tackle (double tap: slide) */
  C: 2,
} as const;
export type Btn = (typeof Btn)[keyof typeof Btn];

export interface ButtonEvent {
  btn: Btn;
  kind: 'down' | 'up';
  /** For 'up': how long the button was held (s). */
  hold: number;
}

export interface InputState {
  /** Joystick in screen space, -1..1, y up. */
  moveX: number;
  moveY: number;
  sprint: boolean;
  held: [boolean, boolean, boolean];
  holdTime: [number, number, number];
  events: ButtonEvent[];
}

export function makeInput(): InputState {
  return { moveX: 0, moveY: 0, sprint: false, held: [false, false, false], holdTime: [0, 0, 0], events: [] };
}
