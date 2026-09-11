/**
 * CALIBRACIÓN DE LA VERJA DE EXTRACCIÓN contra el golden set de facturación.
 *
 * Dos brazos, y los dos miden un error distinto:
 *
 *   BRAZO SANO. Se le dan a la verja las respuestas CORRECTAS del corpus. Todo
 *   rechazo aquí es un FALSO RECHAZO: la verja manda repetir una tarea que
 *   estaba bien. Cuesta dinero medible y, si es muy alto, hace el piloto local
 *   antieconómico por sí solo.
 *
 *   BRAZO MUTANTE. Se corrompe cada respuesta correcta imitando los modos de
 *   fallo reales de un modelo, y se mira cuántas ESCAPAN. Cada escape es un
 *   FALSO ACEPTADO: un dato falso entregado como bueno. Es el error que no se
 *   mide solo y que no se recupera.
 *
 * Ninguna de las dos cifras se puede adivinar leyendo el código de la verja.
 */
import { readFileSync } from "node:fs";
import { verjaDeExtraccion } from "./verja-de-extraccion.js";
import type {
  CampoRespuesta,
  CasoDelCorpus,
  Respuesta,
  UnidadDeEvidencia,
  ValorCampo,
} from "./tipos.js";

const RAIZ = process.cwd();
function casos(): CasoDelCorpus[] {
  return ["casos-es.json", "casos-ca.json"].flatMap(
    (f) => JSON.parse(readFileSync(`${RAIZ}/corpus/facturacion-y-cobros/${f}`, "utf8")).casos as CasoDelCorpus[],
  );
}

const clona = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

// ───────────────────────────── mutantes ─────────────────────────────

type Mutante = {
  nombre: string;
  /** Qué modo de fallo real imita. */
  imita: string;
  /** Devuelve la respuesta corrompida, o null si el caso no se presta. */
  aplicar: (c: CasoDelCorpus) => Respuesta | null;
};

/** El primer campo con un valor de clase `clase`, si lo hay. */
function primerCampo(r: Respuesta, clases: string[]): CampoRespuesta | null {
  if (r.tipo !== "valor") return null;
  return r.campos.find((c) => clases.includes(c.valor.clase)) ?? null;
}

/** Cambia dos cifras de sitio: 12480.55 → 12408.55. El error de al lado. */
function vecino(cantidad: string): string {
  const d = cantidad.split("");
  const pos = d.map((c, i) => (/\d/.test(c) ? i : -1)).filter((i) => i >= 0);
  if (pos.length < 4) return cantidad;
  const a = pos[pos.length - 4]!;
  const b = pos[pos.length - 3]!;
  if (d[a] === d[b]) return cantidad;
  [d[a], d[b]] = [d[b]!, d[a]!];
  return d.join("");
}

const MUTANTES: Mutante[] = [
  {
    nombre: "importe-vecino",
    imita: "el modelo lee el importe de la línea de al lado (trampa «importes-parecidos»)",
    aplicar: (c) => {
      const r = clona(c.respuesta);
      const campo = primerCampo(r, ["importe"]);
      if (!campo || campo.valor.clase !== "importe") return null;
      const nuevo = vecino(campo.valor.cantidad);
      if (nuevo === campo.valor.cantidad) return null;
      campo.valor.cantidad = nuevo;
      return r;
    },
  },
  {
    nombre: "fecha-invertida",
    imita: "leer 12/03 como 3 de diciembre (trampa «fechas-parecidas»)",
    aplicar: (c) => {
      const r = clona(c.respuesta);
      const campo = primerCampo(r, ["fecha"]);
      if (!campo || campo.valor.clase !== "fecha") return null;
      const [a, m, d] = campo.valor.iso.split("-");
      if (!a || !m || !d || m === d) return null;
      campo.valor.iso = `${a}-${d}-${m}`;
      return r;
    },
  },
  {
    nombre: "cita-fantasma",
    imita: "el modelo se inventa la referencia",
    aplicar: (c) => {
      const r = clona(c.respuesta);
      if (r.tipo !== "valor" || !r.campos.length) return null;
      r.campos[0]!.citas = ["u-fantasma"];
      return r;
    },
  },
  {
    nombre: "sin-cita",
    imita: "el modelo afirma sin señalar de dónde lo saca",
    aplicar: (c) => {
      const r = clona(c.respuesta);
      if (r.tipo !== "valor" || !r.campos.length) return null;
      r.campos[0]!.citas = [];
      return r;
    },
  },
  {
    nombre: "cita-movida-a-distractora",
    imita: "★ el valor es correcto pero la cita señala la unidad equivocada",
    aplicar: (c) => {
      const r = clona(c.respuesta);
      if (r.tipo !== "valor" || !r.campos.length) return null;
      const distractora = c.evidencia.find((u) => u.papel === "distractora");
      if (!distractora) return null;
      r.campos[0]!.citas = [distractora.id];
      return r;
    },
  },
  {
    nombre: "contesta-en-vez-de-abstenerse",
    imita: "★★ el peor: hay contradicción sin desempate y el modelo contesta igual",
    aplicar: (c) => {
      if (c.respuesta.tipo !== "abstencion") return null;
      const u = c.evidencia[0];
      if (!u) return null;
      return {
        tipo: "valor",
        campos: [
          {
            nombre: "respuesta_inventada",
            valor: { clase: "identificador", valor: u.texto.slice(0, 12).trim() } as ValorCampo,
            critico: true,
            citas: [u.id],
          },
        ],
      };
    },
  },
];

// ───────────────────────────── el banco ─────────────────────────────

const todos = casos();
console.log(`\n═══ CALIBRACIÓN DE LA VERJA · ${todos.length} casos de facturación (es+ca) ═══\n`);

// ── BRAZO SANO ──
const rechazos: Array<{ id: string; motivos: string[]; detalle: string }> = [];
let sanasAceptadas = 0;
for (const c of todos) {
  const v = verjaDeExtraccion(c.respuesta, c.evidencia as UnidadDeEvidencia[], c.desempate);
  if (v.aceptada) sanasAceptadas += 1;
  else
    rechazos.push({
      id: c.id,
      motivos: [...new Set(v.reparos.map((r) => r.motivo))],
      detalle: v.reparos[0]?.detalle ?? "",
    });
}
const tasaFalsoRechazo = (100 * rechazos.length) / todos.length;
console.log(`BRAZO SANO — respuestas correctas del corpus`);
console.log(`  aceptadas        : ${sanasAceptadas}/${todos.length}`);
console.log(`  ★ FALSO RECHAZO  : ${rechazos.length}/${todos.length} = ${tasaFalsoRechazo.toFixed(1)} %`);

const porMotivo = new Map<string, number>();
for (const r of rechazos) for (const m of r.motivos) porMotivo.set(m, (porMotivo.get(m) ?? 0) + 1);
if (porMotivo.size) {
  console.log(`  por motivo:`);
  for (const [m, n] of [...porMotivo].sort((a, b) => b[1] - a[1]))
    console.log(`     ${String(n).padStart(3)}  ${m}`);
  console.log(`  tres ejemplos:`);
  for (const r of rechazos.slice(0, 3)) console.log(`     ${r.id}: ${r.detalle}`);
}

// ── BRAZO MUTANTE ──
console.log(`\nBRAZO MUTANTE — respuestas corrompidas a propósito`);
console.log(`  (ESCAPE = la verja la dio por buena = falso aceptado)\n`);
let totalAplicados = 0;
let totalEscapes = 0;
for (const m of MUTANTES) {
  let aplicados = 0;
  let escapes = 0;
  const ejemplos: string[] = [];
  for (const c of todos) {
    const r = m.aplicar(c);
    if (!r) continue;
    aplicados += 1;
    if (verjaDeExtraccion(r, c.evidencia as UnidadDeEvidencia[], c.desempate).aceptada) {
      escapes += 1;
      if (ejemplos.length < 3) ejemplos.push(c.id);
    }
  }
  totalAplicados += aplicados;
  totalEscapes += escapes;
  const pct = aplicados ? (100 * escapes) / aplicados : 0;
  const marca = escapes === 0 ? "✅" : pct < 10 ? "⚠️ " : "🔴";
  console.log(`  ${marca} ${m.nombre.padEnd(30)} escapes ${String(escapes).padStart(3)}/${String(aplicados).padStart(3)}  (${pct.toFixed(1)} %)`);
  console.log(`     imita: ${m.imita}`);
  if (ejemplos.length) console.log(`     escapan: ${ejemplos.join(", ")}`);
}
console.log(
  `\n  ★ FALSO ACEPTADO GLOBAL : ${totalEscapes}/${totalAplicados} = ${(totalAplicados ? (100 * totalEscapes) / totalAplicados : 0).toFixed(1)} %`,
);

console.log(`\n═══ LECTURA ═══`);
console.log(`  Falso rechazo  ${tasaFalsoRechazo.toFixed(1)} %  → cuesta dinero: repetir tareas que estaban bien`);
console.log(`  Falso aceptado ${(totalAplicados ? (100 * totalEscapes) / totalAplicados : 0).toFixed(1)} %  → entrega datos falsos: no se mide y no se recupera`);
