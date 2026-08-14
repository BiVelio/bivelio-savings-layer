# Corpus de evaluación · Soporte y políticas de producto

Golden set para la fase **F6 del plan (`docs/PLAN-CAMINO-AL-50.md`), el knapsack
de evidencia**: la primera palanca *task-preserving* del producto, la que decide
**qué trozos de contexto recuperado se mandan al modelo en vez de mandarlos
todos**.

40 casos en español y catalán, en `casos.json`. Las verjas que comprueban que el
corpus está bien construido viven en `test/corpus-soporte.test.ts` (25 tests).

---

## Lo que este corpus NO demuestra

**Esto es un golden set SINTÉTICO.** Los casos, las políticas, los importes y el
comercio («Botiga Nord SL») están inventados para este fichero.

Demuestra que el mecanismo **no descarta un campo crítico**: que un knapsack que
tira una unidad de evidencia necesaria se detecta y falla el examen.

**NO demuestra que en el tráfico real de un cliente el ahorro se materialice ni
que la distribución de casos difíciles se parezca.** Aquí los casos difíciles son
el 70 % porque están puestos a mano para cazar fallos; en un buzón de soporte
real la mayoría de las consultas son fáciles y repetidas, y la proporción de
trampas es una incógnita que este fichero no mide. Un 100 % de conservación de
campos críticos sobre estos 40 casos es una condición **necesaria y no
suficiente** para desplegar el knapsack: dice que el mecanismo no está roto, no
dice cuánto se ahorra ni con qué riesgo en producción.

Lo que hace falta para cerrar esa brecha, y que no está aquí: una muestra de
tráfico real anonimizado, etiquetada con la misma forma, y una medición del
ahorro contra la factura del proveedor.

---

## La forma de un caso

```jsonc
{
  "id": "sop-es-004",
  "idioma": "es",                  // "es" | "ca"
  "dominio": "soporte-y-politicas",
  "subdominio": "plazos-por-zona",
  "dificultad": "dificil",         // "facil" | "media" | "dificil"
  "trampas": ["entidad-casi-igual", "condicion"],

  "consulta": "…la consulta del usuario, tal como llega…",

  "evidencia": [                   // las unidades recuperadas
    { "id": "E1", "papel": "necesaria",      "texto": "…" },
    { "id": "E2", "papel": "distractora",    "texto": "…" },
    { "id": "E3", "papel": "contradictoria", "texto": "…",
      "vigencia": { "desde": "2020-01-01", "hasta": "2025-12-31" },
      "derogadaPor": "E4" }
  ],

  "respuesta": {                   // comprobable por máquina, nunca prosa
    "tipo": "estructurada",        // "estructurada" | "abstencion"
    "campos": { "zona": "Ceuta", "plazo_min_dias": 8, "plazo_max_dias": 12 }
  },
  "camposCriticos": ["zona", "plazo_min_dias", "plazo_max_dias"],
  "citas": ["E1"],                 // qué unidades sostienen la respuesta

  "abstencion": null,              // o { motivo, explicacion }
  "reglaDeDesempate": "…",         // obligatorio si hay contradictoria y no se abstiene
  "gemelo": { "caso": "sop-es-005", "porQueDifiere": "…", "colisionaEnCache": true },
  "nota": "el porqué del caso difícil"
}
```

Los papeles de la evidencia:

| papel | significado |
|---|---|
| `necesaria` | Sin ella la respuesta correcta es **imposible**. Va siempre en `citas`. |
| `distractora` | Plausible, del mismo tema, y **no hace falta**. Nunca en `citas`. |
| `contradictoria` | Dice lo contrario. El caso declara cuál manda (`derogadaPor`/`reglaDeDesempate`) o se abstiene. |

Una regla de diseño que las verjas imponen: **el papel de una unidad depende de
la consulta, no de su texto.** La misma cláusula es `necesaria` en un caso y
`distractora` en su gemelo (pasa en `sop-es-002`/`003` y `sop-ca-002`/`003`). Un
knapsack que decida el papel mirando solo el contenido se equivoca en uno de los
dos.

> Nota de coordinación: la forma la fija el agente de facturación. Esta es la
> implementación del mínimo acordado en el encargo (id, idioma, dominio,
> dificultad, consulta, unidades con papel, respuesta estructurada, campos
> críticos, citas, abstención motivada, `nota` en vez de comentarios). Si la
> forma publicada difiere en los nombres, la reconciliación es un renombrado
> mecánico: no hay información que falte ni que sobre.

---

## Reparto

| | casos |
|---|---|
| **Español** | 23 |
| **Catalán** | 17 (de los cuales 12 difíciles) |
| fácil / media / difícil | 2 / 10 / 28 |
| abstenciones | 3 (2 por contradicción sin desempate, 1 por dato ausente) |
| pares casi idénticos con respuesta distinta | 7 pares (14 casos) |

Subdominios: devoluciones, garantía, incidencias de transporte, plazos de entrega
por zona (Canarias, Ceuta, Melilla, Baleares), reembolsos, cambios y
cancelaciones.

El catalán no está por cuota: sostiene 12 casos difíciles repartidos en 7
subdominios, y ejercita la ela geminada (`cancel·lació`, `instal·lació`,
`anul·lació`, `sol·licitud`), l'apòstrof (`l'import`, `s'ha`, `d'aquest`,
`s'aportin`), los acentos abierto y cerrado, la doble negación normativa
(`tampoc no`) y el par `despeses`/`despesa`. Sin eso, «sin degradación por
idioma» —el criterio de aceptación de F6— no sería medible.

---

## Trampas cubiertas

| trampa | casos | qué explota |
|---|---:|---|
| `negacion` | 11 | «NO cubre» frente a «cubre»; `sin`/`sense` en la consulta |
| `condicion` | 17 | «siempre que se comunique en 24 horas» |
| `excepcion` | 8 | regla general y excepción en otro párrafo, lejos |
| `unidades` | 6 | con IVA / sin IVA; IGIC frente a IPSI frente a IVA |
| `verbo-modal` | 5 | `deberá`/`podrá`, `haurà de`/`podrà` |
| `entidad-casi-igual` | 4 | Ceuta / Melilla / Canarias / Baleares |
| `identificador-casi-igual` | 3 | `RMA 4471-A` / `4471-B`, `C-2026-118` / `C-2026-1118` |
| `referencia-cruzada` | 3 | «conforme a la cláusula 4.2», y la 4.2 está en otra unidad |
| `importes-parecidos` | 3 | `12.480,55` / `12.408,55`; `1.204,90` / `1.240,90` |
| `fechas-parecidas` | 3 | `30/06` y `06/08`, cruzando cambio de mes |
| `version-desactualizada` + `derogacion` | 5 | la política vieja y la vigente conviven en el índice |
| `abstencion` | 3 | la respuesta correcta es no responder |

---

## El hallazgo: qué colisiona hoy en la caché

Este es el dominio con más tráfico repetido, así que 7 pares del corpus son
**consultas casi idénticas con respuesta distinta** — justo lo que una caché mal
normalizada serviría cruzada.

No es una hipótesis. El campo `colisionaEnCache` de cada par está **medido**
contra el código real de este repo (`normalizeText` en
`src/canonicalization/canonicalize.ts` y `keyTokensMatch` en
`src/cache/semantic.ts`), y una verja del test lo vuelve a comprobar en cada
ejecución. **Los 7 pares atraviesan hoy el guardarraíl determinista.**

Tres causas, en orden de gravedad:

**1. El sufijo alfabético de un identificador es invisible para las dos verjas.**
`numericTokens` captura `4471-a` como token numérico (y le limpia el borde), e
`isContent` excluye del solapamiento Jaccard todo token que empiece por dígito.
Resultado: `RMA 4471-A` y `RMA 4471-B` no se distinguen **ni** por el
multiconjunto numérico **ni** por el solapamiento léxico. Un expediente aprobado
por 12.480,55 EUR y uno denegado comparten clave (`sop-es-006`/`007`). El par con
sufijo *numérico* (`C-2026-118` / `C-2026-1118`, `sop-ca-007`) sí se separa: la
diferencia no es de diseño, es un efecto lateral de dónde corta el regex.

**2. La lista de negaciones es anglocéntrica, y el código lo dice.**
`NEGATIONS` contiene `without`, no `sin` ni `sense`; no contiene `tampoco`,
`tampoc`, `excepto`, `excepte`, `llevat`, `cap` ni `ni`. La paridad de negación
—la verja pensada precisamente para que «seguro cubre» y «seguro NO cubre» no
colisionen— no ve la negación cuando está escrita en las dos lenguas del
producto. En `sop-ca-004`/`005`, `excepte` invierte la respuesta de `true` a
`false` y las dos consultas comparten clave.

**3. La protección decae con la longitud de la consulta.** El suelo de
solapamiento (Jaccard ≥ 0,75) protege una consulta corta y deja de proteger la
misma trampa en una consulta larga: cuando difiere 1 token de 18, el solapamiento
sigue muy por encima del umbral. Medido: `sense l'embalatge` frente a `amb
l'embalatge` se separa en la versión corta (0,714) y **colisiona** en la versión
larga y cortés. Lo mismo con `deberá`/`podrá`, `Ceuta`/`Melilla`,
`Canarias`/`Baleares` y `IVA incluido`/`IVA excluido`. El tráfico real de soporte
es largo y cortés: **el guardarraíl es más débil justo donde el tráfico es más
denso.**

Las consultas de los pares están escritas en su forma larga a propósito, porque
es la forma en que llegan.

### Qué hacer con esto

Nada, todavía — este corpus no arregla la caché, la documenta. Pero el par
`sop-es-006`/`007` es un fallo de la caché semántica **independiente del
knapsack**, y merece su propio arreglo y su propio PR. El resto es material de
diseño para F6: un knapsack no puede apoyarse en que la clave de caché distinga
estos casos, porque hoy no los distingue.

Si alguien mejora la normalización o el guardarraíl, la verja
`declara con exactitud qué pares atraviesan hoy el guardarraíl determinista`
falla y nombra el par que ha cambiado de lado. Esa es la reacción buscada:
actualizar el campo `colisionaEnCache` después de mirar qué cambió, no antes.

---

## Cómo se usa

```bash
npx vitest run test/corpus-soporte.test.ts
```

Hoy las verjas comprueban **el corpus**, no el knapsack: que no haya citas rotas,
que toda unidad necesaria esté citada y ninguna distractora lo esté, que los
campos críticos existan en la respuesta, que ningún valor sea prosa que haya que
juzgar a ojo, que las contradicciones tengan desempate o abstención, y que los
gemelos difieran de verdad en la respuesta **y** en la evidencia que los
sostiene. Un golden set con una cita rota aprueba a cualquiera.

Cuando exista el knapsack, el examen es el criterio de aceptación de F6:

1. **100 % de conservación de campos críticos.** Para cada caso, los
   `camposCriticos` de la respuesta producida tras la selección deben coincidir
   con los del corpus. Un solo campo perdido es un fallo, no un porcentaje.
2. **Citas válidas y accesibles.** Toda unidad de `citas` debe seguir presente en
   el contexto que se manda al modelo. Si el knapsack tira una unidad citada, la
   respuesta puede salir bien por casualidad y el caso igualmente falla.
3. **Sin degradación por idioma ni tipo documental.** La tasa de conservación en
   catalán y en español se compara por separado, y por subdominio.
4. **Las abstenciones se respetan.** En los 3 casos de abstención, responder es
   el fallo — aunque se acierte.
