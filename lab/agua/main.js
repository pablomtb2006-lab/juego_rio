import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RiverSimulation } from '../../src/fluid/RiverSimulation.js';
import { RiverController } from '../../src/fluid/RiverController.js';
import { FreeSurfaceReconstruction } from '../../src/fluid/render/FreeSurfaceReconstruction.js';
import { WaterRendering, SKY_GLSL } from '../../src/fluid/render/WaterRendering.js';
import { FoamAndSpray } from '../../src/fluid/render/FoamAndSpray.js';
import { FieldView, FIELDS } from '../../src/fluid/render/FieldView.js';

/**
 * Río Vivo — water laboratory, isolated from the game.
 * An arena like the reference video: a mesa with water on top (it pours off as a waterfall),
 * a ramp, grey blocks, rocks, a narrowing between two walls, a source that can be opened, and a
 * drain whose outflow is booked. Everything you see moving is the solver; see docs/RIO_VIVO.md.
 */
const params = new URLSearchParams(location.search);
const PROFILES = {
  // resolution, cost and particle budget — never changed silently: the panel shows the active one
  dev: { capacity: 8192, spacing: 0.19, substeps: 2, iterations: 3, pixelRatio: 1 },
  balanced: { capacity: 16384, spacing: 0.15, substeps: 3, iterations: 4, pixelRatio: 1.25 },
  high: { capacity: 32768, spacing: 0.12, substeps: 3, iterations: 4, pixelRatio: 1.5 },
  experimental: { capacity: 65536, spacing: 0.095, substeps: 4, iterations: 4, pixelRatio: 1.5 },
};

// --- the arena (SI metres) -----------------------------------------------------------------------
const DOMAIN = { min: [-12, 0, -12], max: [12, 8, 12] };
const MESA = { center: [-8, 1.0, -8], half: [3.5, 1.0, 3.5] };
const RAMP_ANGLE = Math.atan2(2, 3.8);
const ARENA = {
  boxes: [
    MESA,
    { center: [-2.6, 0.86, -8], half: [2.15, 0.15, 1.6], rot: [0, 0, -RAMP_ANGLE] }, // ramp off the mesa
    // the narrowing: two walls leaving a 1.6 m gap
    { center: [3, 0.7, -3.4], half: [0.35, 0.7, 2.6] },
    { center: [3, 0.7, 3.4], half: [0.35, 0.7, 2.6] },
    // blocks scattered like the video
    { center: [-3.5, 0.6, 1.5], half: [0.8, 0.6, 0.8], rot: [0, 0.5, 0] },
    { center: [0.5, 0.45, -5.5], half: [0.6, 0.45, 1.1], rot: [0, -0.3, 0] },
    { center: [-6, 0.5, 4], half: [1.2, 0.5, 0.5], rot: [0, 0.9, 0] },
    { center: [6.5, 0.8, -1], half: [0.7, 0.8, 0.7], rot: [0, 0.2, 0] },
    { center: [7.5, 0.4, 5], half: [1.4, 0.4, 0.6], rot: [0, -0.6, 0] },
    { center: [-0.5, 1.0, 7.5], half: [0.5, 1.0, 1.6], rot: [0, 0.15, 0] },
    { center: [9.5, 0.6, -7], half: [0.9, 0.6, 0.9], rot: [0, 0.7, 0] },
  ],
  spheres: [
    { center: [-2.5, -0.35, -1.6], radius: 0.9 },
    { center: [1.5, -0.5, 2.4], radius: 1.1 },
    { center: [5.2, -0.3, -4.6], radius: 0.7 },
    { center: [-4.2, -0.2, 6.8], radius: 0.8 },
  ],
};
const WATER = [{ min: [-10.8, 2.0, -10.8], max: [-5.4, 3.5, -5.4] }];
const SOURCE = { center: [-8, 5.6, -8], dir: [0, -1, 0], radius: 0.45, speed: 3.5 };
const SINK = { min: [9.6, 0, 9.6], max: [12, 1.2, 12] };

// --- renderer, camera, light --------------------------------------------------------------------
const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
renderer.outputColorSpace = THREE.LinearSRGBColorSpace; // tone mapping + sRGB happen in the water compositor
renderer.toneMapping = THREE.NoToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
const gl = renderer.getContext();

const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 400);
camera.position.set(10, 10.5, 15);
const controls = new OrbitControls(camera, canvas);
controls.target.set(-3, 0.5, -3);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI * 0.49;

const sunDir = new THREE.Vector3(0.45, 0.78, 0.32).normalize();
const sky = {
  uniforms: {
    uSunDir: { value: sunDir },
    uSunColor: { value: new THREE.Vector3(2.7, 2.5, 2.2) },
    uSkyTop: { value: new THREE.Vector3(0.16, 0.34, 0.74) },
    uSkyHorizon: { value: new THREE.Vector3(0.62, 0.74, 0.86) },
    uSkyGround: { value: new THREE.Vector3(0.32, 0.31, 0.29) },
  },
};

const scene = new THREE.Scene();
scene.add(
  new THREE.Mesh(
    new THREE.SphereGeometry(200, 32, 16),
    new THREE.ShaderMaterial({
      uniforms: sky.uniforms,
      side: THREE.BackSide,
      depthWrite: false,
      vertexShader: `varying vec3 vDir; void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `${SKY_GLSL}\nvarying vec3 vDir; void main() { gl_FragColor = vec4(skyRadiance(normalize(vDir)), 1.0); }`,
    }),
  ),
);
const sun = new THREE.DirectionalLight(new THREE.Color(1.0, 0.95, 0.86), 2.7);
sun.position.copy(sunDir).multiplyScalar(40);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -18, right: 18, top: 18, bottom: -18, near: 1, far: 90 });
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.02;
scene.add(sun, new THREE.HemisphereLight(0x9cc4ec, 0x5c574e, 1.05));

// floor: light concrete slabs, so refraction has something to bend
function concreteTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const x = c.getContext('2d');
  x.fillStyle = '#b8b4aa';
  x.fillRect(0, 0, 512, 512);
  const img = x.getImageData(0, 0, 512, 512);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 18;
    img.data[i] += n;
    img.data[i + 1] += n;
    img.data[i + 2] += n * 0.9;
  }
  x.putImageData(img, 0, 0);
  x.strokeStyle = 'rgba(70,66,60,0.45)';
  x.lineWidth = 3;
  for (let k = 0; k <= 4; k++) {
    x.beginPath();
    x.moveTo(k * 128, 0);
    x.lineTo(k * 128, 512);
    x.moveTo(0, k * 128);
    x.lineTo(512, k * 128);
    x.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(15, 15);
  t.anisotropy = 4;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const floor = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.MeshStandardMaterial({ map: concreteTexture(), roughness: 0.92 }));
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);

const blockMat = new THREE.MeshStandardMaterial({ color: 0x9ba4a9, roughness: 0.85 });
const rockMat = new THREE.MeshStandardMaterial({ color: 0x6d7c84, roughness: 0.95, flatShading: true });
for (const b of ARENA.boxes) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(b.half[0] * 2, b.half[1] * 2, b.half[2] * 2), blockMat);
  m.position.fromArray(b.center);
  m.rotation.fromArray([...(b.rot ?? [0, 0, 0]), 'XYZ']);
  m.castShadow = m.receiveShadow = true;
  scene.add(m);
}
function rockMesh(r) {
  const g = new THREE.IcosahedronGeometry(r, 2);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const v = new THREE.Vector3().fromBufferAttribute(p, i);
    v.multiplyScalar(1 + (Math.sin(v.x * 5.1) * Math.cos(v.z * 4.3) + Math.sin(v.y * 6.7)) * 0.025);
    p.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, rockMat);
  m.castShadow = m.receiveShadow = true;
  return m;
}
for (const s of ARENA.spheres) {
  const m = rockMesh(s.radius);
  m.position.fromArray(s.center);
  scene.add(m);
}
// arena kerb (the domain walls are real for the solver: show them)
const kerbMat = new THREE.MeshStandardMaterial({ color: 0x8b9196, roughness: 0.9 });
for (const [cx, cz, sx, sz] of [[0, -12.2, 24.8, 0.4], [0, 12.2, 24.8, 0.4], [-12.2, 0, 0.4, 24.8], [12.2, 0, 0.4, 24.8]]) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(sx, 1.4, sz), kerbMat);
  m.position.set(cx, 0.7, cz);
  m.receiveShadow = m.castShadow = true;
  scene.add(m);
}
// drain and spout
const drain = new THREE.Mesh(new THREE.PlaneGeometry(SINK.max[0] - SINK.min[0], SINK.max[2] - SINK.min[2]), new THREE.MeshStandardMaterial({ color: 0x1d2226, roughness: 0.6 }));
drain.rotation.x = -Math.PI / 2;
drain.position.set((SINK.min[0] + SINK.max[0]) / 2, 0.01, (SINK.min[2] + SINK.max[2]) / 2);
scene.add(drain);
const spout = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 1.2, 24, 1, true), new THREE.MeshStandardMaterial({ color: 0x59636a, roughness: 0.5, metalness: 0.4, side: THREE.DoubleSide }));
spout.position.set(SOURCE.center[0], SOURCE.center[1] + 0.7, SOURCE.center[2]);
scene.add(spout);
const thrownRock = rockMesh(0.6);
thrownRock.visible = false;
scene.add(thrownRock);

// --- simulation ------------------------------------------------------------------------------------
let profileName = PROFILES[params.get('profile')] ? params.get('profile') : 'balanced';
document.getElementById('profile').value = profileName;
let sim, controller, surface, foam, fieldView, source, rock;
const water = new WaterRendering(renderer, sky);
let sceneRT;
const emptyDepth = new THREE.DataTexture(new Float32Array([0, 0, 0, 0]), 1, 1, THREE.RGBAFormat, THREE.FloatType);
emptyDepth.needsUpdate = true;

function build() {
  const P = PROFILES[profileName];
  sim = new RiverSimulation(gl, {
    capacity: P.capacity,
    domain: DOMAIN,
    obstacles: { boxes: ARENA.boxes, spheres: ARENA.spheres },
    config: { spacing: P.spacing, substeps: P.substeps, iterations: P.iterations },
  });
  sim.fill(WATER);
  source = sim.addSource(SOURCE);
  source.on = sourceOn;
  sim.setSink(SINK.min, SINK.max);
  controller = new RiverController(sim, { maxAccel: 6, response: 3 });
  surface = new FreeSurfaceReconstruction(renderer, sim.L, sim.cfg.particleRadius);
  foam = new FoamAndSpray(sim.L);
  if (fieldView) scene.remove(fieldView.points);
  const prevField = fieldView?.field ?? null;
  fieldView = new FieldView(sim.L);
  fieldView.field = prevField;
  rock = null;
  thrownRock.visible = false;
  renderer.resetState();
  resize();
  if (document.getElementById('physCtl')) {
    buildPhysics();
    buildOptics();
  }
}

let sourceOn = false;
function resize() {
  const P = PROFILES[profileName];
  const pr = Math.min(window.devicePixelRatio || 1, P.pixelRatio);
  const w = Math.max(2, Math.floor(window.innerWidth * pr));
  const h = Math.max(2, Math.floor(window.innerHeight * pr));
  renderer.setPixelRatio(1);
  renderer.setSize(w, h, false);
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  sceneRT?.dispose();
  sceneRT = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, depthTexture: new THREE.DepthTexture(w, h, THREE.UnsignedIntType), samples: 0 });
  surface?.setSize(w, h);
  size = { w, h };
}
let size = { w: 2, h: 2 };
window.addEventListener('resize', resize);

// --- the thrown rock: a kinematic solid (one-way coupled: it pushes the water, the water does not push it)
function throwRock() {
  const m = sim.measure();
  const c = m.active ? m.com : [0, 0, 0];
  if (!rock) {
    sim.collision.addSphere({ center: [c[0], 7, c[2]], radius: 0.6 });
    rock = { index: sim.collision.spheres.length - 1, vel: [0, -4, 0] };
  }
  rock.pos = [c[0] + (Math.random() - 0.5) * 2, 7.2, c[2] + (Math.random() - 0.5) * 2];
  rock.vel = [0, -6, 0];
  thrownRock.visible = true;
}
function updateRock(dt) {
  if (!rock) return;
  rock.vel[1] -= 9.81 * dt;
  for (let i = 0; i < 3; i++) rock.pos[i] += rock.vel[i] * dt;
  if (rock.pos[1] < 0.6) {
    rock.pos[1] = 0.6;
    rock.vel = [0, 0, 0];
  }
  sim.collision.spheres[rock.index].center = [...rock.pos];
  thrownRock.position.fromArray(rock.pos);
}

// --- input -----------------------------------------------------------------------------------------
const keys = new Set();
let paused = params.has('paused');
window.addEventListener('keydown', (e) => {
  keys.add(e.code);
  if (e.code === 'KeyR') build();
  if (e.code === 'KeyP') togglePause();
  if (e.code === 'KeyF') toggleSource();
  if (e.code === 'KeyT') throwRock();
  if (e.code === 'KeyV') toggleField();
});
window.addEventListener('keyup', (e) => keys.delete(e.code));
function steer() {
  let f = 0;
  let s = 0;
  if (keys.has('KeyW') || keys.has('ArrowUp')) f += 1;
  if (keys.has('KeyS') || keys.has('ArrowDown')) f -= 1;
  if (keys.has('KeyD') || keys.has('ArrowRight')) s += 1;
  if (keys.has('KeyA') || keys.has('ArrowLeft')) s -= 1;
  const fwd = new THREE.Vector3();
  camera.getWorldDirection(fwd);
  fwd.y = 0;
  fwd.normalize();
  const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
  controller.setInput(fwd.x * f + right.x * s, fwd.z * f + right.z * s);
}

// --- panel -----------------------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
$('min').onclick = () => $('panel').classList.toggle('min');
$('reset').onclick = build;
$('pause').onclick = togglePause;
$('source').onclick = toggleSource;
$('rock').onclick = throwRock;
$('fieldBtn').onclick = toggleField;
$('profile').onchange = (e) => {
  profileName = e.target.value;
  build();
};
$('preset').onchange = (e) => {
  water.setPreset(e.target.value);
  buildOptics();
};
$('view').onchange = (e) => (water.params.view = +e.target.value);
function togglePause() {
  paused = !paused;
  $('pause').classList.toggle('on', paused);
}
function toggleSource() {
  sourceOn = !sourceOn;
  source.on = sourceOn;
  $('source').classList.toggle('on', sourceOn);
}
function toggleField() {
  const f = fieldView.cycle();
  $('fieldBtn').classList.toggle('on', !!f);
  $('field').style.display = f ? 'block' : 'none';
  if (f) $('field').textContent = `Campo: ${FIELDS[f].label} · ${FIELDS[f].range[0]}–${FIELDS[f].range[1]} ${FIELDS[f].unit}`;
}

function slider(parent, label, get, set, min, max, step, fmt = (v) => (+v).toFixed(2)) {
  const l = document.createElement('label');
  l.innerHTML = `<span>${label}</span><input type="range" min="${min}" max="${max}" step="${step}"><output></output>`;
  const input = l.querySelector('input');
  const out = l.querySelector('output');
  input.value = get();
  out.textContent = fmt(get());
  input.oninput = () => {
    set(+input.value);
    out.textContent = fmt(+input.value);
  };
  parent.appendChild(l);
}
function buildPhysics() {
  const el = $('physCtl');
  el.innerHTML = '';
  // changed live: uniforms only, the state is kept (documented in docs/RIO_VIVO.md §parámetros)
  slider(el, 'Gravedad (m/s²)', () => -sim.cfg.gravity[1], (v) => (sim.cfg.gravity = [0, -v, 0]), 0, 20, 0.01);
  slider(el, 'Viscosidad XSPH', () => sim.cfg.xsph, (v) => (sim.cfg.xsph = v), 0, 0.3, 0.005, (v) => v.toFixed(3));
  slider(el, 'Roce del lecho (1/s)', () => sim.cfg.wallDrag, (v) => (sim.cfg.wallDrag = v), 0, 10, 0.1);
  slider(el, 'Iteraciones', () => sim.cfg.iterations, (v) => (sim.cfg.iterations = v), 1, 10, 1, (v) => v.toFixed(0));
  slider(el, 'Subpasos', () => sim.cfg.substeps, (v) => (sim.cfg.substeps = v), 1, 8, 1, (v) => v.toFixed(0));
  slider(el, 'Caudal fuente (m/s)', () => source.speed, (v) => (source.speed = v), 0.5, 8, 0.1);
  slider(el, 'Fuerza jugador (m/s²)', () => controller.maxAccel, (v) => (controller.maxAccel = v), 0, 15, 0.5);
}
function buildOptics() {
  const el = $('optCtl');
  el.innerHTML = '';
  const p = water.params;
  slider(el, 'Absorción rojo (1/m)', () => p.absorb[0], (v) => (p.absorb[0] = v), 0, 5, 0.01);
  slider(el, 'Absorción verde (1/m)', () => p.absorb[1], (v) => (p.absorb[1] = v), 0, 5, 0.01);
  slider(el, 'Absorción azul (1/m)', () => p.absorb[2], (v) => (p.absorb[2] = v), 0, 5, 0.01);
  slider(el, 'Turbidez (1/m)', () => p.turbidity, (v) => (p.turbidity = v), 0, 5, 0.01);
  slider(el, 'Color dispersión R', () => p.scatterTint[0], (v) => (p.scatterTint[0] = v), 0, 1, 0.01);
  slider(el, 'Color dispersión G', () => p.scatterTint[1], (v) => (p.scatterTint[1] = v), 0, 1, 0.01);
  slider(el, 'Color dispersión B', () => p.scatterTint[2], (v) => (p.scatterTint[2] = v), 0, 1, 0.01);
  slider(el, 'Reflejos', () => p.reflect, (v) => (p.reflect = v), 0, 2, 0.01);
  slider(el, 'Refracción', () => p.refract, (v) => (p.refract = v), 0, 3, 0.01);
  slider(el, 'Visibilidad del fondo', () => p.bottom, (v) => (p.bottom = v), 0, 1, 0.01);
  slider(el, 'Intensidad de luz', () => p.intensity, (v) => (p.intensity = v), 0, 3, 0.01);
  slider(el, 'Exposición', () => p.exposure, (v) => (p.exposure = v), 0.3, 2.5, 0.01);
  slider(el, 'Suavizado superficie', () => surface.params.smoothing, (v) => (surface.params.smoothing = v), 0.5, 5, 0.1);
}

const fmt = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '—');
const rows = (el, list) => {
  el.innerHTML = list.map(([k, v, cls = '']) => `<tr><td>${k}</td><td class="${cls}">${v}</td></tr>`).join('');
};
let stats = null;
let frames = 0;
let fpsT = performance.now();
let fps = 0;
let cpuMs = 0;
function updatePanel() {
  const m = sim.measure();
  stats = m;
  const work = controller.account(m);
  const t = sim.gpu.pollTimers();
  const P = PROFILES[profileName];
  const gpuSim = ['predict', 'neighbours', 'constraints', 'velocity'].reduce((a, k) => a + (t[k] || 0), 0);
  rows($('perf'), [
    ['FPS / CPU por frame', `${fmt(fps, 0)} / ${fmt(cpuMs, 1)} ms`],
    ['GPU solver (último subpaso)', sim.gpu.timerExt ? `${fmt(gpuSim, 2)} ms` : 'sin medidor GPU'],
    ['  predicción · vecinos', `${fmt(t.predict, 2)} · ${fmt(t.neighbours, 2)} ms`],
    ['  restricciones · velocidad', `${fmt(t.constraints, 2)} · ${fmt(t.velocity, 2)} ms`],
    ['Partículas activas / capacidad', `${m.active} / ${P.capacity}`],
    ['Resolución (d, h)', `${fmt(sim.cfg.spacing * 100, 1)} · ${fmt(sim.cfg.h * 100, 1)} cm`],
    ['Subpasos · iteraciones · dt', `${sim.cfg.substeps} · ${sim.cfg.iterations} · ${fmt((1000 / 60) / sim.cfg.substeps, 2)} ms`],
    ['Tiempo simulado', `${fmt(m.time, 1)} s`],
  ]);
  const errCls = m.relError < 1e-6 && m.lost === 0 ? 'ok' : 'bad';
  rows($('mass'), [
    ['Volumen en el dominio', `${fmt(m.volumeDomain, 2)} m³`],
    ['Masa en el dominio', `${fmt(m.massDomain / 1000, 2)} t`],
    ['Entrada acumulada (fuente)', `${fmt(m.massIn / 1000, 2)} t`],
    ['Salida acumulada (desagüe)', `${fmt(m.massOut / 1000, 2)} t`],
    ['Perdida (fallo numérico)', `${m.lost}`, m.lost ? 'bad' : 'ok'],
    ['Error relativo de masa', `${m.relError.toExponential(1)}`, errCls],
    ['Fuente sin hueco (capacidad)', `${source.starved ?? 0}`, source.starved ? 'bad' : ''],
  ]);
  rows($('phys'), [
    ['Velocidad media / máx', `${fmt(m.speedMean)} / ${fmt(m.speedMax)} m/s`],
    ['Error de densidad medio / máx', `${fmt(m.densityErrorMean * 100, 2)} / ${fmt(m.densityErrorMax * 100, 1)} %`],
    ['Divergencia media |∇·v|', `${fmt(m.divergenceMean)} 1/s`],
    ['Vorticidad media / máx', `${fmt(m.vorticityMean)} / ${fmt(m.vorticityMax, 1)} 1/s`],
    ['Energía cinética', `${fmt(m.kinetic / 1000, 2)} kJ`],
    ['Energía potencial', `${fmt(m.potential / 1000, 1)} kJ`],
    ['Trabajo del jugador (muestreado)', `${fmt(work.work / 1000, 2)} kJ`],
    ['Espuma (fracción)', `${fmt(m.foamFraction * 100, 1)} %`],
    ['Dentro de sólidos / fuera', `${m.insideSolids} / ${m.outsideDomain}`, m.insideSolids + m.outsideDomain ? 'bad' : 'ok'],
    ['Velocidades recortadas', `${m.speedClamps}`, m.speedClamps ? 'bad' : ''],
  ]);
}

// --- frame -----------------------------------------------------------------------------------------
let lastPanel = 0;
const clock = new THREE.Clock();
function frame() {
  const t0 = performance.now();
  const dt = Math.min(clock.getDelta(), 0.1);
  controls.update();
  steer();
  if (!paused) {
    // the solver advances 1/60 s of simulated time per frame: if the GPU cannot keep up, the
    // simulation slows down instead of taking unstable steps (the panel shows simulated time)
    controller.update(1 / 60);
    updateRock(1 / 60);
    sim.gpu.timing = true;
    sim.step(1 / 60);
    renderer.resetState();
  }

  const showField = !!fieldView.field;
  if (showField) {
    fieldView.sync(sim, size.h / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)));
    if (!fieldView.points.parent) scene.add(fieldView.points);
  } else if (fieldView.points.parent) scene.remove(fieldView.points);

  renderer.setRenderTarget(sceneRT);
  renderer.render(scene, camera);
  let surf;
  if (showField) surf = { depth: emptyDepth, thickness: emptyDepth, pointScale: 1 };
  else {
    const aniso = sim.anisotropy(surface.splatRadius);
    renderer.resetState();
    surf = surface.render(camera, sim.position, sceneRT.depthTexture, aniso);
  }
  renderer.setRenderTarget(null);
  water.render(camera, sceneRT.texture, sceneRT.depthTexture, surf, size.w, size.h);
  if (!showField) foam.render(renderer, camera, sim, surf, sceneRT.depthTexture, size.w, size.h);

  cpuMs = performance.now() - t0;
  frames++;
  const now = performance.now();
  if (now - fpsT > 500) {
    fps = (frames * 1000) / (now - fpsT);
    frames = 0;
    fpsT = now;
  }
  if (now - lastPanel > 350) {
    lastPanel = now;
    updatePanel();
  }
  if (!window.__manual) requestAnimationFrame(frame);
}

try {
  build();
  if (params.has('source')) toggleSource();
  window.__lab = { get sim() { return sim; }, frame, water, get surface() { return surface; }, get controller() { return controller; }, throwRock, toggleField, camera, controls, build, get stats() { return stats; }, toggleSource };
  window.__manual = params.has('manual');
  window.__READY = true;
  if (!window.__manual) requestAnimationFrame(frame);
} catch (e) {
  $('err').style.display = 'grid';
  $('err').textContent = `${e.message}\n\n${e.stack ?? ''}`;
  console.error(e);
}
