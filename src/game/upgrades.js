/**
 * Permanent upgrades bought with Gotas between matches (the progression loop).
 * Levels live in services.economy.upgrades = { [id]: level }. Only the player gets them;
 * rivals scale through AI skill instead, so upgrades feel like real power.
 */
export const UPGRADES = [
  {
    id: 'flow',
    icon: '💧',
    name: { es: 'Caudal inicial', en: 'Starting flow' },
    desc: { es: '+20% de agua al aterrizar', en: '+20% water when you land' },
    costs: [150, 350, 700, 1300, 2200],
    apply: (s, l) => (s.volume *= 1 + 0.2 * l),
  },
  {
    id: 'current',
    icon: '⚡',
    name: { es: 'Corriente', en: 'Current' },
    desc: { es: '+4% de velocidad máxima', en: '+4% top speed' },
    costs: [200, 450, 900, 1600, 2600],
    apply: (s, l) => (s.speedMul = 1 + 0.04 * l),
  },
  {
    id: 'thirst',
    icon: '🌊',
    name: { es: 'Sed', en: 'Thirst' },
    desc: { es: '+15% de agua al absorber lagos', en: '+15% water from lakes' },
    costs: [200, 450, 900, 1600, 2600],
    apply: (s, l) => (s.absorbMul = 1 + 0.15 * l),
  },
  {
    id: 'leap',
    icon: '🐬',
    name: { es: 'Salto', en: 'Leap' },
    desc: { es: 'Saltas más alto y recargas antes', en: 'Leap higher, recharge faster' },
    costs: [250, 550, 1000, 1800, 3000],
    apply: (s, l) => {
      s.leapPower = 1 + 0.1 * l;
      s.leapCooldown = Math.max(5, 9 - 0.8 * l);
    },
  },
  {
    id: 'resist',
    icon: '🛡️',
    name: { es: 'Resistencia', en: 'Endurance' },
    desc: { es: '−10% de evaporación', en: '−10% evaporation' },
    costs: [150, 350, 700, 1300, 2200],
    apply: (s, l) => (s.evapMul = Math.max(0.4, 1 - 0.1 * l)),
  },
];

export const MAX_LEVEL = 5;

export function applyUpgrades(stream, levels) {
  if (!levels) return;
  for (const u of UPGRADES) {
    const l = Math.min(MAX_LEVEL, levels[u.id] | 0);
    if (l > 0) u.apply(stream, l);
  }
}

/** Cost of the next level, or null when maxed. */
export function nextCost(id, level) {
  const u = UPGRADES.find((x) => x.id === id);
  return u && level < u.costs.length ? u.costs[level] : null;
}
