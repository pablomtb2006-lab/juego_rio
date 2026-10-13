import * as THREE from 'three';
import { archGate } from './arch.js';

const UP = new THREE.Vector3(0, 1, 0);
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _d = new THREE.Vector3();
const _e = new THREE.Vector3();
const _f2 = new THREE.Vector2();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _qr = new THREE.Quaternion();

/** Critically damped spring (implicit, stable for any dt). Mutates x/v Vector3s in place. */
function springV(x, v, target, omega, dt) {
  const f = 1 + 2 * dt * omega;
  const oo = omega * omega;
  const hoo = dt * oo;
  const hhoo = dt * hoo;
  const inv = 1 / (f + hhoo);
  for (const k of ['x', 'y', 'z']) {
    const xx = (f * x[k] + dt * v[k] + hhoo * target[k]) * inv;
    v[k] = (v[k] + hoo * (target[k] - x[k])) * inv;
    x[k] = xx;
  }
}

function springS(s, key, target, omega, dt) {
  const f = 1 + 2 * dt * omega;
  const oo = omega * omega;
  const hoo = dt * oo;
  const hhoo = dt * hoo;
  const inv = 1 / (f + hhoo);
  const x = s[key];
  const v = s[key + 'V'];
  s[key] = (f * x + dt * v + hhoo * target) * inv;
  s[key + 'V'] = (v + hoo * (target - x)) * inv;
}

const smoother = (t) => {
  t = Math.min(1, Math.max(0, t));
  return t * t * t * (t * (t * 6 - 15) + 10);
};

/** Cheap deterministic 1D noise (sum of incommensurate sines), −1..1. */
function wobble(t, seed) {
  return (Math.sin(t * 1.73 + seed) * 0.5 + Math.sin(t * 3.11 + seed * 2.3) * 0.3 + Math.sin(t * 7.37 + seed * 4.1) * 0.2);
}

export const INTRO = { hold: 1.5, crane: 2.6 };

/**
 * All camera work. Modes:
 *   'menu'       slow cinematic orbit of the island
 *   'intro'      match start: low at the summit arch looking up at the falling drop, then a crane
 *                up into the skydive camera
 *   'drop'       skydive camera above/behind the drop (dive = steeper & wider, flare = flatter)
 *   'arch'       cut to a low shot through the summit arch as the drop falls through it (ref_006)
 *   'impact'     landing punch-in: above/behind the splash, trauma + flash, then into chase
 *   'chase'      low, fast camera hugging the water, looking ahead along the river's path
 *   'eliminated' hold on the elimination, then spectate whoever cut you (aerial chase)
 *   'spectate'   aerial chase of any stream (after elimination / finishing)
 *   'victory'    crane up to a top-down view over the coast (ref_033) with a slow turn
 *
 * Contract: director.mode, director.setMode(mode, opts), director.focus (Vector3, used for
 * shadow placement), director.shake(amount), update(dt). Event hooks used by Game:
 * startMatch, onLanded, onCut, onVictory, onEliminated, addTrauma.
 *
 * Every pose is passed through a terrain-aware boom: lift first, then shorten, and finally
 * a hard clearance clamp, so the camera never ends up inside a slope.
 */
export class CameraDirector {
  constructor(game) {
    this.game = game;
    this.ctx = game.ctx;
    this.mode = 'menu';
    this.target = null;
    this.focus = new THREE.Vector3();
    this.lookAt = new THREE.Vector3();
    this.t = 0;
    this.time = 0;
    this.trauma = 0;
    this.snap = true;
    this.pos = new THREE.Vector3();
    this.posV = new THREE.Vector3();
    this.look = new THREE.Vector3();
    this.lookV = new THREE.Vector3();
    this.up = new THREE.Vector3(0, 1, 0);
    this.upV = new THREE.Vector3();
    this.fwd = new THREE.Vector3(0, 0, 1);
    this.fwdV = new THREE.Vector3();
    this.s = { fov: 60, fovV: 0, roll: 0, rollV: 0, boom: 1, boomV: 0, lift: 0, liftV: 0, swallowK: 0, swallowKV: 0 };
    this.swallow = null;
    this.desired = new THREE.Vector3();
    this.desiredLook = new THREE.Vector3();
    this.desiredUp = new THREE.Vector3(0, 1, 0);
    this.archShown = false;
    this.path = [];
    this.spectateTarget = null;
    this.victoryDir = new THREE.Vector2(1, 0);
    this.anchor = new THREE.Vector3();
  }

  // --- hooks ------------------------------------------------------------------------

  setMode(mode, opts = {}) {
    this.mode = mode;
    if (opts.target !== undefined) this.target = opts.target;
    this.t = 0;
    this.snap = opts.snap ?? false;
  }

  startMatch(player, { intro = true } = {}) {
    this.archShown = false;
    this.trauma = 0;
    this.spectateTarget = null;
    this.setMode(intro && this.game.archMatch && this.ctx.world?.landmarks?.arch ? 'intro' : 'drop', { target: player, snap: true });
  }

  shake(amount) {
    this.addTrauma(Math.min(1, amount / 8));
  }

  addTrauma(a) {
    this.trauma = Math.min(1, this.trauma + a);
  }

  flash(v) {
    this.ctx.postfx?.flash?.(v);
  }

  onLanded(stream, impact = 80) {
    this.anchor.copy(stream.pos);
    this.setMode('impact', { target: stream });
    this.addTrauma(0.55 + Math.min(impact / 300, 0.35));
    this.s.fovV += 28;
    this.flash(0.55);
  }

  onCut(dealt) {
    this.addTrauma(dealt ? 0.35 : 0.55);
    this.flash(dealt ? 0.25 : 0.4);
  }

  onVictory(stream) {
    this.anchor.copy(stream.pos);
    this.victoryDir.copy(stream.heading);
    this.setMode('victory', { target: stream });
    this.addTrauma(0.4);
    this.flash(1);
  }

  onEliminated(victim, by) {
    this.anchor.copy(victim.pos);
    this.spectateTarget = by && by.alive ? by : null;
    this.setMode('eliminated', { target: victim });
    this.addTrauma(0.7);
    this.flash(0.5);
  }

  // --- helpers ----------------------------------------------------------------------

  /** Base vertical FOV adapted to the aspect ratio (portrait needs more vertical FOV). */
  fovFor(base) {
    // portrait screens are narrow: open the vertical FOV, but less so for already-wide lenses
    const a = this.ctx.camera.aspect || 1;
    const k = a < 1 ? THREE.MathUtils.lerp(0.32, 0, THREE.MathUtils.clamp((a - 0.45) / 0.55, 0, 1)) : 0;
    return Math.min(base + k * Math.min(base, 62), 104);
  }

  ground(x, z) {
    const t = this.ctx.terrain;
    return Math.max(t.heightAt(x, z), t.seaLevel);
  }

  /** Highest ground in a small ring around (x, z) — keeps the near plane out of slopes. */
  groundRing(x, z, r = 4) {
    let h = this.ground(x, z);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      h = Math.max(h, this.ground(x + Math.cos(a) * r, z + Math.sin(a) * r));
    }
    return h;
  }

  /**
   * Terrain-aware boom from `pivot` to `want` (in place): raise the camera to clear the
   * line of sight (up to `maxLift`), otherwise shorten the boom. Boom changes are sprung
   * (fast in, slow out) so collisions never pop.
   */
  solveBoom(pivot, want, dt, { maxLift = 30, margin = 2.5 } = {}) {
    const steps = 14;
    let lift = 0;
    for (let i = 1; i <= steps; i++) {
      const f = i / steps;
      const x = pivot.x + (want.x - pivot.x) * f;
      const z = pivot.z + (want.z - pivot.z) * f;
      const y = pivot.y + (want.y - pivot.y) * f;
      const need = this.ground(x, z) + margin * (0.4 + f) - y;
      if (need > 0) lift = Math.max(lift, need / Math.max(f, 0.25));
    }
    springS(this.s, 'lift', Math.min(lift, maxLift), lift > this.s.lift ? 16 : 2.5, dt);
    want.y += Math.max(0, this.s.lift);
    // still blocked? shorten the boom
    let frac = 1;
    for (let i = 1; i <= steps; i++) {
      const f = i / steps;
      const x = pivot.x + (want.x - pivot.x) * f;
      const z = pivot.z + (want.z - pivot.z) * f;
      const y = pivot.y + (want.y - pivot.y) * f;
      if (this.ground(x, z) + margin * 0.5 > y) {
        frac = Math.max(0.15, (i - 1) / steps);
        break;
      }
    }
    springS(this.s, 'boom', frac, frac < this.s.boom ? 18 : 2.2, dt);
    const b = THREE.MathUtils.clamp(this.s.boom, 0.12, 1);
    want.set(pivot.x + (want.x - pivot.x) * b, pivot.y + (want.y - pivot.y) * b, pivot.z + (want.z - pivot.z) * b);
    return want;
  }

  /** Predicted path of a flowing stream (current heading easing into the valley line). */
  predictPath(s, length, step = 8) {
    const hydro = this.game.hydro;
    const out = this.path;
    out.length = 0;
    let x = s.pos.x;
    let z = s.pos.z;
    let hx = s.heading.x;
    let hz = s.heading.y;
    const steer = s.input?.steer ?? 0;
    const n = Math.max(2, Math.ceil(length / step));
    for (let i = 0; i < n; i++) {
      hydro.flowDirAt(x, z, _f2);
      if (_f2.lengthSq() > 0.5) {
        // bend like the physics would (steering offset)
        const ang = steer * 1.15 * 0.8;
        const c = Math.cos(ang);
        const sn = Math.sin(ang);
        const fx = _f2.x * c - _f2.y * sn;
        const fz = _f2.y * c + _f2.x * sn;
        const k = Math.min(1, 0.25 + i * 0.12);
        hx += (fx - hx) * k;
        hz += (fz - hz) * k;
        const l = Math.hypot(hx, hz) || 1;
        hx /= l;
        hz /= l;
      }
      x += hx * step;
      z += hz * step;
      out.push(_e.set(x, hydro.waterY(x, z, s.radius), z).clone());
    }
    return out;
  }

  // --- per-mode desired poses ---------------------------------------------------------

  poseMenu() {
    const { terrain } = this.ctx;
    const zone = this.game.dropZone ?? { x: 0, z: 0, radius: 1500 };
    const a = this.time * 0.03 + 0.6;
    // portrait needs to stand further back to fit the island's width
    const aspect = this.ctx.camera.aspect || 1;
    const far = aspect < 1 ? THREE.MathUtils.lerp(1.45, 1, THREE.MathUtils.clamp((aspect - 0.45) / 0.55, 0, 1)) : 1;
    const r = terrain.size * 0.42 * far;
    this.desired.set(zone.x + Math.cos(a) * r, terrain.size * 0.2 * far, zone.z + Math.sin(a) * r);
    this.desiredLook.set(zone.x * 0.5, 0, zone.z * 0.5);
    this.desiredUp.copy(UP);
    return { fov: this.fovFor(46), omega: 1.2, roll: 0 };
  }

  poseDrop(s) {
    const r = s.radius;
    const dive = s.dive ?? 0;
    const alt = s.pos.y - this.ground(s.pos.x, s.pos.z);
    const near = THREE.MathUtils.clamp(1 - (alt - 120) / 500, 0, 1); // close to the ground
    const back = (52 + r * 2.6) * (1 - 0.3 * Math.max(dive, 0)) * (1 + 0.25 * Math.max(-dive, 0)) * (1 - 0.35 * near);
    const up = (26 + r * 1.2 + 34 * Math.max(dive, 0)) * (1 - 0.4 * near);
    const hx = s.heading.x;
    const hz = s.heading.y;
    this.desired.set(s.pos.x - hx * back, s.pos.y + up, s.pos.z - hz * back);
    const ahead = 50 + 40 * Math.max(-dive, 0);
    const down = (70 + 90 * Math.max(dive, 0)) * (1 - 0.6 * near);
    this.desiredLook.set(s.pos.x + hx * ahead, s.pos.y - down, s.pos.z + hz * ahead);
    this.desiredUp.copy(UP);
    return { fov: this.fovFor(64 + 12 * Math.max(dive, 0) - 6 * Math.max(-dive, 0)), omega: 4.2, roll: -s.bank * 0.22 };
  }

  poseIntro(s) {
    const { center: A, normal: n, radius: R } = archGate(this.ctx.world.landmarks.arch);
    const side = _a.set(-n.z, 0, n.x);
    // shot A: low beside the arch's front pillar, looking up past the rock at the falling drop
    const camA = _b.set(A.x - n.x * R * 1.7 + side.x * R * 0.7, 0, A.z - n.z * R * 1.7 + side.z * R * 0.7);
    camA.y = Math.max(A.y - R * 0.45, this.groundRing(camA.x, camA.z, 6) + 3);
    const lookA = _c.copy(s.pos).lerp(A, 0.3);
    const pd = this.poseDrop(s);
    const u = smoother((this.t - INTRO.hold) / INTRO.crane);
    // ease the crane: hold, then a rising whoosh into the skydive cam
    this.desired.lerpVectors(camA, this.desired, u);
    this.desiredLook.lerpVectors(lookA, this.desiredLook, smoother((this.t - INTRO.hold * 0.8) / (INTRO.crane * 0.8)));
    if (this.t >= INTRO.hold + INTRO.crane) this.setMode('drop', { target: s });
    return {
      fov: THREE.MathUtils.lerp(this.fovFor(70), pd.fov, u),
      omega: u > 0 ? 3 + 9 * u : 30,
      roll: pd.roll * u,
      noBoom: u < 0.05,
    };
  }

  /** ref_006: from just in front of the opening, look back through it at the incoming drop. */
  poseArch(s) {
    const { center: A, normal: n, radius: R } = archGate(this.ctx.world.landmarks.arch);
    const side = _a.set(-n.z, 0, n.x);
    const cam = _b.set(A.x - n.x * R * 1.35 + side.x * R * 0.08, 0, A.z - n.z * R * 1.35 + side.z * R * 0.08);
    cam.y = Math.max(A.y - R * 0.35, this.groundRing(cam.x, cam.z, 5) + 2.5);
    this.desired.copy(cam);
    // keep the opening in frame: aim between the gate and the drop
    this.desiredLook.copy(A).lerp(s.pos, 0.5);
    this.desiredUp.copy(UP);
    return { fov: this.fovFor(58), omega: 9, roll: 0, noBoom: true };
  }

  /** ref_008/010: steep look down onto the splash, punching in, then easing into the chase. */
  poseImpact(s) {
    const r = s.radius;
    const p = this.anchor;
    const hx = s.heading.x;
    const hz = s.heading.y;
    const k = smoother(this.t / 1.4);
    const back = 14 + r * 1.6 + k * 8;
    const up = 40 + r * 2.6 - k * 18;
    this.desired.set(p.x - hx * back, Math.max(p.y, s.pos.y) + up, p.z - hz * back);
    this.desiredLook.copy(p).lerp(s.pos, 0.35 + 0.65 * k);
    this.desiredLook.x += hx * (4 + 10 * k);
    this.desiredLook.z += hz * (4 + 10 * k);
    this.desiredUp.copy(UP);
    if (this.t > 1.3) this.setMode('chase', { target: s });
    return { fov: this.fovFor(60), omega: 5.5, roll: 0, pivot: p };
  }

  poseChase(s, aerial = false) {
    const r = s.radius;
    const sp = s.flowSpeed ?? s.speed;
    const speed01 = THREE.MathUtils.clamp((sp - 12) / 42, 0, 1);
    // Look FAR down the valley: the whole point of the chase shot is that you see the trap
    // (a dam, a lava field, a rival's channel) with enough road left to steer around it.
    const lookDist = THREE.MathUtils.clamp(sp * 1.25, 46, 130) + r;
    const path = this.predictPath(s, lookDist + 20, 8);
    // forward = towards a point ahead on the predicted path
    const idx = Math.min(path.length - 1, Math.max(1, Math.round((lookDist * 0.65) / 8)));
    const ahead = path[idx];
    _d.set(ahead.x - s.pos.x, 0, ahead.z - s.pos.z);
    if (_d.lengthSq() < 1e-4) _d.set(s.heading.x, 0, s.heading.y);
    _d.normalize();
    springV(this.fwd, this.fwdV, _d, aerial ? 2.2 : 3.6, this.ctx.dt || 1 / 60);
    const f = _a.copy(this.fwd).setY(0).normalize();
    // swallowing a lake: rise and pull back so the lake (and its vanishing) is in the shot
    const body = s.absorbBody && s.absorbBody.kind !== 'cloud' ? s.absorbBody : null;
    if (body) this.swallow = body;
    springS(this.s, 'swallowK', body ? 1 : 0, body ? 2.2 : 0.8, this.ctx.dt || 1 / 60);
    const sk = THREE.MathUtils.clamp(this.s.swallowK, 0, 1) * (this.swallow ? Math.min(1, this.swallow.radius / 80) : 0);
    const lakeR = this.swallow?.radius ?? 0;
    // …and ride high enough to see OVER the pines that line the valley (Scatter.js keeps the
    // channel itself clear, the camera clears the banks).
    const back = (aerial ? 46 + r * 2.4 : 20 + r * 1.5 - speed01 * 2) + sk * (20 + lakeR * 0.25);
    const height = (aerial ? 22 + r * 1.3 : 15 + r * 0.72 + speed01 * 3) + sk * (22 + lakeR * 0.3);
    const baseY = Math.max(s.pos.y, this.ground(s.pos.x - f.x * back, s.pos.z - f.z * back));
    this.desired.set(s.pos.x - f.x * back, baseY + height, s.pos.z - f.z * back);
    // aim short of the far point: the camera reads the whole valley, but your own head still
    // sits in the lower third of the frame where you can steer by it
    const lp = path[Math.min(path.length - 1, Math.round((lookDist * 0.58) / 8))] ?? ahead;
    this.desiredLook.set(lp.x, Math.min(lp.y, s.pos.y) + r * 0.25 + (aerial ? -8 : 6), lp.z);
    if (sk > 0.01 && this.swallow) {
      this.desiredLook.x += (this.swallow.x - this.desiredLook.x) * sk * 0.55;
      this.desiredLook.z += (this.swallow.z - this.desiredLook.z) * sk * 0.55;
      this.desiredLook.y += (this.swallow.y - this.desiredLook.y) * sk * 0.55;
    }
    // threat framing: lean the shot towards a bigger river that's about to cut you off
    const th = s.threat;
    if (!aerial && th && th.alive && s.danger > 0.05) {
      const k = Math.min(0.45, s.danger * 0.6 + 0.1);
      this.desiredLook.x += (th.pos.x - this.desiredLook.x) * k;
      this.desiredLook.z += (th.pos.z - this.desiredLook.z) * k;
    }
    this.desiredUp.copy(UP);
    let fov = this.fovFor(aerial ? 60 : 66) + speed01 * 16 + (s.surging ? 6 : 0);
    const roll = THREE.MathUtils.clamp(-(s.turnRate ?? 0) * 0.08, -0.12, 0.12);
    // rapids: steep water shakes the lens
    const slope = Math.max(0, -(s.vel.y || 0) / Math.max(sp, 1));
    this.trauma = Math.max(this.trauma, Math.min(0.3, slope * 0.8 + speed01 * 0.12 + (s.surging ? 0.12 : 0)));
    return { fov, omega: aerial ? 3.2 : 6.5, roll, pivot: _b.set(s.pos.x, s.pos.y + r * 0.5 + 1.5, s.pos.z) };
  }

  poseVictory(s) {
    const r = s.radius;
    const p = this.anchor;
    const k = smoother(this.t / 3.2);
    const ang = this.t * 0.045;
    const vx = this.victoryDir.x * Math.cos(ang) - this.victoryDir.y * Math.sin(ang);
    const vz = this.victoryDir.y * Math.cos(ang) + this.victoryDir.x * Math.sin(ang);
    const H = THREE.MathUtils.lerp(40 + r * 2, 300 + r * 4, k);
    const back = THREE.MathUtils.lerp(60 + r * 2, -H * 0.12, k);
    this.desired.set(p.x - vx * back, this.ctx.terrain.seaLevel + H, p.z - vz * back);
    this.desiredLook.set(p.x + vx * H * 0.22 * k, this.ctx.terrain.seaLevel, p.z + vz * H * 0.22 * k);
    // the sea at the top of the frame, the coast below (ref_033)
    this.desiredUp.set(vx, 0, vz).multiplyScalar(k).add(_c.set(0, 1 - k, 0)).normalize();
    return { fov: this.fovFor(THREE.MathUtils.lerp(70, 56, k)), omega: THREE.MathUtils.lerp(4, 2.2, k), roll: 0, pivot: p };
  }

  poseEliminated(s) {
    const killer = this.spectateTarget;
    const p = this.anchor;
    if (this.t > 2.4) {
      const next = killer && killer.alive ? killer : this.game.leader;
      if (next) {
        this.setMode('spectate', { target: next });
        return next.phase === 'drop' ? this.poseDrop(next) : this.poseChase(next, true);
      }
    }
    const focus = killer ? killer.pos : p;
    const hx = this.target.heading.x;
    const hz = this.target.heading.y;
    this.desired.set(p.x - hx * 50 + hz * 20, p.y + 34, p.z - hz * 50 - hx * 20);
    this.desiredLook.copy(p).lerp(focus, 0.5);
    this.desiredUp.copy(UP);
    return { fov: this.fovFor(58), omega: 2.5, roll: 0, pivot: p };
  }

  // --- main -------------------------------------------------------------------------------

  update(dt) {
    const cam = this.ctx.camera;
    this.time += dt;
    this.t += dt;
    let s = this.target;

    // automatic transitions
    if (this.mode === 'drop' && s && s.phase === 'drop' && !this.archShown && this.archTrigger(s)) {
      this.archShown = true;
      this.setMode('arch', { target: s, snap: true });
    }
    if (this.mode === 'arch' && s && s.phase === 'drop' && this.t > 6) this.setMode('drop', { target: s });
    if ((this.mode === 'drop' || this.mode === 'intro') && s && s.phase === 'flow' && s !== this.game.player) this.setMode('chase');
    if (this.mode === 'spectate' && (!s || (!s.alive && !(s.phase === 'finished' && this.game.time - s.finishedAt < 4)))) {
      const next = this.game.leader;
      if (next && next !== s) this.setMode('spectate', { target: next });
      s = this.target;
    }

    let o;
    if (this.mode === 'menu' || !s) o = this.poseMenu();
    else if (this.mode === 'intro') o = s.phase === 'drop' ? this.poseIntro(s) : this.poseChase(s);
    else if (this.mode === 'drop') o = s.phase === 'drop' ? this.poseDrop(s) : this.poseChase(s);
    else if (this.mode === 'arch') o = this.poseArch(s);
    else if (this.mode === 'impact') o = this.poseImpact(s);
    else if (this.mode === 'chase') o = s.phase === 'drop' ? this.poseDrop(s) : this.poseChase(s);
    else if (this.mode === 'victory') o = this.poseVictory(s);
    else if (this.mode === 'eliminated') o = this.poseEliminated(s);
    else if (this.mode === 'spectate') o = s.phase === 'drop' ? this.poseDrop(s) : this.poseChase(s, true);
    else o = this.poseMenu();

    // terrain-aware boom
    if (!o.noBoom && this.mode !== 'menu') {
      const pivot = o.pivot ?? _e.copy(this.desiredLook);
      this.solveBoom(pivot, this.desired, dt);
    }

    if (this.snap) {
      this.pos.copy(this.desired);
      this.look.copy(this.desiredLook);
      this.up.copy(this.desiredUp);
      this.posV.set(0, 0, 0);
      this.lookV.set(0, 0, 0);
      this.upV.set(0, 0, 0);
      this.s.fov = o.fov;
      this.s.fovV = 0;
      this.s.roll = o.roll;
      this.s.rollV = 0;
      if (s) this.fwd.set(s.heading.x, 0, s.heading.y);
      this.snap = false;
    } else {
      springV(this.pos, this.posV, this.desired, o.omega, dt);
      springV(this.look, this.lookV, this.desiredLook, o.omega * 1.3, dt);
      springV(this.up, this.upV, this.desiredUp, 3, dt);
      springS(this.s, 'fov', o.fov, 3.2, dt);
      springS(this.s, 'roll', o.roll, 4, dt);
    }

    // hard guarantee: never inside the terrain or under the sea
    cam.position.copy(this.pos);
    const floor = this.groundRing(cam.position.x, cam.position.z, 3.5) + 1.6;
    if (cam.position.y < floor) {
      cam.position.y = floor;
      this.pos.y = Math.max(this.pos.y, floor);
      this.posV.y = Math.max(this.posV.y, 0);
    }

    // shake (trauma²), deterministic
    this.trauma = Math.max(0, this.trauma - dt * 0.9);
    const sh = this.trauma * this.trauma;
    const tt = this.time * 9;
    if (sh > 1e-4) {
      const amp = sh * (this.mode === 'chase' ? 0.7 : 1.6);
      cam.position.x += wobble(tt, 1.1) * amp;
      cam.position.y += wobble(tt, 7.3) * amp * 0.7;
      cam.position.z += wobble(tt, 3.7) * amp;
      cam.position.y = Math.max(cam.position.y, floor);
    }

    // orientation: look-at with a sprung up vector, then roll
    this.lookAt.copy(this.look);
    const upv = _c.copy(this.up).normalize();
    _d.subVectors(this.lookAt, cam.position).normalize();
    if (Math.abs(_d.dot(upv)) > 0.995) upv.set(this.victoryDir.x, 0, this.victoryDir.y);
    _m.lookAt(cam.position, this.lookAt, upv);
    _q.setFromRotationMatrix(_m);
    const roll = this.s.roll + (sh > 1e-4 ? wobble(tt, 5.1) * sh * 0.035 : 0);
    _qr.setFromAxisAngle(_a.set(0, 0, 1), roll);
    cam.quaternion.copy(_q).multiply(_qr);

    const fov = THREE.MathUtils.clamp(this.s.fov, 20, 110);
    if (Math.abs(cam.fov - fov) > 0.01) {
      cam.fov = fov;
      cam.updateProjectionMatrix();
    }

    this.focus.copy(s && this.mode !== 'menu' ? (this.mode === 'victory' ? this.anchor : s.pos) : this.lookAt);
    this.updatePost(s);
  }

  updatePost(s) {
    const post = this.ctx.postfx;
    if (!post?.setSpeed) return;
    let v = 0;
    if (s && (this.mode === 'chase' || this.mode === 'spectate') && s.phase === 'flow') {
      v = THREE.MathUtils.clamp((s.flowSpeed - 14) / 40, 0, 1) * (this.mode === 'spectate' ? 0.5 : 1) + (s.surging ? 0.2 : 0);
    } else if (s && (this.mode === 'drop' || this.mode === 'intro') && s.phase === 'drop') {
      v = THREE.MathUtils.clamp(0.25 + (s.dive ?? 0) * 0.45, 0, 1) * (this.mode === 'intro' ? smoother((this.t - INTRO.hold) / INTRO.crane) : 1);
    } else if (this.mode === 'impact') v = 0.35 * (1 - smoother(this.t / 1.2));
    post.setSpeed(Math.min(1, v));
  }

  /** Will the drop pass through the summit arch within the next few seconds? */
  archTrigger(s) {
    const arch = this.game.archMatch ? this.ctx.world?.landmarks?.arch : null;
    if (!arch) return false;
    const { center: A, radius: R } = archGate(arch);
    const above = s.pos.y - A.y;
    if (above < 15 || above > 380 || s.vel.y >= -1) return false;
    const t = above / -s.vel.y;
    const px = s.pos.x + s.vel.x * t;
    const pz = s.pos.z + s.vel.z * t;
    return Math.hypot(px - A.x, pz - A.z) < R * 2.2;
  }
}
