# GameNight — project description

**GameNight** is a mobile-first football (soccer) game. It's a PWA built with **Vite + TypeScript + three.js**, deployed on **Vercel** and played in landscape on phones. The match is a real-time 11v11 physics simulation. The look is a stylised **pixel-art** 3D render. Around the matches sits a light club/collection layer: club, squad, card packs and coins.

The repo is `jpcpais01/football-game`. The working branch has been `claude/peaceful-gauss-9negtt`. The current version is in `package.json` and shown on the home screen.

## The goal
Ultra-realistic, emergent football mechanics: physics-driven ball, bodies, tackles and keepers, not scripted outcomes. It should feel great on a touch screen, with a beautiful, atmospheric stadium. Prefer simple, elegant, physically honest rules over special cases.

## How the owner wants work done
- Be wise, smart and bold. Write good, elegant code and trust it.
- **Don't test or screenshot everything.** Test only when it's genuinely needed: a risky change to the simulation rules, or something that can't be reasoned about from the code. When a change affects gameplay quality (passing, seeking, AI), **measure it**. Benchmark many simulated matches before and after; numbers beat intuition, and "fixes" have been worse more than once.
- Remember what was asked before; don't make the owner repeat themselves.
- **Bump the version in `package.json` on every push.**
- More than one chat may work on the same branch: **fetch and merge before pushing, never overwrite**.
- Reply in plain language: what changed and what the player will notice.

## Product decisions in force
- **Graphics:** pixel art is the only mode. The Palette and HD looks are retired but still work in the code; `GRAPHICS` in `src/main.ts` lists the enabled modes.
- **Weather** (pause menu): Evening (golden hour into floodlights), Sunny day, Rainy night. The choice is remembered, and `?weather=rain` also selects rain.
- **Pause menu:** includes an FPS/ms counter toggle.

## Code map
- `src/sim/` is the deterministic simulation: fixed step `DT = 1/120`, seeded Rng, no rendering.
  - `match.ts`: match flow and phases (kickoff, play, out, setpiece, goal, halftime/fulltime); human input; kicks (`performKick`: pass, through ball, shot, cross, lob, clear and set pieces, with an error model); ball touches and control; tackles (leg capsule hitbox, fouls only on real contact, `legImpact` can make the victim fall); goal sequence.
  - `ai.ts`: team AI.
    - Ball reading: `intercept` per player, ball path samples, `meetPoint`, and `runTime`. `runTime` is the honest running model: it follows `Player.move`'s sprint-start curve, tabulated per player.
    - Passing choices: `bestReceiver`, `pickReceiver`, `planThrough`.
    - Off-ball shape, marking, pressing, keepers (hitbox, dives, playing with feet), celebrations.
  - `player.ts`: movement and acceleration, actions (kick, tackle, slide, dive, stumble, fall, header, …) and kick lunge/stretch.
  - `ball.ts`, `kick.ts`: ball physics, kick solvers (`solveGroundPass`, `solveLofted`, `solveShot`, `solveFreeKick`) and `predictBallAt`.
  - `constants.ts`: `PITCH`, `PLAYER`, `BALL`, `GOAL_SEQ` (goal celebration timeline).
- `src/render/` holds the three.js visuals.
  - Core: `players.ts` (instanced procedural players and all animation poses), `pixelPass.ts` (low-res pixel pipeline), `cameraRig.ts`.
  - Camera shots in `cameraRig.ts`: the broadcast camera, an over-the-shoulder view for free kicks and penalties, the front-on goal celebration shot, and the crowd shot.
  - `stadium.ts`: procedural stadium with a 2.5D shader crowd (rows of upright fan cards traced per pixel). It also has tifos, flags, banners, the fan photo banner, floodlights and beams, and the near stand shown during low camera shots.
  - Pitch and weather: `pitch.ts` (procedural grass, wet look, puddles), `turfMarks.ts` (slide-tackle scars), `atmosphere.ts` (time of day and weather), `rain.ts`, `particles.ts`.
- `src/ui/`: HUD, touch controls, synthesised WebAudio (crowd, rain), fan banner.
- `src/home/`, `src/meta/`: home screen, club studio, squad, store, cards and packs, formations, crest.
- `tests/`: vitest scenario tests: dead balls, contact/fouls, keeper reach, club matches and more. `club.test.ts` "a club line-up plays a match" is known to be flaky.

## Commands
`npm run dev`, `npm run build` (runs `tsc --noEmit` first), `npm test`.

## Useful knowledge
- **Benchmarking gameplay.** Make a throwaway vitest file that runs about 20 seeded matches (`m.autoPlay = true`). Hook `m.log` (it logs every kick, e.g. `pass -> #9`) to classify outcomes. For the human's experience, set `autoPlay` only while the controlled player has the ball, so the human seeking code runs with an idle stick. Compare against `git stash` of `src`. Delete the file afterwards.
- **Shaders.** New GLSL isn't checked by `tsc`. Check it by loading the built app in headless Chromium with Playwright: `import` from `/opt/node22/lib/node_modules/playwright/index.mjs`, use `executablePath /opt/pw-browsers/chromium` with the SwiftShader flags, and watch the console for shader errors. Avoid reserved words such as `flat`.
- **Human input.** A player switch cancels any held button. In tests, set `m.switchT = 99` before pressing.
