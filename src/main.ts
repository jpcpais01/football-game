import '@fontsource/barlow-condensed/latin-600.css';
import '@fontsource/barlow-condensed/latin-800.css';
import './style.css';
import * as THREE from 'three';
import { DT } from './sim/constants';
import { Match } from './sim/match';
import { createPitch } from './render/pitch';
import { createStadium } from './render/stadium';
import { createGoals } from './render/goals';
import { PlayersView } from './render/players';
import { BallView } from './render/ballView';
import { CameraRig } from './render/cameraRig';
import { COLORS, SUN_DIR } from './render/look';
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
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(COLORS.fog);
scene.fog = new THREE.Fog(COLORS.fog, 90, 260);

const sun = new THREE.DirectionalLight(COLORS.sun, 2.6);
sun.position.copy(SUN_DIR).multiplyScalar(-100);
scene.add(sun);
scene.add(new THREE.HemisphereLight(COLORS.hemiSky, COLORS.hemiGround, 1.25));

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
const rig = new CameraRig(window.innerWidth / window.innerHeight);
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
    <h1>Matchday</h1>
    <p class="sub">${match.teams[0].info.name} <span>vs</span> ${match.teams[1].info.name}</p>
    <button class="play">Kick off</button>
    <p class="hint">Landscape · joystick to move · Pass / Through / Shoot</p>
  </div>`;
ui.appendChild(menu);

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
    <button class="sound ghost">Sound: on</button>
  </div>`;
ui.appendChild(pauseMenu);

const rotate = document.createElement('div');
rotate.className = 'rotate';
rotate.innerHTML = '<div class="phone"></div><p>Turn your phone sideways</p>';
ui.appendChild(rotate);

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
    const att = match.attackingTeam() === match.humanTeam || match.phase === 'kickoff';
    controls.setMode(att ? 'attack' : 'defend');
    acc += dt;
    let steps = 0;
    while (acc >= DT && steps < 12) {
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
  stadium.update(now / 1000, match.excitement);
  if (playing) hud.update(match, now / 1000);

  renderer.render(scene, rig.camera);
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
