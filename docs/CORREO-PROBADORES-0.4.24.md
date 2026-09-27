**Asunto:** bvsala: desde la próxima versión el gateway necesita tu clave de servicio para arrancar

Hola,

Con la próxima versión de `@bivelio/savings-layer` cambia una cosa del gateway (`bvsala claude`, `bvsala codex`, `bvsala goose`, `bvsala qwen`, `bvsala gateway`).

**Qué cambia.** Hasta ahora, si no tenías `BIVELIO_SERVICE_KEY` exportada, el gateway reenviaba el tráfico sin medirlo. A partir de esta versión no arranca sin ella. Al arrancar comprueba que tu organización tiene una licencia activa, y la tuya la tiene: no tienes que pagar ni pedir nada.

**Qué tienes que hacer.** Exporta la clave de servicio que ya usas en todos los sitios desde los que lances `bvsala`, es decir la terminal, el IDE y cualquier script:

```bash
export BIVELIO_SERVICE_KEY=bvk_…     # la misma de siempre, en tu panel → Instalar, paso 2
```

Si trabajas en una máquina sin salida a internet, exporta también `BIVELIO_LICENSE_KEY` (panel → Instalar, paso 1). Con ella la licencia se comprueba sin red.

**Cómo comprobarlo.** Al lanzar `bvsala claude` verás una línea `license: PRO, active until …`. Si en su lugar sale un error, el mensaje te dice exactamente qué falta y dónde conseguirlo.

**Lo que no cambia.** Ninguna petición en curso se corta nunca. `bvsala doctor`, `bvsala skill`, `--help` y `--version` siguen funcionando sin clave.

Cualquier duda, responde a este correo.

Un saludo,
El equipo de BiVelio
