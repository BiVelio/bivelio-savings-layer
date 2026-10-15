# D10 · Paridad TS ↔ Python (plan Caveman 2026-10-14)

**Estado:** interno y experimental. Nada de esto cambia lo que hace el paquete
de Python hoy (`bvsala` es un cliente del gateway): los dos módulos nuevos no se
exportan desde `bvsala/__init__.py` y nadie los llama salvo sus pruebas.

## Qué hay

| Pieza | Dónde | Qué hace |
| --- | --- | --- |
| Casos | `test/helpers/paridad.ts` | La lista de entradas, escrita a mano, con un nombre que explica cada una. |
| Vectores | `test/fixtures/paridad/json-estricto.json`, `uso-por-intento.json` | Entrada → salida esperada, **calculada por la implementación de TypeScript**. |
| Generador | `scripts/paridad-vectores.ts` (`pnpm paridad:vectores`, `--comprobar`) | Reescribe los vectores; con `--comprobar` sale 1 si alguno no está al día. |
| Python | `packages/python/src/bvsala/_json_estricto.py`, `_uso.py` | Las mismas funciones puras, solo biblioteca estándar. |
| pytest | `packages/python/tests/test_paridad.py` | Compara Python con los vectores, campo a campo. |
| vitest | `test/paridad-python.test.ts` | Vectores frescos + oráculos independientes + lanza el pytest de paridad (obligatorio en CI). |

### json-estricto

`compactToolOutput(texto, { profile: "lossless-data", minSavedChars })` con el
**estimador heurístico**: texto resultante, `applied`/`bypassed`, el código de
motivo (`applied`, `not_json`, `invalid_json`, `duplicate_keys`,
`invalid_unicode`, `not_smaller`, `below_threshold`), los tokens estimados y las
longitudes. Incluye claves duplicadas (raíz, a profundidad y por escape),
enteros de 64 bits, decimales y `1e400` tal como están escritos, escapes,
sustitutos sueltos en crudo y escapados, BOM, NBSP, comentarios, comas finales,
anidamiento de 3000 niveles. Y el estimador heurístico suelto, con los espacios
en los que `\s` de JavaScript y de Python **no** coinciden (`U+FEFF`, `U+0085`,
`U+001C..1F`).

### uso-por-intento

`normalizarUso` por dialecto (`anthropic`, `openai-chat`, `openai-responses`,
`provider-usage`) → `AttemptUsage`, y `tarifarIntento` → `priced` (micro-USD
entero + importe exacto en atto-USD) / `unpriced` / `uncertain` con su motivo y
su suelo. Incluye usage ausente, cortado, a medias, contadores como cadena,
booleano, fraccionario, negativo y por encima de 2^53, iteraciones de
compactación, alias `-latest`, instantánea con fecha, modelo sin precio, 200K
justo y 200K+1, y una mitad exacta de micro-USD (redondeo hacia arriba, no al par).

## Límites (lo que NO hace, y por qué)

- **Python no lleva el catálogo de precios.** El vector le da la *fila* que el
  catálogo de TS resolvió para ese modelo ese día (`null` si no hay precio).
  Emparejar ids, vetos, alias y tramos por día sigue siendo del gateway y del
  SDK; portarlo duplicaría la fuente de verdad del dinero.
- **Solo el estimador heurístico.** Python no tiene o200k ni el tokenizador de
  ningún proveedor sin dependencias. Pedir otro estimador devuelve
  `status: "passthrough"`, `reason: "unsupported_estimator"`.
- **Solo la transformación `json-lossless` v1.** Otra versión →
  `passthrough` / `unsupported_version`. Si TS sube la versión, el test de
  formato de pytest cae hasta que alguien porte la regla.
- **Dialecto desconocido** → `DialectoNoSoportado`, o `passthrough` /
  `unsupported_dialect` con `normalizar_o_passthrough`. Nunca un uso vacío que
  parezca medido.
- **Sin selección por mensaje.** `protected` (vista de fichero, herramienta
  exceptuada) es de `seleccionarCompactables`, que mira la conversación entera;
  aquí solo se porta la decisión sobre UN texto.
- **Cancelación y streaming quedan fuera.** El paquete de Python no ve el
  stream del proveedor ni lo corta: lo hace el gateway, y Python lee el informe
  que el gateway ya cerró (`Gateway.report`). La paridad de esos caminos es la
  del extremo a extremo que ya existe (`test/python-cliente.test.ts`).
- **No hay publicación.** Los módulos van en la rueda (están bajo `src/bvsala`)
  pero no son API: no se documentan en el README de PyPI.

## Cómo se mantiene

1. Se cambia una regla en TS (o un caso en `test/helpers/paridad.ts`).
2. `pnpm paridad:vectores` reescribe los ficheros; el diff enseña qué cambió.
3. `pnpm test` exige que estén frescos y lanza el pytest de paridad; en local
   sin Python ≥ 3.10 con pytest ese último paso se salta, en CI no.
