# Río Royale — De juego terminado a juego con éxito

Documento vivo. El juego ya está completo y es jugable; esto es lo que falta para que
**funcione en una plataforma web** (Poki / CrazyGames / GameDistribution) y genere ingresos.

---

## 1. Lluvia de ideas

### ¿Qué decide el éxito de un juego en estas plataformas?
El dinero sale de `partidas × anuncios por sesión × pago por anuncio`. No controlamos el pago,
así que todo se reduce a dos cosas: **que entre gente** (la plataforma nos promociona) y
**que se quede** (retención). Todo lo de abajo ataca una de las dos.

### Por qué un jugador nuevo se va en los primeros 60 segundos
- No entiende qué hacer (no hay tutorial).
- Muere en el primer minuto sin saber por qué (rivales a tope desde la partida 1).
- Pierde y no siente que estuvo cerca → no reintenta.
- La carga tarda y ve una barra de progreso sin nada que hacer.
- Va a tirones en su móvil.

### Por qué un jugador no vuelve mañana
- No hay nada pendiente: ni misión, ni cofre, ni objetivo a medias.
- La progresión (Gotas → mejoras) es lenta y poco visible.
- Todas las partidas se sienten iguales (mismo mapa, mismas reglas).

### Ideas en bruto (sin filtrar)
**Primeros 60 s:** tutorial contextual en la caída · rivales suaves las 3 primeras partidas ·
bots con nombre de "novato" al principio · objetivo visible desde el segundo 1 ·
"casi lo consigues" en el resultado · botón OTRA VEZ gigante · saltarse el menú tras perder ·
mapa más corto en la primera partida · primera partida siempre con un lago enorme cerca.

**Volver mañana:** misión diaria · cofre tras 3 partidas · racha · nivel de cuenta con
recompensas · pase de temporada gratis · skin desbloqueable por logros · modificador del día
(lluvia / sequía / presas reforzadas) · tabla de récords local · "tu mejor marca: 2:48".

**Que lo promocionen:** miniatura espectacular · tráiler de 15 s · que cargue en < 3 s ·
60 fps en móvil · sin errores en consola · soporte táctil impecable · icono y metadatos.

**Más ingresos por jugador:** anuncio con recompensa para revivir (ya) · x2 Gotas (ya) ·
Gotas gratis cada día viendo anuncio (ya) · skins caras y vistosas · ruleta diaria ·
intersticial entre partidas con límite (ya).

**Viralidad:** compartir puesto · reto a un amigo con la misma semilla · repetición de los
últimos 5 s para clip · "has superado a 19 de 24 ríos".

**Largo plazo:** multijugador real · más mapas (volcán, cañón, glaciar) · modos (contrarreloj,
duelo 1v1) · eventos de fin de semana.

---

## 2. Plan por tramos

Orden elegido: primero lo que **evita perder jugadores que ya entraron** (es lo más barato y lo
que más multiplica), después lo que **nos deja entrar en la plataforma**, y al final lo que
**amplía el techo**.

### ▸ TRAMO 1 — El primer minuto *(retención día 1)* — **HECHO**
El jugador nuevo tiene que entender, sobrevivir y querer reintentar.
*Archivos: `game/difficulty.js`, `game/Objectives.js`, `ui/hud/Coach.js`, `ui/screens/Result.js`.*
1. **Curva de dificultad**: las primeras partidas con rivales menos agresivos, más protección
   al aterrizar y sin acoso de los "matones". Sube hasta la dificultad normal en ~5 partidas.
2. **Tutorial contextual**: avisos cortos en el momento justo (caída, aterrizaje, primer lago,
   primera presa, primer rival grande). Solo en las primeras partidas; se pueden desactivar.
3. **"Casi lo consigues"** en la pantalla de resultado: a cuánto quedaste del mar, cuánto te
   faltaba para romper la presa, a cuántos superaste. Es lo que provoca el reintento.
4. **Objetivos de partida**: 3 metas por partida con recompensa en Gotas ("traga 3 lagos",
   "rompe una presa", "acaba entre los 5 primeros"). Siempre hay algo a medias.

**Comprobado en simulación** (piloto automático, 3 semillas por nivel):

| Partidas jugadas | Resultado del jugador |
|---|---|
| 0 (novato) | gana la carrera (#1, 2,5–4,1 M L) |
| 2 | #1, #1 y una eliminación a los 68 s |
| 5+ (completa) | #8, #16 y una eliminación a los 69 s |

### ▸ TRAMO 2 — Que entre por la puerta *(requisitos técnicos de la plataforma)*
Sin esto, no lo aceptan o lo entierran.
1. **Rendimiento en móvil**: medir fps reales, bajar vegetación/efectos en preset bajo,
   escalado dinámico de resolución si baja de 30 fps.
2. **Carga rápida**: hoy la isla tarda ~3–4 s en generarse. Objetivo < 3 s hasta el menú.
3. **Peso del paquete**: hoy ~2,2 MB. Dividir en trozos y cargar lo que no es urgente después.
4. **Cero errores en consola** y comprobación en pantallas pequeñas y táctiles.

### ▸ TRAMO 3 — Volver mañana *(retención día 7)*
1. **Misiones diarias** (3 al día, se renuevan) y **cofre** tras N partidas.
2. **Nivel de cuenta** con recompensas cada pocos niveles (Gotas, skins).
3. **Modificador del día**: regla que cambia cada día para que no sea siempre igual.
4. **Récords personales** visibles (mejor tiempo, mejor puesto, más litros).

### ▸ TRAMO 4 — Que den ganas de verlo *(que la plataforma lo destaque)*
1. **Juice** en los momentos clave: romper presa, absorber lago, llegar al mar.
2. **Miniatura** y capturas de prensa.
3. **Tráiler de 15 s** con los mejores momentos.
4. Repaso visual final de cada pantalla.

### ▸ TRAMO 5 — Publicación
1. Integrar de verdad el SDK de la plataforma elegida.
2. Paquete final, metadatos, descripción, etiquetas.
3. Enviar a Poki, CrazyGames y GameDistribution.
4. Analítica conectada para ver retención real.

### ▸ TRAMO 6 — Ampliar el techo *(solo si los números acompañan)*
1. Multijugador real con servidor (Colyseus).
2. Más mapas y modos.
3. Eventos y temporadas.

---

## 3. Estado

| Tramo | Estado |
|---|---|
| 1 — El primer minuto | **hecho** |
| 2 — Requisitos técnicos | pendiente |
| 3 — Volver mañana | pendiente |
| 4 — Presentación | pendiente |
| 5 — Publicación | pendiente |
| 6 — Multijugador | pendiente |
