/**
 * Inline SVG icon set (24×24, currentColor) + a shared <defs> sprite for gradients.
 * icon(name, cls?) -> '<svg …>' string.
 */
const P = {
  play: '<path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.4-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5z"/>',
  drop: '<path d="M12 2.2c.4 0 .7.2.9.5 2.8 4.2 6.1 8 6.1 12a7 7 0 0 1-14 0c0-4 3.3-7.8 6.1-12 .2-.3.5-.5.9-.5z"/><path d="M9.2 13.6a3.2 3.2 0 0 0 2.6 4.2" fill="none" stroke="rgba(255,255,255,.75)" stroke-width="1.8" stroke-linecap="round"/>',
  locker: '<path d="M12 3a2.6 2.6 0 0 1 2.6 2.6c0 1.1-.6 1.8-1.5 2.3-.6.3-1.1.8-1.1 1.4v.3l8.5 5.6c1 .7.5 2.3-.7 2.3H4.2c-1.2 0-1.7-1.6-.7-2.3L12 9.6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>',
  shop: '<path d="M5 8h14l-1.2 11.2A2 2 0 0 1 15.8 21H8.2a2 2 0 0 1-2-1.8L5 8z"/><path d="M8.5 9V7a3.5 3.5 0 0 1 7 0v2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  gear: '<path d="M10.3 2.6h3.4l.5 2.6 1.6.9 2.5-.9 1.7 2.9-2 1.8v1.9l2 1.7-1.7 3-2.5-.9-1.6.9-.5 2.6h-3.4l-.5-2.6-1.6-.9-2.5.9-1.7-3 2-1.7v-1.9l-2-1.8 1.7-2.9 2.5.9 1.6-.9z"/><circle cx="12" cy="12" r="3.2" fill="rgba(0,0,0,.45)"/>',
  gift: '<rect x="3" y="8.5" width="18" height="4.5" rx="1"/><rect x="4.5" y="13" width="15" height="8" rx="1"/><rect x="10.6" y="8.5" width="2.8" height="12.5" fill="rgba(0,0,0,.28)"/><path d="M12 8.3c-1.3-3.6-5.6-4.6-5.6-2 0 1.6 2.6 2 5.6 2zm0 0c1.3-3.6 5.6-4.6 5.6-2 0 1.6-2.6 2-5.6 2z" fill="none" stroke="currentColor" stroke-width="1.8"/>',
  trophy: '<path d="M7 3h10v5a5 5 0 0 1-10 0V3z"/><path d="M7 5H4v1.5A3.5 3.5 0 0 0 7.5 10M17 5h3v1.5a3.5 3.5 0 0 1-3.5 3.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M10.5 13h3l.5 4h-4z"/><rect x="7.5" y="17.5" width="9" height="3.5" rx="1"/>',
  crown: '<path d="M3 8l4.5 4L12 5l4.5 7L21 8l-2 11H5z"/>',
  close: '<path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>',
  check: '<path d="M4.5 12.5l5 5L19.5 7" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10.5" rx="2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" fill="none" stroke="currentColor" stroke-width="2.4"/>',
  ad: '<rect x="2.5" y="5" width="19" height="13" rx="2.5"/><path d="M10 8.8v5.4l4.6-2.7z" fill="rgba(0,0,0,.55)"/><path d="M8 21h8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  share: '<circle cx="18" cy="5.5" r="2.8"/><circle cx="6" cy="12" r="2.8"/><circle cx="18" cy="18.5" r="2.8"/><path d="M8.4 10.7l7.2-3.9M8.4 13.3l7.2 3.9" stroke="currentColor" stroke-width="2"/>',
  home: '<path d="M3 11.2L12 4l9 7.2V20a1 1 0 0 1-1 1h-5.5v-6h-5v6H4a1 1 0 0 1-1-1z"/>',
  pause: '<rect x="6" y="4.5" width="4" height="15" rx="1.2"/><rect x="14" y="4.5" width="4" height="15" rx="1.2"/>',
  map: '<path d="M2.5 6.2L8.5 4l7 2.4 6-2.2v13.6l-6 2.2-7-2.4-6 2.2z" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linejoin="round"/><path d="M8.5 4v13.6M15.5 6.4V20" stroke="currentColor" stroke-width="2"/>',
  volume: '<path d="M4 9h3.5L12 5v14l-4.5-4H4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18 6a8.5 8.5 0 0 1 0 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  music: '<path d="M9 17.5V5.5l11-2v12" fill="none" stroke="currentColor" stroke-width="2.2"/><circle cx="6.5" cy="17.5" r="3"/><circle cx="17.5" cy="15.5" r="3"/>',
  globe: '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3 12h18M12 3c3 3.2 3 14.8 0 18M12 3c-3 3.2-3 14.8 0 18" fill="none" stroke="currentColor" stroke-width="1.8"/>',
  gamepad: '<path d="M6.5 7h11a4.5 4.5 0 0 1 4.3 5.8l-1.3 4.4a2.6 2.6 0 0 1-4.4 1L14 16h-4l-2.1 2.2a2.6 2.6 0 0 1-4.4-1l-1.3-4.4A4.5 4.5 0 0 1 6.5 7z"/><path d="M7.5 10v4M5.5 12h4" stroke="rgba(0,0,0,.5)" stroke-width="1.8"/><circle cx="16.5" cy="10.5" r="1.1" fill="rgba(0,0,0,.5)"/><circle cx="18" cy="13" r="1.1" fill="rgba(0,0,0,.5)"/>',
  keyboard: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M5.5 9.5h1.5M9 9.5h1.5M12.5 9.5H14M16 9.5h2.5M5.5 12.5H7M9 12.5h6M17 12.5h1.5M7 15h10" stroke="rgba(0,0,0,.55)" stroke-width="1.6" stroke-linecap="round"/>',
  hand: '<path d="M9 11V4.5a1.5 1.5 0 0 1 3 0V10m0-1.5a1.5 1.5 0 0 1 3 0V11m0-1a1.5 1.5 0 0 1 3 0v5a6 6 0 0 1-6 6h-.6a6 6 0 0 1-4.6-2.2l-3-3.7a1.5 1.5 0 0 1 2.2-2L9 15V11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  wave: '<path d="M2 15c2.5 0 2.5-2.5 5-2.5s2.5 2.5 5 2.5 2.5-2.5 5-2.5 2.5 2.5 5 2.5M2 19.5c2.5 0 2.5-2.5 5-2.5s2.5 2.5 5 2.5 2.5-2.5 5-2.5 2.5 2.5 5 2.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><path d="M12 3l4 6H8z"/>',
  scissors: '<circle cx="6" cy="6.5" r="3" fill="none" stroke="currentColor" stroke-width="2.2"/><circle cx="6" cy="17.5" r="3" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M8.5 8.2L20 18M8.5 15.8L20 6" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>',
  skull: '<path d="M12 3a8 8 0 0 0-8 8c0 2.6 1.3 4.4 3 5.5V20a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-3.5c1.7-1.1 3-2.9 3-5.5a8 8 0 0 0-8-8z"/><circle cx="8.8" cy="11.5" r="2" fill="rgba(0,0,0,.6)"/><circle cx="15.2" cy="11.5" r="2" fill="rgba(0,0,0,.6)"/>',
  sun: '<circle cx="12" cy="12" r="4.5"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  bolt: '<path d="M13.5 2L4.5 13.5H11L9.8 22l9.7-12H13z"/>',
  back: '<path d="M15 4.5L7.5 12l7.5 7.5" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>',
  chevronRight: '<path d="M9 4.5l7.5 7.5L9 19.5" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>',
  arrow: '<path d="M12 2l7.5 19L12 16.5 4.5 21z"/>',
  star: '<path d="M12 2.5l2.9 6 6.6.8-4.9 4.6 1.3 6.6L12 17.3l-5.9 3.2 1.3-6.6-4.9-4.6 6.6-.8z"/>',
  heart: '<path d="M12 20.5s-8.5-5-8.5-11A4.8 4.8 0 0 1 12 6.7a4.8 4.8 0 0 1 8.5 2.8c0 6-8.5 11-8.5 11z"/>',
  revive: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round"/><path d="M20.5 3.5v5.5H15z"/>',
  streams: '<path d="M5 3c0 4 4 5 4 9s-4 5-4 9M12 3c0 4 4 5 4 9s-4 5-4 9M19 3c0 4-3 5-3 9" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>',
  flag: '<path d="M5 21V4" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/><path d="M6 4h12l-2.5 4L18 12H6z"/>',
  clock: '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M12 7v5.5l3.5 2" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>',
  mountain: '<path d="M2 20l7-12 4 6 2.5-3.5L22 20z"/>',
  plus: '<path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="3.2" stroke-linecap="round"/>',
  info: '<circle cx="12" cy="12" r="9.5"/><path d="M12 10.5v6.5" stroke="rgba(0,0,0,.6)" stroke-width="2.4" stroke-linecap="round"/><circle cx="12" cy="7.3" r="1.4" fill="rgba(0,0,0,.6)"/>',
  pin: '<path d="M12 2a7 7 0 0 0-7 7c0 5 7 13 7 13s7-8 7-13a7 7 0 0 0-7-7z"/><circle cx="12" cy="9" r="2.6" fill="rgba(0,0,0,.45)"/>',
  compass: '<circle cx="12" cy="12" r="9.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 4.5l2.6 7.5h-5.2z"/><path d="M12 19.5l-2.6-7.5h5.2z" opacity=".45"/>',
};

export function icon(name, cls = '') {
  return `<svg class="ic ${cls}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${P[name] ?? ''}</svg>`;
}

/** The "Gota" coin: a gold disc with a water drop. Uses gradients from the shared sprite. */
export function coin(cls = '') {
  return `<svg class="coin ${cls}" viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="12" cy="12" r="11" fill="url(#rr-coin-rim)"/>
    <circle cx="12" cy="12" r="8.6" fill="url(#rr-coin-face)"/>
    <path d="M12 5.4c2 3 4.4 5.6 4.4 8.4a4.4 4.4 0 0 1-8.8 0c0-2.8 2.4-5.4 4.4-8.4z" fill="url(#rr-coin-drop)" stroke="#0a5a7a" stroke-width=".8"/>
    <path d="M10.2 13.6a2 2 0 0 0 1.6 2.6" fill="none" stroke="#fff" stroke-width="1.2" stroke-linecap="round"/>
  </svg>`;
}

/** Litre drop used next to volume counters (HUD). */
export function dropIcon(cls = '') {
  return `<svg class="dropi ${cls}" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M12 1.8c.4 0 .7.2.9.5 2.9 4.3 6.3 8.2 6.3 12.3a7.2 7.2 0 0 1-14.4 0c0-4.1 3.4-8 6.3-12.3.2-.3.5-.5.9-.5z" fill="url(#rr-drop)"/>
    <path d="M8.9 14a3.4 3.4 0 0 0 2.8 4.4" fill="none" stroke="#fff" stroke-width="1.9" stroke-linecap="round" opacity=".9"/>
  </svg>`;
}

export const SPRITE = `<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>
  <linearGradient id="rr-coin-rim" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff2a8"/><stop offset=".5" stop-color="#ffc21a"/><stop offset="1" stop-color="#c77700"/></linearGradient>
  <linearGradient id="rr-coin-face" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffd84a"/><stop offset="1" stop-color="#f29a00"/></linearGradient>
  <linearGradient id="rr-coin-drop" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#9ff4ff"/><stop offset="1" stop-color="#1fa6d6"/></linearGradient>
  <linearGradient id="rr-drop" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8ef0ff"/><stop offset="1" stop-color="#1b9fd8"/></linearGradient>
</defs></svg>`;
