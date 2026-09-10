/**
 * LA SONDA DEL SDK — la primera integración real de la librería, y existe para
 * contestar UNA pregunta con datos: ¿se distingue el tráfico del SDK del tráfico
 * del gateway en la base de datos?
 *
 * Por qué hacía falta. A 10 de septiembre de 2026 hay CERO filas de SDK en
 * producción, en toda la historia de la base: 15.717 peticiones de gateway y
 * ninguna de la librería. No es que la separación esté rota — es que nadie ha
 * usado nunca el SDK, ni un cliente ni nosotros. Sin un solo dato de SDK no hay
 * dos cosas que separar, así que cualquier plan para separarlas es teoría.
 *
 * Esta sonda genera ese dato. Corre unas cuantas peticiones REALES a través de
 * `createSavingsLayer` con la clave de servicio puesta, de modo que el emisor
 * las marca `sdk/<versión>` y el ingest las sella. Después se mira
 * `bvsala.seat_activity`: si aparece una fila con prefijo `sdk`, la señal
 * funciona y separar los dos productos es viable. Si no aparece, lo sabemos por
 * unos céntimos en vez de después de una migración.
 *
 * NO hace falta ninguna migración para que esto responda: el prefijo de versión
 * ya viaja en una cabecera y la RPC ya lo funde en `seat_activity` desde 0024.
 *
 * Uso:
 *   pnpm sonda:sdk            # contra el proveedor configurado
 *   pnpm sonda:sdk --seco     # sin red y sin emitir: comprueba el cableado
 *
 * Variables (van en `.env.bench`, NUNCA en la línea de comandos ni en un log):
 *   BVSALA_SONDA_BASE_URL   endpoint compatible con OpenAI. Para Gemini:
 *                           https://generativelanguage.googleapis.com/v1beta/openai
 *   BVSALA_SONDA_API_KEY    la clave de ese proveedor
 *   BVSALA_SONDA_MODEL      p. ej. gemini-3.5-flash
 *   BIVELIO_SERVICE_KEY     la clave de servicio de la org (la que ya usa el gateway)
 *   BVSALA_SONDA_METERING   opcional; por defecto https://savings.bivelio.com
 */
import { createSavingsLayer, OpenAICompatibleProvider, type ToolDescriptor } from "../../src/index.js";
import { BV_SALA_VERSION } from "../../src/version.js";

const seco = process.argv.includes("--seco");
const baseUrl = process.env.BVSALA_SONDA_BASE_URL;
const apiKey = process.env.BVSALA_SONDA_API_KEY;
const model = process.env.BVSALA_SONDA_MODEL ?? "gemini-3.5-flash";
const serviceAccountKey = process.env.BIVELIO_SERVICE_KEY;
const licenseServerUrl = process.env.BVSALA_SONDA_METERING ?? "https://savings.bivelio.com";

function faltan(): string[] {
  const f: string[] = [];
  if (!seco) {
    if (!baseUrl) f.push("BVSALA_SONDA_BASE_URL");
    if (!apiKey) f.push("BVSALA_SONDA_API_KEY");
    if (!serviceAccountKey) f.push("BIVELIO_SERVICE_KEY");
  }
  return f;
}

/**
 * Un catálogo de herramientas TAL COMO LLEGA DE UN CLIENTE REAL: nombre,
 * descripción y esquema, sin `intents` ni `risk`. Es exactamente la forma que
 * hacía que el selector emitiera CERO herramientas o reventara antes de #250, y
 * por eso va en la sonda: si la librería sobrevive a esto, sobrevive a un
 * catálogo MCP de verdad.
 */
const CATALOGO_CRUDO = [
  { id: "buscar_pedido", description: "Busca un pedido por su número" },
  { id: "estado_envio", description: "Consulta el estado de un envío" },
  { id: "abrir_incidencia", description: "Abre una incidencia de soporte" },
  { id: "listar_facturas", description: "Lista las facturas de un cliente" },
] as unknown as ToolDescriptor[];

/** Las peticiones de la sonda, elegidas para tocar palancas DISTINTAS. */
const PETICIONES: { nombre: string; que: string; req: Record<string, unknown> }[] = [
  {
    nombre: "resolutor local",
    que: "no debería llegar al proveedor: la capa lo resuelve sin modelo",
    req: { messages: [{ role: "user", content: "¿Cuánto es 128 * 64?" }] },
  },
  {
    nombre: "pregunta normal",
    que: "una llamada corriente, la línea base",
    req: { messages: [{ role: "user", content: "En una frase: ¿qué es una caché de prefijo?" }] },
  },
  {
    nombre: "misma pregunta, otra vez",
    que: "debería salir de la caché exacta y evitar la llamada",
    req: { messages: [{ role: "user", content: "En una frase: ¿qué es una caché de prefijo?" }] },
  },
  {
    nombre: "catálogo sin tipar",
    que: "el selector no puede podar sin señal: debe pasar las herramientas ÍNTEGRAS",
    req: {
      messages: [{ role: "user", content: "¿Dónde está mi pedido 4417?" }],
      tools: CATALOGO_CRUDO,
    },
  },
  {
    nombre: "datos estructurados",
    que: "el selector de formato elige la codificación más barata",
    req: {
      messages: [{ role: "user", content: "¿Qué región vendió más?" }],
      structuredData: [
        { region: "norte", ventas: 1200, devoluciones: 14 },
        { region: "sur", ventas: 980, devoluciones: 9 },
        { region: "este", ventas: 1430, devoluciones: 22 },
        { region: "oeste", ventas: 1105, devoluciones: 11 },
      ],
    },
  },
];

async function main(): Promise<void> {
  const ausentes = faltan();
  if (ausentes.length) {
    console.error(`\n✗ faltan variables en .env.bench: ${ausentes.join(", ")}`);
    console.error("  Añádelas TÚ al fichero; la sonda nunca las imprime ni las pide por consola.\n");
    process.exit(1);
  }

  console.log(`\nSONDA DEL SDK · v${BV_SALA_VERSION}`);
  console.log(`  modelo:     ${model}`);
  console.log(`  medición:   ${seco ? "APAGADA (--seco)" : `${licenseServerUrl}/api/metering/usage`}`);
  console.log(`  marca:      sdk/${BV_SALA_VERSION}   ← lo que debe aparecer en seat_activity`);
  console.log("");

  if (seco) {
    console.log("(--seco) cableado correcto: la sonda sabe construir la capa y no toca la red.");
    console.log(`Peticiones que lanzaría: ${PETICIONES.length}.\n`);
    return;
  }

  const layer = createSavingsLayer({
    provider: new OpenAICompatibleProvider({ baseUrl: baseUrl!, apiKey: apiKey! }),
    serviceAccountKey,
    licenseServerUrl,
    // El emisor agrupa por tiempo; con tan pocas peticiones se fuerza el envío
    // al cerrar, así que el intervalo largo evita lotes a medias.
    metering: { flushIntervalMs: 60_000 },
  });

  let ok = 0;
  let fallos = 0;
  for (const p of PETICIONES) {
    process.stdout.write(`  · ${p.nombre.padEnd(24)}`);
    try {
      const r = await layer.generate({ model, ...p.req } as never);
      const c = r.report.calls;
      const evitadas = c.avoidedLlm ?? 0;
      console.log(
        `llamadas ${c.actualLlm} (evitadas ${evitadas})` +
          `  entrada ${r.report.tokens.actualInput}  salida ${r.report.tokens.actualOutput}` +
          `  caché: ${r.report.cache.result}`,
      );
      ok += 1;
    } catch (e) {
      console.log(`✗ ${e instanceof Error ? e.message : String(e)}`);
      fallos += 1;
    }
  }

  // El cierre normal dispara el envío sin esperarlo; aquí SÍ se espera, porque
  // el dato que buscamos es justo el que llega al final.
  layer.close();
  await new Promise((r) => setTimeout(r, 2500));

  console.log(`\n  ${ok} peticiones servidas, ${fallos} fallidas.`);
  console.log("\nAhora comprueba en la base de datos (solo lectura):");
  console.log("  select seat_id, client_version_min, client_version_max, requests");
  console.log("    from bvsala.seat_activity where day = current_date order by 1;");
  console.log(`\nSi aparece una fila con \`sdk/${BV_SALA_VERSION}\`, la señal funciona.\n`);
}

await main();
