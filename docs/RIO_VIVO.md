# Río Vivo — laboratorio de agua

Simulador de agua 3D en tiempo real, **aislado del juego**, construido con las reglas del documento
«PROYECTO: RÍO VIVO». Corre en el navegador (WebGL2) para que lo que salga de aquí pueda entrar
después en Río Royale, que es un juego web.

```
npm install
npm run dev
→ http://localhost:5173/lab/agua/                 laboratorio
→ http://localhost:5173/lab/agua/?profile=high     perfil de alta calidad
→ http://localhost:5173/lab/agua/tests.html        pruebas en el navegador
node tools/fluid-tests.mjs                         pruebas sin pantalla (escribe docs/validation/results.json)
```

Controles: **WASD / flechas** empujan el agua (fuerza contabilizada) · ratón gira y hace zoom ·
**F** abre/cierra la fuente · **T** lanza una roca · **V** recorre los campos físicos · **R** reinicia ·
**P** pausa.

---

## 1. Qué se eligió y por qué

| Método | Masa | Superficie libre / chorros | Coste en tiempo real | Decisión |
|---|---|---|---|---|
| Euleriano / volúmenes finitos + VOF | muy buena | buena en 3D, cara | alto en 3D | no como base |
| Aguas someras 2D (altura) | exacta | **no** (sin chorros, sin salpicadura) | muy bajo | futuro: río global |
| SPH débilmente compresible | exacta | buena | pasos de tiempo diminutos | no |
| **PBF (Position Based Fluids)** | **exacta** (por partículas) | **buena** | estable con pasos grandes, GPU | **elegido** |
| FLIP / APIC | buena | la mejor | presión en rejilla, mejor con WebGPU | futuro |

PBF (Macklin & Müller 2013) es lo que se ve en el vídeo de referencia: una masa de agua hecha de
partículas que rodea obstáculos, se amontona, salta y se separa. La incompresibilidad es una
restricción de densidad ρ_i = ρ0 resuelta por iteraciones; no es exacta y su error se mide.

## 2. Arquitectura (`src/fluid/`)

| Subsistema del documento | Archivo |
|---|---|
| RiverSimulation | `RiverSimulation.js` — coordina todo, fuentes, sumideros, subpasos |
| FluidSolver | `FluidSolver.js` — predicción, λ, Δp, velocidad, XSPH, cohesión, espuma, anisotropía |
| (búsqueda de vecinos) | `SpatialHash.js` — clave de celda exacta + ordenación bitónica + tabla de celdas |
| FluidProperties | `FluidProperties.js` — constantes SI, núcleos, calibración de masa, tabla de contorno |
| FluidBoundaryConditions | `RiverSimulation.js` (`addSource`, `setSink`) |
| FluidCollision | `FluidCollision.js` — SDF de dominio, cajas orientadas, esferas (GLSL + espejo JS) |
| FreeSurfaceReconstruction | `render/FreeSurfaceReconstruction.js` |
| WaterRendering | `render/WaterRendering.js` |
| FoamAndSpray | `render/FoamAndSpray.js` (+ criterio de generación en `FluidSolver.js`) |
| RiverController | `RiverController.js` |
| RiverMassAccounting | `RiverMassAccounting.js` |
| SimulationDiagnostics | `SimulationDiagnostics.js` + `render/FieldView.js` + panel del laboratorio |
| FluidValidationTests | `FluidValidationTests.js` + `tools/fluid-tests.mjs` |

GPU: `gpu/GPU.js` (WebGL2, texturas RGBA32F, MRT, medidores de tiempo GPU) y `gpu/glsl.js`.
El solver no usa three.js: comparte el contexto y el laboratorio llama a `renderer.resetState()`.

## 3. Modelo físico y unidades

- **Unidades:** SI en todo el módulo (m, kg, s, Pa). La escena usa **1 unidad = 1 m**, sin conversión.
  En Unreal Engine sería ×100 (cm).
- **Agua dulce a 20 °C:** ρ0 = 998,2 kg/m³ y g = 9,81 m/s² se usan directamente.
- **Viscosidad 1,002·10⁻³ Pa·s: NO resoluble** a h ≈ 0,1–0,4 m (Re ~10⁵–10⁶). El solver tiene
  disipación numérica muy superior. `xsph` es un suavizado de velocidades declarado como numérico.
- **Tensión superficial 0,0728 N/m: despreciable** a esta escala (Bond ≈ 10³). No se modela.
  La **cohesión** (Akinci et al. 2013) es un modelo de **submalla**: mantiene continuas las láminas más
  finas que una partícula. Solo actúa donde el agua está por debajo de su densidad (láminas y bordes),
  con fuerzas por pares antisimétricas (conserva el momento).
- **Contornos:** los sólidos aportan densidad como una red virtual de partículas (Akinci et al. 2012,
  tabulada); entran solo por el gradiente de la restricción de la partícula (λ_b = 0), que es lo
  consistente con PBD.
- **Aire:** no se simula. La espuma no es aire.
- **Masa por partícula:** calibrada para que una red regular en reposo tenga ρ0 exacto. Su volumen
  m/ρ0 es un 1% menor que d³ (el núcleo no es una partición perfecta de la unidad).

### Lo calculado frente a lo aproximado

| Calculado por el solver | Aproximación declarada |
|---|---|
| Gravedad, transporte de momento | Viscosidad (XSPH numérico) |
| Incompresibilidad (restricción de densidad, error medido) | Tensión superficial (cohesión de submalla) |
| Colisión con suelo, paredes, cajas, rocas | Turbulencia por debajo de la partícula (no resuelta) |
| Desvío, estela, salpicadura, caídas, chorros | Espuma y burbujas (capa visual con criterios medibles) |
| División y reunión de masas | Refracción (en espacio de pantalla) |
| Fuente y desagüe con balance de masa | Roca lanzada: acoplamiento en un solo sentido |
| Fuerza del jugador y su trabajo | Trabajo del jugador: integrado por muestreo |

## 4. Capas de la superficie (documento §11)

1. **Estado físico:** las partículas (posición, velocidad, densidad, presión).
2. **Superficie reconstruida:** en espacio de pantalla. Cada partícula se dibuja como un **elipsoide
   anisótropo** (Yu & Turk 2013): esfera en el interior, disco plano en una lámina, gota pequeña si
   está aislada. Los centros se suavizan hacia la media local. Después hay un filtro bilateral 2D y las
   normales salen de la profundidad. No añade masa. Puede ocultar ondas menores que ~2 espaciados,
   nunca crearlas.
3. **Sombreado óptico:** Fresnel (F0 = 0,02 ⇔ n = 1,33) y absorción Beer–Lambert por canal RGB sobre el
   **grosor real atravesado**. El color sale de la dispersión simple: albedo σs/(σa+σs). Refracción del
   fondo desplazada por la normal.
4. **Espuma y gotas:** la espuma se marca con aire atrapado (vorticidad × energía cinética) y con
   cresta (baja densidad × velocidad), persiste con una vida media y viaja con la partícula
   (Ihmsen et al. 2012). Las gotas son agua real en vuelo: tienen masa y caen balísticamente.

Parámetros ópticos independientes en el panel: absorción R/G/B, turbidez, color de la dispersión,
reflejos, refracción, visibilidad del fondo, intensidad de luz y exposición. Hay cuatro preajustes; el de
«agua pura» usa la absorción medida (≈0,34 / 0,057 / 0,009 1/m a 650 / 550 / 450 nm; Pope & Fry 1997).

## 5. Validación — resultados medidos

Ejecutado con `node tools/fluid-tests.mjs` en **SwiftShader (GPU por software)**. Los números exactos
están en `docs/validation/results.json`.

| Prueba | Referencia | Resultado | Estado |
|---|---|---|---|
| **G1 caída libre** | centro de masas = y0 − ½g·t·(t+dt) (Euler simpléctico) | error 1,8·10⁻⁶; velocidad 1,7·10⁻⁶; deriva lateral 0,3 µm | **pasa** |
| **A reposo** | dp/dz = ρg | error de pendiente **1,2%** (con κ_yy medido = 0,913); superficie +0,55% sobre la geométrica; Ec final = 2,0% de la de pico; v media 1,1 cm/s | **pasa** |
| **B masa con flujos** | M = M0 + M_in − M_out | residuo **6·10⁻¹⁴ kg**; caudal entregado = diseño (85,4 kg/s, Q = A·v) | **pasa** |
| **Control del jugador** | trabajo ≥ ΔEc | desplaza 2,66 m; trabajo 3,69 kJ ≥ Ec máx. 1,97 kJ; masa intacta | **pasa** |
| **G2 rotura de presa** | Ritter (1892): calado en la compuerta 4/9·H0, frente ≤ 2√(gH0) | calado 1,088 × Ritter; frente 0,739 × 2√(gH0) | **pasa** |
| **J paso de tiempo** (2/3/5 subpasos) | dispersión < 10% | calado 5,0%; frente 1,2% | **pasa** |
| **I resolución** (d = 4 / 3 / 2,4 cm) | dispersión < 10% | calado **17%**; frente 7% | **falla** |
| I, cuarta resolución (d = 1,9 cm) | — | calado 1,073; frente 0,818 | informativo |

**Interpretación honesta de I.** Con H0/d < 10 partículas, el calado en la compuerta depende de la
resolución. La secuencia 1,164 → 1,088 → 0,977 → 1,073 no converge de forma monótona: con H0/d ≥ 10
queda dentro de ±10% de Ritter, pero no hay convergencia demostrada. El frente se acelera al refinar
(0,69 → 0,82), lo esperado al reducirse la disipación numérica.

**Correcciones que salieron de las pruebas** (no de la intuición):

- Sin contribución de los sólidos a la densidad, las capas del fondo se comprimían: superficie un 4% más
  baja y pendiente un 25% por debajo de ρg.
- El factor 2 de la presión espejada de SPH no es consistente con PBD: daba +11% de presión y temblor.
- La presión artificial aplicada en cada iteración hacía depender del número de iteraciones la altura
  del agua. Ahora es un término por subpaso.
- El estimador de presión necesitaba la normalización del gradiente discreto, κ (Bonet & Lok 1999),
  medida sobre la configuración real de partículas.
- La cohesión en todo el volumen añadía un temblor del 3,4%. Ahora solo actúa en láminas y bordes.

**Pendientes del documento:** C (perfil de velocidad en canal recto), D (pendiente), E (estrechamiento:
la geometría ya está en la arena), F (estela tras un cilindro) y H (división y reunión).

## 6. Rendimiento

**No hay medidas en una GPU real todavía**: este servidor no tiene tarjeta gráfica. En SwiftShader un
subpaso de 6.300 partículas tarda unos 90 ms. Eso solo sirve para comparar módulos entre sí: el grueso
es la iteración de restricciones (~65%), y la vecindad y la ordenación son ~20%.

| Perfil | Partículas | d | Subpasos · iteraciones | Uso |
|---|---|---|---|---|
| Desarrollo | 8.192 | 19 cm | 2 · 3 | iterar rápido |
| Equilibrado | 16.384 | 15 cm | 3 · 4 | por defecto |
| Alta calidad | 32.768 | 12 cm | 3 · 4 | — |
| Experimental | 65.536 | 9,5 cm | 4 · 4 | estudiar convergencia |

El panel muestra el tiempo GPU por módulo (`EXT_disjoint_timer_query_webgl2`), los FPS y el tiempo de
CPU por frame. **El simulador avanza 1/60 s de tiempo simulado por frame:** si la GPU no llega, la
simulación se ralentiza en vez de dar pasos inestables. El panel enseña el tiempo simulado para que
eso nunca quede oculto.

## 7. Parámetros en vivo

Se cambian sin reiniciar (solo uniforms; el estado se conserva): gravedad, XSPH, roce del lecho,
iteraciones, subpasos, caudal de la fuente, fuerza del jugador y todos los parámetros ópticos.
La resolución (perfil) **reinicia** la simulación, porque cambia el número de partículas y la masa de
cada una.

## 8. Limitaciones conocidas

- La refracción y los reflejos están en espacio de pantalla: solo muestran lo que está en pantalla
  (cielo procedural; sin reflejos de objetos cercanos).
- El agua no proyecta sombras.
- La roca lanzada empuja el agua, pero el agua no la frena (un sentido). La proyección puede lanzar
  partículas a ~20 m/s; quedan a la vista en el panel (velocidad máxima y recortes).
- Esquinas de dos o tres paredes: la contribución de contorno se suma por pared (ligera
  sobreestimación en las aristas).
- La cohesión es un modelo de submalla, no la tensión superficial del agua.

## 9. Siguientes pasos

1. Medir en tu ordenador y en tu móvil (FPS y tiempos GPU de cada perfil).
2. Pruebas C, D, E, F y H.
3. Integración en Río Royale: un río de km no cabe en partículas. El plan es un modelo de aguas someras
   para todo el cauce y PBF local alrededor del jugador (alternativas 2 y 3 del documento).
4. Puerto a WebGPU (compute shaders) para FLIP/APIC y más partículas.
