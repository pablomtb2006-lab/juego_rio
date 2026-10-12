/** Copies device input into the player's stream. `autopilot` hands control to the AI (captures, demo). */
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
    s.input.steer = this.input.steer;
    s.input.move.copy(this.input.move);
    s.input.surge = this.input.surge;
  }
}
