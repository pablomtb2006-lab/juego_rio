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
| `leap` / `leapLanded` | `{ stream }` / `{ stream, impact }` — salto (E / J / botón SALTO) |
| `damBreak` | `{ dam, stream, bonus }` — presa rota (game/Obstacles.js) |
| `damBlocked` | `{ dam, stream }` — un río pequeño choca con una presa |
| `droughtStart` / `droughtWarn` / `droughtSweep` | `{}` / `{ victim, seconds }` / `{ victim }` — la sequía (game/Drought.js) |
| `hazardHit` | `{ stream, hazard, kind }` — peligro del terreno (game/Hazards.js) |
| `catWarn` / `catStart` / `catEnd` | `{ kind, seconds }` / `{ kind }` / `{ kind }` — la catástrofe anunciada (game/Catastrophe.js) |

**Zonas de salida** (`game.startZones`, `game.dropZone`): `{ x, z, y, radius, dir: Vector2, isArch }`.
Se calculan una vez sobre las cumbres de la isla y se sortea una por partida, así que cada carrera
baja por una ladera distinta. `game.archMatch` dice si esta partida cae por el arco (plano de intro,
objetivo del arco). Todo el que lea la zona de caída debe leer `game.dropZone`, nunca el arco.

**Catástrofe** (`game/Catastrophe.js`): una por carrera, anunciada antes de caer.
`catastrophe.phase ('idle'|'warn'|'active'|'done'), .kind, .def, .timeLeft, .k (0..1), .front`,
`check(stream, dt)` lo llama `Rules` justo después de los peligros y escribe `s.catEvap`.
El frente de lava es una recta perpendicular a `game.raceDir` que avanza: `frontGap(s)` da los
metros que le sacas. `world/props/HazardField.js` lo dibuja con los instances que sobran.

**Habilidades** (`game/Abilities.js`): `ABILITIES` (muro, succión, vapor), `abilities.cast(s, id, T?)`,
`abilities.state(s, id)` para el HUD, `abilities.check(s, dt)` (los muros bloquean como presas, lo llama
`Rules`), `abilities.walls[]`, `abilities.marks[]` (runa de aviso = tipo 8, mira = tipo 9, las pinta
`HazardField` sin test de profundidad), `abilities.lock` (el rival al que apunta el jugador).
Campos del río: `abil{wall,leech,fog}`, `leechT/leechTarget`, `leechedT`, `fogT`, `abilityCoolMul`.
Entrada: Q/R/F, botones del HUD, mando (X, LB, RB) → `input.ability` → `s.input.ability`.
Eventos: `ability`, `abilityDenied`, `wallBreak`, `wallBlocked`, `leechEnd`.
Render: `world/props/AbilityFx.js` (pilares, hilo, vapor). URL `?abilities=all` desbloquea las tres.

**Bioma** (`game/biomes.js`): `game.biome` (sorteado en `startMatch` antes que nada) y
`game.nextBiome` (el de la siguiente partida, para el lobby). Cambia hora del día, tinte del suelo
y del cielo, nieve, brasas, velo, pesos de peligros, agarre, evaporación y caudal. Todo material que
quiera seguir el bioma hace spread de `BIOME_UNIFORMS` e incluye `BIOME_GRADE_GLSL`, y termina con
`applyBiome(col, snowMask, emberMask)`. Nada fuera de ese archivo decide "esta partida se ve
distinta".

**Dificultad** (`game/difficulty.js`): además de la rampa de las primeras partidas, `playerShield`
y `playerEvap` son los dos mandos invisibles que mantienen la victoria del jugador en el 30-40%.
Nada fuera de ese archivo debe decidir "esto es más fácil porque es el jugador".

**Progresión**: `game/upgrades.js` (`UPGRADES`, `applyUpgrades`) + `economy.upgrades`, `economy.buyUpgrade(id)`;
pantalla `ui/screens/Upgrades.js`. Las mejoras solo se aplican al jugador.

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
