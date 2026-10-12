import { hex, shade } from './util.js';

let uid = 0;

/**
 * Stylised water-drop artwork for a skin (SVG string): translucent body with the skin's
 * shallow→deep gradient, white foam swirls, specular highlight and bubbles. Animated by CSS
 * (.skinart__body wobble, .skinart__shine sweep, sparkles for epic/legendary).
 */
export function skinArt(skin, cls = '') {
  const n = ++uid;
  const deep = hex(skin.deep);
  const shallow = hex(skin.shallow);
  const light = hex(shade(skin.shallow, 0.55));
  const foam = hex(skin.foam);
  const dark = hex(shade(skin.deep, -0.35));
  const fancy = skin.rarity === 'epic' || skin.rarity === 'legendary';
  const sparkles = fancy
    ? `<g class="skinart__sparkles" fill="${foam}">
        <path d="M100 30l2.4 6 6 2.4-6 2.4-2.4 6-2.4-6-6-2.4 6-2.4z"/>
        <path d="M18 58l1.6 4 4 1.6-4 1.6-1.6 4-1.6-4-4-1.6 4-1.6z"/>
        <path d="M104 104l1.8 4.5 4.5 1.8-4.5 1.8-1.8 4.5-1.8-4.5-4.5-1.8 4.5-1.8z"/>
      </g>`
    : '';
  return `<svg class="skinart ${cls}" viewBox="0 0 120 140" aria-hidden="true">
    <defs>
      <radialGradient id="sk-b${n}" cx="38%" cy="38%" r="75%">
        <stop offset="0" stop-color="${light}"/>
        <stop offset="0.45" stop-color="${shallow}"/>
        <stop offset="1" stop-color="${deep}"/>
      </radialGradient>
      <linearGradient id="sk-s${n}" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="#fff" stop-opacity="0"/>
        <stop offset="0.5" stop-color="#fff" stop-opacity="0.55"/>
        <stop offset="1" stop-color="#fff" stop-opacity="0"/>
      </linearGradient>
      <clipPath id="sk-c${n}"><path d="M60 6C76 33 106 55 106 89a46 46 0 0 1-92 0C14 55 44 33 60 6z"/></clipPath>
    </defs>
    <ellipse class="skinart__shadow" cx="60" cy="133" rx="36" ry="5.5" fill="rgba(0,0,0,.35)"/>
    <g class="skinart__body">
      <path d="M60 6C76 33 106 55 106 89a46 46 0 0 1-92 0C14 55 44 33 60 6z" fill="url(#sk-b${n})"/>
      <g clip-path="url(#sk-c${n})">
        <path d="M8 104c14-12 26-12 38-3s24 9 36-1 22-9 34 0v40H8z" fill="${dark}" opacity=".35"/>
        <path class="skinart__foam" d="M14 96c12-10 22-11 32-3s22 8 32-1 18-8 28-2" fill="none" stroke="${foam}" stroke-width="5" stroke-linecap="round" opacity=".9"/>
        <path class="skinart__foam2" d="M24 114c10 6 20 6 30 0s20-6 30 0" fill="none" stroke="${foam}" stroke-width="3.5" stroke-linecap="round" opacity=".7"/>
        <path d="M70 46c8 6 14 14 16 24" fill="none" stroke="${foam}" stroke-width="3" stroke-linecap="round" opacity=".55"/>
        <rect class="skinart__shine" x="-60" y="0" width="40" height="140" fill="url(#sk-s${n})" transform="skewX(-18)"/>
      </g>
      <path d="M60 6C76 33 106 55 106 89a46 46 0 0 1-92 0C14 55 44 33 60 6z" fill="none" stroke="${foam}" stroke-opacity=".55" stroke-width="2.5"/>
      <ellipse cx="42" cy="66" rx="8" ry="15" fill="#fff" opacity=".6" transform="rotate(28 42 66)"/>
      <circle cx="49" cy="88" r="3.2" fill="#fff" opacity=".55"/>
      <circle class="skinart__bubble" cx="78" cy="98" r="4" fill="none" stroke="#fff" stroke-width="1.6" opacity=".7"/>
      <circle class="skinart__bubble skinart__bubble--2" cx="66" cy="112" r="2.6" fill="#fff" opacity=".5"/>
    </g>
    ${sparkles}
  </svg>`;
}
