# GameNight

A mobile-first football game (PWA). Stylized look, realistic feel.

- **Look:** soft 3-band toon shading, thin outlines, a hand-mown pitch drawn entirely in a shader,
  late-afternoon light with the main stand's shadow across the near touchline. A quiet, hazy
  stadium keeps the eye on the play.
- **Feel:** a fixed 120 Hz simulation. The ball has real aerodynamics (drag crisis, Magnus curl,
  spin decay), skids before it rolls, and bounces with friction. Players have momentum:
  acceleration curves, braking, a grip limit when turning, body orientation (backpedalling is
  slower), stamina. The ball is never glued to the foot. Dribbling is a series of real touches,
  and first touch, passes and shots carry errors from skill, body shape, speed and pressure.
- **Controls (FIFA Mobile style):** joystick on the left. Buttons on the right:
  - Attack: **Pass** (hold for a lofted pass), **Through**, **Shoot** (hold for power), **Sprint**.
  - Defence: **Switch**, **Press** (hold), **Tackle** (double-tap to slide).
  - Keyboard: WASD/arrows, Shift to sprint, J / K / L for the three buttons.

## Develop

```bash
npm install
npm run dev        # http://localhost:5173 (use ?debug for an fps / draw-call overlay)
npm test           # physics + full AI-vs-AI match tests
npm run build      # production build + service worker into dist/
```

Debug URL flags: `?debug` (overlay), `?dpr=1` (fixed resolution), `?zoom=10` (close camera).

## Versioning

The version in `package.json` is shown on the home screen (bottom right). Bump it with every
pushed update.

## Deploy (Vercel)

Import the repo in Vercel. It detects Vite; `vercel.json` sets the build and the cache headers
for the service worker.

## Layout

- `src/sim/`: deterministic simulation (no three.js). Ball physics, kick solver, players, match
  rules, AI.
- `src/render/`: three.js views. Instanced procedural players, shader pitch, stadium, goals, camera.
- `src/ui/`: touch controls, HUD, synthesized audio (no audio files).
