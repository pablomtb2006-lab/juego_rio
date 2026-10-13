# Río Royale — Retos, rutas y progresión visual

Continuación de `docs/PLAN_EXITO.md`. Aquí está la lluvia de ideas y el plan de las
funciones nuevas: que **ganar sea difícil**, que **el mapa deje de ser un pasillo** y que
**cada partida deje algo que desbloquear**.

---

## 1. Lluvia de ideas

### Problema 1 — «Es muy fácil ganar»
Hoy no hay presión de tiempo ni nadie te ataca de verdad. Ideas:
- **Tormenta / sequía que avanza**: cada X segundos se elimina al último de la clasificación.
  Convierte la carrera en contrarreloj y obliga a arriesgar.
- Rivales que **te eligen a ti** como objetivo cuando vas primero (el líder lleva una diana).
- Rivales que **usan habilidades** contra ti, no solo contra el que tienen cerca.
- Subir la pericia base de la IA y quitarle la ayuda que hoy le damos al jugador.
- **Castigo por ir primero**: el líder evapora un poco más rápido.
- Rivales que se **alían** contra el líder.
- Que el mar tenga una **puerta que se cierra**: solo los N primeros puntúan.

### Problema 2 — «La gota siempre va por el mismo sitio»
El río sigue la línea del valle y el giro solo la desvía 66°. Ideas:
- Ampliar el giro y permitir **cruzar collados** entre valles con impulso.
- **Bifurcaciones señalizadas**: un portal con dos puertas y su cartel.
  - **CORTA · PELIGROSA**: menos distancia, lava, pasillos estrechos, más presas.
  - **LARGA · SEGURA**: más distancia, casi sin peligros, más lagos.
  - **OBSTÁCULOS**: distancia media, llena de trampas, premia la habilidad.
- **Atajos ocultos** que solo se cruzan con salto o con mucho volumen.
- Mapa con **nodos**: la ruta se decide en 3–4 bifurcaciones por carrera.

### Problema 3 — Obstáculos que cambian cada partida
Todos deben **secar, evaporar o frenar** el agua. Lluvia de ideas:
- **Lava** a los lados de un pasillo estrecho: tocarla evapora agua a chorro.
- **Géiseres** que estallan por ciclos y evaporan al que pase encima.
- **Arenas secas / dunas**: el suelo absorbe tu agua mientras lo cruzas.
- **Grietas / sumideros**: se tragan un porcentaje si pasas por encima.
- **Zona de sol abrasador**: evaporación x3 mientras estás dentro.
- **Viento seco**: te empuja de lado y evapora.
- **Rocas / escombros**: frenan como una presa pequeña.
- **Hielo**: no evapora pero te hace resbalar (giro reducido).
- **Esponjas / musgo**: frena y chupa poco a poco.
- **Vapor**: no quita agua pero tapa la visión.
- **Red de troncos**: frena fuerte, se rompe con volumen.
- **Remolino de arena**: te desvía de la ruta.

### Problema 4 — Habilidades para fastidiar
Desbloqueables con los puntos de jugar. Ideas:
- **Muro de roca**: planta una barrera delante del rival más cercano.
- **Dique**: barrera ancha que tapa un valle entero unos segundos.
- **Sanguijuela**: robas litros al rival más cercano durante unos segundos.
- **Sequía**: marcas a un rival y evapora al triple un rato.
- **Niebla**: le tapas la vista al rival (si es el jugador, pantalla con vapor).
- **Imán**: atraes los lagos cercanos hacia ti.
- **Espejismo**: una bifurcación falsa que desvía a quien la siga.
- **Escudo**: te protege de un corte.
- **Turbo helado**: congelas tu estela para que nadie la cruce.

### Problema 5 — Catástrofe anunciada (tensión)
Una por carrera, avisada 10 s antes con cuenta atrás y aviso en pantalla:
- **Avalancha de lava**: baja por un valle concreto; hay que no estar allí.
- **Tormenta de polvo**: visión borrosa y evaporación alta un rato.
- **Terremoto**: cambia la física (menos agarre, se abren grietas).
- **Diluvio**: todos ganan agua, pero se desbordan los lagos y cambian las rutas.
- **Ola de calor**: evaporación x2 para todos.
- **Granizo**: frena a todo el mundo y rompe presas.
- **Eclipse**: se oscurece y los rivales no te ven (puedes cortar sin que te esquiven).

### Problema 6 — Progresión visual que enganche
Todo cosmético, nunca ventaja. Ideas:
- **Sombreros / accesorios**: gafas de sol, corona, sombrero de copa, casco, flotador, aletas.
- **Caras**: enfadada, feliz, dormida, gafas de sol, loca, corazones.
- **Materiales**: hielo, fuego, galaxia, oro, lava, tóxico, arcoíris.
- **Estelas**: burbujas, estrellas, pétalos, chispas, humo, notas musicales.
- **Desbloqueo**: por nivel, por retos, por racha, por rareza al ganar. Nunca solo por ganar.
- **Escaparate**: pantalla de "siguiente desbloqueo" con barra de progreso.

### Problema 7 — Variedad y vuelta al día siguiente
- **Variantes del mismo mapa**: hielo, lava, selva, tormenta. Misma geometría, otros
  materiales, otra luz, otros obstáculos y otra física.
- **Retos diarios** (3) y **semanales** (3 grandes, más recompensa).
- **Racha de victorias**, **clasificación local**, **mejor tiempo**.
- **Botón de venganza**: repetir la misma semilla y los mismos rivales al perder.

---

## 2. Plan por tramos

Orden por dependencia e impacto. Cada tramo se termina, se prueba y se sube antes del siguiente.

| # | Tramo | Contenido |
|---|---|---|
| **A** | **Que ganar sea difícil** ✅ | LA SEQUÍA: contrarreloj que seca al último cada 17 s (bajando a 8,5 s) · IA más dura que ataca al líder · el primero evapora un 45% más |
| **B** | **Rutas libres y bifurcaciones** ✅ | Giro de 89° que suelta el agarre del valle · cruce de collados con impulso · 4 bifurcaciones señalizadas por mapa con puertas de colores y aviso en el HUD |
| **C** | **Peligros aleatorios** ✅ | 260 peligros por partida (lava, géiseres, arena seca, sumideros, calor, hielo, rocas, vapor) colocados sobre las rutas reales del agua y amontonados en los ramales cortos · zona de caída centrada en el arco para que todos se crucen |
| **D** | **Catástrofe anunciada** ✅ | Un evento por carrera, anunciado con 9-13 s de cuenta atrás: avalancha de lava (frente que barre la montaña por detrás), tormenta de polvo, terremoto (rompe todas las presas), diluvio, ola de calor, granizada, eclipse. No todos castigan: el diluvio y el eclipse son los que permiten remontar |
| **E** | **Habilidades ofensivas** ✅ | Muro (Q), Succión (R) y Vapor (F), con recarga y coste en litros, desbloqueadas por nivel (1/2/3); la IA las usa con las mismas reglas · runa de aviso, mira de objetivo, pilares de roca, hilo de succión y vapor · mejora «Tácticas» · objetivo de partida |
| **F** | **Crecimiento visible** | La estela y la ola crecen de verdad con los litros; hitos visuales al crecer |
| **G** | **Variantes del mapa** ✅ | 6 mundos sobre la misma geometría (Valle Templado, Alba Dorada, Valle Helado, La Caldera, Selva Crecida, La Tormenta): cambian hora del día, cielo, niebla, color del suelo y la vegetación, nieve, brasas, qué trampas crecen, el agarre, la evaporación y el caudal de los valles · el lobby anuncia el próximo mundo y tu récord en él |
| **H** | **Progresión y cosméticos** | Nivel con puntos · sombreros, caras, estelas · retos diarios y semanales · racha, clasificación, mejor tiempo · botón de venganza |

---

## 2.bis Equilibrio: ganar un 30-40%

El objetivo no es que sea fácil, es que sea **difícil y aun así ganable**. Tres mandos invisibles
en `src/game/difficulty.js` lo consiguen sin tocar nada de lo que el jugador ve en pantalla, y sin
suavizar un ápice lo que los rivales se hacen entre ellos:

- `playerShield` — un rival necesita ser 1,8× más grande de lo normal para cortar **al jugador**
  (entre ellos se cortan con el margen de siempre, 1,3×).
- `playerEvap` — el jugador se evapora un 25% más despacio.
- `playerHazard` — las trampas del terreno le muerden un 25% menos.
- `protectBonus` — 3 s extra de protección al aterrizar, siempre. Que te corten en el 00:50 con los
  litros con los que empezaste es la única derrota de la que nadie vuelve.

Los tres bajan con las partidas jugadas, así que el techo sube con el jugador.

Y el problema de fondo: **el campo se aniquilaba antes de que nadie llegara al mar**. 16 ríos en vez
de 24, la sequía arranca en el segundo 82 (antes 55), la evaporación sube más despacio con el reloj,
los peligros bajan de 260 a 210 y pegan ~40% menos, y sobre todo `inflowFrom` baja de 0,35 a 0,22:
un río que se sale del valle principal ya puede alimentarse en vez de secarse sin remedio.

Medido con `node tools/dev/sim.mjs 20` (jugador en piloto automático, dificultad máxima y **sin
mejoras compradas**): **30% de victorias**, puesto medio 5,5 de 16, partida media 123 s. Una persona
que conduce mejor que el piloto automático y que lleva mejoras queda dentro del 30-40% pedido.

---

## 2.ter El bioma de la partida (contra la monotonía)

La geometría de la isla no se toca: encima de ella está construido todo (hidrología, rutas,
bifurcaciones, presas). Lo que cambia cada partida es **todo lo que ves y unas cuantas cosas que
sientes**, y eso basta para que no sea el mismo mapa dos veces:

| Mundo | Qué cambia al verlo | Qué cambia al jugarlo |
|---|---|---|
| 🌤️ Valle Templado | la isla de siempre | — |
| 🌅 Alba Dorada | amanecer, sombras largas, todo ámbar | mucho sol y vapor · evaporas menos |
| 🧊 Valle Helado | nieve por toda la montaña, color lavado, pinos escarchados | agarre ×0,74 (derrapas) · casi no te evaporas · hielo y vapor por todas partes |
| 🌋 La Caldera | basalto quemado, brasas en el fondo de los valles, luz de atardecer | lava y géiseres · evaporación ×1,4 |
| 🌴 Selva Crecida | verde profundo y saturado | valles ×1,18 de caudal · sumideros · húmedo |
| ⛈️ La Tormenta | sin luz, velo de lluvia, todo gris azulado | agarre ×0,88 · ríos crecidos ×1,22 |

Un solo archivo manda: `src/game/biomes.js`. Los shaders comparten `BIOME_UNIFORMS` (los mismos
objetos), así que cambiar de mundo **no recompila nada**: se escriben tres uniforms y ya.

Y el gancho: la semilla de la siguiente partida se sortea por adelantado, así que **el lobby dice
en qué mundo vas a caer antes de darle a jugar**, con tu récord en él (`SIN ESTRENAR` / `MEJOR #3` /
`GANADO ×2`). Seis mundos que conquistar.

---

## 2.cuater Habilidades (Tramo E): verbos contra los otros ríos

Hasta ahora todo lo que podías hacer era contra la isla (girar, acelerar, saltar). Estas tres son
contra los **otros ríos**, y cada una es un problema distinto para quien la recibe:

| | Qué hace | Cómo se esquiva |
|---|---|---|
| 🪨 **Muro** (Q · nivel 1) | Columnas de roca que brotan cruzando el valle **delante** del rival. Aguanta a cualquiera más pequeño que ~0,9× tú; uno más grande lo revienta | La runa roja avisa 1 s antes: gira, salta (E) por encima o sé más grande |
| 🌀 **Succión** (R · nivel 2) | Un hilo violeta que le bebe ~3,6%/s de su agua durante 4,6 s y te da el 65% | Aléjate más de 235 m, salta, o que se le acabe |
| ☁️ **Vapor** (F · nivel 3) | Una nube sobre el rival: si eres tú, te ciega; si es un bot, da bandazos y no puede acelerar | Mantener la línea a ciegas (o tener la mejora de Resistencia, que no ayuda: es puro temple) |

Cuestan litros (5/3/4%) y tienen recarga (15/21/23 s), así que **usarlas es una decisión**, no un
botón que se aporrea. La IA las usa con las mismas reglas y recargas un 45% más lentas, entre ellos
y contra ti. Para que una manada de bots no te encadene, hay un **presupuesto de presión**: como mucho
2 lanzamientos de bots contra ti cada 14 s (`PRESSURE` en `Abilities.js`).

Lo que lo hace AAA y no un menú de efectos: el aviso se pinta **encima** del agua y del follaje (si no
lo ves, no es un aviso), la **mira dorada** te dice a quién vas a dar antes de pulsar, los pilares
brotan en onda desde el centro con salpicadura y temblor de cámara, el hilo de succión es violeta
(el complementario del agua turquesa, se lee sobre río, cielo y pinos) con gotas viajando hacia ti, y
la vegetación se aparta en un **corredor por delante** de tu cabeza para que veas lo que viene.

---

## 3. Estado

| Tramo | Estado |
|---|---|
| A — Dificultad y tormenta | **hecho** |
| B — Rutas y bifurcaciones | **hecho** |
| C — Peligros aleatorios | **hecho** |
| D — Catástrofe anunciada | **hecho** |
| E — Habilidades | **hecho** |
| F — Crecimiento visible | pendiente |
| G — Variantes del mapa | **hecho** |
| H — Progresión y cosméticos | pendiente |
