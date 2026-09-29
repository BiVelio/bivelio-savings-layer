**Asunto:** bvsala 0.4.32: actualiza, y el gateway necesita tu clave de servicio para arrancar

Hola,

Ya está publicada la versión 0.4.32 de `@bivelio/savings-layer`. Te pedimos que actualices, y te contamos un cambio del gateway que tienes que conocer antes.

**Cómo actualizar.**

```bash
npm install @bivelio/savings-layer@latest
```

**El gateway necesita la clave de servicio.** Esto afecta a `bvsala claude`, `bvsala codex`, `bvsala goose`, `bvsala qwen` y `bvsala gateway`. Desde la 0.4.24 el gateway no arranca sin `BIVELIO_SERVICE_KEY`: al arrancar comprueba que tu organización tiene una licencia activa. La tuya la tiene, así que no tienes que pagar ni pedir nada. Exporta la clave en todos los sitios desde los que lances `bvsala` (la terminal, el IDE y cualquier script):

```bash
export BIVELIO_SERVICE_KEY=bvk_…     # la misma de siempre, en tu panel → Instalar, paso 2
```

Si trabajas en una máquina sin salida a internet, exporta también `BIVELIO_LICENSE_KEY` (panel → Instalar, paso 1). Con ella la licencia se comprueba sin red.

**Cómo comprobarlo.** Al lanzar `bvsala claude` verás una línea `license: PRO, active until …`. Si en su lugar sale un error, el mensaje te dice qué falta y dónde conseguirlo.

**Qué trae la 0.4.32.**

- Gemini funciona a través de la capa, también con herramientas en varios turnos, y su coste incluye el pensamiento.
- gpt-5.6 con herramientas: pasa `reasoningEffort: "none"` en la petición.
- Compatibilidad con Claude Sonnet 5.5, que ya tiene precio propio en el catálogo.
- Con Anthropic, en bucles de herramientas, la capa deja el catálogo de herramientas en la caché del proveedor.
- Las respuestas en las que el modelo se niega, y las de temas sensibles, no se guardan en caché ni cuentan como ahorro.

Las notas completas están en la página de la versión en GitHub.

**Tu panel te avisará si una máquina se queda atrás.** Desde esta versión solo cuenta como ahorro verificado el de la 0.4.32 o posterior. Si alguna de tus máquinas sigue en una versión anterior, verás un aviso en el panel con el comando para actualizarla.

**Lo que no cambia.** Ninguna petición en curso se corta nunca. `bvsala doctor`, `bvsala skill`, `--help` y `--version` siguen funcionando sin clave.

Cualquier duda, responde a este correo.

Un saludo,
El equipo de BiVelio
