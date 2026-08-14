# Contratos y clausulado — 50 casos

Golden set del dominio de contratos para el knapsack de evidencia (F6).

**La limitación que vale para todo lo que hay aquí está en el
[README de arriba](../README.md) y se resume así: es un golden set sintético;
demuestra que el mecanismo no descarta un campo crítico, y no demuestra que en
el tráfico real de un cliente el ahorro se materialice ni que la distribución de
casos difíciles se parezca.**

## Ficheros

- `contratos.es.json` — 30 casos en castellano.
- `contratos.ca.json` — 20 casos en catalán.
- Forma y utilidades: [`../forma.ts`](../forma.ts).
- Verja: `test/corpus-contratos.test.ts` (23 comprobaciones).

## Reparto

| | |
|---|---:|
| Casos | 50 |
| Unidades de evidencia | 190 |
| Castellano / catalán | 30 / 20 |
| Fácil / media / difícil | 6 / 10 / 34 |
| Abstenciones | 9 |
| Casos con trampa de campo declarada | 41 |
| Pares gemelos | 16 (15 cruzados es↔ca, 1 de desempate) |

Subdominios, entre 5 y 7 casos cada uno: prestación de servicios, arrendamiento,
confidencialidad, niveles de servicio, penalización por retraso, prórroga tácita,
resolución anticipada y protección de datos.

## Trampas y cuántos casos las ejercitan

| Trampa | Casos | Ejemplo |
|---|---:|---|
| `condicion` | 24 | «siempre que se comunique con 15 días de antelación» (ct-es-003) |
| `importes-parecidos` | 15 | 12.480,55 contra 12.408,55 (ct-es-002) |
| `referencia-cruzada` | 14 | «la bonificación prevista en la cláusula 6.5» (ct-es-005) |
| `fechas-parecidas` | 11 | fecha de envío contra fecha de recepción (ct-es-006) |
| `negacion` | 10 | «no tendrá la consideración de Información Confidencial» (ct-es-004) |
| `abstencion` | 9 | 85 EUR/h contra 92 EUR/h sin prelación (ct-es-009) |
| `verbo-modal` | 8 | «deberá» contra «podrá» (ct-es-017) |
| `excepcion` | 8 | la excepción ocho cláusulas por debajo de su regla (ct-es-003) |
| `derogacion` | 7 | adenda posterior que deja sin efecto la 12.1 (ct-es-007) |
| `unidades` | 5 | EUR/m² × m² × IVA (ct-es-011) |
| `apostrofo` | 4 | l'import, s'ha, d'aquest (ct-ca-001) |
| `identificadores-parecidos` | 3 | NDA-2024-118 / NDA-2024-1118 / NDA-2023-118 (ct-es-013) |
| `ela-geminada` | 3 | Col·legi ≡ Collegi, instal·lació (ct-ca-002) |
| `diacriticos` | 2 | «més» y «mes» plegados al mismo token (ct-ca-014) |

Las tres últimas filas son las **más flojas del corpus** y conviene decirlo: tres
casos de identificadores y dos de diacríticos bastan para detectar una rotura
gruesa, no para caracterizarla. Si F6 falla ahí, hacen falta más casos antes de
sacar conclusiones sobre la magnitud.

## Las cuatro cosas que hacen que un caso pueda fallar

1. **Presupuesto que aprieta.** `maxUnidades` es siempre menor que el número de
   unidades y nunca menor que las citas obligatorias: siempre hay que tirar algo
   y siempre existe una elección correcta. Si cupiera todo, mandarlo todo sería
   óptimo y el caso no mediría nada.
2. **La unidad que decide no es la que más se parece a la pregunta.** Es el
   patrón que se repite en casi todos los difíciles: en ct-es-014 la cláusula que
   mata el derecho a cobrar no contiene ni una cifra de dinero; en ct-es-010 la
   que resuelve el conflicto de precios no contiene ni «precio» ni «hora».
3. **Trampa invertida.** En las derogaciones (ct-es-007, ct-es-016, ct-es-022,
   ct-ca-010, ct-ca-019) la cláusula muerta responde a la consulta *mejor* que la
   que manda. Un selector por parecido se queda justo con la equivocada.
4. **El campo crítico no es solo la conclusión.** En ct-es-006 y ct-ca-016 la
   conclusión sale bien por dos caminos y solo un campo intermedio
   (`dias_de_antelacion`, `data_limit`) delata que el razonamiento era otro. Sin
   ese campo, una selección rota aprobaría el caso.

## Pares gemelos

Un gemelo comparte esqueleto y cambia **una** cosa. Son 16:

- **15 cruzados es↔ca** (p. ej. ct-es-003 ↔ ct-ca-009): miden la degradación por
  idioma en estado puro. Cualquier diferencia de resultado entre los dos no se
  puede atribuir al caso.
- **4 de esos 15 son asimétricos**: cambian un dato para invertir la respuesta
  (ct-es-002 aplica el tope y ct-ca-005 no; ct-es-006 se prorroga y ct-ca-006 no;
  ct-es-005 cae en el tramo del 5 % y ct-ca-011 en el del 15 %; ct-es-014 caduca
  y ct-ca-016 no). Un selector que memorice la forma del caso acierta uno y falla
  el otro.
- **1 de desempate en el mismo idioma**: ct-es-009 / ct-es-010, mismas unidades
  salvo la cláusula de prelación. Es la prueba de que abstenerse no es miedo:
  quitando esa única unidad, la respuesta correcta pasa de «85 EUR» a «no
  contestes».

## Abstenerse

Nueve casos, en los dos idiomas y por los dos motivos:

- **`contradiccion-sin-regla-de-desempate`** (7): ct-es-009, ct-es-023,
  ct-es-027, ct-es-030, ct-ca-008, ct-ca-017, ct-ca-020. En todos, misma fecha de
  documento y ninguna cláusula de prelación, así que ni «lo posterior deroga» ni
  «prevalece el anexo» tienen dónde apoyarse. ct-es-030 y ct-ca-017 cazan además
  un error concreto: creer que dentro de un mismo contrato la cláusula 4.6
  prevalece sobre la 4.2 por ir después.
- **`evidencia-insuficiente`** (2): ct-es-015 y ct-ca-012, donde la evidencia
  remite a un Anexo V que no está. La respuesta correcta es nombrar lo que falta,
  no inferir un sí.

En una abstención, las **dos** unidades del conflicto son citas obligatorias:
con una sola, abstenerse deja de estar justificado y la respuesta equivocada sale
perfectamente redactada.

## Castellano y catalán

El reparto es real: 20 casos en catalán, no una traducción de cortesía. Lo que se
ejercita es lo que de verdad rompe, y varias notas del corpus apuntan a código
concreto de este repositorio:

- **Ela geminada.** `normalizeText` (`src/canonicalization/canonicalize.ts`)
  trata el punt volat entre letras como adorno: `col·legi` → `collegi`,
  `instal·lació` → `installacio`. El corpus escribe las dos grafías a propósito
  (ct-ca-002, ct-ca-008) porque en un registro real conviven.
- **Apóstrofo.** `l'import`, `s'ha`, `d'aquest` sobreviven a la normalización
  —dentro de palabra el apóstrofo es ortografía, no adorno—, pero pegan el
  artículo al sustantivo y con ello el sujeto al verbo: en ct-ca-007 la marca que
  distingue «l'Encarregat notifica» de «el Responsable notifica» queda dentro de
  una sola palabra normalizada.
- **Diacríticos.** `més` (cantidad) y `mes` (unidad de tiempo) salen como el
  mismo token. ct-ca-014 y ct-ca-016 lo explotan sobre texto jurídico, donde
  decide si un descuento se aplica el mes siguiente o nunca. El repositorio ya
  pagó esta factura una vez: el 2026-08-14 se descubrió que plegar diacríticos
  dejaba muda una herramienta cuyo `intent` iba acentuado.
- **`despeses` / `despesa`.** ct-ca-008: la unidad que contradice usa el
  singular, así que no comparte token con la consulta y es la primera que se cae.

Y un hueco **documentado, no arreglado**: la lista `NEGATIONS` de
`src/cache/semantic.ts` está escrita en inglés. El castellano cuela de rebote
porque «no» coincide, pero `sin`, `sense`, `cap` y `ni` no están, así que la
paridad de negación de `keyTokensMatch` no las cuenta. Las notas de ct-ca-003 y
ct-ca-013 lo dicen, y hay un test que lo fija: si alguien amplía la lista, ese
test falla y lo que toca es actualizar las notas, no relajar la comprobación.
Quien escriba F6 no debe suponer que ese guardarraíl existe en catalán.

## Convenciones

- **Los JSON no llevan comentarios.** El porqué de cada caso va en `nota`, y el
  de cada unidad peligrosa en `unidades[].nota`.
- **Nada de prosa libre en la respuesta.** Todo `respuesta.campos` es comparable
  por máquina: importes, fechas ISO, identificadores, booleanos, la cláusula que
  aplica. Los campos acabados en `_eur`, `_pct`, `_dias`, `_horas`, `_m2`,
  `_anys`, `_dies` o `_hores` son números, no texto — la verja lo comprueba.
- **Un caso, un documento coherente.** Las cláusulas citadas dentro de un caso
  pertenecen al mismo contrato imaginario, con su numeración y sus fechas.
