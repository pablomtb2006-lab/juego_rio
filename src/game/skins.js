// Water skins — shared data between the shop (UI/economy) and the water renderer.
// Colours are linear-ish sRGB hex. `price` is in Gotas (soft currency); 0 = free.
// rarity drives shop presentation: common | rare | epic | legendary.
export const SKINS = [
  { id: 'clear', name: 'Cristalina', price: 0, rarity: 'common', deep: 0x0b6e8a, shallow: 0x35d0d6, foam: 0xffffff, glow: 0x000000 },
  { id: 'tropical', name: 'Tropical', price: 500, rarity: 'rare', deep: 0x007a78, shallow: 0x3cf2c8, foam: 0xf4fffb, glow: 0x000000 },
  { id: 'glacier', name: 'Glaciar', price: 900, rarity: 'rare', deep: 0x2d5f9e, shallow: 0xa8e4ff, foam: 0xffffff, glow: 0x0a1a30 },
  { id: 'toxic', name: 'Tóxica', price: 1500, rarity: 'epic', deep: 0x2f6b00, shallow: 0x9dff2e, foam: 0xeaffc8, glow: 0x1f4a00 },
  { id: 'gold', name: 'Oro Líquido', price: 2500, rarity: 'epic', deep: 0x8a5a00, shallow: 0xffd34d, foam: 0xfff5cf, glow: 0x3a2400 },
  { id: 'magma', name: 'Magma', price: 4000, rarity: 'legendary', deep: 0x5a0d00, shallow: 0xff6a1a, foam: 0xffd27a, glow: 0x7a1800 },
  { id: 'galaxy', name: 'Galaxia', price: 6000, rarity: 'legendary', deep: 0x1a0b4a, shallow: 0x8a5cff, foam: 0xf0e6ff, glow: 0x2a1080 },
];

// Rival colours (used for their name tags, route lines and a tint on their water).
export const RIVAL_COLORS = [
  0xff5fa2, 0xa77bff, 0xffd23f, 0x3fd8ff, 0xff8a3d, 0x7dff6b, 0xff4d4d, 0x4dffd2,
  0xf0a6ff, 0xb8ff3d, 0x5f8bff, 0xffb3b3, 0x9cf6ff, 0xffe08a, 0xc59bff,
];

export const getSkin = (id) => SKINS.find((s) => s.id === id) ?? SKINS[0];
