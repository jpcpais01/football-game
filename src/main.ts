import '@fontsource/barlow-condensed/latin-600.css';
import '@fontsource/barlow-condensed/latin-800.css';
import './style.css';
import * as THREE from 'three';
import { DT, GOAL_SEQ, MATCH, PITCH } from './sim/constants';
import { CELEBRATIONS, Match } from './sim/match';
import { createPitch } from './render/pitch';
import { TurfMarks } from './render/turfMarks';
import { createStadium } from './render/stadium';
import { createOldGround } from './render/oldGround';
import { clearFanBanner, loadFanBanner, pickFanBanner } from './ui/fanBanner';
import { createGoals } from './render/goals';
import { PlayersView } from './render/players';
import { BallView } from './render/ballView';
import { CAMERA_PRESETS, CameraRig, type CameraPreset } from './render/cameraRig';
import { Atmosphere, WEATHERS, WEATHER_NAMES, type Weather } from './render/atmosphere';
import { Rain } from './render/rain';
import { Terraces } from './ui/terraces';
import { PixelPass } from './render/pixelPass';
import { PALETTES } from './render/palettes';
import { Particles } from './render/particles';
import { Officials } from './render/officials';
import { Benches } from './render/bench';
import { SHARED } from './render/look';
import { Controls } from './ui/controls';
import { Hud } from './ui/hud';
import { Minimap } from './ui/minimap';
import { CornerAim } from './render/cornerAim';
import { Btn } from './sim/input';
import { GameAudio } from './ui/audio';
import { Club } from './meta/club';
import { crestCanvas } from './meta/crest';
import { HomeUI } from './home/home';

const app = document.getElementById('app')!;
// The boot screen in index.html: report milestones, dismiss it after the first frame.
const boot = window as unknown as { __boot?: (p: number) => void; __bootDone?: () => void };
boot.__boot?.(0.5);
let booted = false;
const params = new URLSearchParams(location.search);
const DEBUG = params.has('debug');

// ---------------------------------------------------------------- renderer
// Phones get a slightly lower resolution ceiling: the pitch shader is per-pixel work and
// 1.6x is visually indistinguishable at arm's length. Quality adapts at runtime anyway.
const coarse = matchMedia('(pointer: coarse)').matches;
const maxDpr = Math.min(window.devicePixelRatio || 1, coarse ? 1.6 : 2);
const startsHD = params.get('gfx') === 'hd';
const renderer = new THREE.WebGLRenderer({
  antialias: startsHD && maxDpr < 1.3,
  powerPreference: 'high-performance',
  stencil: false,
  // The pixel look renders the world into its own target (with depth); the screen canvas
  // only receives the final blit, so it needs no depth buffer (memory and bandwidth).
  depth: startsHD,
});
let dpr = maxDpr;
renderer.setPixelRatio(dpr);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
// Filmic tone mapping: warm highlights roll off softly instead of clipping.
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.12;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap; // (PCFSoft is gone in r18x; this is what it fell back to)
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
// Shadow texels well under an art pixel are wasted: 512 covers the 80 m around the camera
// at ~16 cm (an art pixel is ~25 cm there). Redrawn every other frame (see frame()).
const atmo = new Atmosphere(scene, { shadowSize: startsHD ? (coarse ? 1024 : 2048) : 512 });
renderer.shadowMap.autoUpdate = false;
let shadowTick = 0;
// ?tod=0..1 pins the time of day (for looking at the evening without playing a match).
const TOD = params.has('tod') ? Number(params.get('tod')) : -1;
// ?showcase: frozen line-up near the camera, for judging the player models.
const SHOWCASE = params.has('showcase');
// ?crowd=-1 / 1: hold the goal crowd shot on the home / away end (for looking at the stands).
const CROWD_SHOT = Number(params.get('crowd')) || 0;
// ?corner=near / far: your team gets a corner a moment after kick-off (for the corner camera);
// gk / gk-opp / fk-opp: a goal kick (yours / theirs) or their free kick on the edge of your box.
const DEBUG_CORNER = params.get('corner');
let debugCornerDone = false;

const club = new Club();
// The attract mode behind the menus plays our own club.
let match = new Match(Date.now() & 0xffff, club.matchSetup(Date.now() & 0xffff));
match.autoPlay = true;

const turfMarks = new TurfMarks();
const rain = new Rain();
/** The atmosphere in the stands: songs, drums, pyro (see Terraces). */
const terraces = new Terraces();
scene.add(rain.group);
scene.add(createPitch(renderer, turfMarks.texture));
// The stands wear the club's colours and crest; rebuilt when the kit or crest changes.
const makeStadium = () =>
  (club.state.ground === 'old' ? createOldGround : createStadium)(club.info().kit.shirt, club.opponentInfo().kit.shirt, {
    crest: crestCanvas(club.state.crest, 256),
    name: club.info().name,
    motto: club.bannerColors(),
    founded: club.state.crest.year,
  });
let stadium = makeStadium();
scene.add(stadium.group);
boot.__boot?.(0.75);
let fanPhoto: HTMLCanvasElement | null = null;

function rebuildStadium(): void {
  scene.remove(stadium.group);
  stadium.group.traverse((o) => {
    const m = o as THREE.Mesh;
    m.geometry?.dispose();
    const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
    for (const mat of mats) mat.dispose();
  });
  stadium = makeStadium();
  scene.add(stadium.group);
  if (fanPhoto) stadium.setFanBanner(fanPhoto);
}
const goals = createGoals();
scene.add(goals.group);
const officials = new Officials();
const benches = new Benches(22 + officials.all.length);
benches.reset(club.benchSetup(Date.now() & 0xffff));
const playersView = new PlayersView(match, [...officials.all, ...benches.all]);
playersView.officials = officials;
playersView.bench = benches;
scene.add(playersView.group);
const ballView = new BallView();
scene.add(ballView.group);
const cornerAim = new CornerAim();
scene.add(cornerAim.group);
let particles = new Particles(match.teams[0].info.kit.shirt, match.teams[1].info.kit.shirt);
scene.add(particles.points);
const rig = new CameraRig(window.innerWidth / window.innerHeight);
playersView.camera = rig.camera;
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

// Graphics: the pixel-art look (default), pixel art in a fixed palette, or full-resolution HD.
type Graphics = 'pixel' | 'palette' | 'hd';
// Palette and HD are retired for now (still fully working): put them back in this list to
// bring the Graphics / Palette options back to the pause menu.
const GRAPHICS: Graphics[] = ['pixel'];
const isGraphics = (g: string | null): g is Graphics => GRAPHICS.includes(g as Graphics);
let graphics: Graphics = isGraphics(params.get('gfx')) ? (params.get('gfx') as Graphics) : 'pixel';
let paletteIdx = 0;
try {
  const saved = localStorage.getItem('graphics');
  if (!params.has('gfx') && isGraphics(saved)) graphics = saved;
  paletteIdx = Math.min(PALETTES.length - 1, Math.max(0, Number(localStorage.getItem('palette')) || 0));
} catch {
  /* keep default */
}
const pixelPass = new PixelPass();
// Pixel fineness (pause menu slider): the art height, from chunky to fine.
const PIXELS_MIN = 140;
const PIXELS_MAX = 560;
let pixelsH = 288;
try {
  const saved = Number(localStorage.getItem('pixelH'));
  const old = localStorage.getItem('pixelFine'); // the old 7-step slider
  if (saved >= PIXELS_MIN && saved <= PIXELS_MAX) pixelsH = saved;
  else if (old !== null) pixelsH = [180, 216, 250, 288, 330, 380, 440][Number(old)] ?? 288;
} catch {
  /* keep default */
}
// The pixel look draws its art pixels at the screen's true resolution (whole device pixels
// each, no browser smoothing); the 3D work is at art resolution, so this costs ~nothing.
const deviceDpr = Math.min(window.devicePixelRatio || 1, 3);
/** Both pixel looks render through the pixel pass. */
const pixelLook = () => graphics !== 'hd';

// Match weather: evening (golden hour into floodlights), a sunny day or a rainy night.
try {
  const w = localStorage.getItem('weather') as Weather | null;
  if (w && WEATHERS.includes(w)) atmo.weather = w;
} catch {
  /* keep default */
}
const wq = params.get('weather') as Weather | null;
if (wq && WEATHERS.includes(wq)) atmo.weather = wq;
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

const home = new HomeUI(ui, club, audio, {
  onPlay: (seed) => startGame(seed),
  bannerLabel: () => (hasFanBanner ? 'Change your banner' : 'Your banner: add a photo'),
  onBanner: async () => {
    const photo = await pickFanBanner();
    if (photo) setFanBanner(photo);
  },
  onIdentity: () => {
    rebuildStadium();
    scene.remove(particles.points);
    particles = new Particles(club.info().kit.shirt, club.opponentInfo().kit.shirt);
    scene.add(particles.points);
    // Re-dress the attract-mode match behind the menus.
    if (!playing) {
      newMatch();
      match.autoPlay = true;
    }
  },
});
home.show();
boot.__boot?.(0.9);

const pauseBtn = document.createElement('button');
pauseBtn.className = 'pause-btn';
pauseBtn.setAttribute('aria-label', 'Pause');
pauseBtn.innerHTML = '<span></span><span></span>';
ui.appendChild(pauseBtn);
// Debug (temporary): a foul for us where the ball is right now.
const foulBtn = document.createElement('button');
foulBtn.className = 'debug-foul';
foulBtn.textContent = 'FOUL';
foulBtn.addEventListener('click', () => match.debugFoul());
ui.appendChild(foulBtn);

const pauseMenu = document.createElement('div');
pauseMenu.className = 'menu pause hidden';
pauseMenu.innerHTML = `
  <div class="menu-card">
    <h2>Paused</h2>
    <button class="resume">Resume</button>
    <button class="restart ghost">Restart match</button>
    <button class="quit ghost">Forfeit match</button>
    <button class="weather ghost">Match: Evening</button>
    <button class="graphics ghost">Graphics: Pixel</button>
    <button class="palette ghost">Palette</button>
    <button class="camera ghost">Camera: Normal</button>
    <button class="sound ghost">Sound: on</button>
    <button class="smooth ghost">Smoothing: on</button>
    <label class="fine wide"><span>Pixels</span><div class="fine-track"><div class="fine-ticks"></div><input class="fine-in" type="range" min="${PIXELS_MIN}" max="${PIXELS_MAX}" step="1"></div><b class="fine-val">288</b></label>
    <button class="stats ghost wide">FPS counter: off</button>
    <button class="fan ghost wide">Your banner: add photo</button>
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

// Dead-ball aim: a target on the goal mouth, moved with the stick in the shoulder view.
const aimMark = document.createElement('div');
aimMark.className = 'aim-mark';
aimMark.innerHTML = '<i></i>';
ui.appendChild(aimMark);
const aimPos = new THREE.Vector3();
/** Where the aiming reticle is on screen this frame (null when it isn't shown). */
let aimScreen: { x: number; y: number } | null = null;

function updateAim(): void {
  aimScreen = null;
  const a = playing && !paused && match.aimingShot ? match.aimPoint() : null;
  if (!a) {
    aimMark.classList.remove('show');
    return;
  }
  aimPos.set(a.x, a.y, a.z).project(rig.camera);
  if (aimPos.z > 1) return aimMark.classList.remove('show');
  const x = (aimPos.x * 0.5 + 0.5) * window.innerWidth;
  const y = (-aimPos.y * 0.5 + 0.5) * window.innerHeight;
  aimScreen = { x, y };
  aimMark.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
  // Off target (wide or over the bar): the reticle turns red.
  const off = Math.abs(a.z) > PITCH.goalHalfWidth - 0.1 || a.y > PITCH.goalHeight - 0.1;
  aimMark.classList.toggle('off', off);
  aimMark.classList.add('show');
}

function updateCharge(alpha: number): void {
  const inp = controls.input;
  let btn = -1;
  if (playing && !paused && controls.mode === 'attack') {
    if (inp.held[2]) btn = 2;
    else if (inp.held[0]) btn = 0;
    else if (inp.held[1]) btn = 1;
  }
  // A player switch cancels a charge that was being held.
  if (btn >= 0 && inp.holdTime[btn] > match.switchT + 0.05) btn = -1;
  if (btn < 0) {
    charge.classList.remove('show');
    return;
  }
  const hold = inp.holdTime[btn];
  // Shoot: full power at 0.85 s, over-hit beyond (red).
  const shot = btn === 2;
  // Pass / Through: the bar is the pass weight (full at 0.6 s); blue once slid up (lofted).
  const p = shot ? Math.min(1.15, hold / 0.85) / 1.15 : Math.min(1, hold / 0.6);
  // Dead-ball shot (aiming at the reticle): a gauge whose green peak is the best power —
  // full pace without sending it over (power ~0.92 of 1.15 on the bar's scale).
  const dead = shot && aimScreen !== null;
  charge.classList.toggle('dead', dead);
  if (dead) {
    chargeFill.style.transform = '';
    chargeFill.style.clipPath = `inset(0 ${((1 - p) * 100).toFixed(1)}% 0 0)`;
  } else {
    chargeFill.style.clipPath = '';
    chargeFill.style.transform = `scaleX(${p.toFixed(3)})`;
  }
  charge.classList.toggle('shot', shot);
  charge.classList.toggle('over', shot && hold > 0.85);
  charge.classList.toggle('lofted', !shot && inp.swipe[btn]);
  chargeTick.style.display = shot ? '' : 'none';
  chargeTick.style.left = `${((dead ? 0.92 : 1) / 1.15) * 100}%`;
  let x: number;
  let y: number;
  if (aimScreen) {
    // Free kick / penalty: the bar sits right over the aiming reticle, where the eyes are.
    x = aimScreen.x;
    y = aimScreen.y - 32;
  } else {
    // Open play: above the active player's head.
    const c = match.controlled;
    headPos.set(c.prevPos.x + (c.pos.x - c.prevPos.x) * alpha, 2.45 * c.look.height, c.prevPos.z + (c.pos.z - c.prevPos.z) * alpha);
    headPos.project(rig.camera);
    x = (headPos.x * 0.5 + 0.5) * window.innerWidth;
    y = (-headPos.y * 0.5 + 0.5) * window.innerHeight;
  }
  charge.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
  charge.classList.add('show');
}

const fpsEl = document.createElement('div');
fpsEl.className = 'fps';
ui.appendChild(fpsEl);
// FPS / frame-time readout: a pause-menu setting (always on with ?debug).
let showStats = DEBUG;
try {
  showStats = showStats || localStorage.getItem('stats') === '1';
} catch {
  /* keep default */
}
const statsBtn = pauseMenu.querySelector('.stats') as HTMLButtonElement;
const applyStats = () => {
  fpsEl.style.display = showStats ? '' : 'none';
  statsBtn.textContent = `FPS counter: ${showStats ? 'on' : 'off'}`;
};
applyStats();
statsBtn.addEventListener('click', () => {
  showStats = !showStats;
  applyStats();
  try {
    localStorage.setItem('stats', showStats ? '1' : '0');
  } catch {
    /* ignore */
  }
});

let playing = false;
let paused = false;
controls.setVisible(false);
hud.setVisible(false);
const minimap = new Minimap(ui);
minimap.setVisible(false);
pauseBtn.style.display = foulBtn.style.display = 'none';

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

let matchSeed = 1;
function newMatch(seed = Date.now() & 0xffff): void {
  matchSeed = seed;
  match = new Match(seed, club.matchSetup(seed));
  officials.reset();
  benches.reset(club.benchSetup(seed));
  playersView.applyColors(match);
  hud.setTeams(match);
  acc = 0;
}

function startGame(seed: number): void {
  audio.unlock();
  void enterFullscreen();
  void keepAwake();
  newMatch(seed);
  playing = true;
  paused = false;
  home.hide();
  onResize();
  controls.setVisible(true);
  hud.setVisible(true);
  minimap.setVisible(true);
  pauseBtn.style.display = foulBtn.style.display = '';
}

pauseBtn.addEventListener('click', () => setPaused(true));
pauseMenu.querySelector('.resume')!.addEventListener('click', () => setPaused(false));
pauseMenu.querySelector('.restart')!.addEventListener('click', () => {
  newMatch(matchSeed);
  setPaused(false);
});
// Forfeit: back to the menu mid-match, booked as a 0-3 defeat. Two taps, so it's never by accident.
const quitBtn = pauseMenu.querySelector('.quit') as HTMLButtonElement;
quitBtn.addEventListener('click', () => {
  if (!quitBtn.classList.contains('armed')) {
    quitBtn.classList.add('armed');
    quitBtn.textContent = 'Tap again: lose 0–3';
    return;
  }
  club.recordForfeit();
  setPaused(false);
  backToMenu();
  home.toast('Match forfeited · 0–3 defeat');
});
const weatherBtn = pauseMenu.querySelector('.weather') as HTMLButtonElement;
const weatherLabel = () => (weatherBtn.textContent = `Match: ${WEATHER_NAMES[atmo.weather]}`);
weatherLabel();
weatherBtn.addEventListener('click', () => {
  atmo.weather = WEATHERS[(WEATHERS.indexOf(atmo.weather) + 1) % WEATHERS.length];
  weatherLabel();
  try {
    localStorage.setItem('weather', atmo.weather);
  } catch {
    /* ignore */
  }
});
const graphicsBtn = pauseMenu.querySelector('.graphics') as HTMLButtonElement;
const paletteBtn = pauseMenu.querySelector('.palette') as HTMLButtonElement;
if (GRAPHICS.length < 2) graphicsBtn.style.display = 'none';
const applyGraphics = () => {
  graphicsBtn.textContent = `Graphics: ${graphics === 'pixel' ? 'Pixel' : graphics === 'palette' ? 'Palette' : 'HD'}`;
  rig.pixelHeight = pixelLook() ? pixelPass.pixelHeight : 0;
  pixelPass.setPalette(graphics === 'palette' ? PALETTES[paletteIdx] : null);
  paletteBtn.style.display = graphics === 'palette' ? '' : 'none';
  pauseMenu.classList.toggle('has-palette', graphics === 'palette');
  paletteBtn.innerHTML = `<span class="pal-arrow">‹</span>${PALETTES[paletteIdx].name}<span class="pal-arrow">›</span>`;
  paletteBtn.title = `Palette ${paletteIdx + 1} of ${PALETTES.length} · tap or swipe`;
};
graphicsBtn.addEventListener('click', () => {
  graphics = GRAPHICS[(GRAPHICS.indexOf(graphics) + 1) % GRAPHICS.length];
  onResize();
  try {
    localStorage.setItem('graphics', graphics);
  } catch {
    /* ignore */
  }
});
// Palette: tap for the next one, or swipe across the button either way.
const setPaletteIdx = (i: number) => {
  paletteIdx = (i + PALETTES.length) % PALETTES.length;
  applyGraphics();
  try {
    localStorage.setItem('palette', String(paletteIdx));
  } catch {
    /* ignore */
  }
};
let palSwipeX = -1;
let palSwiped = false;
paletteBtn.addEventListener('pointerdown', (e) => {
  palSwipeX = e.clientX;
  palSwiped = false;
});
paletteBtn.addEventListener('pointermove', (e) => {
  if (palSwipeX < 0 || palSwiped) return;
  const dx = e.clientX - palSwipeX;
  if (Math.abs(dx) > 36) {
    palSwiped = true;
    setPaletteIdx(paletteIdx + (dx < 0 ? 1 : -1));
  }
});
paletteBtn.addEventListener('pointerup', () => (palSwipeX = -1));
paletteBtn.addEventListener('click', () => {
  if (!palSwiped) setPaletteIdx(paletteIdx + 1);
  palSwiped = false;
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
const fineRow = pauseMenu.querySelector('.fine') as HTMLElement;
const fineIn = pauseMenu.querySelector('.fine-in') as HTMLInputElement;
const fineVal = pauseMenu.querySelector('.fine-val') as HTMLElement;
const fineTicks = pauseMenu.querySelector('.fine-ticks') as HTMLElement;
/** Art heights that divide this screen's real height exactly (every art pixel n x n device pixels). */
let exactHeights: number[] = [];
let ticksFor = 0;
function updateFineTicks(): void {
  const H = renderer.domElement.height;
  if (H === ticksFor) return;
  ticksFor = H;
  exactHeights = [];
  for (let n = 1; n <= 64; n++) if (H % n === 0 && H / n >= PIXELS_MIN && H / n <= PIXELS_MAX) exactHeights.push(H / n);
  const span = PIXELS_MAX - PIXELS_MIN;
  fineTicks.innerHTML = exactHeights.map((v) => `<i style="--p:${((v - PIXELS_MIN) / span).toFixed(4)}" title="${v} px · ${H / v}x"></i>`).join('');
  showFine();
}
function showFine(): void {
  const sharp = exactHeights.includes(pixelsH);
  fineVal.textContent = sharp ? `${pixelsH} px · sharp` : `${pixelsH} px`;
  fineVal.classList.toggle('sharp', sharp);
}
fineIn.value = String(pixelsH);
showFine();
fineIn.addEventListener('input', () => {
  // Steps of 4, snapping onto an exact value when the thumb comes within a few pixels of it.
  const raw = Number(fineIn.value);
  const near = exactHeights.find((v) => Math.abs(v - raw) <= 4);
  pixelsH = near ?? Math.min(PIXELS_MAX, Math.max(PIXELS_MIN, PIXELS_MIN + Math.round((raw - PIXELS_MIN) / 4) * 4));
  fineIn.value = String(pixelsH);
  showFine();
  onResize();
  try {
    localStorage.setItem('pixelH', String(pixelsH));
  } catch {
    /* ignore */
  }
});
// Smoothing: each art pixel picks the most typical of 4 samples (no shimmer), or takes 1.
const smoothBtn = pauseMenu.querySelector('.smooth') as HTMLButtonElement;
let smoothing = true;
try {
  smoothing = localStorage.getItem('smoothing') !== 'off';
} catch {
  /* keep default */
}
const applySmoothing = () => {
  pixelPass.setSupersample(smoothing ? 2 : 1);
  smoothBtn.textContent = `Smoothing: ${smoothing ? 'on' : 'off'}`;
};
applySmoothing();
smoothBtn.addEventListener('click', () => {
  smoothing = !smoothing;
  applySmoothing();
  try {
    localStorage.setItem('smoothing', smoothing ? 'on' : 'off');
  } catch {
    /* ignore */
  }
});
const soundBtn = pauseMenu.querySelector('.sound') as HTMLButtonElement;
soundBtn.addEventListener('click', () => {
  audio.setMuted(!audio.muted);
  soundBtn.textContent = `Sound: ${audio.muted ? 'off' : 'on'}`;
});

// "Your banner": a photo the fans hold up in the stands (kept on this device).
let hasFanBanner = false;
const fanBtn = pauseMenu.querySelector('.fan') as HTMLButtonElement;
function setFanBanner(photo: HTMLCanvasElement | null): void {
  hasFanBanner = photo !== null;
  fanPhoto = photo;
  stadium.setFanBanner(photo);
  fanBtn.textContent = hasFanBanner ? 'Your banner: remove' : 'Your banner: add photo';
}
void loadFanBanner().then((photo) => photo && setFanBanner(photo));
fanBtn.addEventListener('click', async () => {
  if (hasFanBanner) {
    clearFanBanner();
    setFanBanner(null);
  } else {
    const photo = await pickFanBanner();
    if (photo) setFanBanner(photo);
  }
});

function setPaused(p: boolean): void {
  if (!playing) return;
  paused = p;
  quitBtn.classList.remove('armed');
  quitBtn.textContent = 'Forfeit match';
  pauseMenu.classList.toggle('hidden', !p);
  minimap.setVisible(!p);
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
  if (!FIXED_DPR) renderer.setPixelRatio(pixelLook() ? deviceDpr : dpr);
  renderer.setSize(w, h);
  rig.setAspect(w / h);
  pixelPass.height = pixelsH;
  pixelPass.resize(renderer.domElement.width, renderer.domElement.height);
  updateFineTicks();
  renderer.domElement.style.imageRendering = pixelLook() ? 'pixelated' : '';
  fineRow.style.display = pixelLook() ? '' : 'none';
  applyGraphics();
  rotate.classList.toggle('show', playing && h > w && matchMedia('(pointer: coarse)').matches);
}
window.addEventListener('resize', onResize);
onResize();

// ---------------------------------------------------------------- loop
let acc = 0;
let last = performance.now();
/** When the next frame is due (see the frame pacing in `frame`). */
let nextFrameAt = 0;
let simTime = 0;
let frameAvg = 16.7;
/** Frame pacing: the display's refresh interval, and the interval we actually draw at. */
let rafAvg = 16.7;
let lastRaf = performance.now();
let targetMs = 16.7;

let perfCheckAt = performance.now() + 3000;
let fpsFrames = 0;
let fpsT = performance.now();
let lastPhase = match.phase;

function handleEvents(now: number): void {
  const e = match.takeEvents();
  terraces.onEvents(e, match);
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
      const who = scorer ? (scorer.name ? scorer.name.split(' ').slice(-1)[0] : '#' + (scorer.index + 1)) + ' · ' : '';
      hud.showCaption('GOAL', `${who}${team.info.name}`, 3.2, now);
      // The new score is revealed as the camera comes back from the crowd.
      hud.goal(match, e.goal, GOAL_SEQ.back + 0.6);
    }
    if (e.save > 0.5) audio.crowdGasp();
    // Referee's calls.
    const f = match.lastFoul;
    if (e.foul === 2) hud.showCaption('ADVANTAGE', 'Play on', 1.8, now, 'small');
    else if (e.foul === 1 && f) {
      if (f.penalty) {
        hud.showCaption('PENALTY', match.teams[f.victim.team].info.name, 3, now);
        audio.crowdGasp();
      } else if (f.yellow) hud.showCaption('YELLOW CARD', `${f.offender.name ? f.offender.name.split(' ').slice(-1)[0] : '#' + (f.offender.index + 1)} · ${match.teams[f.offender.team].info.name}`, 2.6, now, 'yellow');
      else hud.showCaption('FOUL', `Free kick · ${match.teams[f.victim.team].info.name}`, 2, now, 'small');
    }
    if (e.offside && match.lastOffside) hud.showCaption('OFFSIDE', `Free kick · ${match.teams[match.lastOffside.team].info.name}`, 2, now, 'small');
    // Booked while advantage was played: show the card now.
    if (e.card && e.foul === 2 && f) hud.showCaption('YELLOW CARD', `${f.offender.name ? f.offender.name.split(' ').slice(-1)[0] : '#' + (f.offender.index + 1)} · ${match.teams[f.offender.team].info.name} · advantage`, 2.6, now, 'yellow');
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

function backToMenu(): void {
  playing = false;
  hud.setVisible(false);
  minimap.setVisible(false);
  controls.setVisible(false);
  pauseBtn.style.display = foulBtn.style.display = 'none';
  match.autoPlay = true;
  home.show();
  onResize();
}

function showEndMenu(): void {
  const [h, a] = match.teams;
  backToMenu();
  home.showResult(h.score, a.score, h.info, a.info, () => home.show());
}

function adaptQuality(frameMs: number, now: number): void {
  if (FIXED_DPR) return;
  frameAvg += (frameMs - frameAvg) * 0.05;
  if (now < perfCheckAt) return;
  // Pixel look: the resolution is the art, and smoothing is the player's choice (pause menu).
  if (pixelLook()) return;
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
  if (!booted) {
    // Compile every shader while the boot screen is still up (no hitch the first time
    // something appears), then lift the curtain once the first frame has been drawn.
    booted = true;
    renderer.setRenderTarget(pixelLook() ? pixelPass.target : null);
    const compiled = renderer.compileAsync(scene, rig.camera).catch(() => undefined);
    renderer.setRenderTarget(null);
    const timeout = new Promise((r) => setTimeout(r, 4000));
    void Promise.race([compiled, timeout]).then(() => requestAnimationFrame(() => boot.__bootDone?.()));
  }
  requestAnimationFrame(frame);
  // Frame pacing: a frame scheduler at the target rate — 120 fps in play, 90 on the home
  // screen, 60 under the pause menu. On a faster display, refreshes are skipped evenly to
  // hold the rate; on a slower one every refresh is drawn.
  rafAvg += (Math.min(50, now - lastRaf) - rafAvg) * 0.1;
  lastRaf = now;
  targetMs = 1000 / (paused ? 60 : playing ? 120 : 90);
  if (now < nextFrameAt - rafAvg * 0.5) return;
  nextFrameAt = now - nextFrameAt > targetMs ? now + targetMs : nextFrameAt + targetMs;
  const t0 = performance.now();
  const frameMs = now - last;
  const dt = Math.min(0.1, frameMs / 1000);
  last = now;

  const running = !paused;
  if (running) {
    controls.update(dt);
    // After your goal the buttons pick the celebration (and show which, while it plays).
    const cel = match.celebration;
    const mine = match.phase === 'goal' && match.scorer?.team === match.humanTeam && !match.autoPlay;
    if (match.celebrationOpen) controls.setMode('celebrate');
    else if (mine && cel && match.phaseT < cel.at + 1.6) controls.setMode('celebrate', CELEBRATIONS.indexOf(cel.kind));
    else controls.setMode(match.humanAttacking() ? 'attack' : 'defend');
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

  officials.update(match, running ? dt : 0);
  benches.update(match, running ? dt : 0);
  rig.cinematic = !playing || match.phase === 'halftime' || match.phase === 'fulltime';
  // A 4-second shot of the scoring side's fans going wild after each goal.
  rig.crowdShot = CROWD_SHOT || (playing && match.phase === 'goal' && match.phaseT >= GOAL_SEQ.crowd && match.phaseT < GOAL_SEQ.back && match.scorer ? (match.scorer.team === 0 ? -1 : 1) : 0);
  rig.update(match, alpha, dt, now / 1000);
  playersView.update(match, alpha, now / 1000);
  ballView.update(match, alpha, running ? dt : 0);
  goals.update(simTime);
  // Time of day follows the match clock (the attract mode loops through it too).
  const progress = TOD >= 0 ? TOD : Math.min(1, ((match.half - 1) * MATCH.halfSeconds + match.clock) / (2 * MATCH.halfSeconds));
  atmo.set(progress);
  atmo.follow(rig.focusX, rig.focusZ);
  SHARED.uTime.value = now / 1000;
  // The ultras hold up their card display for each kick-off and the opening seconds of the half.
  const tifo = match.phase === 'kickoff' || (match.phase === 'play' && match.clock < 8) ? 1 : 0;
  stadium.setNearStand(rig.groundLevel);
  if (DEBUG_CORNER && !debugCornerDone && playing && match.phase === 'play' && match.clock > 2) {
    debugCornerDone = true;
    const t = match.humanTeam;
    const o = 1 - t;
    if (DEBUG_CORNER === 'gk') match.startSetPiece('goalkick', t, -PITCH.halfL * match.teams[t].dir + match.teams[t].dir * 5.5, 4);
    else if (DEBUG_CORNER === 'gk-opp') match.startSetPiece('goalkick', o, -PITCH.halfL * match.teams[o].dir + match.teams[o].dir * 5.5, -4);
    else if (DEBUG_CORNER === 'fk-opp') match.startSetPiece('freekick', o, PITCH.halfL * match.teams[o].dir - match.teams[o].dir * 22, 6);
    else match.startSetPiece('corner', t, PITCH.halfL * match.teams[t].dir, (DEBUG_CORNER === 'far' ? -1 : 1) * PITCH.halfW);
  }
  terraces.update(running ? dt : 0, match);
  stadium.update(now / 1000, match.excitement, atmo, tifo, terraces);
  turfMarks.update(match, renderer);
  if (playing) hud.update(match, now / 1000), minimap.update(match, now / 1000);
  updateAim();
  // Corner ring and flight preview (holding Shoot shows the floated ball).
  cornerAim.update(match, playing && controls.input.held[Btn.C], now / 1000);
  updateCharge(alpha);

  particles.setScale(pixelLook() ? pixelPass.pixelHeight : renderer.domElement.height, rig.camera.fov);
  particles.update(running ? dt : 0, now / 1000, match, rig.focusX, rig.focusZ, terraces);
  rain.update(atmo.weather === 'rain', rig.camera, rig.focusX, rig.focusZ, pixelLook() ? pixelPass.pixelHeight : renderer.domElement.height);
  audio.setRain(atmo.weather === 'rain');
  audio.terraces(terraces);
  // A full-screen menu covers the stadium: don't spend the battery drawing it.
  if (home.opaque) {
    /* skip */
  } else if (pixelLook()) {
    if ((shadowTick++ & 1) === 0) renderer.shadowMap.needsUpdate = true;
    pixelPass.render(renderer, scene, rig.camera, SHARED.uFlood.value, atmo.weather === 'sunny' ? 0.35 : 1, rig.subPixelX, rig.subPixelY);
  } else {
    renderer.shadowMap.needsUpdate = true;
    renderer.render(scene, rig.camera);
  }
  cpuAvg += (performance.now() - t0 - cpuAvg) * 0.05;
  adaptQuality(frameMs, now);

  if (showStats) {
    fpsFrames++;
    if (now - fpsT > 500) {
      const fps = Math.round((fpsFrames * 1000) / (now - fpsT));
      const ms = ((now - fpsT) / fpsFrames).toFixed(1);
      const info = renderer.info.render;
      fpsEl.textContent = DEBUG
        ? `${fps} fps · ${ms} ms · ${info.calls} calls · ${(info.triangles / 1000).toFixed(0)}k tris · dpr ${dpr.toFixed(2)} · cpu ${cpuAvg.toFixed(2)}ms`
        : `${fps} fps · ${ms} ms`;
      fpsFrames = 0;
      fpsT = now;
    }
  } else {
    fpsFrames = 0;
    fpsT = now;
  }
}
requestAnimationFrame(frame);

// Expose for debugging in the console.
if (DEBUG) (window as unknown as { game: unknown }).game = { get match() { return match; }, renderer, scene, pixelPass, stadium, atmo, start: startGame };
