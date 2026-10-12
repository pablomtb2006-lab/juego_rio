import { t } from '../i18n.js';

/**
 * Contextual tutorial (TRAMO 1). Teaches one mechanic at a time, in the moment it matters,
 * and only while the new-player ramp is on (game.difficulty.level < 1, i.e. the first matches).
 * Each tip fires at most once per match, and never two at once.
 *
 * Add a tip: push to TIPS with `when(ctx)` returning true when it should fire. Order matters —
 * the first matching tip wins — so put the more specific ones first.
 */
const GAP = 4.5; // seconds between tips, so they never pile up

const TIPS = [
  {
    id: 'clouds',
    life: 5,
    when: ({ p, g }) => p.phase === 'drop' && nearestCloud(g, p) < 450,
  },
  {
    id: 'danger',
    life: 5,
    when: ({ p }) => p.phase === 'flow' && p.threat && p.danger > 0.25,
  },
  {
    id: 'lake',
    life: 5,
    when: ({ p, g }) => p.phase === 'flow' && nearestLake(g, p) < 320,
  },
  {
    id: 'leap',
    life: 6,
    when: ({ p, g }) => p.phase === 'flow' && g.time > 25 && (p.leapCool ?? 0) <= 0,
  },
  {
    id: 'surge',
    life: 5,
    when: ({ p, g }) => p.phase === 'flow' && g.time > 50 && p.volume > 300000,
  },
];

function nearestCloud(g, p) {
  let best = Infinity;
  for (const b of g.ctx.world?.skyWater?.bodies ?? []) {
    if (b.volume <= 0) continue;
    const d = Math.hypot(b.x - p.pos.x, b.z - p.pos.z) + Math.abs(b.y - p.pos.y) * 0.4;
    if (d < best) best = d;
  }
  return best;
}

function nearestLake(g, p) {
  let best = Infinity;
  for (const b of g.ctx.world?.lakes?.bodies ?? []) {
    if (b.volume <= 0 || b.kind !== 'lake') continue;
    if (Math.abs(b.y - p.pos.y) > 60) continue;
    const dx = b.x - p.pos.x;
    const dz = b.z - p.pos.z;
    const d = Math.hypot(dx, dz);
    // only count it if it is roughly ahead of us
    if (d > 1 && (dx * p.heading.x + dz * p.heading.y) / d < 0.3) continue;
    if (d < best) best = d;
  }
  return best;
}

export class Coach {
  constructor(ui) {
    this.ui = ui;
    this.shown = new Set();
    this.cool = 0;
    ui.ctx.bus.on('phase', ({ state }) => {
      if (state === 'drop') {
        this.shown.clear();
        this.cool = 2;
      }
    });
  }

  /** True while the new-player ramp is running. */
  get active() {
    const d = this.ui.ctx.game?.difficulty;
    return !!d && d.level < 1 && !this.ui.ctx.params.capture;
  }

  update(dt) {
    if (!this.active) return;
    this.cool -= dt;
    if (this.cool > 0) return;
    const g = this.ui.ctx.game;
    const p = g.player;
    if (!p || !p.alive || (g.state !== 'drop' && g.state !== 'stream')) return;
    const ctx = { p, g, touch: this.ui.touch };
    for (const tip of TIPS) {
      if (this.shown.has(tip.id)) continue;
      let ok = false;
      try {
        ok = tip.when(ctx);
      } catch {
        ok = false; // a tip must never break the HUD
      }
      if (!ok) continue;
      this.shown.add(tip.id);
      this.cool = GAP;
      this.ui.hud.hint(t(`coach.${tip.id}${this.ui.touch ? 'Touch' : ''}`), tip.life);
      return;
    }
  }
}
