# D11 · `bvsala init` con evidencia (plan Caveman 2026-10-14)

**Estado:** opt-in. Sin `--compaction`, `init` imprime, escribe y devuelve en JSON
exactamente lo mismo que antes (un test lo exige para cada capa × proveedor).
No hay un segundo punto de entrada: todo vive en `gateway/init.ts` y
`gateway/init-fragmentos.ts`.

## Qué hace

```
bvsala init [--stack S] [--provider P] --compaction off|measure|on [--write [--yes]] [--json]
node bivelio-verify-compaction.mjs        # la verificación que init propone (y escribe con --write)
```

| Modo | Inferencia | Lo que init añade |
| --- | --- | --- |
| `off` (por defecto) | igual | nada |
| `measure` | **igual**, el cableado es el de siempre byte a byte | `measure-tool-outputs.*`: `measureToolOutput(output)` devuelve el output intacto y apunta qué haría `lossless-data`; `measuredSummary()` da la cobertura primero |
| `on` | la copia enviada al modelo lleva los tool outputs JSON sin espacio | una opción en el cableado, `toolOutputCompaction: { profile: "lossless-data" }`, enseñada como **diff unificado** que se revisa y se deshace (borrando esas líneas, o `git apply -R`) |

Con `measure` o con `on`, el plan trae además `bivelio-verify-compaction.mjs`. Es
**una** llamada local y acotada, con un tope de 10 s, a un modelo falso que vive
en el propio script.

**Por qué es un script y no `init --verify`:** init no ejecuta nada del
proyecto, y el gateway nunca construye la capa del SDK; lo exige
`test/no-solape-gateway-pipeline.test.ts`, la verja que impide contar dos
veces los mismos tokens. Un primer intento en proceso la rompía y se descartó.

El script imprime el recibo de cada tool output (aplicado o desviado y por qué,
tokens antes → después, estimados) y lo comprueba contra lo que el modelo
**recibió**:

- los ids de herramienta no cambian;
- lo desviado sale byte a byte;
- en `measure`, la capa no compacta nada;
- lo aplicado vuelve a leerse como el mismo JSON.

Después imprime la **cobertura de la muestra** y dice que no es la del cliente.

## Dónde se puede encender (`on`)

Decisión provisional, revisable por el dueño: el piloto es la API de Mensajes de
Anthropic, sin stream, a través del SDK.

| Pila | `on` | Por qué |
| --- | --- | --- |
| SDK (`createSavingsLayer`) + Anthropic | **sí** | la capa construye la petición que manda |
| SDK + OpenAI | no | fuera del piloto: las peticiones de OpenAI quedan como están |
| ai-sdk, Mastra, LangChain.js, Anthropic SDK | no | el adaptador reenvía la petición que construyó el framework **tal cual** y rechaza una reescrita (`puente.ts`); además sus opciones no aceptan `toolOutputCompaction` (TS2353) |

Donde no se admite, `init` lo dice con el motivo, el cableado no cambia ni un
byte, y se ofrece `measure`.

## Límites

- **La muestra no es el tráfico del cliente.** La cobertura que imprime
  verificación (1 de 3) es la de tres tool outputs fijos. No se promete ningún
  ahorro: la cobertura propia solo se conoce midiendo (`measure`).
- **Los tokens son estimaciones** del estimador heurístico (no hay tokenizador
  local de Anthropic), nunca un ahorro verificado.
- **El streaming.** La opción también corre en `generateStream()`. El piloto solo
  verifica `layer.generate()`, y el comentario del cableado dice cómo apagarla en
  una petición (`savings: { toolOutputCompaction: false }`).
- **La licencia.** La verificación crea la capa sin `licenseServerUrl` ni
  `serviceAccountKey`: la licencia se verifica fuera de línea y no se emite uso.
  La clave se lee **solo del entorno** (`BIVELIO_LICENSE_KEY`): no hay argumento
  para ella, no se imprime, y un `LicenseError` se reescribe sin eco de su valor.
  Una licencia sin `long_context_compression` hace que la capa no compacte, y
  la verificación lo dice (`not ok`, salida 1).
- **Un cableado existente no se lee.** `init` sigue leyendo solo `package.json`.
  Si el fichero ya existe, se dice que se añadan las líneas `+` del diff.

## Evidencia

- `test/init-compactacion.test.ts`:
  - el diff se aplica y se revierte con `git apply` y da, byte a byte, el cableado con y sin la opción;
  - con `measure` el cableado es idéntico;
  - el módulo de medición devuelve cada output intacto;
  - los dos scripts de verificación se ejecutan con la red prohibida y dicen «ok»;
  - una licencia inválida dice «not ok» sin imprimir su valor;
  - el CLI de verdad imprime el diff y, con `--write --yes`, escribe el cableado con la opción.
- `test/init-ejemplos.test.ts`:
  - los ejemplos nuevos `examples/stacks/sdk-anthropic-compaction/` y `sdk-anthropic-measure/` son la salida de init;
  - compilan en strict y como JavaScript;
  - su comprobación dice «ok» sin red.
