# La palanca de TTL, medida en neto — 2026-10-03

> **Veredicto.** Medida sobre **51 sesiones del tráfico de Claude Code de una
> sola organización** (la del dueño), **19.779 peticiones en 13 días**,
> simulada contra los **precios de lista** del proveedor, la rebaja de TTL
> (escrituras de caché 1h → 5m cuando lo nuevo es ≥ 30 % del cuerpo) deja un
> **neto de +$113,45, un +2,49 % de la factura** ($4.563,61), después de restar
> los fallos de caché que ella misma provoca.
>
> | IC 95 % (bootstrap, 10.000 remuestreos) | Neto % de la factura | Neto $ |
> |---|---:|---:|
> | por **sesión** (51 clusters) | **+1,50 % … +3,57 %** | +$42,70 … +$222,58 |
> | por **día** (13 clusters) | **+1,73 % … +4,82 %** | +$65,11 … +$169,62 |
>
> Los dos intervalos excluyen el cero: con este tráfico la palanca **gana**
> dinero. Pero es UNA organización, UN proveedor y UN cliente: no es una cifra
> para prometer a nadie más (ver «Límites»).

Solo cifras agregadas. Ningún prompt, respuesta, cabecera ni id de sesión sale
de la captura (`~/.bvsala-f0`, privada, no está en el repo).

## Cómo se reproduce

```bash
pnpm ttl:replay --salida=/tmp/ttl.json          # todas las capturas de ~/.bvsala-f0
pnpm vitest run test/ttl-replay.test.ts         # fixtures sintéticas
```

- `benchmarks/ttl/nucleo.ts` — la decisión **no está copiada**: llama a
  `parsearMensajes`, `huellaDe`, `MemoriaDePrefijos`, `fraccionNueva`,
  `decidirRebaja`, `rebajarTtlDeCache` y `ahorroDeRebaja` de
  `gateway/tarifa.ts`, en el orden de `gateway/servidor.ts`, con el reloj de la
  captura. Lo único escrito a mano es la plantilla de la clave del hilo
  (`sesión:hash del system`), que en el servidor vive inline.
- Precios: `precioDeLista` de `src/pricing/catalogo.ts` (lista de Anthropic) el
  día de cada petición; primas 1,25× / 2× de `src/pricing/primas.ts`. El replay
  se niega a correr si `claude-fable-5` no sale a $10/MTok de entrada: la fe de
  erratas del 06-09 (un script con fable-5 al precio de Haiku 3.5 que valoraba
  el corpus en $279) no puede repetirse en silencio.
- Las peticiones se deciden en **orden de llegada** (`at`): la captura graba al
  terminar cada respuesta y 5.999 registros llegan desordenados.

## El modelo de caché (declarado)

- **Línea base** = lo que el proveedor facturó, con el `usage` real (1h).
- **Con la palanca**, un turno rebajado paga su escritura de 1h a 1,25× en vez
  de 2× (`ahorroDeRebaja`).
- **Fallo inducido dentro del hilo** (hilo = sesión + system): si el turno
  siguiente llega pasados 5 min (y antes de 1h), lo que cubría la entrada de 5m
  —lo que el turno rebajado escribió, no lo que ya leía de una entrada de 1h—
  pasa de lectura a escritura, a la prima de ESE turno (2× si no se rebaja).
  Tras un turno no rebajado el prefijo entero vuelve a estar bajo 1h: la
  ventana de riesgo dura un turno.
- **Variante conservadora** (`hilo+prefijo-compartido`): además, el primer turno
  de un hilo que leía la entrada de OTRO hilo (mismas tools + system) la pierde
  entera si el último arranque con ese prefijo fue hace más de 5 min. Cambia
  poco: +$113,06 (+2,48 %), 3 fallos más.

## Resultado, todas las capturas (modelo «hilo»)

| | |
|---|---:|
| Peticiones / sesiones / días | 19.779 / 51 / 13 |
| Factura base (lista) | $4.563,61 |
| Prima de la hora (techo de cualquier política de TTL) | $327,15 (7,2 %) |
| Rebajas | 2.583 |
| Prima ahorrada (bruto) | $141,58 |
| Fallos inducidos | 124 — cuestan $28,14 |
| **Neto** | **+$113,45 (+2,49 %)** |

### Por modelo

| Modelo | Peticiones | Factura | Rebajas | Bruto | Fallos | Coste fallos | **Neto** | **% factura** |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| claude-fable-5 | 1.921 | $1.036,54 | 23 | $49,50 | 1 | $1,44 | **+$48,06** | **+4,64 %** |
| claude-fable-5-1 | 2.236 | $1.224,53 | 25 | $20,23 | 0 | $0,00 | **+$20,23** | **+1,65 %** |
| claude-opus-5 | 8.344 | $1.900,28 | 70 | $33,36 | 2 | $2,76 | **+$30,60** | **+1,61 %** |
| claude-opus-4-8 | 1.193 | $176,76 | 34 | $11,47 | 0 | $0,00 | **+$11,47** | **+6,49 %** |
| claude-sonnet-5 | 6.080 | $225,26 | 2.427 | $26,94 | 121 | $23,93 | **+$3,01** | **+1,34 %** |
| claude-haiku-4-5 | 5 | $0,24 | 4 | $0,08 | 0 | $0,00 | +$0,08 | (n = 5) |

Sonnet-5 es el caso feo: el 94 % de las rebajas, el 98 % de los fallos y un
neto casi nulo (en P1, **−$3,44, −9,4 %** de su factura). Su tráfico son hilos
cortos que se rehacen a menudo y vuelven pasados 5 min. La regla gana de verdad
donde los arranques son caros y raros (fable, opus).

### Por periodo de captura

| Periodo | Pet. | Ses. | Días | Factura | Rebajas | Fallos | **Neto** | IC 95 % por sesión |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| P1 · 23-08 → 06-09 | 4.186 | 9 | 8 | $1.269,49 | 645 | 48 | **+$56,17 (+4,42 %)** | +0,29 % … +9,12 % |
| P2 · 07-09 → 10-09 ¹ | 14.372 | 19 | 4 | $3.062,24 | 1.635 | 63 | **+$47,41 (+1,55 %)** | +1,13 % … +2,05 % |
| P3 · 11-09 ¹ ² | 1.221 | 23 | 1 | $231,88 | 303 | 13 | **+$9,87 (+4,26 %)** | +2,45 % … +25,7 % |

¹ **Grabado detrás del gateway, con la palanca ya armada.** Desde el 07-09 la
captura trae `claude-fable-5-1` (el modelo hermano: el cliente pide fable-5) y
desde el 08-09 marcas `"ttl":"5m"` explícitas —que Claude Code nunca escribe—,
justo el día en que producción empieza a acreditar ahorro medido. El replay
reconstruye lo que mandó el cliente: un cuerpo con TODAS sus marcas en `"5m"`
explícito vuelve a `"1h"`, su escritura de 5m vuelve a 1h y, si el turno
siguiente del hilo llegó pasados 5 min, el fallo que la rebaja real causó se
deshace (escritura → lectura). Es una línea base **reconstruida**, menos firme
que la de P1.

² La captura del 11-09 siguió abierta hasta el 23-09 pero solo contiene tráfico
del 11-09: el «11-09 → 23-09» del encargo es, en datos, un día. Su IC por día
no existe (un cluster).

## ¿Reproduce el +4,9 % del 06-09?

Sí, a una décima. El corpus de aquel informe ($1.232,91, 3.305 peticiones)
cuadra al céntimo con **P1 sin claude-sonnet-5**: fable-5 $1.036,54 en 1.921
peticiones, opus-4-8 $176,76, opus-5 $19,33, haiku $0,24 — 3.304 peticiones,
$1.232,87. Aquel análisis no incluyó el tráfico de sonnet-5.

| | Informe 06-09 | Replay de hoy | Replay, fallo a 1,25× |
|---|---:|---:|---:|
| Rebajas | 56 | 61 | 61 |
| Bruto | $61,83 | $61,05 | $61,05 |
| Fallos | 4 ($0,87) | 1 ($1,44) | 1 ($0,87) |
| **Neto** | **+$60,96 (+4,9 %)** | **+$59,61 (+4,83 %)** | +$60,18 (+4,88 %) |
| IC 95 % por sesión | — | +0,69 % … +9,04 % (9 sesiones) | |

Las diferencias, explicadas: (1) la decisión de hoy no es la de entonces —desde
el 09-09 la huella ignora las herramientas diferidas y desde el 27-09 solo mira
las marcas donde la API las lee—; (2) el replay decide en orden de llegada;
(3) aquel informe cobraba el fallo a 1,25× − lectura («un fallo cuesta 1,15×
sobre lo gordo»), pero el turno que falla no está rebajado y reescribe a **2×**:
con la aritmética correcta el mismo fallo cuesta más ($1,44 frente a $0,87).

**Lo que el +4,9 % no decía:** con el sonnet-5 que dejó fuera, P1 da +4,42 %;
y en todo el tráfico, **+2,49 %**. La cifra de septiembre era correcta para
su corpus, pero el corpus era el más favorable.

## Contraste con producción (solo lectura)

Consulta con el rol `supabase_read_only_user` (endpoint read-only de la
Management API), solo agregados:

| | |
|---|---:|
| Organizaciones con actividad de gateway | 2 |
| Asientos | 3 |
| Peticiones | 25.627 (2026-09-01 → 2026-09-12) |
| **Bruto medido** (`measured_baseline_cost − measured_actual_cost`) | **$93,19** |
| …en | 1 organización, 1 asiento, 4 días (08-09 → 11-09) |
| Base medida | $5.204,27 → el bruto es el 1,79 % |

Por modelo (`usage_daily_by_model`): opus-5 $36,45 · sonnet-5 $38,89 ·
fable-5-1 $17,86. El fable-5-1 coincide al céntimo con la prima que la captura
ahorró en ese modelo ($17,86): producción y espía vieron el mismo tráfico.
En opus-5 y sonnet-5 producción vio más peticiones que la captura (el 10-09 y
el 11-09 el espía no estuvo en todo el tráfico), de ahí que su bruto sea mayor
que el de la captura ($31,66 y $21,79).

**La cifra de producción es BRUTA**, no neta: `sobrecosteEvitado`
(`gateway/medidor.ts`) acredita la prima de cada escritura rebajada y no resta
los fallos que la rebaja provoca en el turno siguiente — no puede: el turno que
falla no sabe que habría acertado. En la misma captura, la palanca tal como
corrió entonces ahorró $71,30 de prima y causó 66 fallos que costaron unos
$21,54 (estimado al deshacerlos): **un 30 % del bruto se lo comen los
fallos**, casi todo en sonnet-5. El carril sombra (`shadow_*`, 15.774
peticiones, −$1.238,39) mezcla la sombra de la elisión con la de TTL y no
sirve para separar esta palanca.

## Límites

- **Una organización, un cliente, un proveedor.** Claude Code contra
  Anthropic, el tráfico del dueño. Nada de Codex ni de otros proveedores. 51
  sesiones; P3 es un solo día.
- **Precio de lista, simulado.** No es una factura: es el `usage` real tarifado
  con el catálogo. Descuentos, tier o suscripción cambiarían el dinero.
- **El modelo de caché es un modelo.** Supone que la entrada se indexa por
  prefijo y que un turno a 1h re-cubre todo su prefijo; la variante
  conservadora acota el riesgo entre hilos y apenas mueve la cifra.
- **P2 y P3 reconstruidos.** Grabados detrás del gateway: su línea base se
  reconstruye deshaciendo la rebaja real (ver nota ¹).
- **El techo cambia con el cliente.** Desde el 08-09 Claude Code deja muchas
  marcas sin `ttl` (5m del cliente, fuera del alcance de la palanca): de 19.779
  peticiones, 7.327 no traen ni una marca de 1h.
- **El hueco se mide desde la llegada de cada petición**, no desde el fin de la
  respuesta: cuenta algún fallo de más, nunca de menos.
