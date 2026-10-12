// URL parameters. Used by players (quality) and by tools/capture.mjs (scene, capture).
//   ?seed=7            world seed
//   ?quality=high      low | medium | high | ultra (default: auto)
//   ?scene=stream      jump straight to a scenario (see src/game/Scenarios.js)
//   ?capture=1         deterministic mode: no real-time loop, driven by window.__engine.step()
//   ?nohud=1           hide the DOM overlay
//   ?mute=1            no audio
const q = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');

export const params = {
  seed: Number(q.get('seed') ?? 7),
  quality: q.get('quality') ?? 'auto',
  scene: q.get('scene') ?? null,
  capture: q.get('capture') === '1',
  nohud: q.get('nohud') === '1',
  mute: q.get('mute') === '1',
  debug: q.get('debug') === '1',
};
