/**
 * Copies device input into the player's stream. `autopilot` hands control to the AI
 * (captures, demo, headless sims). A future NetworkController writes the same
 * `stream.input` fields: { steer, move: Vector2(turn, pitch), surge }.
 *
 * Mapping
 *   drop  : steer → turn, forward → dive (+) / flare (−)
 *   river : steer → bend the course off the valley line, forward > 0.75 or surge → surge
 */
export class PlayerController {
  constructor(stream, input, ai) {
    this.stream = stream;
    this.input = input;
    this.ai = ai;
    this.autopilot = false;
  }

  update(dt, game) {
    if (this.autopilot) {
      this.ai.update(dt, game);
      return;
    }
    const s = this.stream;
    const i = this.input;
    s.input.steer = i.steer;
    s.input.move.set(i.steer, i.forward);
    s.input.surge = s.phase === 'flow' ? i.surge || i.forward > 0.75 : false;
  }
}
