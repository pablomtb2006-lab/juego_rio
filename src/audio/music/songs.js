import { SCALES, scaleStep } from './theory.js';

/**
 * Procedural score. Every song is a chord progression in a key plus a `step()`
 * function the sequencer calls on every 16th note with the musical state:
 *
 *   s = { t, step (0..15), bar, sbar (bar inside section), section, sym, pcs,
 *         voicing (voice-led pad chord), root (bass root, E2..D#3), arp (chord tones
 *         D4..A5), high (chord tones G5..D7), key (tonic MIDI, octave 4), scale,
 *         layers (0..3, adaptive, changes on bar lines), build (0..1), stepDur }
 *
 * Melodies are written by hand as [step, semitones above the tonic, length in
 * 16ths], so they are guaranteed to be in key and singable; harmonies are
 * derived diatonically (scaleStep) from the bar's scale.
 */

const C = (r, q, scale) => ({ r, q, scale });
// Roman numerals in a major key
const I = C(0, 'maj');
const Iadd9 = C(0, 'add9');
const ii7 = C(2, 'min7');
const IV = C(5, 'maj');
const IVadd9 = C(5, 'add9');
const IVmaj7 = C(5, 'maj7');
const V = C(7, 'maj');
const Vsus4 = C(7, '7sus4');
const vi = C(9, 'min');
const vi7 = C(9, 'min7');
const bVII = C(10, 'maj', SCALES.mixolydian); // the "adventure" chord (borrowed from mixolydian)

const ACC = [1, 0.5, 0.72, 0.5, 0.9, 0.5, 0.72, 0.55, 1, 0.5, 0.72, 0.5, 0.9, 0.55, 0.8, 0.6];
const ARP_HITS = [1, 0, 1, 1, 0, 1, 1, 0, 1, 0, 1, 1, 0, 1, 1, 1];
const ARP_SEQ = [0, 2, 1, 3, 2, 4, 3, 1, 0, 2, 1, 3, 4, 3, 2, 1];
const SKY_SEQ = [0, 1, 2, 3, 4, 3, 2, 1, 2, 3, 4, 5, 4, 3, 2, 1];

const at = (list, step) => {
  for (const n of list) if (n[0] === step) return n;
  return null;
};

function bassNote(s, kind) {
  if (kind === 'O') return s.root + 12;
  if (kind === '5') return s.root + 7;
  return s.root;
}

// ---------------------------------------------------------------------------
// MENU — playful, sunny lobby groove (G major, I V vi IV I bVII IV V)
// ---------------------------------------------------------------------------
// 3+3+2 syncopation; beats 1 & 3 carry chord tones, the 16th before beat 4 is a passing tone
const MENU_MELODY = [
  [[0, 4, 3], [3, 7, 3], [6, 12, 4], [10, 11, 2], [12, 12, 4]], // G:  B D G . F# G
  [[0, 14, 3], [3, 11, 3], [6, 7, 4], [10, 9, 2], [12, 11, 4]], // D:  A F# D . E F#
  [[0, 12, 3], [3, 9, 3], [6, 4, 4], [10, 7, 2], [12, 9, 4]], // Em: G E B . D E
  [[0, 12, 3], [3, 9, 3], [6, 5, 4], [10, 7, 2], [12, 9, 2], [14, 7, 2]], // C: G E C . D E D
  [[0, 4, 3], [3, 7, 3], [6, 12, 4], [10, 11, 2], [12, 12, 4]], // G
  [[0, 14, 3], [3, 10, 3], [6, 5, 4], [10, 7, 2], [12, 10, 4]], // F (bVII): A F C . D F
  [[0, 9, 3], [3, 12, 3], [6, 17, 4], [10, 16, 2], [12, 12, 4]], // C:  E G C' . B G
  [[0, 14, 4], [4, 12, 2], [6, 11, 4], [10, 9, 2], [12, 7, 4]], // D:  A G F# . E D
];
const MENU_BASS = [[0, 'R', 3], [3, 'R', 2], [6, 'O', 1], [7, 'R', 2], [10, '5', 2], [12, 'R', 2], [14, 'O', 2]];

function menuStep(m, s, { calm = false } = {}) {
  const { t, step, sbar, section } = s;
  const intro = section === 'intro';
  const brk = section === 'break';
  const lift = section === 'lift';
  const groove = !intro && !brk && !calm;

  if (step === 0) m.pad(t, s.voicing, 16, brk || calm || intro ? 0.66 : 0.48, { cutoff: lift ? 2600 : 1700 });

  // pluck arpeggio
  if (!brk) {
    const hit = intro || calm ? step % 2 === 0 : ARP_HITS[step];
    if (hit) {
      const n = s.arp[ARP_SEQ[step] % s.arp.length];
      m.pluck(t, n, ACC[step] * (intro ? 0.6 : calm ? 0.42 : 0.62), { bright: lift ? 0.75 : intro ? 0.55 : 0.42 });
    }
  }

  // bass
  if (groove) {
    const b = at(MENU_BASS, step);
    if (b) m.bass(t, bassNote(s, b[1]), b[2], step === 0 ? 0.85 : 0.7);
  } else if ((brk || calm) && (step === 0 || step === 8)) {
    m.bass(t, step === 0 ? s.root : s.root + 7, 8, 0.5, { bite: 0.15 });
  }

  // drums
  if (groove) {
    const kicks = sbar % 2 ? [0, 6, 10] : [0, 7, 8];
    if (kicks.includes(step)) m.drum('kick', t, step === 0 ? 0.95 : 0.75);
    if (step === 4 || step === 12) m.drum('clap', t, 0.62);
    if (step % 2 === 0) {
      if (lift && step === 14) m.drum('hatO', t, 0.38);
      else m.drum('hatC', t, step % 4 === 2 ? 0.5 : 0.32);
    }
    if (step === 15 && sbar % 2) m.drum('hatC', t, 0.22);
    m.drum('shaker', t, step % 2 ? 0.28 : 0.16);
    if (lift && (step === 7 || step === 13) && sbar % 4 === 3) m.drum('rim', t, 0.35);
    if (sbar === 0 && step === 0) m.drum('crash', t, 0.4);
    // fill into the next section
    if (sbar === s.slen - 1 && step >= 12) m.drum('tom', t, 0.5 + (step - 12) * 0.08, { rate: [1.45, 1.25, 1.05, 0.88][step - 12] });
  } else if (intro) {
    if (step % 4 === 2) m.drum('shaker', t, 0.2);
    if (sbar === s.slen - 1 && step === 0) m.drum('revCrash', t, 0.32, { tail: s.stepDur * 16 });
  } else if (brk) {
    if (step === 0) m.drum('kick', t, 0.6);
    if (step === 8 && sbar % 2) m.drum('rim', t, 0.25);
    if (sbar === s.slen - 1 && step === 0) m.drum('revCrash', t, 0.35, { tail: s.stepDur * 16 });
  } else if (calm) {
    if (step === 0) m.drum('kick', t, 0.42);
    if (step % 4 === 2) m.drum('shaker', t, 0.18);
  }

  // mallet melody (+ diatonic third above in the lift, bells echo in the break)
  if (!intro) {
    const n = at(MENU_MELODY[sbar % 8], step);
    if (n) {
      const midi = s.key + n[1];
      const vel = step === 0 || step === 8 ? 0.72 : 0.6;
      if (brk) {
        if (step === 0 || step === 6 || step === 10) m.bell(t, midi + 12, 0.32, { decay: 0.7 });
      } else {
        m.mallet(t, midi, calm ? vel * 0.8 : vel);
        if (lift) m.bell(t, scaleStep(midi, 2, s.key, s.scale) + 12, 0.16, { decay: 0.4 });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// DROP — floating in the sky (IVadd9 I ii7 V7sus4), bells + pad; builds to the impact
// ---------------------------------------------------------------------------
const DROP_LEAD = [
  [[0, 9, 8], [8, 7, 8]], // C: E5 D5
  [[0, 4, 16]], // G: B4
  [[0, 5, 8], [8, 9, 8]], // Am7: C5 E5
  [[0, 7, 12], [12, 12, 4]], // D7sus4: D5 G5
];

function dropStep(m, s) {
  const { t, step, build } = s;
  if (step === 0) {
    m.pad(t, s.voicing, 16, 0.55 + build * 0.15, { cutoff: 1900 + 2600 * build, attack: 0.9 });
    m.bass(t, s.root, 15, 0.42, { bite: 0.05 });
  }
  // glassy sky arpeggio
  if (step % 2 === 0 || build > 0.35) {
    const n = s.high[SKY_SEQ[step] % s.high.length];
    m.bell(t, n, (step % 4 === 0 ? 0.2 : 0.13) * (1 + build * 0.4), { decay: 0.45, ratio: 3.01, index: 1.4 });
  }
  const ln = at(DROP_LEAD[s.bar % 4], step);
  if (ln) m.lead(t, s.key + ln[1], ln[2], 0.38, { cutoff: 1800 + build * 1500 });

  // build-up as the ground approaches (driven by time-to-impact)
  if (build > 0.12) {
    const div = build > 0.82 ? 1 : build > 0.58 ? 2 : 4;
    if (step % div === 0) m.drum('snare', t, 0.18 + 0.55 * build * (0.7 + 0.3 * (step / 16)));
    if (build > 0.45 && step % 4 === 0) m.drum('kick', t, 0.45 + 0.4 * build);
  }
}

// ---------------------------------------------------------------------------
// MATCH — driving adaptive groove (vi IV I V), vertical layers 0..3
// ---------------------------------------------------------------------------
const HOOK_A = [
  [[0, 9, 3], [3, 4, 3], [6, 9, 2], [8, 12, 2], [10, 11, 2], [12, 9, 2], [14, 7, 2]],
  [[0, 9, 3], [3, 5, 3], [6, 9, 2], [8, 12, 4], [12, 14, 2], [14, 12, 2]],
  [[0, 16, 3], [3, 12, 3], [6, 7, 2], [8, 12, 2], [10, 14, 2], [12, 16, 2], [14, 19, 2]],
  [[0, 14, 6], [6, 11, 2], [8, 14, 2], [10, 16, 2], [12, 14, 2], [14, 11, 2]],
];
const HOOK_B = [
  [[0, 16, 4], [4, 14, 2], [6, 12, 2], [8, 11, 4], [12, 9, 4]],
  [[0, 12, 4], [4, 9, 2], [6, 7, 2], [8, 5, 4], [12, 9, 4]],
  [[0, 7, 2], [2, 11, 2], [4, 12, 4], [8, 14, 2], [10, 16, 2], [12, 19, 4]],
  [[0, 21, 6], [6, 19, 2], [8, 14, 4], [12, 11, 4]],
];

function matchStep(m, s) {
  const { t, step, bar, layers: L } = s;
  if (step === 0) m.pad(t, s.voicing, 16, 0.5, { cutoff: 1100 + L * 700, attack: L >= 2 ? 0.25 : 0.5 });

  // bass: sparse → driving octave bounce
  if (L >= 2) {
    if (step % 2 === 0) m.bass(t, step % 4 === 2 ? s.root + 12 : s.root, 1.6, step % 8 === 0 ? 0.85 : 0.68, { bite: 0.65 });
  } else if (step === 0 || step === 10 || (L >= 1 && step === 6)) {
    m.bass(t, s.root, step === 0 ? 6 : 4, 0.75, { bite: 0.35 });
  }

  // drums
  if (L >= 1) {
    const kicks = L >= 2 ? [0, 4, 8, 12] : bar % 2 ? [0, 8, 10] : [0, 8];
    if (kicks.includes(step)) m.drum('kick', t, step === 0 ? 1 : 0.85);
    if (L >= 2 && (step === 4 || step === 12)) m.drum('clap', t, 0.7);
    if (L >= 3 && step % 4 === 2) m.drum('hatO', t, 0.32);
    else if (L >= 2 || step % 2 === 0) m.drum('hatC', t, (step % 4 === 2 ? 0.5 : 0.3) * (L >= 2 ? 1 : 0.8));
    m.drum('shaker', t, step % 2 ? 0.26 : 0.14);
    // phrase-end fill
    if (L >= 2 && bar % 4 === 3 && step >= 12) m.drum('snare', t, 0.35 + (step - 12) * 0.12);
    if (L >= 3 && bar % 4 === 0 && step === 0) m.drum('crash', t, 0.45);
  }

  // arpeggio
  if (L >= 2) {
    const n = s.arp[ARP_SEQ[step] % s.arp.length];
    m.pluck(t, n, ACC[step] * 0.55, { bright: 0.5 + L * 0.12, decay: 0.16 });
  } else if (L >= 1 && step % 4 === 0) {
    m.pluck(t, s.arp[(step / 4) % s.arp.length], 0.45, { bright: 0.35, decay: 0.25 });
  }

  // lead hook (call / response every 4 bars) + sparkles
  if (L >= 3) {
    const hook = Math.floor(bar / 4) % 2 ? HOOK_B : HOOK_A;
    const n = at(hook[bar % 4], step);
    if (n) m.lead(t, s.key + n[1], n[2], step % 8 === 0 ? 0.7 : 0.58);
    if (step % 4 === 2) m.bell(t, s.high[(bar + step) % s.high.length], 0.12, { decay: 0.35 });
  }
}

// ---------------------------------------------------------------------------
// RESULT loops
// ---------------------------------------------------------------------------
function defeatStep(m, s) {
  const { t, step } = s;
  if (step === 0) {
    m.pad(t, s.voicing, 16, 0.55, { cutoff: 1100, attack: 1.0 });
    m.bass(t, s.root, 14, 0.4, { bite: 0.05 });
  }
  if (step === 0 || step === 6 || step === 10) {
    const n = s.arp[(s.bar + step) % s.arp.length];
    m.mallet(t, n + 12, 0.38, { decay: 0.6 });
  }
}

export const SONGS = {
  menu: {
    bpm: 116,
    swing: 0.12,
    key: 67, // G
    progression: [I, V, vi, IV, I, bVII, IV, V],
    sections: [['intro', 4], ['groove', 8], ['lift', 8], ['break', 8]],
    loopFrom: 1,
    step: (m, s) => menuStep(m, s),
  },
  drop: {
    bpm: 124,
    swing: 0,
    key: 67,
    progression: [IVadd9, Iadd9, ii7, Vsus4],
    sections: [['sky', 4]],
    loopFrom: 0,
    step: dropStep,
  },
  match: {
    bpm: 124,
    swing: 0,
    key: 67,
    adaptive: true,
    progression: [vi, IV, I, V],
    sections: [['river', 4]],
    loopFrom: 0,
    step: matchStep,
  },
  victory: {
    bpm: 104,
    swing: 0.1,
    key: 67,
    progression: [I, V, vi, IV, I, bVII, IV, V],
    sections: [['calm', 8]],
    loopFrom: 0,
    step: (m, s) => menuStep(m, s, { calm: true }),
  },
  defeat: {
    bpm: 84,
    swing: 0,
    key: 67,
    progression: [vi7, IVmaj7, I, Vsus4],
    sections: [['calm', 8]],
    loopFrom: 0,
    step: defeatStep,
  },
};
