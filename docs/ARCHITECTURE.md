# Arquitectura y contratos — Río Royale

Este documento es el **contrato** entre módulos. Cada subagente es dueño de unos archivos
concretos y puede reescribir sus *internals* libremente, pero **no puede romper** las
firmas/campos descritos aquí sin coordinarlo.

## Arranque y bucle

`src/main.js` → `Engine.init()` crea `ctx` y los subsistemas en este orden:
`services → atmosphere → terrain (TerrainData) → world → audio → game → ui → postfx`.

- Simulación de **paso fijo** (`FIXED_DT = 1/60`): `game.fixedUpdate(dt)`.
- Visual por frame: `game.update → world.update → atmosphere.update → ui.update → audio.update → postfx.render`.
- `?capture=1` desactiva el bucle en tiempo real; `window.__engine.step(n)` avanza y renderiza.
- `?scene=<nombre>` ejecuta un escenario de `src/game/Scenarios.js` y marca `window.__READY`.

### `ctx`
| Campo | Tipo / dueño |
|---|---|
| `renderer, scene, camera` | THREE (Engine) |
| `bus` | EventBus |
| `quality` | preset de `core/Quality.js` |
| `params` | `core/debug.js` |
| `atmosphere` | `render/Atmosphere.js` |
| `terrain` | `world/terrain/TerrainData.js` |
| `world` | `world/World.js` → `terrainRenderer, ocean, lakes, skyWater, vegetation, landmarks, streams` |
| `game` | `game/Game.js` |
| `ui`, `audio`, `services`, `postfx` | |

## Contratos clave

**TerrainData** (metros, nivel del mar y=0): `size, res, cell, seaLevel, maxHeight, heights, flow, seaDist,
heightAt(x,z), normalAt(x,z,out), gradientAt(x,z,out), distToSea(x,z), flowAt(x,z), isLand(x,z),
lakeSites[], puddleSites[], peaks[], heightTexture`.

**Stream** (`game/Stream.js`): `id, name, color, skin, isPlayer, personality, phase ('drop'|'flow'|'finished'|'eliminated'),
pos, vel, heading (Vector2), volume (L), peakVolume, radius (getter, m), speed, trail {data:[x,y,z,w…], count, version},
distToSea, place, eliminatedBy, absorbing (L/s), surging, landedAt, finishedAt, input {steer, move, surge}`.

**Cuerpos de agua absorbibles** (`world.lakes.bodies`, `world.skyWater.bodies`):
`{ id, kind: 'lake'|'puddle'|'cloud', x, y, z, radius, volume, maxVolume }` + `holder.drain(body, litres)` + `reset()`.

**Atmósfera compartida**: todo `ShaderMaterial` propio incluye `ATMOSPHERE_PARS_GLSL`, hace spread de
`ctx.atmosphere.uniforms` y termina con `applyAtmosphere(color, worldPos)`. Los `MeshStandardMaterial`
usan `scene.fog` (el dueño de render puede parchear `THREE.ShaderChunk.fog_*` para igualarlos).

**Eventos del bus**
| Evento | Payload |
|---|---|
| `phase` | `{ state: 'menu'|'drop'|'stream'|'result' }` |
| `landed` | `{ stream }` |
| `splash` | `{ x, y, z, size, stream }` |
| `absorb` | `{ stream, body, amount }` (cada tick mientras absorbe) |
| `cut` | `{ attacker, victim, amount }` |
| `eliminated` | `{ victim, by, reason: 'blocked'|'swallowed'|'dried' }` |
| `finished` | `{ stream, place }` |
| `matchEnd` | `{ outcome: 'win'|'eliminated', place, player }` |

**Servicios**: `storage.get/set`, `economy {coins, owned, equippedSkin, rewardFor, grant, buy, equip, recordMatch}`,
`ads {showRewarded, showInterstitial, gameplayStart, gameplayStop}`, `analytics.track`.

**Skins**: `game/skins.js` (`SKINS`, `RIVAL_COLORS`, `getSkin`) — compartido por tienda y render del agua.

## Propiedad de archivos (subagentes)
| Área | Archivos |
|---|---|
| Terreno | `src/world/terrain/**` |
| Agua | `src/world/water/**` |
| Cielo, luz, post | `src/render/**`, `src/core/Quality.js` |
| Vegetación e hitos | `src/world/props/**` |
| Jugabilidad, IA, cámara | `src/game/**` (excepto `skins.js`) |
| UI y monetización | `src/ui/**`, `src/services/**`, `src/game/skins.js`, `index.html`, `src/main.js` |
| Audio | `src/audio/**` |
| Integración (orquestador) | `src/core/Engine.js`, `src/world/World.js`, `docs/**`, `tools/**`, `package.json` |

## Dirección de arte (la biblia visual — todos convergen aquí)

Objetivo: **estilizado AAA tipo Fortnite (Capítulo 4/5, Unreal 5)** — formas legibles y amables, materiales ricos,
luz cálida, color saturado pero no chillón, mucha densidad de detalle.

- **Sol**: cálido `#FFE9C9`, elevación 35–45°, sombras nítidas con penumbra suave; sombras teñidas de azul (`#5A6FA8`).
- **Cielo**: cénit `#3E8EDE` → horizonte `#BFE3FF`; cúmulos grandes con cimas brillantes y bases lavanda/azuladas.
- **Hierba**: `#5DBB3A`–`#8CCB3F`, variación cálida/fría a gran escala; hierba seca `#B9B45A` en altura.
- **Roca**: taupe cálido `#8E8174`, planos facetados marcados, oscurecimiento en cavidades; rocas costeras
  anaranjadas `#D07A4A` (como en la referencia).
- **Nieve** `#F4F8FF` con sombras azules · **Arena** `#E8D3A0`.
- **Agua**: somera `#35D0D6` → profunda `#0B6E8A`; espuma blanca pura de bordes nítidos; océano profundo
  `#0A5C8F`, costa `#3FD9E0`.
- **Bosque**: pinos oscuros `#1F4A2E` + árboles otoñales rojo/naranja `#C8432B` / `#E0762F` (referencia).
- **Post**: AgX/ACES, saturación +10%, bloom sutil en espuma/brillos, viñeta suave.
- **UI**: fuente Luckiest Guy, blanco con sombra oscura, resaltado amarillo `#FFD23F` (como los textos del tráiler).

## Rendimiento
Presupuesto por preset en `core/Quality.js`. Objetivo: 60 fps escritorio (High), ≥30 fps móvil (Medium/Low).
Nada de assets externos en runtime: todo procedural o empaquetado por Vite.

## Revisión visual
`npm run capture -- --scenes=stream,lake --size=portrait` → `captures/*.png`.
Escenarios: `menu, drop, arch, landing, stream, lake, rival, forest, sea, map`.
