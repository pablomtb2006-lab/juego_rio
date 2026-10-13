/**
 * LA SEQUÍA — the shrinking "storm" of a river battle royale (TRAMO A).
 *
 * Every `interval` seconds the stream furthest from the sea dries up and is eliminated.
 * That turns the race into a countdown: you can never coast, and falling behind kills you
 * even if nobody attacks you. The interval shortens as the field thins, so the end is tense.
 *
 * Contract (read by the HUD and the callouts):
 *   drought.active        the countdown is running
 *   drought.timeLeft      seconds until the next sweep
 *   drought.interval      current gap between sweeps
 *   drought.victim        the stream that will be swept if nothing changes (may be the player)
 *   drought.playerAtRisk  the player is the current victim
 *   drought.sweeps        how many streams it has taken this match
 *
 * Bus events:
 *   'droughtWarn'  { victim, seconds }   a few seconds before each sweep (once per sweep)
 *   'droughtSweep' { victim }            the moment it takes someone
 */
export const DROUGHT = {
  grace: 82, // seconds after the match starts before the first sweep
  interval: 30, // seconds between sweeps at the start
  minInterval: 17, // …shrinking to this as the field thins
  warnAt: 5, // seconds before a sweep that the warning fires
  minAlive: 2, // never sweep the last survivor
  safeAfterLanding: 6, // a stream that just landed cannot be the victim yet
};

export class Drought {
  constructor(game) {
    this.game = game;
    this.reset();
  }

  reset() {
    this.active = false;
    this.timeLeft = DROUGHT.grace;
    this.interval = DROUGHT.interval;
    this.victim = null;
    this.warned = false;
    this.sweeps = 0;
  }

  get playerAtRisk() {
    return !!this.victim && this.victim === this.game.player;
  }

  /** Streams that can still be swept (alive, flowing, landed long enough ago). */
  candidates() {
    const t = this.game.time;
    return this.game.streams.filter((s) => s.phase === 'flow' && t - s.landedAt > DROUGHT.safeAfterLanding);
  }

  /** Whoever is furthest from the sea. Ties break on the smaller river. */
  pickVictim(list) {
    let worst = null;
    for (const s of list) {
      if (!worst) {
        worst = s;
        continue;
      }
      const d = s.routeDist - worst.routeDist;
      if (d > 1 || (Math.abs(d) <= 1 && s.volume < worst.volume)) worst = s;
    }
    return worst;
  }

  update(dt) {
    const game = this.game;
    if (game.state !== 'stream' && game.state !== 'drop') return;
    const alive = game.streams.filter((s) => s.alive).length;
    if (alive <= DROUGHT.minAlive) {
      this.active = false;
      this.victim = null;
      return;
    }

    // the clock only starts once somebody is actually racing
    const list = this.candidates();
    if (!list.length) return;
    if (!this.active) game.ctx.bus.emit('droughtStart', {});
    this.active = true;
    this.victim = this.pickVictim(list);
    this.timeLeft -= dt;

    if (!this.warned && this.timeLeft <= DROUGHT.warnAt) {
      this.warned = true;
      game.ctx.bus.emit('droughtWarn', { victim: this.victim, seconds: Math.max(0, this.timeLeft) });
    }
    if (this.timeLeft > 0) return;

    // sweep: re-pick at the last instant so a late sprint really saves you
    const victim = this.pickVictim(this.candidates());
    this.sweeps++;
    this.warned = false;
    // the field thins → the drought closes in
    this.interval = Math.max(DROUGHT.minInterval, DROUGHT.interval - this.sweeps * 0.75);
    this.timeLeft = this.interval;
    if (!victim) return;
    game.ctx.bus.emit('droughtSweep', { victim });
    game.rules.eliminate(victim, null, 'drought', 'drought');
  }
}
