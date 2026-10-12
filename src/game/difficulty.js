/**
 * Difficulty ramp for new players (TRAMO 1: retención del primer minuto).
 *
 * A brand-new player who is cut off 40 seconds into their first match usually never comes
 * back. The first matches are therefore softer: rivals are slower, keep their distance, don't
 * hunt the player, and the post-landing protection lasts longer. Everything is back to normal
 * by match RAMP_MATCHES.
 *
 * Read through `game.difficulty` (set in Game.startMatch). Nothing else should branch on
 * "is this a new player" — add a field here instead.
 */
export const RAMP_MATCHES = 5;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * @param {number} matches  matches already finished (economy.stats.matches)
 * @returns {{
 *   level: number,        // 0 = first match ever, 1 = full difficulty
 *   isFirst: boolean,     // very first match: used for the tutorial
 *   aiSkill: number,      // multiplier on rival terminal speed
 *   aggression: number,   // multiplier on the bully trait (0 = nobody hunts you)
 *   caution: number,      // multiplier on how widely bots avoid bigger rivers
 *   huntPlayer: boolean,  // may bots pick the player as prey
 *   dropNearPlayer: number, // how strongly bots aim their landing at the player
 *   protectBonus: number, // extra seconds of post-landing protection
 *   damMul: number,       // multiplier on dam strength (weaker dams at first)
 * }}
 */
export function difficultyFor(matches = 0) {
  const level = clamp01(matches / RAMP_MATCHES);
  return {
    level,
    isFirst: matches <= 0,
    aiSkill: 0.84 + 0.16 * level,
    aggression: level * level, // bullies stay off until the player has a few matches in
    caution: 1 + (1 - level) * 0.8,
    huntPlayer: level >= 0.6,
    dropNearPlayer: 0.35 + 0.65 * level,
    protectBonus: (1 - level) * 7,
    damMul: 0.6 + 0.4 * level,
  };
}

/** Full difficulty, for scenarios / headless sims that must not depend on saved stats. */
export const FULL_DIFFICULTY = difficultyFor(RAMP_MATCHES);
