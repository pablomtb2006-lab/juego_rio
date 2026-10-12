// Small helpers shared by every audio module. No DOM, no THREE — works with any
// BaseAudioContext (real-time or OfflineAudioContext, which the offline tests use).

export const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const dbToGain = (db) => Math.pow(10, db / 20);
export const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
export const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/** Deterministic PRNG (mulberry32) — used for buffer synthesis so sounds are reproducible. */
export function rng(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random helpers bound to Math.random (gameplay variation, not reproducible on purpose). */
export const rand = (a = 0, b = 1) => a + Math.random() * (b - a);
export const pick = (arr) => arr[(Math.random() * arr.length) | 0];

/**
 * Drives an AudioParam towards targets with setTargetAtTime, skipping redundant
 * automation events (calling it every frame would otherwise pile up thousands).
 * Never assigns `.value` once automation started, so there is no zipper noise.
 */
export class Smooth {
  constructor(param, initial, eps = 1e-4) {
    this.param = param;
    this.last = initial;
    this.eps = eps;
    param.value = initial;
  }

  to(value, time, tc = 0.08) {
    if (!Number.isFinite(value)) return;
    if (Math.abs(value - this.last) <= this.eps * Math.max(1, Math.abs(this.last))) return;
    this.last = value;
    this.param.setTargetAtTime(value, time, tc);
  }

  /** Jump (fast but click-free) — 5 ms time constant. */
  snap(value, time) {
    this.last = value;
    this.param.cancelScheduledValues(time);
    this.param.setTargetAtTime(value, time, 0.005);
  }
}

/**
 * Classic attack/decay/sustain/release on a GainNode param.
 * a, d, r in seconds; `hold` = time the key is held (release starts at t + hold).
 * Uses exponential-ish segments (setTargetAtTime) that never produce clicks.
 */
export function adsr(param, t, { a = 0.005, d = 0.1, s = 0.6, r = 0.2, hold = 0.2, peak = 1 } = {}) {
  param.cancelScheduledValues(t);
  param.setValueAtTime(0, t);
  param.linearRampToValueAtTime(peak, t + a);
  param.setTargetAtTime(peak * s, t + a, Math.max(d, 0.001) / 3);
  const rel = t + Math.max(hold, a);
  param.setTargetAtTime(0, rel, Math.max(r, 0.001) / 4);
  return rel + r * 1.2;
}

/** Percussive envelope: linear attack to `peak`, exponential decay (time constant tau). */
export function perc(param, t, peak, a, tau) {
  param.cancelScheduledValues(t);
  param.setValueAtTime(0, t);
  param.linearRampToValueAtTime(peak, t + a);
  param.setTargetAtTime(0, t + a, tau);
  return t + a + tau * 7;
}

/** Disconnect the given nodes once `source` ends (lets the GC reclaim one-shot graphs). */
export function cleanup(source, ...nodes) {
  source.onended = () => {
    for (const n of nodes) {
      try {
        n.disconnect();
      } catch {
        /* already disconnected */
      }
    }
  };
}

/** Rotate vector v by unit quaternion q ({x,y,z,w}); writes into out. */
export function rotateByQuat(v, q, out) {
  const { x, y, z } = v;
  const qx = q.x, qy = q.y, qz = q.z, qw = q.w;
  const ix = qw * x + qy * z - qz * y;
  const iy = qw * y + qz * x - qx * z;
  const iz = qw * z + qx * y - qy * x;
  const iw = -qx * x - qy * y - qz * z;
  out.x = ix * qw + iw * -qx + iy * -qz - iz * -qy;
  out.y = iy * qw + iw * -qy + iz * -qx - ix * -qz;
  out.z = iz * qw + iw * -qz + ix * -qy - iy * -qx;
  return out;
}
