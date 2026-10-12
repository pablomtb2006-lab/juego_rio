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
| **B** | **Rutas libres y bifurcaciones** | Giro amplio y cruce de collados · bifurcaciones señalizadas (corta/larga/obstáculos) · aviso en el HUD |
| **C** | **Peligros aleatorios** | Lava, géiseres, arenas, grietas, sol, viento, hielo, vapor… colocados al azar cada partida |
| **D** | **Catástrofe anunciada** | Un evento por carrera con cuenta atrás y aviso: avalancha, tormenta de polvo, ola de calor, diluvio… |
| **E** | **Habilidades ofensivas** | Muro, sanguijuela, sequía, niebla… con recarga, desbloqueadas por nivel; la IA también las usa |
| **F** | **Crecimiento visible** | La estela y la ola crecen de verdad con los litros; hitos visuales al crecer |
| **G** | **Variantes del mapa** | Hielo / lava / selva / tormenta sobre la misma geometría |
| **H** | **Progresión y cosméticos** | Nivel con puntos · sombreros, caras, estelas · retos diarios y semanales · racha, clasificación, mejor tiempo · botón de venganza |

---

## 3. Estado

| Tramo | Estado |
|---|---|
| A — Dificultad y tormenta | **hecho** |
| B — Rutas y bifurcaciones | pendiente |
| C — Peligros aleatorios | pendiente |
| D — Catástrofe anunciada | pendiente |
| E — Habilidades | pendiente |
| F — Crecimiento visible | pendiente |
| G — Variantes del mapa | pendiente |
| H — Progresión y cosméticos | pendiente |
