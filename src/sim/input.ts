/** Buttons are contextual: the same physical button means different things in attack and defence. */
export const Btn = {
  /** Bottom button. Attack: Pass · Defence: Tackle (double tap: slide) */
  A: 0,
  /** Top button. Attack: Through ball · Defence: Switch */
  B: 1,
  /** Middle button. Attack: Shoot · Defence: Press */
  C: 2,
} as const;
export type Btn = (typeof Btn)[keyof typeof Btn];

export interface ButtonEvent {
  btn: Btn;
  kind: 'down' | 'up';
  /** For 'up': how long the button was held (s). */
  hold: number;
  /** For 'up': the finger slid upward while holding (FIFA-Mobile style lofted pass). */
  swipeUp?: boolean;
}

export interface InputState {
  /** Joystick in screen space, -1..1, y up. */
  moveX: number;
  moveY: number;
  sprint: boolean;
  held: [boolean, boolean, boolean];
  holdTime: [number, number, number];
  /** Live: finger currently slid up on a held button. */
  swipe: [boolean, boolean, boolean];
  events: ButtonEvent[];
  /** Defence: finger slid down on the held Sprint button (a long drag = slide). Consumed by the match. */
  tackleSwipe: 'tackle' | 'slide' | null;
}

export function makeInput(): InputState {
  return { moveX: 0, moveY: 0, sprint: false, held: [false, false, false], holdTime: [0, 0, 0], swipe: [false, false, false], events: [], tackleSwipe: null };
}
