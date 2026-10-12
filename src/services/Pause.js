/**
 * Reference-counted pause + mute shared by the pause menu, ads and tab visibility.
 *   pause.acquire(reason) / pause.release(reason)    freeze the simulation (and audio)
 *   pause.muteFor(reason) / pause.unmuteFor(reason)  silence audio only (rewarded ads on result screens)
 *   pause.paused, pause.onChange(fn)
 *
 * Uses the best hook available, so it keeps working while other modules evolve:
 *   engine.pause()/resume()  →  game.setPaused(bool)  →  engine.running = false + engine.start()
 */
export class PauseControl {
  constructor(ctx) {
    this.ctx = ctx;
    this.reasons = new Set();
    this.muteReasons = new Set();
    this.listeners = new Set();
    this.wasRunning = false;
    this.prevMuted = null;
  }

  get paused() {
    return this.reasons.size > 0;
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  acquire(reason) {
    const was = this.paused;
    this.reasons.add(reason);
    this.muteFor(`pause:${reason}`);
    if (!was) this.apply(true);
  }

  release(reason) {
    if (!this.reasons.delete(reason)) return;
    this.unmuteFor(`pause:${reason}`);
    if (!this.paused) this.apply(false);
  }

  apply(p) {
    const { engine, game } = this.ctx;
    try {
      if (typeof engine?.pause === 'function' && typeof engine?.resume === 'function') {
        if (p) engine.pause();
        else engine.resume();
      } else if (typeof game?.setPaused === 'function') {
        game.setPaused(p);
      } else if (engine && !engine.params?.capture) {
        if (p) {
          this.wasRunning = engine.running;
          engine.running = false;
        } else if (this.wasRunning && !engine.running) {
          engine.start();
        }
      }
    } catch (e) {
      console.error(e);
    }
    for (const fn of this.listeners) fn(p);
  }

  muteFor(reason) {
    const was = this.muteReasons.size > 0;
    this.muteReasons.add(reason);
    if (was) return;
    const audio = this.ctx.audio;
    if (!audio) return;
    try {
      if (typeof audio.setPaused === 'function') audio.setPaused(true);
      else {
        this.prevMuted = !!audio.muted;
        audio.setMuted?.(true);
      }
    } catch (e) {
      console.error(e);
    }
  }

  unmuteFor(reason) {
    if (!this.muteReasons.delete(reason) || this.muteReasons.size) return;
    const audio = this.ctx.audio;
    if (!audio) return;
    try {
      if (typeof audio.setPaused === 'function') audio.setPaused(false);
      else if (this.prevMuted === false) audio.setMuted?.(false);
    } catch (e) {
      console.error(e);
    }
  }
}
