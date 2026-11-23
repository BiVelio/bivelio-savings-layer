Todas las herramientas de costes de LLM enseñan una cifra de ahorro. Pocas enseñan cómo comprobarla, y es en la comprobación donde se desmoronan la mayoría de las promesas: el panel muestra un gran ahorro y la factura apenas se mueve. Esta guía da un método que puedes aplicar con cualquier herramienta, o sin ninguna: qué registrar, cómo conciliarlo con los datos de uso del proveedor, cómo distinguir un ahorro real de una estimación y cómo asegurarte de que el ahorro vino del cambio que hiciste. Al final verás cómo el SDK open source BV-SALA etiqueta cada importe para que esta comprobación sea posible.

## Por qué no cuadran las cifras de ahorro y las facturas

La diferencia casi siempre viene de una de estas causas:

- **Precio de lista frente a tu precio.** Las herramientas valoran los tokens a los precios de lista públicos. Tu factura puede incluir descuentos, contratos de consumo comprometido, tarifas regionales o de residencia de datos, niveles de prioridad e impuestos.
- **Estimaciones presentadas como mediciones.** Si una herramienta quitó 2000 tokens de un prompt, el proveedor nunca los contó. La cifra «ahorrada» es el recuento de la propia herramienta, hecho con un tokenizador que puede no ser el del proveedor.
- **El descuento del proveedor atribuido a la herramienta.** La caché de prompts de OpenAI, Anthropic, DeepSeek o Gemini la factura el proveedor a una tarifa más baja. Una herramienta que cuenta ese descuento como ahorro propio infla su cifra.
- **Tráfico que la herramienta nunca vio.** Las llamadas de otro servicio, el script de un compañero, las peticiones secundarias de un agente de programación o un proceso batch aparecen todas en la factura y no en la herramienta.
- **Uso que no llega.** Una petición en streaming sin su evento final de uso no tiene ningún recuento de tokens. Contarla como cero sin avisar hace que todo lo que viene después parezca más barato.
- **El tiempo.** Los proveedores agrupan el uso por día UTC, y parte del uso aparece con retraso.

## El método, paso a paso

### 1. Registra los contadores del propio proveedor en cada petición

No tu estimación: el bloque `usage` que devolvió el proveedor. Entrada, entrada en caché (y escrituras de caché donde existan), salida, tokens de razonamiento, el id de modelo que indica el proveedor, la clave de API o el proyecto, y el timestamp UTC. Marca una petición cuyo uso no llegó como **sin medir**, nunca como cero.

### 2. Concilia los tokens antes que los dólares

Exporta el uso diario del proveedor para las mismas claves y los mismos días: la [Usage API](https://developers.openai.com/api/reference/resources/organization/subresources/usage) de OpenAI, la [Usage and Cost API](https://platform.claude.com/docs/en/manage-claude/usage-cost-api) de Anthropic o las páginas de uso de las consolas de DeepSeek y Model Studio. Después compara partida por partida:

```ts
interface Row { day: string; model: string; input: number; cachedInput: number; output: number }

function byDayAndModel(rows: Row[]): Map<string, Row> {
  const totals = new Map<string, Row>();
  for (const r of rows) {
    const k = `${r.day}|${r.model}`;
    const t = totals.get(k) ?? { day: r.day, model: r.model, input: 0, cachedInput: 0, output: 0 };
    t.input += r.input;
    t.cachedInput += r.cachedInput;
    t.output += r.output;
    totals.set(k, t);
  }
  return totals;
}

/** Lines where your log and the provider disagree by more than the tolerance. Empty means they agree. */
export function reconcile(mine: Row[], provider: Row[], tolerance = 0.01): string[] {
  const a = byDayAndModel(mine);
  const b = byDayAndModel(provider);
  const gaps: string[] = [];
  for (const k of new Set([...a.keys(), ...b.keys()])) {
    for (const field of ["input", "cachedInput", "output"] as const) {
      const yours = a.get(k)?.[field] ?? 0;
      const theirs = b.get(k)?.[field] ?? 0;
      const gap = theirs === 0 ? (yours === 0 ? 0 : 1) : Math.abs(yours - theirs) / theirs;
      if (gap > tolerance) gaps.push(`${k} ${field}: yours ${yours}, provider ${theirs}`);
    }
  }
  return gaps;
}
```

Si los tokens cuadran, tu registro está completo y puedes fiarte del resto del análisis. Si el proveedor muestra más, encuentra el tráfico que no estás registrando antes de seguir.

### 3. Después ponle precio, con una tabla de precios fechada

Multiplica cada partida por su tarifa, guarda la fecha en que copiaste las tarifas y compara con el informe de costes del proveedor. Una diferencia estable de un pequeño porcentaje suele ser un descuento o una tarifa regional, y es la misma con y sin tu optimización, así que no cambia el ahorro.

### 4. Mantén separadas tres clases de cifras

- **Medido:** leído del contador del proveedor para una llamada que se ejecutó.
- **Medido por referencia:** una llamada que no se hizo (un acierto de caché, una petición deduplicada), valorada con el contador del proveedor de la llamada idéntica que sí se ejecutó. Es la mejor prueba disponible de una llamada que nunca ocurrió.
- **Estimado:** todo lo que el proveedor nunca contó, como los tokens que una herramienta quitó de un prompt.

Suma cada clase por separado. Nunca sumes importes estimados a los medidos, y nunca promedies porcentajes entre peticiones: suma el dinero y luego divide.

### 5. Separa el descuento del proveedor del tuyo

Los tokens de entrada en caché son más baratos gracias al proveedor. Si no cambiaste nada y tu tasa de aciertos ya era alta, ese descuento no es un ahorro de tu proyecto. Valora los tokens en caché a la tarifa de caché en los dos lados de la comparación; lo que queda es tuyo.

## ¿El ahorro lo causó el cambio?

Una factura que baja tras un despliegue también puede ser una semana tranquila. Para atribuir un ahorro:

- **Ejecuta dos brazos a la vez.** Envía las mismas peticiones con y sin el cambio, al mismo tiempo y con la misma clave, y compara los contadores del proveedor de ambos. Repartir las peticiones al azar entre los brazos es la versión limpia.
- **Da un intervalo, no un punto.** Remuestrea conversaciones o días enteros y di «entre X e Y %». Un intervalo que cruza el cero significa que no puedes distinguir la diferencia del ruido, y eso es un resultado legítimo.
- **Comprueba la calidad en la misma ejecución.** Una respuesta más barata pero errónea no es un ahorro. Mide la precisión, o una comprobación propia de la tarea, en los dos brazos.

## Cómo hace BV-SALA posible esta comprobación

[BV-SALA](https://github.com/BiVelio/bivelio-savings-layer) es una capa de ahorro Apache-2.0, gratis y sin clave. Cada petición devuelve un `SavingsReport` pensado exactamente para este método:

- `cost.basis` es `measured`, `reference`, `estimated` o `unmeasured`, con las definiciones de arriba. Una repetición solo se valora por referencia cuando la llamada que se ejecutó fue directamente a la API de OpenAI, de Anthropic o de Gemini de Google; en cualquier otro caso se queda en `estimated`.
- El ahorro se lleva en cuatro libros contables separados que nunca se suman en una sola cifra: `avoided_calls`, `eliminated_tokens`, `compressed_tokens` y `provider_cached_tokens`.
- El descuento de caché del propio proveedor se da aparte, en `report.nativeSavings`, y nunca se cuenta como ahorro de la capa.
- Un stream que termina sin su uso es `unmeasured`, nunca se valora como cero.

Sumar los informes por base cuesta unas pocas líneas:

```ts
import type { SavingsReport } from "@bivelio/savings-layer";

/** Spend and saving per basis. Never mix bases, never average ratios. */
export function totalsByBasis(reports: SavingsReport[]) {
  const totals: Record<string, { requests: number; spendUsd: number; savedUsd: number }> = {};
  for (const r of reports) {
    const t = (totals[r.cost.basis] ??= { requests: 0, spendUsd: 0, savedUsd: 0 });
    t.requests += 1;
    t.spendUsd += r.cost.actual;
    t.savedUsd += r.cost.netSavingsUsd;
  }
  return totals;
}
```

Desde Python, el cliente del paquete lee los mismos informes del gateway local y mantiene la misma separación:

```python
# pip install bivelio-savings-layer
import bvsala

gw = bvsala.Gateway("http://127.0.0.1:8403")
# ... send requests with gw.wrap(client) and read each one with gw.report(response) ...
t = gw.totals()
print(t.requests, t.metered, t.not_metered, t.actual_cost_usd)
print(t.net_savings_usd_by_basis)  # one amount per basis, never added together
```

Después aplica el paso 2 de arriba a estos totales: el gasto `measured` de la capa debería coincidir con el uso del proveedor para la misma clave y el mismo día, exactamente en tokens y, en dólares, salvo tus descuentos. Los informes valoran a precio de lista; no son una factura.

## El mismo método, aplicado en público

El proyecto publica sus propias ejecuciones A/B en la [página del banco público](/es/benchmarks): dos brazos con las mismas peticiones, uno directo al proveedor y otro a través de la capa, ambos medidos con el contador de uso del propio proveedor, con intervalos del 95 % y la fecha y la versión de cada ejecución. Los resultados que no ahorraron nada, o que costaron más, están en la misma página. El método completo, el estimador y sus límites están en [el paper](/es/paper).

Para los detalles de cada proveedor, consulta [por qué cached_tokens es 0 en OpenAI](/es/guides/openai-prompt-caching-cached-tokens), [por qué no funciona el prompt caching de Claude](/es/guides/claude-prompt-caching-not-working) y [cómo medir el coste de Claude Code por petición](/es/guides/claude-code-cost-per-request). El código y los informes en bruto están en [GitHub](https://github.com/BiVelio/bivelio-savings-layer).
