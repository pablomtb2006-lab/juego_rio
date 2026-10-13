# Río Vivo — ríos rivales, absorción y fusión

Extiende el laboratorio de agua existente (`docs/RIO_VIVO.md`). No hay simulación nueva ni se
sustituye el río del jugador: **todos los ríos son agua del mismo solver PBF**, y lo que distingue
a un río de otro es la etiqueta de propietario de cada partícula.

```
npm run dev
→ http://localhost:5173/lab/agua/?modo=rivales      (o el selector «Ríos rivales» del panel)
node tools/fluid-tests.mjs rivales                  pruebas 1–10 sin pantalla
```

Controles: **WASD** mueve tu río (turquesa) · **C** cámara libre / seguir · **R** reiniciar ·
**P** pausa. Toca a un río más pequeño para absorberlo; huye de los grandes.

## 1. Qué es física y qué es regla de juego

| Fenómeno | Tipo | Dónde |
|---|---|---|
| Movimiento del agua, presión, choques, rodear obstáculos, salpicaduras | **Física simulada** (PBF) | `FluidSolver.js` |
| Masa de cada río m = N·m_p, volumen V = m/ρ, ρ = 998,2 kg/m³ | **Medida** de las partículas | `RiverEntity.js` |
| Tamaño y forma de cada río | **Emergente** (gravedad + cohesión de cuerpo) | ver §4 |
| Cohesión de cuerpo κ(C − x) y amortiguación interna | **Regla de juego** (fuerzas internas de suma cero) | `FluidSolver.js` (`predict`) |
| Fuerza de dirección (jugador / IA) | **Fuerza externa** contabilizada (trabajo P = a·M v̄) | `RiverEntity.js` |
| Contacto entre ríos (partícula a partícula, distancia < h) | **Medida** | `RiverIdentity.js` |
| Absorción: quién absorbe, a qué ritmo, histéresis, fases | **Regla de juego** | `AbsorptionSystem.js` |
| Transferencia de masa | **Conservativa por construcción**: se cambia el propietario de partículas reales, nada se crea, destruye ni teletransporta | `RiverIdentity.js` |
| Color: transporte con el fluido + difusión | **Modelo físico de tinte** (advección lagrangiana exacta + difusión SPH) | `RiverIdentity.js` |
| Color final tras la fusión | **Política visual** configurable | `RiverEcosystem.js` |

La mezcla física (el agua se mueve, el tinte se difunde) y la absorción de juego (de quién es
cada kilogramo) son dos capas distintas y nunca se mezclan en el código.

## 2. Arquitectura

| Requisito del documento | Implementación |
|---|---|
| Entidad reutilizable de río (§2) | `src/fluid/RiverEntity.js`: id, tipo (jugador/rival/neutral), color, masa, volumen, densidad, caudal, velocidad media, profundidad y área, estado, absorbedor, % de fusión, resistencia, maniobrabilidad, IA, registro de masa |
| Identidad por partícula | textura `id` del solver (rgb = absorbancia del tinte, a = propietario), permutada con las partículas en cada subpaso (4.ª salida MRT del pase `reorder`) |
| Contacto, transferencia, tinte, estadísticas (GPU) | `src/fluid/RiverIdentity.js` |
| Absorción (§5–§8) | `src/fluid/AbsorptionSystem.js` |
| IA (§13) | `src/fluid/RivalAI.js` |
| Orquestación y conservación (§14) | `src/fluid/RiverEcosystem.js` |
| Pruebas (§15) | `src/fluid/RivalTests.js` + `tools/fluid-tests.mjs rivales` |
| Laboratorio | `lab/agua/rivals.js` + modo `?modo=rivales` en `lab/agua/main.js` |

**Un solo solucionador** con identidad por río (lo que pide §14). Por fotograma:

1. intenciones: teclado / `RivalAI` → aceleración de dirección de cada río (con tope)
2. fuerzas por río al solver (textura 8×3: dirección + κ, centro + tope, velocidad media + amortiguación)
3. paso PBF normal (presión, colisiones, cantidad de movimiento)
4. `RiverIdentity` (GPU): contacto, cambios de propietario, tinte, estadísticas por río
5. `AbsorptionSystem`: episodios y probabilidades de transferencia del fotograma siguiente
6. comprobaciones de conservación con recuentos exactos

Sin rivales (modo laboratorio) la textura de identidad es cero y las fuerzas por río están
apagadas, así que el solver es exactamente el anterior. Comprobado con el código final: las cinco
pruebas base dan los mismos números que antes del cambio:
- caída libre: error 1,8·10⁻⁶
- reposo: pendiente de presión 1,2%, energía cinética final 1,96% del pico
- caudal: balance 6·10⁻¹⁴ kg
- control: desplazamiento 2,66 m
- rotura de presa: compuerta 1,088 × Ritter, frente 0,739

## 3. Masa: una sola fuente de verdad

Un río no guarda agua propia. Su masa es el número de partículas con su etiqueta por la masa de
partícula calibrada (`FluidProperties`). Centro de masas, velocidad, radio de huella
(R = √2·r_rms), área A = πR², profundidad media H = V/A y caudal másico Q = ρ·(2R·H)·|v̄| se
**miden** cada fotograma en la GPU (sumas por río con mezcla aditiva) y nunca se guardan aparte.

Absorber es cambiar el propietario de partículas reales en el frente de contacto:
- m_final = m_A + m_B y V_final = V_A + V_B **por construcción** (las partículas no cambian)
- nunca se suman radios ni se escala una malla
- cada partícula que cambia de dueño se cuenta en una matriz 8×8 acumulada en la GPU

## 4. El tamaño emerge de la masa

Sin una regla que mantenga unido cada río, el agua se extendería en una lámina y dos ríos se
fundirían al tocarse. La **cohesión de cuerpo** (regla de juego) aplica a cada partícula una
aceleración horizontal κ·(C − x), con tope de 14 m/s², hacia el centro de masas de su río, más
una amortiguación −c·(v − v̄). Sumadas sobre el río ambas son cero: dan forma al río pero no lo
mueven. El equilibrio hidrostático con la gravedad es una cúpula:

  H(r) = H0 − κ r²/(2g),   V = π κ R⁴/(4g)   ⇒   R = (4 g V/(π κ))^¼

Con κ = 8 s⁻²: 1,5 m³ → R ≈ 1,24 m; 4 m³ → 1,58 m; 8 m³ → 1,88 m. Al absorber, el radio crece
solo porque hay más agua (∝ V^¼). Limitación: el centro de masas llega con un fotograma de
retraso, así que la suma no es exactamente cero.

## 5. Contacto real (§5)

Una partícula de A está «en contacto» con B si tiene **al menos 2 vecinas de B a menos de h**
(la misma búsqueda de vecinos exacta del solver). Las gotas y la espuma no cuentan: se excluyen
las partículas con menos de 3 vecinas de su propio río.

  A_c = ½ (N_AB + N_BA) · V_p^(2/3)      (m²)

La fórmula es exacta para una interfaz plana entre dos retículas. Cuando dos cuerpos chocan y se
interpenetran, la zona de contacto es un volumen y A_c la cuenta como una superficie equivalente
mayor (medido: 3–12 m² entre cúpulas de 1–5 m³).

**Histéresis:**
- el contacto empieza con A_c ≥ 0,6 m²
- debe mantenerse (A_c ≥ 0,25 m²) 0,6 s antes de transferir nada (fase de agarre)
- termina tras 0,35 s por debajo de 0,25 m²
- una rozadura no transfiere

Los restos ya triturados de un río (f ≥ 0,85 o menos de 0,3 m³) se sostienen con todas las
partículas de contacto, porque son finos. Un cuerpo que se escapa se juzga solo por su contacto
de cuerpo.

## 6. Absorción progresiva (§6–§8) — regla de juego

- Quién absorbe: la mayor masa al terminar el agarre (en empate, la más rápida).
- R = m_A / max(m_B, m_suelo) ≥ 1 y S(R) = (R − 1)/(R + 1).
- Duración nominal: T(R) = 7 − 5,5·S^0,7 s. Es la duración con contacto firme de frente, y con
  ese contacto las ventanas del diseño (parecidos 5–8 s, moderada 3–5 s, muy grande 1,5–3 s) se
  cumplen por construcción. Cualquier contacto más débil (menos área, corrientes alineadas,
  resistencia) solo la alarga, y entonces puede quedar fuera de la ventana por arriba; por
  ejemplo, una persecución alineada entre iguales puede pasar de 8 s.

| R | 1 | 1,5 | 2 | 4 | 8 | → ∞ |
|---|---|---|---|---|---|---|
| T(R) | 7,0 s | 5,2 s | 4,45 s | 3,15 s | 2,4 s | 1,5 s |

**Ritmo (kg/s, nunca negativo):**

  dm/dt = (m_B0 / T(R0)) · min(φ_A · φ_u · φ_dir · φ_r, 1)

  El tope es 1. Medido: con un tope de 1,25, un duelo de frente con R0 = 1,13 tardaba 4,9 s,
  por debajo de los 5 s del diseño.

- **φ_A** = clamp(A_c / (2,5·V_B0^(2/3)), 0,25, 1,25): más contacto, más rápido.
- **φ_u** = clamp(0,85 + 0,15·|u_rel|, 0,85, 1,25), donde |u_rel| es la velocidad relativa medida
  en las parejas de contacto.
- **φ_dir** = (1 − 0,25·cos θ)·clamp(1 + 1,5χ, 0, 1). Compara las corrientes de los dos ríos
  (dirección de su fuerza más su inercia) y su cierre χ sobre la línea de centros:
  - de frente → 1,25
  - persecución alineada → 0,75
  - separándose → 0 (sin transferencia), pero solo cuando los cuerpos ya están separados: el
    término se activa gradualmente entre 0,5 y 0,8 veces la suma de radios, porque mientras se
    interpenetran la línea de centros no indica una dirección fiable
- **φ_r** = 1 − 0,35·resistencia_B·(1 − S): la resistencia importa sobre todo entre iguales.
- Tope adicional: dm/dt ≤ 2·m_B0/T_min, y nunca más de lo que B tiene.

La GPU realiza ese ritmo convirtiendo partículas del frente con probabilidad p = q / N_frente,
donde q es el déficit entre la transferencia acumulada del modelo y la medida. Por eso la curva
real sigue al modelo sin pasarse.

**Progreso:** f = m_transferida / m_B0, calculado con recuentos exactos. La barra sobre cada río
muestra este valor.

**Fases:** agarre → fusión → integración (f ≥ 0,85) → completa. La integración es un punto
de no retorno: separarse ya no frena la transferencia, y solo perder el contacto por completo la
interrumpe. Medido: en un duelo de frente entre iguales, el último 15% atravesaba a A y salía
por el otro lado.

**Interrupción:** si se pierde el contacto, la transferencia se para y lo ya transferido se queda
en A.

**Restos:**
- cuando quedan menos del 3% de m_B0, se liberan como **agua libre** (neutral), no se borran
- un río por debajo de 0,12 m³ se disuelve en agua libre
- el agua libre que toca un río se une a él a 1,5 s⁻¹ por partícula del frente

**Cadenas:** un río que está siendo absorbido no puede absorber.

## 7. Escape (§9)

El escape es físico: la única herramienta es la fuerza de dirección del río, con tope según la
masa: a_max = 5·(3000 kg ÷ m)^¼ m/s², limitada entre 2,5 y 8 m/s². Los ríos grandes son más lentos y maniobran
peor. Al separarse, las corrientes dejan de empujar contra el contacto, φ_dir cae a 0 y el
contacto acaba rompiéndose por geometría. Los controles del jugador nunca se bloquean.

## 8. Color (§3, §10, §11)

Cada partícula lleva una **absorbancia** σ_rgb (1/m). El color del agua sale de Beer–Lambert
sobre el espesor real atravesado, igual que antes, y se conservan reflejos, refracción y
transparencia. El pase de espesor acumula la profundidad óptica Σσ·cuerda por canal; Beer–Lambert
es aditivo en profundidad óptica, así que la mezcla de aguas de distinto color a lo largo de un
rayo es exacta.

La absorbancia de cada río se calcula a partir de su color objetivo: σ = 3,2·(−ln c_lineal).
Colores: jugador turquesa; rivales azul eléctrico, esmeralda, violeta, oro anaranjado y coral.
El color es solo visual: no afecta a la física.

**Transporte del tinte:**
- viaja con la partícula (advección lagrangiana exacta)
- se difunde entre vecinas con coeficiente D = 0,004 m²/s (laplaciano SPH de Brookshaw,
  simétrico por parejas, así que conserva Σσ·V)

El borde de color queda irregular porque el frente de absorción también lo es.

**Políticas de color final (selector del panel):**
- **receptor**: el agua absorbida toma poco a poco el color del absorbedor (τ ≈ 1,7 s)
- **mezcla**: solo física; el tinte se advecta y difunde, conservado, sin relajación
- **estilizado**: como receptor, pero cada absorción completada mueve un 20% el color del
  absorbedor hacia la mezcla ponderada por masa

## 9. IA (§13) — `RivalAI.js`

La IA solo decide la dirección deseada. No mueve agua, así que no puede atravesar muros,
teletransportarse ni cambiar de tamaño. Percibe datos reales: masas, centros, velocidades,
quién absorbe a quién y las SDF de los sólidos (con sondas de anticipación para esquivarlos).

| Personalidad | Caza (masa presa/propia) | Huye de | Rasgo |
|---|---|---|---|
| agresiva | ≤ 1,3× | ≥ 2,2× | resiste un momento si la agarra uno parecido |
| evasiva | ≤ 0,55× | ≥ 0,85× | más rápida |
| oportunista | ≤ 0,8× (×1,6 si la presa ya está siendo absorbida) | ≥ 1,3× | prefiere presas debilitadas |
| territorial | ≤ 1,5× dentro de su zona (7 m) | ≥ 2,5× | vuelve a casa, alta resistencia |

## 10. Conservación (§14)

Se comprueba cada fotograma con recuentos enteros exactos:
- el total de partículas (todos los ríos más el agua libre) no cambia
- en cada río, N(t) − N(0) = Σ entradas − Σ salidas de la matriz de transferencias, es decir,
  ningún kilogramo cambia de dueño sin quedar registrado ni se cuenta dos veces
- ningún episodio transfiere más de lo que B tenía: f ≤ 1
- la contabilidad del solver se mantiene: sin pérdidas numéricas ni partículas dentro de sólidos

Un río eliminado no destruye masa: sus partículas ya pertenecen a otro río o al agua libre.

## 11. Pruebas 1–10 — resultados medidos

Ejecutadas con `node tools/fluid-tests.mjs rivales` en Chromium sin pantalla con WebGL2 sobre
**SwiftShader (CPU)**. Resolución d = 0,15 m salvo en la prueba 10; los datos completos están en
`docs/validation/results.json`. Columna «Cons.»: error de conservación en partículas
(total / libro de transferencias). **10/10 pasan.**

| # | Prueba | Resultado medido | Criterio | Cons. |
|---|---|---|---|---|
| 1 | Rozadura | contacto de 0,75 s con un máximo de 0,89 m²; el agarre empezó pero se cortó: **0 kg transferidos**, sin absorción | sin absorción completa, < 2% transferido | 0 / 0 |
| 2 | Tamaños parecidos | R0 = 1,13, T(R0) = 6,24 s → **5,93 s** hasta completar; 2105 de 2222 kg transferidos (el resto, como agua libre); área media 8,0 m² | completa en 5–8 s | 0 / 0 |
| 3 | Diferencia grande | R0 = 6,31, T(R0) = 2,60 s → **2,27 s**; 684 de 787 kg | completa en 1,5–3 s | 0 / 0 |
| 4 | Interrumpida | se separan con f = 0,30; contacto perdido 2,35 s después con **f = 0,495**; luego **0 transferencias**; A = 882 + 220 = **1102** y B = 444 − 220 = **224** partículas, exacto; B sobrevive | se interrumpe con 0,25 ≤ f < 0,8, nada más tras el corte, cuentas exactas | 0 / 0 |
| 5 | Corrientes opuestas | R0 = 1,99; φ_dir medido 1,25; **f = 0,333** a 1,5 s de fusión (329 kg/s) | opuestas detectadas (φ_dir ≥ 1,15) | 0 / 0 |
| 6 | Corrientes alineadas | φ_dir medido 0,75; **f = 0,275** a 1,5 s (271 kg/s); las opuestas absorben **1,21×** más rápido | alineadas detectadas (≤ 0,85) y más lentas que las opuestas | 0 / 0 |
| 7 | Conservación de masa | 3 ríos + agua libre; A absorbe a B (R0 3,6, 3,1 s) y a C (R0 7,2, 2,0 s); B agarra a C y la pierde (47 kg); 65 partículas pasan a agua libre y 90 de agua libre se unen a A; total **1623 → 1623** partículas, 5414,8 kg | 0 partículas de error cada fotograma, f ≤ 1 | 0 / 0 |
| 8 | Identidad visual | cada río empieza con su color (< 1%); el color de A cambia como mucho **0,45%** por fotograma (de la distancia A–B); con la política receptor acaba a **2,5%** de su color; con mezcla física el inventario de tinte varía **9·10⁻⁷** | sin saltos, color final según la política, tinte conservado | 0 / 0 |
| 9 | Varios rivales | A absorbe a B y a C **a la vez** (147 fotogramas simultáneos): 2,45 s y 2,60 s; A gana **511** partículas = 511 en la matriz; 0 violaciones de cadena | sin doble transferencia, cuentas exactas | 0 / 0 |
| 10 | Estabilidad | la misma absorción (R0 ≈ 2) con subpasos 2/3/4 y d = 0,18/0,15/0,13 m: **4,15–4,23 s**, dispersión del **2,0%** (T(2) = 4,45 s); todas completas, sin pérdidas ni recortes | dispersión < 25%, masa exacta | 0 / 0 |

En todas las pruebas: ninguna pérdida numérica, ninguna partícula dentro de sólidos y ninguna
velocidad recortada.

**Lo que las pruebas obligaron a cambiar** (cada cambio está anotado en el código con su medida):
- A_on pasó de 0,3 a 0,6 m² y el agarre de 0,4 a 0,6 s: una rozadura rápida transfería un 2,8%.
- Se añadió φ_dir: después del choque ambos cuerpos se mueven juntos, y |u_rel| solo ya no
  distinguía «de frente» de «alineadas».
- El cierre χ distingue «de frente» de «separándose»: antes, una huida real hacía subir f de
  0,31 a 0,68.
- La separación solo cuenta con los cuerpos separados: atravesándose, la línea de centros se
  invertía y paraba una fusión en f = 0,72.
- La integración es un punto de no retorno.
- El tope del factor pasó a 1: con 1,25, un duelo entre iguales duraba 4,9 s.
- Volumen inicial ajustado a capas enteras: a d = 0,18 m la razón de masas salía 1,40 en lugar
  de 2,14.

**No ejercitado por las pruebas:** la regla de cadena (un río absorbido no absorbe). Está en el
código y se vigila en la prueba 9 (0 violaciones), pero en esa prueba A nunca llegó a estar
siendo absorbido. Tampoco hay prueba automática de la IA: se ha observado en el laboratorio
(cazas, huidas, territorio, rodeo de obstáculos) sin criterio numérico.

## 12. Comportamientos observados (emergentes, no programados)

- **Filamentos:** el agua ya transferida pertenece al absorbedor y su cohesión de cuerpo la
  arrastra hacia él. Por eso se ve una corriente que va del río absorbido al absorbedor y que
  cambia de color por el camino (visible en el laboratorio cuando un río huye mientras lo absorben).
- **Correa de drenaje:** si la víctima huye y el absorbedor la persigue, ese filamento puede
  mantener un contacto fino (≈ 0,75 m²) que sigue drenando al ritmo mínimo (φ_A = 0,25). Para
  escapar hay que romperlo. Si resulta demasiado castigador, se ajusta con el suelo de φ_A o con
  A_off.
- **Escape atravesando:** en un choque de frente entre iguales, si el pequeño embiste en línea
  recta sin girar, sus restos pueden atravesar al grande y salir por el otro lado. Antes de
  llegar a la integración eso cuenta como escape real. Las pruebas 2, 3, 8 y 10 usan un guion de
  «lucha sostenida» (cada río apunta al centro del otro) porque miden la absorción, no esta
  huida.

## 13. Limitaciones

- **Lectura GPU→CPU cada fotograma.** Son seis lecturas pequeñas (texturas de 8×1 y 8×8) que
  sincronizan la CPU con la GPU. En el laboratorio es aceptable; para producción convendría
  leer con un fotograma de retraso (PBO).
- **Requiere `EXT_float_blend`.** Se usa para las sumas por río; el contador del sumidero ya lo
  necesitaba.
- **Cohesión de cuerpo.** Es una regla de juego, no la tensión superficial del agua (0,0728 N/m,
  despreciable a esta escala). Usa el centro de masas del fotograma anterior.
- **Área de contacto.** Es una superficie equivalente: cuando los cuerpos se interpenetran cuenta
  un volumen. Los umbrales están calibrados con esta definición y con d = 0,15 m.
- **Pruebas a d = 0,15 m.** La prueba 10 barre d entre 0,13 y 0,18 m; las resoluciones del modo
  experimental (d = 0,095 m) no se han medido en pruebas de rivales.
- **Hasta 7 ríos más el agua libre.** Son 8 ranuras de propietario.
- **Rendimiento en GPU real sin medir.** Aquí solo hay SwiftShader (CPU).
