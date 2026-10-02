# GameNight — project description

**GameNight** is a mobile-first football (soccer) game. It's a PWA built with **Vite + TypeScript + three.js**, deployed on **Vercel** and played in landscape on phones. The match is a real-time 11v11 physics simulation. The look is a stylised **pixel-art** 3D render. Around the matches sits a club/collection layer: your club, kit and crest, squad, card packs and coins, with 90s game-night styled menus.

The repo is `jpcpais01/football-game`. The working branch is `claude/peaceful-gauss-9negtt`. The version (currently **0.60**) is in `package.json` and shown on the home screen.

## The goal
Ultra-realistic, emergent football mechanics: physics-driven ball, bodies, tackles and keepers, not scripted outcomes. It should feel great on a touch screen, inside a beautiful, atmospheric stadium on an epic European night. Prefer simple, elegant, physically honest rules over special cases.

## How the owner wants work done
- Be wise, smart and bold. Write good, elegant code and trust it.
- **Don't test or screenshot everything.** Test only when genuinely needed: a risky simulation change, a shader, or something that can't be reasoned about from the code.
- **Measure gameplay changes** (passing, seeking, AI). Benchmark many simulated matches before and after: numbers beat intuition, and "fixes" have been worse more than once.
- Before a bigger change, understand what's really happening first. Trace it, don't guess.
- Remember what was asked before; don't make the owner repeat themselves.
- **On every push:** bump the version in `package.json`, and add a line to `src/home/patchNotes.ts` (newest first, at most 50 words).
- More than one chat works on this branch: **fetch and merge before pushing, never overwrite**. If two chats claim the same version, the one already pushed keeps it.
- Reply in plain language: what changed and what the player will notice.

## Product decisions in force
- **Graphics:** pixel art is the only mode. The Palette and HD looks are retired but still work in the code (`GRAPHICS` in `src/main.ts`; `?gfx=hd` for debugging).
- **Pause menu:**
  - Weather: Evening, Sunny day, Rainy night
  - Camera: Close / Normal / Far
  - a Pixels fineness slider
  - Smoothing on/off
  - FPS counter
  - Sound
  - Forfeit
- **Frame rate:** 120 fps in play, 90 on the home screen, 60 under the pause menu (a frame scheduler in `frame()` in `main.ts`).
- **The minimap** sits at the bottom centre and hides while paused.
- **Patch notes:** a button beside the version on the home screen opens them.

## Code map
- **`src/sim/`** is the deterministic simulation: fixed step `DT = 1/120`, seeded Rng, no rendering.
  - `match.ts`
    - Match flow and phases (kickoff, play, out, setpiece, goal, halftime/fulltime) and human input.
    - Kicks: `performKick` handles pass, through ball, shot, cross, lob, clear and set pieces, with an error model.
    - Ball touches and control, including the stretch-reach (`tryStretches`).
    - Tackles: a leg-capsule hitbox, fouls only on real contact, and `legImpact`, which can knock the victim down.
    - `deadBallView`: when a dead ball is watched from behind the taker (goal kicks, direct free kicks, penalties, yours and theirs).
  - `ai.ts`: team AI.
    - Ball reading: per-player `intercept`, `meetPoint`, and `runTime` (the honest running model: `Player.move`'s sprint curve, tabulated per player).
    - Passing choices: `bestReceiver`, `pickReceiver`, `planThrough`.
    - Off-ball shape, marking, pressing, keepers, set-piece takers and celebrations.
  - `player.ts`
    - Movement and acceleration, plus a burst near a loose ball.
    - The body faces the run; it squares up to the ball only when `squareUp` is set (jockeying, keepers, the wall, a receiver).
    - Actions: kick, tackle, slide, dive, stumble, fall, header, stretch and others.
  - `body.ts`: five body types (lean, athletic, muscular, stocky, tall & lanky), read from height, weight and strength. They give each player a body shape for the renderer; the simulation keeps the real height and weight.
  - `ball.ts`, `kick.ts`: ball physics, kick solvers and `predictBallAt`.
  - `constants.ts`: `PITCH`, `PLAYER`, `BALL`, and `GOAL_SEQ` (the goal-sequence timeline: run, front-on celebration, crowd shot).
- **`src/render/`** holds the three.js visuals.
  - `players.ts`: instanced procedural players built from the body shapes, plus every animation pose: kicks, tackles, slide, stretch, keeper dives, falls, celebrations.
  - `pixelPass.ts`: the low-res pixel pipeline.
  - `cameraRig.ts` holds the camera shots:
    - the broadcast camera, which leans toward the goal under attack
    - corner framing of the box
    - the over-the-shoulder dead-ball view
    - the front-on goal celebration
    - the crowd shot
  - `stadium.ts`: the procedural stadium.
    - A 2.5D shader crowd that bounces on the chant beat, with scarves, arms and flare glow.
    - Tifos in both ends, flags, banners, the fan photo banner, floodlights and beams.
    - The near stand, shown during low shots.
  - Pitch and weather:
    - `pitch.ts`: procedural grass, wet look, puddles
    - `turfMarks.ts`: slide-tackle scars
    - `atmosphere.ts`: time of day and weather
    - `rain.ts`
    - `particles.ts`: sparks, smoke, confetti that stays on the grass, rain spray
  - `cornerAim.ts`: the corner landing ring and flight arc.
- **`src/ui/`**: HUD, touch controls, minimap, fan banner, and synthesised WebAudio (no audio files).
  - `terraces.ts` is the **atmosphere director**:
    - which end sings what, songs suited to the score, the Viking clap
    - flares and smoke bombs, confetti
    - boos, "ooh"s and groans
    - per-team **danger**: inside 20 m of goal with the ball, at least half the roar; running at goal, fast, the full roar
  - `chantAudio.ts`: the choir, drum, claps, the build-up roar, the goal eruption, the murmur.
  - Sound, the crowd shader and the particles all read the director.
- **`src/home/`, `src/meta/`**: the home screen (`retro.css` gives the 90s look), club studio, squad (shows body types), store and packs, cards, formations, crest. `patchNotes.ts` holds the patch notes.
- **`tests/`**: vitest scenario tests for dead balls, contact and fouls, keeper reach, celebrations, club matches and more. `club.test.ts` "a club line-up plays a match" is known to be flaky.

## Commands
`npm run dev`, `npm run build` (runs `tsc --noEmit` first), `npm test`. After pulling, run `npm install` if `package.json` gained a dependency.

## Useful knowledge
- **Benchmarking gameplay.**
  - Make a throwaway vitest file that runs 20–30 seeded matches (`m.autoPlay = true`), and hook `m.log` (it logs every kick, e.g. `pass -> #9`) to classify outcomes.
  - For the human's experience, set `autoPlay` only while the controlled player has the ball, so the human seeking code runs with an idle stick.
  - Compare against a `git stash` of `src`, then delete the file.
- **Sound levels** can be measured: render with an `OfflineAudioContext` in a throwaway page served by `vite`, and compare RMS against the crowd bed.
- **Shaders.** New GLSL isn't checked by `tsc`.
  - Load the built app in headless Chromium with Playwright: `import` from `/opt/node22/lib/node_modules/playwright/index.mjs`, use `executablePath /opt/pw-browsers/chromium` with the SwiftShader flags, and watch the console.
  - Avoid reserved words such as `flat`.
  - In a screenshot, hide the UI with `body * { visibility: hidden }` and `canvas { visibility: visible }`.
- **Debug URL options:**
  - `?corner=near|far|gk|gk-opp|fk-opp`: a set piece a moment after kick-off
  - `?crowd=-1|1`: hold the crowd shot on the home / away end
  - `?tod=1`: night
  - `?weather=rain|sunny|evening`
  - `?showcase`: a close-up line-up for judging the player models
  - `?debug`: perf details in the FPS counter
- **Human input.** A player switch cancels any held button. In tests, set `m.switchT = 99` before pressing.
