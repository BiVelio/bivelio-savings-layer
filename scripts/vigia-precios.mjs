#!/usr/bin/env node
/**
 * EL VIGÍA DE PRECIOS — la mitad automática de «se actualiza automáticamente».
 *
 * DOCTRINA (decidida el 2026-08-23): los precios que FACTURAN viven en el
 * catálogo fechado del SDK (src/pricing/catalogo.ts, PRECIOS_AL_DIA) y solo
 * cambian con una revisión humana y un bump de fecha — un robot que cambiara
 * precios de facturación en silencio rompería la cadena auditable que los
 * extractos citan. Lo que SÍ se automatiza es la DETECCIÓN: este vigía corre
 * cada semana en CI (.github/workflows/vigia-precios.yml), compara el catálogo
 * contra una referencia pública machine-readable, y se pone ROJO con el diff
 * exacto y las líneas listas para pegar cuando un proveedor cambia precios.
 * La web se actualiza sola al desplegar el catálogo corregido: el bundle
 * vendored y PRECIOS_AL_DIA viajan juntos.
 *
 * Referencia: el JSON de precios de LiteLLM (BerriAI/litellm, comunidad,
 * ampliamente usado). Es el VIGÍA, no la fuente de verdad: la fuente que la
 * web cita es la página oficial de precios de cada proveedor.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const REFERENCIA = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const CATALOGO_TS = fileURLToPath(new URL("../src/pricing/catalogo.ts", import.meta.url));

// ── nuestro catálogo, leído del fichero fuente (sin compilar nada) ──
const src = readFileSync(CATALOGO_TS, "utf8");
const nuestro = new Map();
const rx = /"([a-z0-9.\-]+)":\s*\{\s*inputPer1k:\s*([\d.]+),\s*outputPer1k:\s*([\d.]+)(?:,\s*cachedInputPer1k:\s*([\d.]+))?/g;
let m;
while ((m = rx.exec(src))) {
  nuestro.set(m[1], {
    inputPer1k: Number(m[2]),
    outputPer1k: Number(m[3]),
    cachedInputPer1k: m[4] !== undefined ? Number(m[4]) : undefined,
  });
}
if (nuestro.size === 0) {
  console.error("[vigia] no se pudo leer el catálogo — ¿cambió el formato de catalogo.ts?");
  process.exit(2);
}
console.log(`[vigia] catálogo propio: ${nuestro.size} modelos · referencia: ${REFERENCIA}`);

// ── la referencia ──
const res = await fetch(REFERENCIA);
if (!res.ok) {
  // La referencia caída no es un cambio de precios: aviso, no rojo.
  console.error(`[vigia] la referencia no responde (HTTP ${res.status}); se reintentará en la próxima corrida.`);
  process.exit(0);
}
const ref = await res.json();

/** litellm publica por token; nuestro catálogo por mil tokens. */
const porMil = (porToken) => (porToken == null ? undefined : porToken * 1_000);
/** La entrada de referencia para una clave nuestra: exacta o la fechada más reciente. */
function referenciaDe(clave) {
  if (ref[clave]) return { clave, datos: ref[clave] };
  const fechadas = Object.keys(ref)
    .filter((k) => k.startsWith(`${clave}-20`))
    .sort()
    .reverse();
  return fechadas.length ? { clave: fechadas[0], datos: ref[fechadas[0]] } : null;
}

const iguales = (a, b) => {
  if (a == null || b == null) return true; // sin dato de referencia no se juzga
  return Math.abs(a - b) <= 1e-12 + Math.abs(a) * 1e-6;
};

const divergencias = [];
const sinReferencia = [];
for (const [clave, propio] of nuestro) {
  const r = referenciaDe(clave);
  if (!r) {
    sinReferencia.push(clave);
    continue;
  }
  const refIn = porMil(r.datos.input_cost_per_token);
  const refOut = porMil(r.datos.output_cost_per_token);
  const refCache = porMil(r.datos.cache_read_input_token_cost);
  const malIn = !iguales(propio.inputPer1k, refIn);
  const malOut = !iguales(propio.outputPer1k, refOut);
  const malCache = propio.cachedInputPer1k !== undefined && !iguales(propio.cachedInputPer1k, refCache);
  if (malIn || malOut || malCache) {
    divergencias.push({ clave, refClave: r.clave, propio, referencia: { refIn, refOut, refCache } });
  } else {
    console.log(`[vigia] ✓ ${clave} (ref: ${r.clave})`);
  }
}

for (const s of sinReferencia) console.log(`[vigia] ⚠ ${s}: sin referencia en litellm — revisar a mano de tanto en tanto`);

if (divergencias.length === 0) {
  console.log(`[vigia] ✅ el catálogo coincide con la referencia pública (${nuestro.size - sinReferencia.length} verificados).`);
  process.exit(0);
}

console.error(`\n[vigia] ⛔ ${divergencias.length} DIVERGENCIA(S): un proveedor ha cambiado precios (o la referencia se equivoca).`);
console.error("[vigia] Verifícalo en la página OFICIAL del proveedor y, si procede, actualiza el catálogo:");
for (const d of divergencias) {
  console.error(`\n  ${d.clave}  (referencia: ${d.refClave})`);
  console.error(`    catálogo:   in ${d.propio.inputPer1k} · out ${d.propio.outputPer1k} · cache ${d.propio.cachedInputPer1k ?? "—"}`);
  console.error(`    referencia: in ${d.referencia.refIn ?? "—"} · out ${d.referencia.refOut ?? "—"} · cache ${d.referencia.refCache ?? "—"}`);
  console.error(
    `    línea lista: "${d.clave}": { inputPer1k: ${d.referencia.refIn}, outputPer1k: ${d.referencia.refOut}${d.referencia.refCache != null ? `, cachedInputPer1k: ${d.referencia.refCache}` : ""} },`,
  );
}
console.error("\n[vigia] Al actualizar: sube también PRECIOS_AL_DIA y reconstruye el vendor (la web se actualiza sola al desplegar).");
process.exit(1);
