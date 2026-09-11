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
 *
 * ─── Y DESDE LA 1.1.0, LA CUENTA DECLARADA ──────────────────────────────────
 *
 * La primera calibración dejó 23 falsos rechazos, todos aritmética legítima, y
 * midió que ENSANCHAR la búsqueda para recogerlos triplicaba los escapes del modo
 * estrella. La salida no era buscar mejor: era que quien responde DECLARE su
 * cuenta. Eso se mide aquí, y hace falta medir DOS cosas distintas, porque un
 * adversario no se comporta como un modelo que simplemente se equivoca:
 *
 *   SANO DECLARADO     el declarador (`declarar-la-derivacion.ts`) justifica los
 *                      valores CORRECTOS. Mide cuánto falso rechazo desaparece.
 *   MUTANTE HEREDADA   el valor se corrompe y la declaración se MANTIENE, que es
 *                      lo que hace un modelo que lee mal un número: no rehace su
 *                      justificación. Es el caso realista.
 *   MUTANTE OPORTUNISTA el valor se corrompe y encima se REBUSCA una cuenta que
 *                      lo justifique. Es el adversario máximo, y es la cifra que
 *                      hay que enseñar aunque salga peor.
 *
 * En los tres brazos declarados la búsqueda ciega va APAGADA: con la cuenta
 * declarada no hace falta adivinar, y es justo al dejar de adivinar cuando la
 * verja deja de tener el agujero que se midió en la 1.0.0.
 */
import { readFileSync } from "node:fs";
import { verjaDeExtraccion } from "./verja-de-extraccion.js";
import { declararLoQueHagaFalta } from "./declarar-la-derivacion.js";
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
  /**
   * Devuelve la respuesta corrompida Y EL CAMPO QUE TOCÓ, o null si el caso no se
   * presta. El campo hace falta para poder separar los escapes que la verja podía
   * ver de los que no: un `booleano` cita una unidad y NINGUNA verja determinista
   * puede comprobar que sea la unidad correcta —haría falta entender la frase—,
   * así que contarlos junto a un importe mal rastreado mezcla dos cosas.
   */
  aplicar: (c: CasoDelCorpus) => { respuesta: Respuesta; campo: string } | null;
};

/** Las clases de valor que la verja NO puede comprobar contra el texto. */
const CIEGAS = ["booleano", "referencia"];
const laVerjaPuedeVerlo = (r: Respuesta, nombre: string): boolean => {
  if (r.tipo !== "valor") return true;
  const campo = r.campos.find((c) => c.nombre === nombre);
  return campo ? !CIEGAS.includes(campo.valor.clase) : true;
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
      return { respuesta: r, campo: campo.nombre };
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
      return { respuesta: r, campo: campo.nombre };
    },
  },
  {
    nombre: "cita-fantasma",
    imita: "el modelo se inventa la referencia",
    aplicar: (c) => {
      const r = clona(c.respuesta);
      if (r.tipo !== "valor" || !r.campos.length) return null;
      r.campos[0]!.citas = ["u-fantasma"];
      return { respuesta: r, campo: r.campos[0]!.nombre };
    },
  },
  {
    nombre: "sin-cita",
    imita: "el modelo afirma sin señalar de dónde lo saca",
    aplicar: (c) => {
      const r = clona(c.respuesta);
      if (r.tipo !== "valor" || !r.campos.length) return null;
      r.campos[0]!.citas = [];
      return { respuesta: r, campo: r.campos[0]!.nombre };
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
      return { respuesta: r, campo: r.campos[0]!.nombre };
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
        respuesta: {
          tipo: "valor",
          campos: [
            {
              nombre: "respuesta_inventada",
              valor: { clase: "identificador", valor: u.texto.slice(0, 12).trim() } as ValorCampo,
              critico: true,
              citas: [u.id],
            },
          ],
        },
        campo: "respuesta_inventada",
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
let aplicadosVisibles0 = 0;
let escapesVisibles0 = 0;
for (const m of MUTANTES) {
  let aplicados = 0;
  let escapes = 0;
  const ejemplos: string[] = [];
  for (const c of todos) {
    const r = m.aplicar(c);
    if (!r) continue;
    aplicados += 1;
    const visible = laVerjaPuedeVerlo(r.respuesta, r.campo);
    if (visible) aplicadosVisibles0 += 1;
    if (verjaDeExtraccion(r.respuesta, c.evidencia as UnidadDeEvidencia[], c.desempate).aceptada) {
      escapes += 1;
      if (visible) escapesVisibles0 += 1;
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


// ══════════════ LA CUENTA DECLARADA (verja 1.1.0) ══════════════
//
// Tres brazos más, la búsqueda ciega APAGADA en los tres.

const SIN_CIEGA = { derivacionCiega: false } as const;
const declaraciones = (r: Respuesta): number =>
  r.tipo === "valor" ? r.campos.filter((c) => c.derivacion).length : 0;

console.log(`\n═══ LA CUENTA DECLARADA · el campo \`operation\` del contrato ═══\n`);

// ── BRAZO SANO DECLARADO ──
const rechazosDeclarado: Array<{ id: string; motivos: string[]; detalle: string }> = [];
let camposDeclarados = 0;
let casosQueDeclaran = 0;
for (const c of todos) {
  const declarada = declararLoQueHagaFalta(c.respuesta, c.evidencia);
  const n = declaraciones(declarada);
  if (n) {
    casosQueDeclaran += 1;
    camposDeclarados += n;
  }
  const v = verjaDeExtraccion(declarada, c.evidencia as UnidadDeEvidencia[], c.desempate, SIN_CIEGA);
  if (!v.aceptada)
    rechazosDeclarado.push({
      id: c.id,
      motivos: [...new Set(v.reparos.map((r) => r.motivo))],
      detalle: v.reparos[0]?.detalle ?? "",
    });
}
const tasaFalsoRechazoDeclarado = (100 * rechazosDeclarado.length) / todos.length;
console.log(`BRAZO SANO DECLARADO — el declarador justifica los valores correctos`);
console.log(`  declaran algo     : ${casosQueDeclaran}/${todos.length} casos, ${camposDeclarados} campos`);
console.log(`  ★ FALSO RECHAZO   : ${rechazosDeclarado.length}/${todos.length} = ${tasaFalsoRechazoDeclarado.toFixed(1)} %`);
for (const r of rechazosDeclarado) console.log(`     sigue rechazado ${r.id}: ${r.motivos.join(",")} — ${r.detalle.slice(0, 90)}`);

// ── BRAZOS MUTANTES ──
// `heredada`: se declara sobre la respuesta SANA y después se corrompe el valor,
// así que la declaración que viaja es la de la respuesta buena.
// `oportunista`: se corrompe primero y se declara DESPUÉS, sobre el valor falso.
console.log(`\nBRAZOS MUTANTES DECLARADOS — el mismo mutante con dos adversarios\n`);
type Cuenta = {
  escapes: number;
  aplicados: number;
  /** Lo mismo, contando SOLO los campos que la verja puede comprobar. */
  escapesVisibles: number;
  aplicadosVisibles: number;
  ejemplos: string[];
};
const cero = (): Cuenta => ({ escapes: 0, aplicados: 0, escapesVisibles: 0, aplicadosVisibles: 0, ejemplos: [] });
const totales = { heredada: cero(), oportunista: cero() };

const anota = (cuenta: Cuenta, escapa: boolean, visible: boolean, id: string) => {
  cuenta.aplicados += 1;
  if (visible) cuenta.aplicadosVisibles += 1;
  if (!escapa) return;
  cuenta.escapes += 1;
  if (visible) cuenta.escapesVisibles += 1;
  if (cuenta.ejemplos.length < 3) cuenta.ejemplos.push(visible ? id : `${id}(ciego)`);
};

console.log(`  ${"mutante".padEnd(30)} ${"heredada".padStart(12)} ${"oportunista".padStart(13)}   escapes en campo ciego`);
for (const m of MUTANTES) {
  const cuenta = { heredada: cero(), oportunista: cero() };
  for (const c of todos) {
    const sucia = m.aplicar(c);
    if (!sucia) continue;

    // heredada: declarar sobre la SANA y ensuciar después, que es lo que hace un
    // modelo que lee mal un número y no rehace su justificación.
    const sanaDeclarada = declararLoQueHagaFalta(c.respuesta, c.evidencia);
    const heredada = m.aplicar({ ...c, respuesta: sanaDeclarada });
    if (heredada) {
      const visible = laVerjaPuedeVerlo(heredada.respuesta, heredada.campo);
      const escapa = verjaDeExtraccion(heredada.respuesta, c.evidencia as UnidadDeEvidencia[], c.desempate, SIN_CIEGA).aceptada;
      anota(cuenta.heredada, escapa, visible, c.id);
    }

    // oportunista: declarar DESPUÉS de ensuciar, sobre el valor falso.
    const oportunista = declararLoQueHagaFalta(sucia.respuesta, c.evidencia);
    const visible = laVerjaPuedeVerlo(oportunista, sucia.campo);
    const escapa = verjaDeExtraccion(oportunista, c.evidencia as UnidadDeEvidencia[], c.desempate, SIN_CIEGA).aceptada;
    anota(cuenta.oportunista, escapa, visible, c.id);
  }
  for (const k of ["heredada", "oportunista"] as const) {
    totales[k].escapes += cuenta[k].escapes;
    totales[k].aplicados += cuenta[k].aplicados;
    totales[k].escapesVisibles += cuenta[k].escapesVisibles;
    totales[k].aplicadosVisibles += cuenta[k].aplicadosVisibles;
  }
  const pinta = (x: Cuenta) => `${x.escapes}/${String(x.aplicados).padStart(3)}`;
  const ciegos = cuenta.oportunista.escapes - cuenta.oportunista.escapesVisibles;
  const marca = cuenta.oportunista.escapesVisibles === 0 ? "✅" : cuenta.oportunista.escapesVisibles <= 2 ? "⚠️ " : "🔴";
  console.log(
    `  ${marca} ${m.nombre.padEnd(28)} ${pinta(cuenta.heredada).padStart(12)} ${pinta(cuenta.oportunista).padStart(13)}   ` +
      (ciegos ? `${ciegos} — la verja no puede juzgarlos` : "—"),
  );
  if (cuenta.oportunista.ejemplos.length) console.log(`     escapan al oportunista: ${cuenta.oportunista.ejemplos.join(", ")}`);
}
const tasa = (x: Cuenta) => (x.aplicados ? (100 * x.escapes) / x.aplicados : 0);
const tasaVisible = (x: Cuenta) => (x.aplicadosVisibles ? (100 * x.escapesVisibles) / x.aplicadosVisibles : 0);

// ── LA TABLA QUE DECIDE ──
const pct = (x: number) => `${x.toFixed(1)} %`.padStart(14);
console.log(`\n═══ LAS DOS CIFRAS, EN LAS TRES POSTURAS ═══\n`);
console.log(`  ${"".padEnd(32)}${"1.0.0 ciega".padStart(14)}${"declarada".padStart(14)}${"declarada".padStart(14)}`);
console.log(`  ${"".padEnd(32)}${"(adivinar)".padStart(14)}${"heredada".padStart(14)}${"oportunista".padStart(14)}`);
console.log(
  `  falso rechazo                   ${pct(tasaFalsoRechazo)}${pct(tasaFalsoRechazoDeclarado)}${pct(tasaFalsoRechazoDeclarado)}`,
);
console.log(
  `  falso aceptado                  ${pct(100 * (totalEscapes / totalAplicados))}${pct(tasa(totales.heredada))}${pct(tasa(totales.oportunista))}`,
);
console.log(
  `  falso aceptado · campos visibles${pct(100 * (escapesVisibles0 / aplicadosVisibles0))}${pct(tasaVisible(totales.heredada))}${pct(tasaVisible(totales.oportunista))}`,
);

const bruto = (e: number, a: number) => `${e}/${a}`.padStart(14);
console.log(
  `\n  en bruto, sin porcentajes       ${bruto(totalEscapes, totalAplicados)}` +
    `${bruto(totales.heredada.escapes, totales.heredada.aplicados)}` +
    `${bruto(totales.oportunista.escapes, totales.oportunista.aplicados)}`,
);
console.log(
  `  ídem, solo campos visibles      ${bruto(escapesVisibles0, aplicadosVisibles0)}` +
    `${bruto(totales.heredada.escapesVisibles, totales.heredada.aplicadosVisibles)}` +
    `${bruto(totales.oportunista.escapesVisibles, totales.oportunista.aplicadosVisibles)}`,
);
console.log(`\n═══ CÓMO SE LEE ESTA TABLA, Y LA TRAMPA QUE TIENE ═══`);
console.log(`
  1 · EL FALSO RECHAZO SE DERRUMBA: 38,3 % → 3,3 %. Los dos casos que quedan no
      son aritmética que la verja no sepa comprobar: son operandos escritos EN
      PALABRAS («el tipo del BCE más OCHO puntos porcentuales»). No hay ningún
      «8» que copiar, así que no hay cuenta declarable. Leer números en palabras
      es otra puerta y su precio no está medido.

  2 · EL FALSO ACEPTADO **EN BRUTO** SUBE, Y NO ES LO QUE PARECE. Todo el
      aumento está en el modo \`cita-movida-a-distractora\` y TODO él cae en
      campos \`booleano\`: una verja determinista no puede comprobar que un
      «sí/no» cite la unidad correcta, porque haría falta entender la frase. La
      1.0.0 los cazaba POR ACCIDENTE — los tapaba su propio falso rechazo en
      OTRO campo del mismo caso. Al dejar de rechazar de más, deja de tapar.

  3 · LA FILA QUE COMPARA DE VERDAD es la tercera: solo los campos que la verja
      puede juzgar. Ahí se ve si la declaración protege peor o igual.

  4 · EL PRECIO REAL DE LA DECLARACIÓN ES LA COLUMNA OPORTUNISTA, y hay que
      mirarla sin consuelo: un adversario que, tras equivocarse, REBUSCA una
      cuenta que justifique su número falso. La declaración no le cierra la
      puerta; se la estrecha a las cuentas que puede construir con operandos
      copiados de las unidades que cita.

  5 · LO QUE NO ARREGLA NADA DE ESTO: \`contesta-en-vez-de-abstenerse\`. Sigue
      igual, y seguirá: cuando la evidencia es INSUFICIENTE no hay huella que
      comprobar. Es enrutado, no código.
`);
