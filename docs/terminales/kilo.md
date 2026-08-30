# Kilo Code a través del gateway

**Fuente:** `docs/PASARELA-S3-TERMINALES.md` §3. Kilo Code configura por **UI**
(proveedor custom con Provider API «Anthropic Messages»; la config queda en
`kilo.json`, detectable) [V]. **La forma del base URL es inferida [I] por
linaje Cline: probar con `/v1` primero y validar en mano contra el log del
gateway.** No hay validación hecha; esta guía lo dice tal cual.

## Qué necesitas

- Kilo Code instalado en VS Code.
- Tu **API key** de Anthropic.
- `bvsala gateway` corriendo en `http://127.0.0.1:8402` (ver [README](README.md)).

## Pasos en la UI

1. Ajustes de Kilo Code → añade un **proveedor custom**.
2. **Provider API**: «Anthropic Messages».
3. Pega tu **API key** de Anthropic.
4. **Base URL** — prueba primero:

   ```
   http://127.0.0.1:8402/v1
   ```

   **Sin barra final.**
5. Elige el modelo y guarda.

## Validar en mano (obligatorio antes de fiarte)

Manda un mensaje trivial y mira la ventana del gateway:

- `[gateway] POST /v1/messages  · <modelo> · $…` → **con `/v1`** es la forma
  buena; confírmalo en S3 (pasar el [I] a [V]).
- `[gateway] POST /v1/v1/messages → 404` → Kilo ya añade `/v1`: quita el `/v1`
  del base URL (`http://127.0.0.1:8402`) y repite.
- `[gateway] POST /messages → 404` → falta el `/v1`; vuelve a ponerlo.
- nada en el log → el proveedor custom no es el activo.

## La trampa típica

- **Adivinar el `/v1`**: de ahí el paso de validación. Un URL mal formado falla
  en silencio (404 del upstream, nada medido, error genérico en la UI).
- **Gateway apagado**: `kilo.json` recuerda el base URL; sin `bvsala gateway`
  corriendo, Kilo fallará hasta que lo arranques o cambies de proveedor.

## Nota BYOK

**API key exclusivamente.** Anthropic prohíbe usar el OAuth de Claude Pro/Max en
harnesses de terceros; esta receta es la del proveedor custom con API key.
