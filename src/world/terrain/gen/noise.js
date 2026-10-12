// Scalar helpers + fractal noise used by the generator (pure JS).

export const sstep = (a, b, v) => {
  let t = (v - a) / (b - a);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * (3 - 2 * t);
};
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

export function fbm(noise, x, y, oct, lac = 2, gain = 0.5) {
  let a = 1;
  let f = 1;
  let s = 0;
  let nrm = 0;
  for (let o = 0; o < oct; o++) {
    s += a * noise(x * f, y * f);
    nrm += a;
    a *= gain;
    f *= lac;
  }
  return s / nrm;
}

/** Ridged multifractal (0..1, sharp crests). */
export function ridged(noise, x, y, oct, lac = 2.03, gain = 0.5) {
  let a = 1;
  let f = 1;
  let s = 0;
  let nrm = 0;
  let w = 1;
  for (let o = 0; o < oct; o++) {
    let v = 1 - Math.abs(noise(x * f, y * f));
    v *= v;
    v *= w;
    w = clamp01(v * 1.6);
    s += a * v;
    nrm += a;
    a *= gain;
    f *= lac;
  }
  return s / nrm;
}
