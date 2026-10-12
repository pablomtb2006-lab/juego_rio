// Stylised hill-shaded island map (minimap / full map), drawn once from the terrain grids.
// Sea in blues by depth, land coloured by biome (meadow, forest, alpine, rock, snow, sand,
// orange coastal rock) with a north-west hillshade, lakes in turquoise and the main
// drainage lines as faint blue threads (the possible routes to the sea).

const hex = (h) => [(h >> 16) & 255, (h >> 8) & 255, h & 255];
const C = {
  deep: hex(0x0a3d6b),
  sea: hex(0x0a5c8f),
  shelf: hex(0x1f9fc4),
  shallow: hex(0x3fd9e0),
  foam: hex(0xe9fbff),
  sand: hex(0xe8d3a0),
  meadow: hex(0x6cbf3f),
  meadowWarm: hex(0x93c843),
  forest: hex(0x2f6a35),
  alpine: hex(0xb9b45a),
  rock: hex(0x9a8c7e),
  coastRock: hex(0xd07a4a),
  snow: hex(0xf4f8ff),
  lake: hex(0x35d0d6),
  river: hex(0x7fd8f0),
};

const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const ss = (a, b, v) => {
  let t = (v - a) / (b - a);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * (3 - 2 * t);
};

export function createMapCanvas(t, size = 512) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d');
  const img = g.createImageData(size, size);
  const { res, heights, cell } = t;
  const px = t.size / size; // metres per pixel
  // light from the north-west, 40° up
  const L = [-0.55, 0.64, -0.53];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const wx = ((x + 0.5) / size - 0.5) * t.size;
      const wz = ((y + 0.5) / size - 0.5) * t.size;
      const gx = (wx / t.size + 0.5) * (res - 1);
      const gz = (wz / t.size + 0.5) * (res - 1);
      const h = bil(heights, res, gx, gz);
      const e = Math.max(1, px / cell);
      const dx = (bil(heights, res, gx + e, gz) - bil(heights, res, gx - e, gz)) / (2 * e * cell);
      const dz = (bil(heights, res, gx, gz + e) - bil(heights, res, gx, gz - e)) / (2 * e * cell);
      const nl = Math.hypot(dx, 1, dz);
      const nx = -dx / nl;
      const ny = 1 / nl;
      const nz = -dz / nl;
      let shade = nx * L[0] + ny * L[1] + nz * L[2];
      const slope = Math.hypot(dx, dz);
      let c;
      if (h <= 0) {
        const d = -h;
        c = mix(C.shallow, C.shelf, ss(1, 18, d));
        c = mix(c, C.sea, ss(14, 70, d));
        c = mix(c, C.deep, ss(60, 170, d));
        // soft surf line hugging the shore
        c = mix(c, C.foam, ss(2.2, 0.2, d) * 0.55);
        shade = 0.82 + 0.18 * shade;
      } else {
        const forest = bil(t.forest, res, gx, gz);
        const coast = bil(t.coast, res, gx, gz);
        const water = bil(t.water, res, gx, gz);
        const flow = bil(t.flow, res, gx, gz);
        c = mix(C.meadow, C.meadowWarm, ss(0, 450, h) * 0.6);
        c = mix(c, C.forest, forest * 0.85);
        c = mix(c, C.alpine, ss(850, 1250, h) * (1 - forest));
        const rockT = ss(0.55, 0.85, slope + ss(900, 1500, h) * 0.25);
        c = mix(c, coast > 0.55 ? mix(C.rock, C.coastRock, ss(0.55, 0.85, coast)) : C.rock, rockT);
        c = mix(c, C.snow, ss(1380, 1480, h) * (1 - ss(0.9, 1.3, slope)));
        c = mix(c, C.sand, ss(5, 1.5, h) * (1 - rockT));
        c = mix(c, C.river, ss(0.72, 0.95, flow) * 0.6);
        if (water > 0.98) c = mix(C.lake, C.shallow, 0.2);
        else if (water > 0.3) c = mix(c, C.sand, 0.35);
        shade = 0.42 + 0.78 * Math.max(0, shade);
      }
      const o = (y * size + x) * 4;
      img.data[o] = Math.min(255, c[0] * shade);
      img.data[o + 1] = Math.min(255, c[1] * shade);
      img.data[o + 2] = Math.min(255, c[2] * shade);
      img.data[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return canvas;
}

function bil(arr, res, gx, gz) {
  const max = res - 1;
  gx = gx < 0 ? 0 : gx > max ? max : gx;
  gz = gz < 0 ? 0 : gz > max ? max : gz;
  let i = Math.floor(gx);
  let j = Math.floor(gz);
  if (i > max - 1) i = max - 1;
  if (j > max - 1) j = max - 1;
  const fx = gx - i;
  const fz = gz - j;
  const k = j * res + i;
  return (arr[k] * (1 - fx) + arr[k + 1] * fx) * (1 - fz) + (arr[k + res] * (1 - fx) + arr[k + res + 1] * fx) * fz;
}
