import '@fontsource/barlow-condensed/latin-600.css';
import '@fontsource/barlow-condensed/latin-800.css';
import './style.css';
import * as THREE from 'three';
import { DT, MATCH } from './sim/constants';
import { Match } from './sim/match';
import { createPitch } from './render/pitch';
import { createStadium } from './render/stadium';
import { createGoals } from './render/goals';
import { PlayersView } from './render/players';
import { BallView } from './render/ballView';
import { CAMERA_PRESETS, CameraRig, type CameraPreset } from './render/cameraRig';
import { Atmosphere } from './render/atmosphere';
import { PixelPass } from './render/pixelPass';
import { Particles } from './render/particles';
import { SHARED } from './render/look';
import { Controls } from './ui/controls';
import { Hud } from './ui/hud';
import { GameAudio } from './ui/audio';

const app = document.getElementById('app')!;
const params = new URLSearchParams(location.search);
const DEBUG = params.has('debug');

// ---------------------------------------------------------------- renderer
// Phones get a slightly lower resolution ceiling: the pitch shader is per-pixel work and
// 1.6x is visually indistinguishable at arm's length. Quality adapts at runtime anyway.
const coarse = matchMedia('(pointer: coarse)').matches;
const maxDpr = Math.min(window.devicePixelRatio || 1, coarse ? 1.6 : 2);
const renderer = new THREE.WebGLRenderer({
  antialias: maxDpr < 1.3,
  powerPreference: 'high-performance',
  stencil: false,
});
let dpr = maxDpr;
renderer.setPixelRatio(dpr);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
// Filmic tone mapping: warm highlights roll off softly instead of clipping.
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.95;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const atmo = new Atmosphere(scene, { shadowSize: coarse ? 1024 : 2048 });
// ?tod=0..1 pins the time of day (for looking at the evening without playing a match).
const TOD = params.has('tod') ? Number(params.get('tod')) : -1;
// ?showcase: frozen line-up near the camera, for judging the player models.
const SHOWCASE = params.has('showcase');

let match = new Match(Date.now() & 0xffff);
match.autoPlay = true;

scene.add(createPitch());
const stadium = createStadium(match.teams[0].info.kit.shirt, match.teams[1].info.kit.shirt);
scene.add(stadium.group);
const goals = createGoals();
scene.add(goals.group);
const playersView = new PlayersView(match);
scene.add(playersView.group);
const ballView = new BallView();
scene.add(ballView.group);
const particles = new Particles(match.teams[0].info.kit.shirt, match.teams[1].info.kit.shirt);
scene.add(particles.points);
const rig = new CameraRig(window.innerWidth / window.innerHeight);
if (params.has('showcase')) rig.distOverride = 9;
// Camera setting (Close / Normal / Far), remembered on this device.
const CAMERA_ORDER: CameraPreset[] = ['close', 'normal', 'far'];
let cameraPreset: CameraPreset = 'normal';
try {
  const saved = localStorage.getItem('camera') as CameraPreset | null;
  if (saved && saved in CAMERA_PRESETS) cameraPreset = saved;
} catch {
  /* storage unavailable: keep the default */
}
rig.baseDist = CAMERA_PRESETS[cameraPreset];

// Graphics: the pixel-art look (default) or full-resolution HD.
type Graphics = 'pixel' | 'hd';
let graphics: Graphics = params.get('gfx') === 'hd' ? 'hd' : 'pixel';
try {
  const saved = localStorage.getItem('graphics');
  if (!params.has('gfx') && (saved === 'pixel' || saved === 'hd')) graphics = saved;
} catch {
  /* keep default */
}
const pixelPass = new PixelPass();

// Match weather: evening (golden hour into floodlights) or a sunny day.
try {
  const w = localStorage.getItem('weather');
  if (w === 'sunny' || w === 'evening') atmo.weather = w;
} catch {
  /* keep default */
}
if (params.get('weather') === 'sunny') atmo.weather = 'sunny';
if (params.has('zoom')) rig.distOverride = Number(params.get('zoom')) || 10;
const FIXED_DPR = params.has('dpr');
if (FIXED_DPR) renderer.setPixelRatio((dpr = Number(params.get('dpr')) || 1));

// ---------------------------------------------------------------- UI
const ui = document.createElement('div');
ui.className = 'ui';
app.appendChild(ui);
const hud = new Hud(ui, match);
const controls = new Controls(ui);
const audio = new GameAudio();

const vignette = document.createElement('div');
vignette.className = 'vignette';
app.insertBefore(vignette, ui);

const menu = document.createElement('div');
menu.className = 'menu';
menu.innerHTML = `
  <div class="menu-card">
    <div class="kicker">Season 01</div>
    <h1>GameNight</h1>
    <p class="sub">${match.teams[0].info.name} <span>vs</span> ${match.teams[1].info.name}</p>
    <button class="play">Kick off</button>
    <p class="hint">Landscape · joystick to move · Pass / Through / Shoot</p>
  </div>`;
ui.appendChild(menu);
const version = document.createElement('div');
version.className = 'version';
version.textContent = `v${__APP_VERSION__}`;
menu.appendChild(version);

const pauseBtn = document.createElement('button');
pauseBtn.className = 'pause-btn';
pauseBtn.setAttribute('aria-label', 'Pause');
pauseBtn.innerHTML = '<span></span><span></span>';
ui.appendChild(pauseBtn);

const pauseMenu = document.createElement('div');
pauseMenu.className = 'menu pause hidden';
pauseMenu.innerHTML = `
  <div class="menu-card">
    <h2>Paused</h2>
    <button class="resume">Resume</button>
    <button class="restart ghost">Restart match</button>
    <button class="weather ghost">Match: Evening</button>
    <button class="graphics ghost">Graphics: Pixel</button>
    <button class="camera ghost">Camera: Normal</button>
    <button class="sound ghost">Sound: on</button>
  </div>`;
ui.appendChild(pauseMenu);

const rotate = document.createElement('div');
rotate.className = 'rotate';
rotate.innerHTML = '<div class="phone"></div><p>Turn your phone sideways</p>';
ui.appendChild(rotate);

// Charge bar above the active player while Pass / Through / Shoot is held.
const charge = document.createElement('div');
charge.className = 'charge';
charge.innerHTML = '<i class="fill"></i><i class="tick"></i>';
ui.appendChild(charge);
const chargeFill = charge.querySelector('.fill') as HTMLElement;
const chargeTick = charge.querySelector('.tick') as HTMLElement;
const headPos = new THREE.Vector3();

function updateCharge(alpha: number): void {
  const inp = controls.input;
  let btn = -1;
  if (playing && !paused && controls.mode === 'attack') {
    if (inp.held[2]) btn = 2;
    else if (inp.held[0]) btn = 0;
    else if (inp.held[1]) btn = 1;
  }
  if (btn < 0) {
    charge.classList.remove('show');
    return;
  }
  const hold = inp.holdTime[btn];
  // Shoot: full power at 0.85 s, over-hit beyond (red).
  const shot = btn === 2;
  // Pass / Through: the bar is the pass weight (full at 0.6 s); blue once slid up (lofted).
  const p = shot ? Math.min(1.15, hold / 0.85) / 1.15 : Math.min(1, hold / 0.6);
  chargeFill.style.transform = `scaleX(${p.toFixed(3)})`;
  charge.classList.toggle('shot', shot);
  charge.classList.toggle('over', shot && hold > 0.85);
  charge.classList.toggle('lofted', !shot && inp.swipe[btn]);
  chargeTick.style.display = shot ? '' : 'none';
  chargeTick.style.left = `${(1 / 1.15) * 100}%`;
  const c = match.controlled;
  headPos.set(c.prevPos.x + (c.pos.x - c.prevPos.x) * alpha, 2.45 * c.look.height, c.prevPos.z + (c.pos.z - c.prevPos.z) * alpha);
  headPos.project(rig.camera);
  const x = (headPos.x * 0.5 + 0.5) * window.innerWidth;
  const y = (-headPos.y * 0.5 + 0.5) * window.innerHeight;
  charge.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
  charge.classList.add('show');
}

const fpsEl = document.createElement('div');
fpsEl.className = 'fps';
if (DEBUG) ui.appendChild(fpsEl);

let playing = false;
let paused = false;
controls.setVisible(false);
hud.setVisible(false);
pauseBtn.style.display = 'none';

async function enterFullscreen(): Promise<void> {
  try {
    if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
      await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
    }
    const o = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
    await o.lock?.('landscape');
  } catch {
    /* not supported (iOS Safari): fine */
  }
}

let wakeLock: { release(): Promise<void> } | null = null;
async function keepAwake(): Promise<void> {
  try {
    const nav = navigator as Navigator & { wakeLock?: { request(t: string): Promise<{ release(): Promise<void> }> } };
    wakeLock = (await nav.wakeLock?.request('screen')) ?? null;
  } catch {
    wakeLock = null;
  }
}

function newMatch(): void {
  match = new Match(Date.now() & 0xffff);
  playersView.applyColors(match);
  acc = 0;
}

function startGame(): void {
  audio.unlock();
  void enterFullscreen();
  void keepAwake();
  newMatch();
  playing = true;
  paused = false;
  menu.classList.add('hidden');
  controls.setVisible(true);
  hud.setVisible(true);
  pauseBtn.style.display = '';
}

menu.querySelector('.play')!.addEventListener('click', startGame);
pauseBtn.addEventListener('click', () => setPaused(true));
pauseMenu.querySelector('.resume')!.addEventListener('click', () => setPaused(false));
pauseMenu.querySelector('.restart')!.addEventListener('click', () => {
  newMatch();
  setPaused(false);
});
const weatherBtn = pauseMenu.querySelector('.weather') as HTMLButtonElement;
const weatherLabel = () => (weatherBtn.textContent = `Match: ${atmo.weather === 'sunny' ? 'Sunny day' : 'Evening'}`);
weatherLabel();
weatherBtn.addEventListener('click', () => {
  atmo.weather = atmo.weather === 'sunny' ? 'evening' : 'sunny';
  weatherLabel();
  try {
    localStorage.setItem('weather', atmo.weather);
  } catch {
    /* ignore */
  }
});
const graphicsBtn = pauseMenu.querySelector('.graphics') as HTMLButtonElement;
const applyGraphics = () => {
  graphicsBtn.textContent = `Graphics: ${graphics === 'pixel' ? 'Pixel' : 'HD'}`;
  rig.pixelHeight = graphics === 'pixel' ? pixelPass.pixelHeight : 0;
};
graphicsBtn.addEventListener('click', () => {
  graphics = graphics === 'pixel' ? 'hd' : 'pixel';
  applyGraphics();
  try {
    localStorage.setItem('graphics', graphics);
  } catch {
    /* ignore */
  }
});
const cameraBtn = pauseMenu.querySelector('.camera') as HTMLButtonElement;
const cameraLabel = () => (cameraBtn.textContent = `Camera: ${cameraPreset[0].toUpperCase()}${cameraPreset.slice(1)}`);
cameraLabel();
cameraBtn.addEventListener('click', () => {
  cameraPreset = CAMERA_ORDER[(CAMERA_ORDER.indexOf(cameraPreset) + 1) % CAMERA_ORDER.length];
  rig.baseDist = CAMERA_PRESETS[cameraPreset];

  cameraLabel();
  try {
    localStorage.setItem('camera', cameraPreset);
  } catch {
    /* ignore */
  }
});
const soundBtn = pauseMenu.querySelector('.sound') as HTMLButtonElement;
soundBtn.addEventListener('click', () => {
  audio.setMuted(!audio.muted);
  soundBtn.textContent = `Sound: ${audio.muted ? 'off' : 'on'}`;
});

function setPaused(p: boolean): void {
  if (!playing) return;
  paused = p;
  pauseMenu.classList.toggle('hidden', !p);
  controls.enabled = !p;
  if (p) audio.suspend();
  else audio.resume();
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (playing && !paused) setPaused(true);
    audio.suspend();
  } else if (playing && wakeLock === null) {
    void keepAwake();
  }
});

// Block browser gestures (pinch zoom, double-tap zoom, context menu) during play.
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('contextmenu', (e) => e.preventDefault());

function onResize(): void {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h);
  rig.setAspect(w / h);
  // ~240-320 px tall: chunky enough to read as pixel art, players still ~10 px tall.
  pixelPass.height = Math.round(Math.min(320, Math.max(240, h * 0.72)));
  pixelPass.resize(w, h);
  applyGraphics();
  rotate.classList.toggle('show', h > w && matchMedia('(pointer: coarse)').matches);
}
window.addEventListener('resize', onResize);
onResize();

// ---------------------------------------------------------------- loop
let acc = 0;
let last = performance.now();
let simTime = 0;
let frameAvg = 16.7;
let perfCheckAt = performance.now() + 3000;
let fpsFrames = 0;
let fpsT = performance.now();
let lastPhase = match.phase;

function handleEvents(now: number): void {
  const e = match.takeEvents();
  if (playing) {
    for (const k of e.kicks) audio.kick(k);
    if (e.bounce > 1.5) audio.bounce(e.bounce);
    if (e.whistle) audio.whistle(e.whistle);
    if (e.post > 0) {
      audio.post(e.post);
      rig.bump(0.6);
    }
    if (e.net > 0) audio.net(e.net);
    if (e.goal >= 0) {
      particles.confetti(rig.focusX, e.goal as 0 | 1);
      audio.goal();
      rig.bump(0.4);
      const scorer = match.scorer;
      const team = match.teams[e.goal];
      hud.showCaption('GOAL', `${scorer ? '#' + (scorer.index + 1) + ' · ' : ''}${team.info.name}`, 3.2, now);
    }
    if (e.save > 0.5) audio.crowdGasp();
    audio.setExcitement(match.excitement);
  }
  if (e.net > 0) goals.impact(e.netX, e.netY, e.netZ, e.net, simTime);
  // Strikes rip up a little grass.
  for (const k of e.kicks) {
    if (k > 0.45 && match.ball.pos.y < 1) particles.grassBurst(match.ball.pos.x, match.ball.pos.z, k, match.ball.vel.x * 0.04, match.ball.vel.z * 0.04);
  }
  if (match.phase !== lastPhase) {
    if (playing && match.phase === 'halftime') hud.showCaption('HALF TIME', `${match.teams[0].score} – ${match.teams[1].score}`, 3, now);
    if (playing && match.phase === 'fulltime') {
      hud.showCaption('FULL TIME', `${match.teams[0].score} – ${match.teams[1].score}`, 30, now);
      setTimeout(() => {
        if (match.phase === 'fulltime') showEndMenu();
      }, 3500);
    }
    lastPhase = match.phase;
  }
}

function showEndMenu(): void {
  playing = false;
  hud.setVisible(false);
  controls.setVisible(false);
  pauseBtn.style.display = 'none';
  const [h, a] = match.teams;
  (menu.querySelector('.kicker') as HTMLElement).textContent = 'Full time';
  (menu.querySelector('.sub') as HTMLElement).innerHTML = `${h.info.short} ${h.score} <span>–</span> ${a.score} ${a.info.short}`;
  (menu.querySelector('.play') as HTMLElement).textContent = 'Play again';
  menu.classList.remove('hidden');
}

function adaptQuality(frameMs: number, now: number): void {
  if (FIXED_DPR) return;
  frameAvg += (frameMs - frameAvg) * 0.05;
  if (now < perfCheckAt) return;
  if (frameAvg > 19.5 && dpr > 0.75) {
    dpr = Math.max(0.75, dpr - 0.15);
    renderer.setPixelRatio(dpr);
    perfCheckAt = now + 2000;
  } else if (frameAvg < 14 && dpr < maxDpr) {
    dpr = Math.min(maxDpr, dpr + 0.1);
    renderer.setPixelRatio(dpr);
    perfCheckAt = now + 4000;
  } else {
    perfCheckAt = now + 1000;
  }
}

function showcase(dt: number): void {
  const picks = [0, 9, 5, 12, 20, 2, 11, 16];
  picks.forEach((id, i) => {
    const p = match.players[id];
    const running = i % 3 === 1;
    p.pos.set(-5.6 + i * 1.6, 0, 5 + (i % 2) * 1.2);
    p.prevPos.copy(p.pos);
    p.facing = running ? 0 : i % 2 === 0 ? -Math.PI / 2 + 0.3 : Math.PI / 2 - 0.3;
    p.prevFacing = p.facing;
    p.vel.set(running ? 7 : 0, 0, 0);
    p.stridePhase += running ? dt * 10 : 0;
    p.action = 'none';
  });
  for (const p of match.players) {
    if (!picks.includes(p.id)) {
      p.pos.set(p.pos.x, 0, -30);
      p.prevPos.copy(p.pos);
    }
  }
  match.ball.reset(0.8, 7);
  match.phase = 'play';
}

let cpuAvg = 0;
function frame(now: number): void {
  requestAnimationFrame(frame);
  const t0 = performance.now();
  const frameMs = now - last;
  const dt = Math.min(0.1, frameMs / 1000);
  last = now;

  const running = !paused;
  if (running) {
    controls.update(dt);
    controls.setMode(match.humanAttacking() ? 'attack' : 'defend');
    acc += dt;
    let steps = 0;
    if (SHOWCASE) {
      showcase(dt);
      acc = 0;
    }
    while (!SHOWCASE && acc >= DT && steps < 12) {
      match.step(controls.input);
      acc -= DT;
      steps++;
    }
    if (steps === 12) acc = 0;
    simTime = match.time;
    // Attract mode loops forever.
    if (!playing && match.phase === 'fulltime' && match.phaseT > 4) newMatch(), (match.autoPlay = true);
  }
  const alpha = acc / DT;
  handleEvents(now / 1000);

  rig.update(match, alpha, dt, now / 1000);
  playersView.update(match, alpha, now / 1000);
  ballView.update(match, alpha, running ? dt : 0);
  goals.update(simTime);
  // Time of day follows the match clock (the attract mode loops through it too).
  const progress = TOD >= 0 ? TOD : Math.min(1, ((match.half - 1) * MATCH.halfSeconds + match.clock) / (2 * MATCH.halfSeconds));
  atmo.set(progress);
  atmo.follow(rig.focusX, rig.focusZ);
  SHARED.uTime.value = now / 1000;
  stadium.update(now / 1000, match.excitement, atmo);
  if (playing) hud.update(match, now / 1000);
  updateCharge(alpha);

  particles.setScale(graphics === 'pixel' ? pixelPass.pixelHeight : renderer.domElement.height, rig.camera.fov);
  particles.update(running ? dt : 0, now / 1000, match, rig.focusX, rig.focusZ);
  if (graphics === 'pixel') pixelPass.render(renderer, scene, rig.camera, SHARED.uFlood.value, atmo.weather === 'sunny' ? 0.35 : 1, rig.subPixelX, rig.subPixelY);
  else renderer.render(scene, rig.camera);
  cpuAvg += (performance.now() - t0 - cpuAvg) * 0.05;
  adaptQuality(frameMs, now);

  if (DEBUG) {
    fpsFrames++;
    if (now - fpsT > 500) {
      const info = renderer.info.render;
      fpsEl.textContent = `${Math.round((fpsFrames * 1000) / (now - fpsT))} fps · ${info.calls} calls · ${(info.triangles / 1000).toFixed(0)}k tris · dpr ${dpr.toFixed(2)} · cpu ${cpuAvg.toFixed(2)}ms`;
      fpsFrames = 0;
      fpsT = now;
    }
  }
}
requestAnimationFrame(frame);

// Expose for debugging in the console.
if (DEBUG) (window as unknown as { game: unknown }).game = { get match() { return match; }, renderer };
