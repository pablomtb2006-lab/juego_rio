import * as THREE from 'three';
import { mulberry32 } from '../../core/random.js';

/**
 * Procedural foliage atlas (no external assets). 2×2 cells of 256 px:
 *   0 (u 0..0.5, v 0.5..1)   broadleaf cluster
 *   1 (u 0.5..1, v 0.5..1)   needle burst (pines / firs)
 *   2 (u 0..0.5, v 0..0.5)   small round leaves (birch)
 *   3 (u 0.5..1, v 0..0.5)   dense small-leaf cluster (bushes)
 * RGB is a grey detail multiplier (≈0.6..1.05), A is coverage (alpha-tested).
 * Transparent texels keep a neutral grey so mip filtering never darkens the edges.
 */
export const ATLAS_CELLS = {
  broad: [0, 0.5],
  needle: [0.5, 0.5],
  birch: [0, 0],
  bush: [0.5, 0],
};

let cached = null;

export function getFoliageAtlas() {
  if (cached) return cached;
  const S = 256;
  const W = S * 2;
  const color = document.createElement('canvas');
  color.width = color.height = W;
  const mask = document.createElement('canvas');
  mask.width = mask.height = W;
  const cg = color.getContext('2d');
  const mg = mask.getContext('2d');
  cg.fillStyle = 'rgb(180,180,180)';
  cg.fillRect(0, 0, W, W);
  mg.fillStyle = '#000';
  mg.fillRect(0, 0, W, W);
  const rand = mulberry32(1337);

  const grey = (v) => {
    const c = Math.max(0, Math.min(255, Math.round(v * 255)));
    return `rgb(${c},${c},${c})`;
  };

  // canvas y grows downwards; texture v grows upwards (flipY) — cells are symmetric enough.
  const cellOrigin = (cell) => {
    const [u, v] = ATLAS_CELLS[cell];
    return [u * W, (1 - v - 0.5) * W];
  };

  function leaf(ctx, x, y, ang, len, wid) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(ang);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.quadraticCurveTo(len * 0.45, -wid, len, 0);
    ctx.quadraticCurveTo(len * 0.45, wid, 0, 0);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  // --- 0: broadleaf cluster -------------------------------------------------
  {
    const [ox, oy] = cellOrigin('broad');
    const cx = ox + S / 2;
    const cy = oy + S / 2;
    const N = 78;
    const leaves = [];
    for (let i = 0; i < N; i++) {
      const a = rand() * Math.PI * 2;
      const r = Math.sqrt(rand()) * S * 0.27;
      leaves.push({ a, r, len: S * (0.1 + rand() * 0.07), ja: (rand() - 0.5) * 0.9, g: rand() });
    }
    leaves.sort((p, q) => p.r - q.r);
    for (const l of leaves) {
      const x = cx + Math.cos(l.a) * l.r;
      const y = cy + Math.sin(l.a) * l.r;
      const ang = l.a + l.ja;
      const wid = l.len * 0.42;
      mg.fillStyle = '#fff';
      leaf(mg, x, y, ang, l.len, wid);
      // inner leaves darker, outer brighter (fake self-shadowing)
      const shade = 0.55 + 0.35 * (l.r / (S * 0.27)) + l.g * 0.15;
      cg.fillStyle = grey(shade);
      leaf(cg, x, y, ang, l.len, wid);
      cg.strokeStyle = grey(shade * 0.78);
      cg.lineWidth = 1.2;
      cg.beginPath();
      cg.moveTo(x, y);
      cg.lineTo(x + Math.cos(ang) * l.len * 0.85, y + Math.sin(ang) * l.len * 0.85);
      cg.stroke();
    }
  }

  // --- 1: needle tuft (dense, fluffy, short needles) ------------------------
  {
    const [ox, oy] = cellOrigin('needle');
    const cx = ox + S / 2;
    const cy = oy + S / 2;
    mg.lineCap = cg.lineCap = 'round';
    const N = 260;
    const nd = [];
    for (let i = 0; i < N; i++) {
      const a = rand() * Math.PI * 2;
      const r0 = Math.sqrt(rand()) * S * 0.24;
      const len = S * (0.06 + rand() * 0.1);
      nd.push({ a, r0, len, g: rand() });
    }
    // inner needles first (darker), outer last (brighter tips)
    nd.sort((p, q) => p.r0 - q.r0);
    for (const n of nd) {
      const x0 = cx + Math.cos(n.a) * n.r0;
      const y0 = cy + Math.sin(n.a) * n.r0;
      const a = n.a + (rand() - 0.5) * 1.1;
      const x1 = x0 + Math.cos(a) * n.len;
      const y1 = y0 + Math.sin(a) * n.len;
      mg.strokeStyle = '#fff';
      mg.lineWidth = 3.2;
      mg.beginPath();
      mg.moveTo(x0, y0);
      mg.lineTo(x1, y1);
      mg.stroke();
      cg.strokeStyle = grey(0.55 + 0.45 * (n.r0 / (S * 0.24)) + n.g * 0.1);
      cg.lineWidth = 3.2;
      cg.beginPath();
      cg.moveTo(x0, y0);
      cg.lineTo(x1, y1);
      cg.stroke();
    }
  }

  // --- 2: small round leaves (birch) ----------------------------------------
  {
    const [ox, oy] = cellOrigin('birch');
    const cx = ox + S / 2;
    const cy = oy + S / 2;
    const N = 70;
    const ls = [];
    for (let i = 0; i < N; i++) {
      const a = rand() * Math.PI * 2;
      const r = Math.sqrt(rand()) * S * 0.33;
      ls.push({ a, r, s: S * (0.045 + rand() * 0.03), g: rand() });
    }
    ls.sort((p, q) => p.r - q.r);
    for (const l of ls) {
      const x = cx + Math.cos(l.a) * l.r;
      const y = cy + Math.sin(l.a) * l.r;
      const ang = rand() * Math.PI * 2;
      mg.fillStyle = '#fff';
      leaf(mg, x, y, ang, l.s * 2.2, l.s * 1.1);
      cg.fillStyle = grey(0.6 + 0.35 * (l.r / (S * 0.33)) + l.g * 0.12);
      leaf(cg, x, y, ang, l.s * 2.2, l.s * 1.1);
    }
  }

  // --- 3: dense bush cluster -------------------------------------------------
  {
    const [ox, oy] = cellOrigin('bush');
    const cx = ox + S / 2;
    const cy = oy + S / 2;
    const N = 80;
    const ls = [];
    for (let i = 0; i < N; i++) {
      const a = rand() * Math.PI * 2;
      const r = Math.sqrt(rand()) * S * 0.3;
      ls.push({ a, r, len: S * (0.08 + rand() * 0.06), g: rand() });
    }
    ls.sort((p, q) => p.r - q.r);
    for (const l of ls) {
      const x = cx + Math.cos(l.a) * l.r;
      const y = cy + Math.sin(l.a) * l.r;
      const ang = l.a + (rand() - 0.5) * 1.4;
      mg.fillStyle = '#fff';
      leaf(mg, x, y, ang, l.len, l.len * 0.5);
      cg.fillStyle = grey(0.58 + 0.38 * (l.r / (S * 0.3)) + l.g * 0.12);
      leaf(cg, x, y, ang, l.len, l.len * 0.5);
    }
  }

  const cd = cg.getImageData(0, 0, W, W).data;
  const md = mg.getImageData(0, 0, W, W).data;
  const out = new Uint8Array(W * W * 4);
  // flip vertically so canvas-top = v 1 (texture convention, DataTexture is not flipped)
  for (let y = 0; y < W; y++) {
    const sy = W - 1 - y;
    for (let x = 0; x < W; x++) {
      const si = (sy * W + x) * 4;
      const di = (y * W + x) * 4;
      out[di] = cd[si];
      out[di + 1] = cd[si + 1];
      out[di + 2] = cd[si + 2];
      out[di + 3] = md[si];
    }
  }
  const tex = new THREE.DataTexture(out, W, W, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  cached = tex;
  return tex;
}
