import { mulberry32 } from '../core/random.js';

/**
 * Per-match objectives (TRAMO 1): three small goals the player can always see, each paying
 * Gotas. They give every match a reason to keep going even when first place is gone, which is
 * what turns "I lost" into "one more".
 *
 * Lifecycle: Game creates one per match and calls start()/stop(); it listens to the bus itself.
 * Read `objectives.list` for the HUD and the result screen:
 *   [{ id, text, progress, target, done, reward, claimed }]
 *
 * Adding a goal: add an entry to POOL. `track` receives (state, event payload) and returns the
 * new progress value; `text` is a function of the target so the wording matches the number.
 */

const POOL = [
  {
    id: 'lakes',
    icon: '🌊',
    targets: [2, 3, 4],
    reward: 60,
    text: (n, es) => (es ? `Tragar ${n} lagos` : `Swallow ${n} lakes`),
    on: 'lake',
  },
  {
    id: 'volume',
    icon: '💧',
    targets: [800000, 1500000, 2500000],
    reward: 70,
    text: (n, es) => (es ? `Llegar a ${fmt(n)} L` : `Reach ${fmt(n)} L`),
    on: 'volume',
  },
  {
    id: 'dams',
    icon: '🪵',
    targets: [1, 2, 3],
    reward: 80,
    text: (n, es) => (es ? `Romper ${n} ${n === 1 ? 'presa' : 'presas'}` : `Smash ${n} ${n === 1 ? 'dam' : 'dams'}`),
    on: 'dam',
  },
  {
    id: 'abil',
    icon: '🪨',
    targets: [1, 2, 3],
    reward: 70,
    text: (n, es) => (es ? `Usar ${n} ${n === 1 ? 'habilidad' : 'habilidades'} contra rivales` : `Use ${n} abilit${n === 1 ? 'y' : 'ies'} on rivals`),
    on: 'ability',
    needsAbility: true,
  },
  {
    id: 'cuts',
    icon: '✂️',
    targets: [1, 2, 3],
    reward: 80,
    text: (n, es) => (es ? `Cortar a ${n} ${n === 1 ? 'rival' : 'rivales'}` : `Cut off ${n} ${n === 1 ? 'rival' : 'rivals'}`),
    on: 'cut',
  },
  {
    id: 'leaps',
    icon: '🐬',
    targets: [2, 3, 5],
    reward: 50,
    text: (n, es) => (es ? `Saltar ${n} veces` : `Leap ${n} times`),
    on: 'leap',
  },
  {
    id: 'place',
    icon: '🏁',
    targets: [10, 5, 3],
    reward: 90,
    // "lower is better": not a count, so it has no x/y counter and completes in one step
    counter: false,
    text: (n, es) => (es ? `Acabar entre los ${n} primeros` : `Finish in the top ${n}`),
    on: 'place',
  },
  {
    id: 'arch',
    icon: '🌉',
    targets: [1],
    reward: 60,
    counter: false,
    text: (_n, es) => (es ? 'Atravesar el arco de roca' : 'Fly through the rock arch'),
    on: 'arch',
  },
  {
    id: 'sea',
    icon: '🌅',
    targets: [1],
    reward: 100,
    counter: false,
    text: (_n, es) => (es ? 'Llegar al mar' : 'Reach the sea'),
    on: 'sea',
  },
];

function fmt(v) {
  return v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : `${Math.round(v / 1000)}K`;
}

/** Difficulty tier of the targets: 0 for a new player, 2 once they know the game. */
function tierFor(matches) {
  return matches < 3 ? 0 : matches < 12 ? 1 : 2;
}

export class Objectives {
  constructor(game) {
    this.game = game;
    this.list = [];
    this.offs = [];
  }

  /** Pick three goals for this match. `seed` keeps them stable across a revive. */
  start(seed = 1) {
    this.stop();
    const matches = this.game.ctx.services?.economy?.stats?.matches ?? 0;
    const tier = tierFor(matches);
    const es = (this.game.ctx.ui?.lang ?? 'es') === 'es';
    const rand = mulberry32((seed >>> 0) + matches * 7919);
    // the arch goal only exists on matches that actually drop through the arch
    const pool = POOL.filter((p) => (p.id !== 'arch' || this.game.archMatch) && (!p.needsAbility || ['wall', 'leech', 'fog'].some((id) => this.game.abilities?.unlocked(this.game.player ?? { isPlayer: true }, id))));
    // the very first matches always include "reach the sea" so the goal of the game is explicit
    const picked = [];
    if (matches < 2) picked.push(pool.splice(pool.findIndex((p) => p.id === 'sea'), 1)[0]);
    while (picked.length < 3 && pool.length) picked.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);

    this.list = picked.map((p) => {
      const target = p.targets[Math.min(tier, p.targets.length - 1)];
      return {
        id: p.id,
        icon: p.icon,
        on: p.on,
        counter: p.counter !== false,
        target,
        reward: p.reward,
        text: p.text(target, es),
        progress: 0,
        done: false,
        claimed: false,
      };
    });

    const bus = this.game.ctx.bus;
    const isPlayer = (s) => s && s === this.game.player;
    const bump = (on, by = 1) => {
      for (const o of this.list) if (o.on === on && !o.done) this.advance(o, o.progress + by);
    };
    // per-match, and keyed by body: a flag on the body itself would survive into the next match
    this.absorbed = new Map();
    this.counted = new Set();

    this.offs = [
      bus.on('absorb', ({ stream, body, amount }) => {
        if (!isPlayer(stream) || !body || body.kind === 'cloud') return;
        const total = (this.absorbed.get(body) ?? 0) + amount;
        this.absorbed.set(body, total);
        // a lake counts once it is mostly drained, so brushing past it is not enough
        if (body.kind === 'lake' && !this.counted.has(body) && total > body.maxVolume * 0.5) {
          this.counted.add(body);
          bump('lake');
        }
      }),
      bus.on('damBreak', ({ stream }) => isPlayer(stream) && bump('dam')),
      bus.on('cut', ({ attacker }) => isPlayer(attacker) && bump('cut')),
      bus.on('leap', ({ stream }) => isPlayer(stream) && bump('leap')),
      bus.on('ability', ({ caster }) => isPlayer(caster) && bump('ability')),
      bus.on('bonus', ({ stream, kind }) => isPlayer(stream) && kind === 'arch' && bump('arch')),
      bus.on('finished', ({ stream, place }) => {
        if (!isPlayer(stream)) return;
        bump('sea');
        for (const o of this.list) if (o.on === 'place' && !o.done && place <= o.target) this.complete(o);
      }),
    ];
  }

  /** Per-frame: volume goals need polling (there is no event for "grew a bit"). */
  /** Volume goals have no event to listen to, so they are polled. */
  update() {
    const p = this.game.player;
    if (!p) return;
    for (const o of this.list) if (o.on === 'volume' && !o.done) this.advance(o, Math.max(o.progress, p.peakVolume));
  }

  advance(o, value) {
    if (o.done) return;
    o.progress = Math.min(value, o.target);
    if (o.progress >= o.target) this.complete(o);
  }

  /** Mark done regardless of progress (threshold goals like "finish top 5"). */
  complete(o) {
    if (o.done) return;
    o.progress = o.target;
    o.done = true;
    this.game.ctx.bus.emit('objective', { objective: o });
  }

  /** Gotas earned this match. Called by the result screen once. */
  claim() {
    let total = 0;
    for (const o of this.list) {
      if (!o.done || o.claimed) continue;
      o.claimed = true;
      total += o.reward;
    }
    return total;
  }

  get doneCount() {
    return this.list.filter((o) => o.done).length;
  }

  stop() {
    for (const off of this.offs) off();
    this.offs = [];
    this.absorbed = null;
    this.counted = null;
  }
}
