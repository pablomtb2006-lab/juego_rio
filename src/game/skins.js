// Water skins — shared data between the shop (UI/economy) and the water renderer.
// Colours are sRGB hex. `price` is in Gotas (soft currency); 0 = free.
// rarity drives shop presentation: common | rare | epic | legendary.
// Renderer fields (stable contract): id, deep, shallow, foam, glow.
// Shop-only fields: name (es), nameEn, rarity, price, featured.
export const SKINS = [
  { id: 'clear', name: 'Cristalina', nameEn: 'Crystal Clear', price: 0, rarity: 'common', deep: 0x0b6e8a, shallow: 0x35d0d6, foam: 0xffffff, glow: 0x000000 },
  { id: 'tropical', name: 'Tropical', nameEn: 'Tropical', price: 500, rarity: 'rare', deep: 0x007a78, shallow: 0x3cf2c8, foam: 0xf4fffb, glow: 0x000000 },
  { id: 'sakura', name: 'Sakura', nameEn: 'Sakura', price: 700, rarity: 'rare', deep: 0x9c2a6b, shallow: 0xff9ccf, foam: 0xfff0f7, glow: 0x2a0018 },
  { id: 'glacier', name: 'Glaciar', nameEn: 'Glacier', price: 900, rarity: 'rare', deep: 0x2d5f9e, shallow: 0xa8e4ff, foam: 0xffffff, glow: 0x0a1a30 },
  { id: 'toxic', name: 'Tóxica', nameEn: 'Toxic', price: 1500, rarity: 'epic', deep: 0x2f6b00, shallow: 0x9dff2e, foam: 0xeaffc8, glow: 0x1f4a00 },
  { id: 'abyss', name: 'Abismo', nameEn: 'Abyss', price: 2000, rarity: 'epic', deep: 0x04163a, shallow: 0x1fb5ff, foam: 0xd8f6ff, glow: 0x003a6a },
  { id: 'gold', name: 'Oro Líquido', nameEn: 'Liquid Gold', price: 2500, rarity: 'epic', deep: 0x8a5a00, shallow: 0xffd34d, foam: 0xfff5cf, glow: 0x3a2400, featured: true },
  { id: 'magma', name: 'Magma', nameEn: 'Magma', price: 4000, rarity: 'legendary', deep: 0x5a0d00, shallow: 0xff6a1a, foam: 0xffd27a, glow: 0x7a1800, featured: true },
  { id: 'galaxy', name: 'Galaxia', nameEn: 'Galaxy', price: 6000, rarity: 'legendary', deep: 0x1a0b4a, shallow: 0x8a5cff, foam: 0xf0e6ff, glow: 0x2a1080 },
];

export const RARITIES = {
  common: { order: 0, color: '#9db4c8', from: '#6f8ba6', to: '#2d4560' },
  rare: { order: 1, color: '#3fc6ff', from: '#2b9cf2', to: '#0d3c8c' },
  epic: { order: 2, color: '#c76bff', from: '#a64dff', to: '#3d0f80' },
  legendary: { order: 3, color: '#ffb23f', from: '#ff9a2e', to: '#8a2c05' },
};

// Rival colours (used for their name tags, route lines and a tint on their water).
export const RIVAL_COLORS = [
  0xff5fa2, 0xa77bff, 0xffd23f, 0x3fd8ff, 0xff8a3d, 0x7dff6b, 0xff4d4d, 0x4dffd2,
  0xf0a6ff, 0xb8ff3d, 0x5f8bff, 0xffb3b3, 0x9cf6ff, 0xffe08a, 0xc59bff,
  0xff9ecf, 0x8affc1, 0xffc46b, 0x6bd0ff, 0xd28aff, 0xe6ff6b, 0xff7a9c, 0x7affea,
];

export const getSkin = (id) => SKINS.find((s) => s.id === id) ?? SKINS[0];

/** Display name in the current language ('es' | 'en'). */
export const skinName = (skin, lang = 'es') => (lang === 'en' ? skin.nameEn ?? skin.name : skin.name);
