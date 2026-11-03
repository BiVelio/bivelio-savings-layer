# Gemini CLI

`bvsala gemini` lanza la CLI de Gemini a través del gateway local, sin tocar su
configuración.

**Mecanismo [V]:** la CLI de Gemini solo habla el protocolo generativelanguage;
el gateway lo entiende desde la 0.6 (`:generateContent` y
`:streamGenerateContent`, con SSE `alt=sse` o JSON por líneas) y lee el
`usageMetadata` de cada respuesta. El `GOOGLE_GEMINI_BASE_URL` de la CLI apunta
al gateway, y tu `GEMINI_API_KEY` viaja en `x-goog-api-key`, intacta.

## Requisitos

- `bvsala` instalado (`npm i -g @bivelio/savings-layer`). Sin claves arranca en
  modo Community; `BIVELIO_SERVICE_KEY` (opcional) añade el panel.
- La CLI de Gemini instalada y tu `GEMINI_API_KEY` exportada.

## Un comando

```bash
bvsala gemini
```

A la salida imprime cuántas peticiones midió y cuáles reenvió sin medir, y por
qué.

## A mano

```bash
bvsala gateway --upstream gemini --port 8402   # el gateway con el dialecto Gemini
GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:8402 gemini
```

## Comprobar que mide

El log del gateway tiene que mostrar `POST /v1beta/models/…:streamGenerateContent`
con `$` y los tokens. Los modelos con precio de lista en el catálogo se meten a
precio de lista; uno sin fila se reenvía y la línea lo dice.
