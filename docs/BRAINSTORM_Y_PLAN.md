# RÍO ROYALE — Brainstorming y planificación

> Concepto (del vídeo de referencia): *battle royale* donde **cada jugador es un río**.
> Caes del cielo como una gota gigante, aterrizas en la montaña y fluyes cuesta abajo.
> **Objetivo: ser el primero en llegar al mar.** Creces absorbiendo lagos, charcos y
> cualquier agua quieta. Si eres más grande que otro río puedes **cortarle el paso**.

---

## 1. Inventario completo del vídeo (fotograma a fotograma)

| # | t (s) | Lo que se ve | Elemento de juego |
|---|-------|--------------|-------------------|
| 1 | 0–1.5 | Vista aérea de montañas rocosas, varios ríos de colores con **etiquetas de nombre** (`riverboi`, `torrent99`, `LaCascade`, `Wasserfall`, `xX_Delta_Xx`, `drip.exe`, `ruisseau`, `rio_loco`). Texto: **“EVERY STREAM IS A PLAYER”** | Rivales con nombre visibles sobre cada río; cámara aérea |
| 2 | 1.5–3 | **Arco de roca** en la cima; una **gota/burbuja de agua gigante** cae del cielo a través del arco. Texto: **“THE GOAL? BE THE FIRST TO THE SEA”** | Fase de caída (drop) desde el cielo; hito: arco de roca |
| 3 | 3–5 | La masa de agua **impacta** contra la roca y se convierte en una ola/torrente espumoso con rayas de espuma blanca | Impacto con salpicadura → transición a río |
| 4 | 5–8 | **Mapa de la isla** (estilo Córcega) con el mar alrededor y las **rutas de cada río en colores** (rosa, morado, amarillo, cian…) | Mapa/minimapa con rutas de todos los jugadores |
| 5 | 8–10 | Río serpenteando entre valles rocosos y verdes. Texto: **“PLAN YOUR ROUTE WELL OR RIVALS CUT YOU OFF”** | Elección de ruta; los rivales bloquean |
| 6 | 10–13 | El río se acerca a un **lago** y se lo traga. Texto: **“SWALLOW LAKES TO GROW STRONGER”** | Absorber lagos → crecer |
| 7 | 13–16 | **Cámara en tercera persona** pegada al agua, a toda velocidad por un **bosque** (pinos oscuros, follaje **rojo otoñal**), espuma, motion blur. HUD: **“18.22 KM TO SEA”** y **“💧 2,445,012 L”** que sube | Cámara de persecución, HUD de distancia y litros |
| 8 | 16–18 | Vista cenital de la costa (rocas anaranjadas, mar turquesa), **onda expansiva** blanca, aves. Texto gigante amarillo **“#1”** | Llegada al mar = victoria #1 con onda expansiva |
| 9 | 18–20 | Montañas y lago al atardecer con **fuegos artificiales** | Celebración de victoria |

Descripción del post: *“A simple idea: battle royale but you're a stream of water and the goal is to be the first to the sea. Get stronger by absorbing lakes, puddles, any still water. If you're bigger than another stream you can block him off.”*

## 2. Lista de funcionalidades (backlog ordenado)

**Núcleo del bucle de juego**
1. Isla procedural grande con montañas, valles, costa y mar (hidrología real: el agua baja por los valles).
2. Fase **DROP**: empiezas muy arriba, caes como una gota gigante; puedes dirigir la caída (como el salto del autobús de Fortnite) y **absorber nubes/gotas** en el aire para llegar con más volumen.
3. **Impacto** con salpicadura masiva y transición a río.
4. Fase **STREAM**: el agua fluye cuesta abajo sola; el jugador dirige izquierda/derecha y puede hacer *surge* (acelerón que gasta agua). Cuesta arriba frena; la pendiente da velocidad.
5. **Absorber** lagos y charcos (el lago se vacía con remolino y tu contador de litros sube).
6. **Rivales IA** (15) con nombres, colores y estrategia (buscan lagos, evitan a los grandes, intentan cortar).
7. **Bloqueo/corte**: si chocas con el cauce de un río más grande, te bloquea y quedas eliminado (te absorbe). Si eres más grande, atraviesas y le robas agua.
8. **Llegada al mar** = puesto (#1, #2…). Onda expansiva, “#1”, fuegos artificiales.
9. Eliminación → pantalla de puesto + quién te cortó + reintentar.

**Cámara y presentación**
10. Cámara de lobby (órbita cinemática de la isla), cámara de caída, cámara de persecución dinámica (FOV con velocidad, temblor en rápidos), cinemáticas de impacto y victoria.
11. HUD: km al mar, litros, ríos vivos, puesto, minimapa con rutas de colores, *kill feed*, avisos grandes centrados (“SWALLOW LAKES TO GROW STRONGER”).
12. Etiquetas de nombre sobre cada río rival.

**Mundo y gráficos (nivel AAA estilizado tipo Fortnite)**
13. Terreno: hierba, roca, acantilados, nieve, arena, triplanar, normales de detalle, variación de color.
14. Agua: océano estilizado (degradado de profundidad, espuma de costa, olas, destellos), lagos, río con flujo, espuma, cascadas en pendientes.
15. Vegetación instanciada: pinos, árboles otoñales rojos, hierba con viento, rocas, flores.
16. Cielo estilizado con nubes, sol, sombras en cascada, iluminación ambiental, niebla atmosférica.
17. Postprocesado: AO, bloom, antialiasing, gradación de color, viñeta, líneas de velocidad.
18. Partículas: espuma, spray, salpicaduras, gotas, aves, fuegos artificiales.
19. Hito: arco de roca en la cumbre.

**Audio**
20. Viento en caída, rugido del agua según velocidad/volumen, salpicaduras, “gulp” al absorber, música/fanfarria de victoria, UI.

**Monetización y retención (pensado desde el día 1)**
21. Moneda blanda (“Gotas”) por partida según puesto y volumen.
22. Tienda de **skins de agua** (Cristal, Tropical, Glaciar, Oro, Tóxica, Magma, Galaxia) y estelas.
23. Capa de anuncios abstraída (`Ads`): *rewarded* (x2 recompensas, revivir) e intersticial entre partidas, con adaptadores para Poki / CrazyGames / AdSense for Games (stubs, sin cargar SDKs por defecto).
24. Recompensa diaria, estadísticas, mejores puestos (localStorage).
25. Hooks de analítica (inicio/fin de partida, compras, anuncios).
26. Ajustes de calidad (Bajo/Medio/Alto/Ultra con autodetección), controles táctiles y móvil en vertical.

**Fuera de alcance por ahora**: multijugador en red (la arquitectura separa `Stream` de su controlador para poder añadir un `NetworkController` más adelante).

## 3. Brainstorming

**¿Qué hace que esto se vea “Fortnite”?**
- Formas estilizadas pero con **materiales ricos**: colores saturados, transiciones suaves, roca con planos marcados, hierba muy verde con variación cálida/fría.
- **Iluminación cálida de sol bajo** + cielo azul intenso + sombras suaves azuladas + AO marcado en grietas.
- **Agua turquesa** muy saturada con espuma blanca nítida (exactamente lo que muestra el vídeo).
- Mucha **densidad** de detalle: árboles, rocas, hierba, partículas; nada vacío.
- **Profundidad atmosférica**: niebla azulada en la distancia, montañas que se difuminan.
- *Game feel*: cámara viva, FOV dinámico, temblor, *juice* en cada absorción (números flotantes, partículas, sonido).

**Ideas de diseño**
- La gota en caída deja estela; atravesar nubes = +litros (recompensa por elegir trayectoria).
- El ancho del río y su rugido escalan con √volumen → sentirse “grande” es la fantasía central.
- Los lagos se vacían visiblemente (nivel baja + remolino) → feedback claro.
- Cascadas automáticas en pendientes > 45° con niebla de spray.
- *Surge* (barra espaciadora / doble toque): acelerón que cuesta un 5% del volumen → decisión de riesgo.
- Rivales con personalidad: “Glotón” (busca lagos), “Velocista” (ruta más directa), “Matón” (persigue más pequeños).
- Revivir con anuncio *rewarded* al ser eliminado (una vez por partida) → monetización no intrusiva.

**Riesgos técnicos y respuestas**
- *Rendimiento en navegador/móvil* → terreno GPU por anillos (clipmap) + instancing por chunks + presets de calidad.
- *Determinismo para capturas/revisión* → simulación de paso fijo + modo `?capture=1` con avance manual.
- *Coherencia visual entre sistemas* → un único módulo de atmósfera (niebla/sol) compartido por todos los shaders.

## 4. Planificación

**Stack**: Three.js r186 (WebGL2) · `postprocessing` (pmndrs) · N8AO · Vite. Sin assets externos: texturas y geometría procedurales (cero licencias, carga rápida).

**Arquitectura** (`src/`):
```
core/      Engine (bucle, ctx, paso fijo), EventBus, Quality, random/noise, debug (?scene=…)
render/    Atmosphere (cielo, sol, sombras, entorno, niebla), shaderChunks, PostFX
world/     World, terrain/ (generación + render), water/ (océano, lagos, ríos), props/ (vegetación, hitos)
game/      Game (máquina de estados), Stream (entidad), StreamPhysics, PlayerController,
           AIController, Rules (absorber/cortar/llegar), CameraDirector, Scenarios (capturas)
ui/        UI DOM (menús, HUD, minimapa, tienda), ui.css
audio/     Audio procedural WebAudio
services/  Storage, Economy, Ads, Analytics
tools/     capture.mjs (capturas automáticas con Playwright para revisión visual)
```

**Contrato compartido** (`ctx`): `renderer, scene, camera, bus, quality, params, terrain, world, game, atmosphere, postfx, ui, audio, services`.
Eventos: `phase`, `landed`, `absorb`, `cut`, `eliminated`, `finished`, `splash`.

**Fases de ejecución**
1. **Esqueleto** jugable de principio a fin con gráficos simples (contratos fijados).
2. **Subagentes en paralelo** (cada uno dueño de sus archivos, en worktrees aislados):
   Terreno · Agua · Cielo/Luz/Post · Vegetación/Hitos · Jugabilidad/IA/Cámara · UI/Monetización · Audio.
3. **Integración** y build.
4. **Bucle de revisión visual**: un subagente juez por cada elemento del bucle (menú, caída,
   impacto, río, lago, rival, bosque, mar/victoria, HUD/mapa). Comparación **a ciegas A/B** contra
   los fotogramas del vídeo de referencia + rúbrica estricta contra el estándar de Fortnite.
   Lo que no llegue a AAA vuelve a los subagentes dueños → nueva ronda.
5. Despliegue estático (`dist/`) listo para itch.io / Poki / CrazyGames.

**Métricas de “hecho”**: 60 fps en escritorio medio y ≥30 fps en móvil reciente (preset Medio),
carga < 5 s, partida de 3–5 min, cada elemento del bucle gana la comparación ciega.
