// AUDITORÍA (SOLO LECTURA) de la comisión facturada a quien hoy no la debería.
//
// POR QUÉ EXISTE. Hasta el 2026-11-16 el cierre cobraba comisión a toda
// organización que no tuviera, el día 1, una suscripción VIVA en Pro o Equipo.
// Pro se vende desde el 2026-09-29, así que los cierres de septiembre y octubre
// pudieron facturar comisión a clientes de Pro o Equipo que habían cancelado o
// estaban impagados, y a organizaciones sin ninguna suscripción. La regla nueva
// (lib/billing/plan-de-la-org.ts, LICENSE-CLOUD §6(b)) deja de facturarlos, pero
// NO deshace lo ya facturado. Este script lista esos cargos para que el DUEÑO
// decida los abonos; no escribe nada, ni en la base ni en Stripe.
//
// QUÉ HACE. Lee `bvsala.cargos` en estado `facturado` o `pagado` desde un
// período (por defecto 2026-09), lee TODAS las filas de `bvsala.subscriptions`
// de esas organizaciones y aplica la MISMA función que usan el cierre y la
// facturación (`decidirComisionDelPeriodo`, importada del módulo, no copiada).
// Saca una línea por cargo cuya decisión de hoy es «sin comisión»:
//   org_id, periodo, importe_eur, estado, stripe_invoice_id, motivo, precios,
//   revisar, seguro
// `precios`: los price ids (no son secretos) de las suscripciones con las que
// se ha decidido. `seguro: true` SOLO si la decisión no es «revisar» Y todas
// esas suscripciones llevan uno de los Prices de Pro o Equipo declarados en
// STRIPE_PRICE_ID_PRO_*/TEAM_*. Todo lo demás es para mirar a mano:
//   · `revisar: true` (Price sin declarar, mes mixto, final no probado);
//   · un 0 apoyado en STRIPE_PRICE_IDS_SIN_COMISION — si ahí se archivó por
//     error un Price de comisión, su factura de comisión era CORRECTA y esto la
//     presentaría como abono;
//   · sin ninguna suscripción en juego (puede ser una fila que falta).
// Solo ids e importes; ningún dato del cliente.
//
// CUÁNDO: ANTES de desplegar la regla nueva (docs/RUNBOOK-ALERTAS.md §7.0), con
// el catálogo que se va a desplegar: es la comprobación de que ningún Price de
// comisión ha acabado en la lista sin comisión.
//
// LÍMITE: la decisión se hace con el estado de HOY de cada suscripción (no hay
// historial de precios). Un cambio de Price posterior dentro de la misma
// suscripción puede dar un falso candidato: comprobar en Stripe antes de abonar.
//
// LO EJECUTA EL DUEÑO, a mano — nunca un agente ni un despliegue. Uso (desde
// apps/web, Node ≥ 22.18: importa TypeScript sin compilar):
//
//   export NEXT_PUBLIC_SUPABASE_URL=…            # pública
//   export STRIPE_PRICE_ID_MONTHLY=… STRIPE_PRICE_ID_YEARLY=… STRIPE_PRICE_IDS_COMISION=… \
//          STRIPE_PRICE_ID_PRO_MONTHLY=… STRIPE_PRICE_ID_PRO_YEARLY=… \
//          STRIPE_PRICE_ID_TEAM_MONTHLY=… STRIPE_PRICE_ID_TEAM_YEARLY=… STRIPE_PRICE_IDS_SIN_COMISION=…
//   # La clave de servicio NUNCA en la línea de órdenes (queda en el historial):
//   read -rs "SUPABASE_SERVICE_ROLE_KEY?service role key: " && export SUPABASE_SERVICE_ROLE_KEY   # zsh
//   node scripts/auditoria-comision-indebida.mjs [--desde=2026-09] [--json]
//   unset SUPABASE_SERVICE_ROLE_KEY
//
// Las variables de Price tienen que ser LAS DE PRODUCCIÓN (los price ids no son
// secretos): con otro catálogo la decisión sería otra. La clave de Supabase se
// lee del entorno en el momento de ejecutar y NO se imprime ni se guarda; hace
// falta la de servicio porque `cargos` solo es legible por los miembros de cada
// organización (RLS). El script solo hace `select`.

import { pathToFileURL } from "node:url";

import { COLUMNAS_SUSCRIPCION_DEL_PERIODO, decidirComisionDelPeriodo, preciosDeLaDecision } from "../lib/billing/plan-de-la-org.ts";

/** Los estados de un cargo que son una factura emitida (0017). `fallido` no se cobró. */
export const ESTADOS_FACTURADOS = ["facturado", "pagado"];
/** El primer cierre que pudo facturar con Pro ya en venta. */
export const DESDE_POR_DEFECTO = "2026-09";

/**
 * La parte pura: de los cargos facturados, los de una organización que HOY no
 * llevaría comisión en ese período.
 *
 * @param {Array<{org_id: string, periodo: string, importe_eur: number|string, estado: string, stripe_invoice_id?: string|null}>} cargos
 * @param {Array<{org_id: string, price_id: string|null, status: string}>} suscripciones todas las filas de esas organizaciones
 * @param {{comision: readonly string[], pro: readonly string[], equipo: readonly string[], sinComision?: readonly string[]}} catalogo
 */
export function candidatosAAbono(cargos, suscripciones, catalogo) {
  const porOrg = new Map();
  for (const s of suscripciones) {
    const id = String(s.org_id);
    porOrg.set(id, [...(porOrg.get(id) ?? []), s]);
  }
  const deProOEquipo = new Set([...catalogo.pro, ...catalogo.equipo]);
  const salida = [];
  for (const c of cargos) {
    if (!ESTADOS_FACTURADOS.includes(String(c.estado))) continue;
    const filas = porOrg.get(String(c.org_id)) ?? [];
    const d = decidirComisionDelPeriodo(filas, catalogo, String(c.periodo));
    if (d.comision) continue;
    const precios = preciosDeLaDecision(filas, catalogo, String(c.periodo));
    salida.push({
      org_id: String(c.org_id),
      periodo: String(c.periodo),
      importe_eur: Number(c.importe_eur ?? 0),
      estado: String(c.estado),
      stripe_invoice_id: c.stripe_invoice_id ?? null,
      motivo: d.motivo,
      precios,
      revisar: d.revisar,
      // Abono seguro = cuota fija PROBADA por un Price de Pro o Equipo, no por
      // la lista libre STRIPE_PRICE_IDS_SIN_COMISION ni por la falta de filas.
      seguro: !d.revisar && precios.length > 0 && precios.every((p) => deProOEquipo.has(p)),
    });
  }
  return salida.sort((a, b) => a.periodo.localeCompare(b.periodo) || a.org_id.localeCompare(b.org_id));
}

async function leerTodo(constructor, tam = 1000) {
  const todo = [];
  for (let pagina = 0; ; pagina++) {
    const { data, error } = await constructor().range(pagina * tam, pagina * tam + tam - 1);
    if (error) throw new Error(error.message ?? String(error));
    todo.push(...(data ?? []));
    if ((data ?? []).length < tam) break;
  }
  return todo;
}

async function main() {
  const args = process.argv.slice(2);
  const desde = (args.find((a) => a.startsWith("--desde=")) ?? `--desde=${DESDE_POR_DEFECTO}`).slice("--desde=".length);
  const enJson = args.includes("--json");
  if (!/^\d{4}-\d{2}$/.test(desde)) {
    console.error(`--desde tiene que ser YYYY-MM (recibido: "${desde}")`);
    process.exit(1);
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const clave = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !clave) {
    // Por existencia, nunca por valor.
    console.error(`Faltan variables: NEXT_PUBLIC_SUPABASE_URL ${url ? "✓" : "✗"} · SUPABASE_SERVICE_ROLE_KEY ${clave ? "✓" : "✗"}`);
    process.exit(1);
  }
  // El MISMO lector de catálogo que la web (lee las variables STRIPE_PRICE_*).
  const { catalogoDeComision } = await import("../lib/stripe/env.ts");
  const catalogo = catalogoDeComision();
  if (catalogo.comision.length === 0 || catalogo.pro.length + catalogo.equipo.length === 0) {
    console.error(
      "El catálogo de Prices está incompleto: hacen falta las variables STRIPE_PRICE_* de PRODUCCIÓN " +
        `(con comisión: ${catalogo.comision.length}, Pro: ${catalogo.pro.length}, Equipo: ${catalogo.equipo.length}). ` +
        "Sin ellas todo saldría como candidato.",
    );
    process.exit(1);
  }

  const { createClient } = await import("@supabase/supabase-js");
  const supabase = createClient(url, clave, { auth: { persistSession: false, autoRefreshToken: false } });
  const bvsala = () => supabase.schema("bvsala");

  const cargos = await leerTodo(() =>
    bvsala()
      .from("cargos")
      .select("org_id, periodo, importe_eur, estado, stripe_invoice_id")
      .in("estado", ESTADOS_FACTURADOS)
      .gte("periodo", desde)
      .order("periodo", { ascending: true })
      .order("org_id", { ascending: true }),
  );
  const orgIds = [...new Set(cargos.map((c) => String(c.org_id)))];
  const subs = [];
  for (let i = 0; i < orgIds.length; i += 100) {
    const lote = orgIds.slice(i, i + 100);
    subs.push(
      ...(await leerTodo(() =>
        bvsala()
          .from("subscriptions")
          .select(COLUMNAS_SUSCRIPCION_DEL_PERIODO)
          .in("org_id", lote)
          .order("org_id", { ascending: true })
          .order("id", { ascending: true }),
      )),
    );
  }

  const candidatos = candidatosAAbono(cargos, subs, catalogo);
  if (enJson) {
    console.log(JSON.stringify({ desde, cargos_revisados: cargos.length, candidatos }, null, 2));
    return;
  }
  console.log(`Cargos facturados/pagados desde ${desde}: ${cargos.length}`);
  console.log(`Catálogo: ${catalogo.comision.length} Price(s) con comisión · ${catalogo.pro.length} Pro · ${catalogo.equipo.length} Equipo · ${(catalogo.sinComision ?? []).length} sin comisión declarados`);
  console.log(`Candidatos (la decisión de hoy es «sin comisión»): ${candidatos.length}\n`);
  if (candidatos.length > 0) {
    console.log("org_id\tperiodo\timporte_eur\testado\tstripe_invoice_id\tmotivo\tprecios\tveredicto");
    for (const c of candidatos) {
      const veredicto = c.seguro ? "seguro" : c.revisar ? "REVISAR" : "COMPROBAR";
      console.log([c.org_id, c.periodo, c.importe_eur.toFixed(2), c.estado, c.stripe_invoice_id ?? "", c.motivo, c.precios.join(",") || "(ninguno)", veredicto].join("\t"));
    }
    const total = candidatos.filter((c) => c.seguro).reduce((t, c) => t + c.importe_eur, 0);
    console.log(`\nTotal de los marcados «seguro» (solo Prices de Pro/Equipo declarados): ${total.toFixed(2)} €`);
    console.log("REVISAR (Price sin declarar, mes mixto, final no probado) y COMPROBAR (un 0 apoyado en STRIPE_PRICE_IDS_SIN_COMISION, o sin");
    console.log("ninguna suscripción) NO son un abono seguro: mirar en Stripe qué Price era y si llevaba comisión antes de abonar nada.");
  }
  console.log("\nNada se ha escrito. El abono (nota de crédito en Stripe) es decisión del dueño.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("La auditoría falló:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
