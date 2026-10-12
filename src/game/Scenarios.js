/**
 * Deterministic set-ups for screenshots / visual review (tools/capture.mjs).
 * Load with ?capture=1&scene=<name>. Each scenario prepares the state by stepping
 * the engine without rendering, then sets window.__READY = true.
 *
 * Every element of the game loop has a scenario so it can be reviewed in isolation.
 */
export const SCENARIOS = {
  menu: async (game) => {
    game.toMenu();
    advance(game, 60);
  },
  drop: async (game) => {
    game.startMatch({ seed: 1 });
    autopilot(game);
    advance(game, 60 * 4);
  },
  arch: async (game) => {
    game.startMatch({ seed: 1 });
    autopilot(game);
    advance(game, 60 * 20, () => game.player.pos.y < (game.ctx.world.landmarks.arch?.position.y ?? 0) + 250);
  },
  landing: async (game) => {
    game.startMatch({ seed: 1 });
    autopilot(game);
    advance(game, 60 * 60, () => game.player.phase === 'flow');
    advance(game, 20);
  },
  stream: async (game) => {
    game.startMatch({ seed: 1 });
    autopilot(game);
    advance(game, 60 * 60, () => game.player.phase === 'flow');
    advance(game, 60 * 12);
  },
  lake: async (game) => {
    game.startMatch({ seed: 1 });
    autopilot(game);
    advance(game, 60 * 60, () => game.player.phase === 'flow');
    advance(game, 60 * 120, () => game.player.absorbing > 0 || !game.player.alive);
    advance(game, 20);
  },
  rival: async (game) => {
    game.startMatch({ seed: 1 });
    autopilot(game);
    advance(game, 60 * 60, () => game.player.phase === 'flow');
    advance(game, 60 * 15);
    // pull the nearest flowing rival right next to the player for a close-up
    const p = game.player;
    const rival = game.streams.find((s) => s !== p && s.phase === 'flow');
    if (rival) {
      rival.pos.set(p.pos.x + p.heading.y * 40 + p.heading.x * 30, p.pos.y, p.pos.z - p.heading.x * 40 + p.heading.y * 30);
      rival.vel.copy(p.vel);
      advance(game, 30);
    }
  },
  forest: async (game) => {
    game.startMatch({ seed: 1 });
    autopilot(game);
    advance(game, 60 * 60, () => game.player.phase === 'flow');
    advance(game, 60 * 300, () => game.player.pos.y < 450 || !game.player.alive);
  },
  sea: async (game) => {
    game.startMatch({ seed: 1 });
    autopilot(game);
    advance(game, 60 * 60, () => game.player.phase === 'flow');
    advance(game, 60 * 600, () => game.state === 'result');
    advance(game, 60 * 2);
  },
  map: async (game) => {
    game.startMatch({ seed: 1 });
    autopilot(game);
    advance(game, 60 * 60, () => game.player.phase === 'flow');
    advance(game, 60 * 25);
    game.ctx.ui?.showMap?.(true);
  },
};

function autopilot(game) {
  if (game.player?.controller) game.player.controller.autopilot = true;
}

/** Step the engine up to `frames` fixed frames (no rendering), stopping early when `until()` is true. */
export function advance(game, frames, until = null) {
  const engine = game.ctx.engine;
  for (let i = 0; i < frames; i++) {
    engine.tick(1 / 60);
    if (until && until()) break;
  }
}

export async function runScenario(game, name) {
  const fn = SCENARIOS[name];
  if (!fn) {
    console.warn(`Unknown scenario "${name}". Available: ${Object.keys(SCENARIOS).join(', ')}`);
    return;
  }
  await fn(game);
  window.__READY = true;
}
