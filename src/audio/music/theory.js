// Tiny music-theory kit: scales, chord qualities, voice leading. Everything the
// sequencer plays is derived from a key + scale, so nothing is ever out of key.

export const SCALES = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  majPent: [0, 2, 4, 7, 9],
  minPent: [0, 3, 5, 7, 10],
};

export const QUALITIES = {
  maj: [0, 4, 7],
  min: [0, 3, 7],
  sus2: [0, 2, 7],
  sus4: [0, 5, 7],
  add9: [0, 4, 7, 14],
  madd9: [0, 3, 7, 14],
  maj7: [0, 4, 7, 11],
  min7: [0, 3, 7, 10],
  dom7: [0, 4, 7, 10],
  maj9: [0, 4, 7, 11, 14],
  min9: [0, 3, 7, 10, 14],
  '7sus4': [0, 5, 7, 10],
};

/** Chord symbol {r: semitones above key, q: quality} → absolute pitch classes 0..11 */
export function chordPcs(keyRoot, sym) {
  return QUALITIES[sym.q].map((iv) => (((keyRoot + sym.r + iv) % 12) + 12) % 12);
}

/** Root MIDI note of a chord symbol placed in a given octave range [lo, lo+12). */
export function chordRoot(keyRoot, sym, lo) {
  const pc = (((keyRoot + sym.r) % 12) + 12) % 12;
  let m = lo - (((lo % 12) + 12) % 12) + pc;
  if (m < lo) m += 12;
  return m;
}

/**
 * Pick a voicing of `pcs` inside [lo, hi] that moves as little as possible from
 * `prev` (smooth pad / string voice leading). Brute force over octave choices —
 * at most 3^5 = 243 candidates, trivial.
 */
export function voiceLead(pcs, prev, lo = 52, hi = 76) {
  const options = pcs.map((pc) => {
    const list = [];
    for (let m = lo; m <= hi; m++) if (((m % 12) + 12) % 12 === pc) list.push(m);
    return list.length ? list : [lo + pc];
  });
  let best = null;
  let bestCost = Infinity;
  const cur = new Array(pcs.length);
  const rec = (i) => {
    if (i === pcs.length) {
      const v = [...cur].sort((a, b) => a - b);
      // avoid muddy close intervals in the low register
      let cost = 0;
      for (let k = 1; k < v.length; k++) {
        if (v[k] === v[k - 1]) cost += 50;
        if (v[k] - v[k - 1] < 3 && v[k - 1] < 55) cost += 8;
      }
      if (prev && prev.length) {
        for (let k = 0; k < v.length; k++) cost += Math.abs(v[k] - prev[Math.min(k, prev.length - 1)]);
      } else {
        const centre = (lo + hi) / 2;
        for (const m of v) cost += Math.abs(m - centre) * 0.5;
      }
      if (cost < bestCost) {
        bestCost = cost;
        best = v;
      }
      return;
    }
    for (const m of options[i]) {
      cur[i] = m;
      rec(i + 1);
    }
  };
  rec(0);
  return best;
}

/** Move `midi` by `steps` scale degrees within `scale` (pitch-class set relative to key). */
export function scaleStep(midi, steps, keyRoot, scale) {
  const rel = midi - keyRoot;
  const oct = Math.floor(rel / 12);
  const pc = ((rel % 12) + 12) % 12;
  // nearest scale degree at or below pc
  let idx = 0;
  for (let i = 0; i < scale.length; i++) if (scale[i] <= pc) idx = i;
  const n = scale.length;
  let total = oct * n + idx + steps;
  const o = Math.floor(total / n);
  const d = ((total % n) + n) % n;
  return keyRoot + o * 12 + scale[d];
}

/** MIDI note of scale degree `deg` (0-based, can exceed scale length) above `base`. */
export function degree(base, scale, deg) {
  const n = scale.length;
  const o = Math.floor(deg / n);
  return base + o * 12 + scale[((deg % n) + n) % n];
}
