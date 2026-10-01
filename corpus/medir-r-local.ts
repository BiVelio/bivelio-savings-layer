/**
 * MEDIR `r` — qué fracción de tareas de extracción puede hacer un modelo LOCAL
 * de forma que la verja lo acepte Y sea cierto.
 *
 * POR QUÉ ESTA CIFRA Y NO OTRA. El plan del CTO calcula el equilibrio de la GPU
 * con `N = F / ((1-r)·c_api − c_local)`. Todo lo demás ya está medido: `c_api` es
 * $0,5811 por tarea (corpus real, 19.045 peticiones) y el hierro está hundido.
 * Falta `r`, y `r` no se puede estimar leyendo benchmarks ajenos: depende de la
 * tarea, del idioma, del documento y —sobre todo— de la verja que decide qué se
 * acepta. Por eso se mide aquí, contra el golden set, con la verja en medio.
 *
 * LAS CUATRO CASILLAS, porque «r» a secas no dice nada:
 *
 *                      la respuesta es CORRECTA     la respuesta es FALSA
 *   la verja ACEPTA     ✅ sustituible: esto es r    🔴 FALSO ACEPTADO: el caro
 *   la verja RECHAZA    💸 falso rechazo: se repite  ✅ la verja hizo su trabajo
 *
 * El número que decide la inversión es la primera casilla. El que decide si se
 * puede encender siquiera es el segundo: un falso aceptado entrega un dato
 * inventado como bueno y no se recupera.
 *
 * LO QUE EL MODELO **NO** RECIBE, y es lo que hace honesta la medición:
 *   · `papel` de cada unidad (necesaria / distractora / contradictoria). Decir
 *     cuál es la distractora es decir la respuesta.
 *   · `desempate` del caso. Si hay contradicción, el modelo tiene que DARSE
 *     CUENTA y declarar la regla él; dárselo hecho es regalarle la parte difícil.
 *   · `nota` del caso, que explica por qué es difícil.
 *   · La lista de campos esperados. Se compara por VALOR y no por nombre, así
 *     que el modelo no aprende de la forma del esquema si la respuesta correcta
 *     era abstenerse. Un esquema real (el de Intake) solo se lo pondría MÁS
 *     fácil: esta medición es un suelo, no un techo.
 *
 * Se le da el CONTRATO (las clases de valor, las operaciones declarables, los
 * motivos de abstención), que es estático e igual para los 60 casos, y el caso.
 *
 * Uso: arrancar un servidor compatible con OpenAI en local y
 *   `pnpm verja:medir-r`  (variables: BVSALA_R_URL, BVSALA_R_MODELO, BVSALA_R_CASOS)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { verjaDeExtraccion } from "./verja-de-extraccion.js";
import {
  camposCriticos,
  type CampoRespuesta,
  type CasoDelCorpus,
  type Respuesta,
  type UnidadDeEvidencia,
  type ValorCampo,
} from "./tipos.js";

const URL_MODELO = process.env.BVSALA_R_URL ?? "http://127.0.0.1:8412/v1/chat/completions";
/**
 * El id EXACTO que publica el servidor en `/v1/models`. Con mlx_lm es la ruta del
 * modelo, y si no coincide el servidor intenta BAJARLO de HuggingFace y devuelve
 * un 404 con un 401 dentro. Pasó en la primera corrida.
 */
const MODELO =
  process.env.BVSALA_R_MODELO ??
  "/Users/fisagol/.lmstudio/models/mlx-community/gpt-oss-20b-MXFP4-Q8";
const CUANTOS = Number(process.env.BVSALA_R_CASOS ?? "0"); // 0 = todos
const RAIZ = process.cwd();

function casos(): CasoDelCorpus[] {
  const todos = ["casos-es.json", "casos-ca.json"].flatMap(
    (f) => JSON.parse(readFileSync(`${RAIZ}/corpus/facturacion-y-cobros/${f}`, "utf8")).casos as CasoDelCorpus[],
  );
  return CUANTOS > 0 ? todos.slice(0, CUANTOS) : todos;
}

// ─────────────────────────── el contrato que se le pide ───────────────────────────

const CONTRATO = `Eres un motor de extracción documental. Respondes SOLO con un objeto JSON, sin texto alrededor y sin markdown.

FORMA DE LA RESPUESTA — una de estas dos:

1) Si la evidencia sostiene una respuesta:
{"tipo":"valor",
 "campos":[{"nombre":"snake_case","valor":<VALOR>,"critico":true,"citas":["u1"],"derivacion":<DERIVACION opcional>}],
 "desempate":<DESEMPATE opcional>}

2) Si NO la sostiene:
{"tipo":"abstencion",
 "motivo":"evidencia-insuficiente"|"contradiccion-sin-regla-de-desempate"|"identificador-ambiguo"|"formato-de-fecha-ambiguo"|"evidencia-caducada"|"fuera-del-alcance-de-la-evidencia",
 "que_falta":"qué haría falta EXACTAMENTE para poder responder",
 "citas":["u2"]}

<VALOR> es una de estas formas:
 {"clase":"importe","cantidad":"1234.56","moneda":"EUR","base":"sin-iva"|"con-iva"|"solo-cuota"|"neto-a-percibir"|"no-aplica"}
 {"clase":"fecha","iso":"2025-03-12"}
 {"clase":"identificador","valor":"F-2025-118"}
 {"clase":"booleano","valor":true}
 {"clase":"porcentaje","valor":"21.00"}
 {"clase":"entero","valor":51}
 {"clase":"opcion","valor":"x","opciones":["x","y"]}
 {"clase":"referencia","unidad":"u3"}

REGLAS QUE SE COMPRUEBAN DE FORMA AUTOMÁTICA, así que cúmplelas al pie de la letra:

· CITA SIEMPRE. Cada campo lleva las unidades que lo sostienen. Citar una unidad
  que no existe, o no citar ninguna, invalida la respuesta.
· IMPORTE: "cantidad" con punto decimal y DOS decimales ("968.00"). La "base"
  importa tanto como el número: el importe correcto sobre la base equivocada es
  una respuesta equivocada.
· FECHA: ISO aaaa-mm-dd. En estos documentos dd/mm/aaaa NUNCA es mm/dd/aaaa.
· SI EL VALOR NO ESTÁ ESCRITO porque lo has CALCULADO, declara la cuenta:
  "derivacion":{"operacion":<OP>,"operandos":[{"unidad":"u1","literal":"800,00"},…]}
  <OP>: "suma" | "resta" | "producto" | "porcentaje" (a×b/100) |
        "base-mas-porcentajes" (a×(1+Σresto/100)) |
        "interes-por-dias" (principal × tipo/100 × días / base_días, en ese orden) |
        "fecha-mas-dias" | "fecha-mas-semanas" (fecha primero, luego los plazos) |
        "dias-entre-fechas" (dos fechas)
  Cada operando va COPIADO LETRA A LETRA del texto de una unidad que el campo
  cite ("2.000,00", "30/06/2024", "21"), no reescrito al estilo JSON. Un operando
  puede ser otro campo de tu respuesta: {"campo":"dias_de_mora"} — y entonces tu
  campo tiene que citar también la evidencia de ese otro campo.
  Como mucho TRES operandos por cuenta.
· SI DOS UNIDADES SE CONTRADICEN y hay una regla que decide cuál manda, dilo:
  "desempate":{"regla":"fecha-posterior"|"version-posterior"|"rectificativa"|"clausula-especial"|"jerarquia-documental","ganadora":"u5","desplazadas":["u2"],"porque":"…"}
  Si NO hay regla que lo decida, la respuesta correcta es abstenerse con motivo
  "contradiccion-sin-regla-de-desempate". Contestar igualmente es el error más
  caro que puedes cometer aquí.
· ABSTENERSE TAMBIÉN SE DEMUESTRA: cita las unidades que enseñan el hueco o el
  choque y di qué falta. Un "no lo sé" sin citas no vale.
· No inventes nada que no esté en las unidades. No uses conocimiento externo: si
  hace falta un tipo de IVA o un plazo legal, está escrito en alguna unidad.`;

function prompt(c: CasoDelCorpus): string {
  const unidades = c.evidencia
    .map((u) => {
      const extra = [u.fuente && `fuente: ${u.fuente}`, u.fecha && `fecha: ${u.fecha}`, u.version && `versión: ${u.version}`]
        .filter(Boolean)
        .join(" · ");
      return `[${u.id}] ${u.texto}${extra ? `\n      (${extra})` : ""}`;
    })
    .join("\n");
  return `CONSULTA: ${c.consulta}\n\nEVIDENCIA ENTREGADA (${c.evidencia.length} unidades):\n${unidades}\n\nResponde SOLO con el JSON.`;
}

// ─────────────────────────── hablar con el modelo local ───────────────────────────

/**
 * El JSON de la respuesta, leyendo SOLO el canal final.
 *
 * gpt-oss contesta en formato «harmony» y `mlx_lm.server` no separa los canales:
 * llega todo en una cadena, `<|channel|>analysis<|message|>…` y después
 * `<|channel|>final<|message|>{…}`. Hay que quedarse con el último canal final y
 * nada más. Leer la cadena entera era peor que inútil: el razonamiento está lleno
 * de llaves y de JSON a medio escribir, así que el primer intento de medición
 * sacaba «json-ilegible» en todos los casos.
 *
 * Si no hay canal final, no hay respuesta: se informa como tal y no se adivina.
 */
function extraeJson(texto: string): { json: unknown } | { fallo: string } {
  const marca = "<|channel|>final<|message|>";
  const i = texto.lastIndexOf(marca);
  const cola = (i >= 0 ? texto.slice(i + marca.length) : texto)
    .replace(/<\|(end|return|start)\|>[\s\S]*$/u, "")
    .replace(/```json|```/g, "")
    .trim();
  if (i < 0 && /<\|channel\|>/.test(texto)) return { fallo: "el modelo se quedó en el canal de razonamiento y no llegó a contestar" };
  const a = cola.indexOf("{");
  const b = cola.lastIndexOf("}");
  if (a < 0 || b <= a) return { fallo: `el canal final no trae un objeto JSON («${cola.slice(0, 50).replace(/\s+/g, " ")}»)` };
  try {
    return { json: JSON.parse(cola.slice(a, b + 1)) };
  } catch (e) {
    return { fallo: `JSON inválido en el canal final: ${e instanceof Error ? e.message.slice(0, 60) : "error"}` };
  }
}

async function preguntar(c: CasoDelCorpus): Promise<{ texto: string; ms: number; tokens: number }> {
  const t0 = Date.now();
  const r = await fetch(URL_MODELO, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: MODELO,
      messages: [
        { role: "system", content: CONTRATO },
        { role: "user", content: prompt(c) },
      ],
      temperature: 0,
      max_tokens: 4096,
    }),
  });
  if (!r.ok) throw new Error(`el modelo devolvió ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const cuerpo = (await r.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { completion_tokens?: number };
  };
  return {
    texto: cuerpo.choices?.[0]?.message?.content ?? "",
    ms: Date.now() - t0,
    tokens: cuerpo.usage?.completion_tokens ?? 0,
  };
}

// ─────────────────────────── ¿es CORRECTA? ───────────────────────────
//
// Se compara por VALOR, no por nombre de campo: el modelo no recibe el esquema,
// así que exigirle que acierte el nombre mediría otra cosa. Lo que se exige es
// que TODOS los valores críticos del golden set estén en su respuesta.

function mismoValor(a: ValorCampo, b: ValorCampo): boolean {
  if (a.clase !== b.clase) return false;
  switch (a.clase) {
    case "importe":
      return (
        b.clase === "importe" &&
        Math.abs(Number(a.cantidad) - Number(b.cantidad)) < 0.005 &&
        a.base === b.base
      );
    case "porcentaje":
      return b.clase === "porcentaje" && Math.abs(Number(a.valor) - Number(b.valor)) < 0.005;
    case "fecha":
      return b.clase === "fecha" && a.iso === b.iso;
    case "entero":
      return b.clase === "entero" && a.valor === b.valor;
    case "booleano":
      return b.clase === "booleano" && a.valor === b.valor;
    case "opcion":
      return b.clase === "opcion" && a.valor === b.valor;
    case "identificador":
      return (
        b.clase === "identificador" &&
        a.valor.replace(/[\s-]/g, "").toLowerCase() === b.valor.replace(/[\s-]/g, "").toLowerCase()
      );
    case "referencia":
      return b.clase === "referencia" && a.unidad === b.unidad;
  }
}

/**
 * EL VEREDICTO, CON TRES CASILLAS Y NO DOS. La primera corrida de este banco dio
 * «40 % de falso aceptado» y la cifra era una acusación injusta: la mayoría de
 * esos casos no decían un valor FALSO, se dejaban un campo crítico SIN DECIR.
 * Son dos cosas de gravedad muy distinta:
 *
 *   CONTRADICHO  el modelo afirma 986,00 donde la verdad es 968,00. Es el fallo
 *                caro, el que no se recupera, y el único que merece llamarse
 *                falso aceptado.
 *   AUSENTE      el modelo contesta bien lo que contesta y omite un campo. No es
 *                una invención, es una respuesta INCOMPLETA — y en parte es
 *                artefacto de este banco, que a propósito NO le da el esquema de
 *                campos (ver la cabecera). La verja nunca prometió completitud:
 *                para eso devuelve `alcance_omitido`.
 *
 * Mezclarlas infla el falso aceptado y además acusa a la verja de algo que no
 * hizo.
 */
type Clasificacion = "correcta" | "contradicha" | "incompleta";
type Veredicto = { clase: Clasificacion; porque: string };

/**
 * ¿Qué campo de la respuesta del modelo se corresponde con este campo crítico?
 * Por nombre si coincide; si no, por clase (y por `base` en los importes, porque
 * el mismo número sobre otra base es otra respuesta). Si hay varios candidatos y
 * uno acierta el valor, se acepta; si ninguno acierta pero alguno es del mismo
 * tipo, es CONTRADICHO; si no hay ninguno, es AUSENTE.
 */
function clasificaCampo(critico: CampoRespuesta, dichos: CampoRespuesta[]): "igual" | "contradicho" | "ausente" {
  const normal = (x: string) => x.toLowerCase().replace(/[^a-z]/g, "");
  if (dichos.some((d) => mismoValor(critico.valor, d.valor))) return "igual";
  const porNombre = dichos.filter((d) => normal(d.nombre) === normal(critico.nombre));
  if (porNombre.length) return "contradicho";
  const mismaClase = dichos.filter(
    (d) =>
      d.valor.clase === critico.valor.clase &&
      (critico.valor.clase !== "importe" || (d.valor.clase === "importe" && d.valor.base === critico.valor.base)),
  );
  return mismaClase.length ? "contradicho" : "ausente";
}

function esCorrecta(c: CasoDelCorpus, dicha: Respuesta): Veredicto {
  const buena = c.respuesta;
  if (buena.tipo === "abstencion") {
    if (dicha.tipo !== "abstencion")
      return { clase: "contradicha", porque: `había que ABSTENERSE (${buena.motivo}) y contestó con un valor` };
    return {
      clase: "correcta",
      porque:
        dicha.motivo === buena.motivo
          ? "se abstuvo, y por el motivo bueno"
          : `se abstuvo (motivo dicho: ${dicha.motivo}, esperado: ${buena.motivo})`,
    };
  }
  if (dicha.tipo === "abstencion")
    return { clase: "contradicha", porque: `se abstuvo (${dicha.motivo}) y la evidencia SÍ sostenía la respuesta` };

  const contradichos: string[] = [];
  const ausentes: string[] = [];
  for (const critico of camposCriticos(c)) {
    const r = clasificaCampo(critico, dicha.campos ?? []);
    if (r === "contradicho") contradichos.push(critico.nombre);
    else if (r === "ausente") ausentes.push(critico.nombre);
  }
  // Un solo valor contradicho manda sobre cualquier omisión: es el fallo caro.
  if (contradichos.length)
    return { clase: "contradicha", porque: `CONTRADICE el valor de ${contradichos.join(", ")}` };
  if (ausentes.length) return { clase: "incompleta", porque: `no menciona ${ausentes.join(", ")} (no dice nada falso)` };
  return { clase: "correcta", porque: "dice todos los valores críticos" };
}

// ─────────────────────────── el banco ───────────────────────────

type Fila = {
  id: string;
  idioma: string;
  dificultad: string;
  trampas: string[];
  aceptada: boolean;
  clase: Clasificacion;
  motivos: string[];
  porque: string;
  ms: number;
  tokens: number;
  declaraciones: number;
  seAbstuvo: boolean;
  /** Lo que la propia verja dice que la respuesta dejó fuera. */
  alcanceOmitido?: string[];
  /**
   * LA RESPUESTA DEL MODELO, tal y como se parseó. Sin esto el artefacto no se
   * puede reanalizar sin volver a pagar la corrida entera — lo descubrí a mi
   * costa al querer separar «contradicho» de «ausente» sobre la primera medición
   * y no poder. Una medición que no se puede reexaminar no es una medición.
   */
  dicha?: unknown;
};

const todos = casos();
console.log(`\n═══ MEDIR r · ${todos.length} casos · modelo local «${MODELO}» ═══\n`);
console.log(`  El modelo NO recibe: papel de las unidades, desempate, nota del caso ni esquema de campos.`);
console.log(`  La verja corre con la búsqueda ciega APAGADA: o está escrito, o se declara la cuenta.\n`);

const filas: Fila[] = [];
for (const c of todos) {
  let fila: Fila = {
    id: c.id,
    idioma: c.idioma,
    dificultad: c.dificultad,
    trampas: c.trampas,
    aceptada: false,
    clase: "contradicha",
    motivos: [],
    porque: "",
    ms: 0,
    tokens: 0,
    declaraciones: 0,
    seAbstuvo: false,
  };
  try {
    const { texto, ms, tokens } = await preguntar(c);
    fila = { ...fila, ms, tokens };
    const leido = extraeJson(texto);
    if ("fallo" in leido) {
      fila.motivos = ["json-ilegible"];
      fila.porque = leido.fallo;
    } else {
      const dicha = leido.json as Respuesta & { desempate?: { regla: string; ganadora: string | null } };
      fila.seAbstuvo = dicha.tipo === "abstencion";
      fila.declaraciones =
        dicha.tipo === "valor" ? (dicha.campos ?? []).filter((x: CampoRespuesta) => x.derivacion).length : 0;
      // El desempate que se le pasa a la verja es EL QUE DECLARÓ EL MODELO, no el
      // del caso: dárselo hecho sería regalarle la parte difícil.
      const v = verjaDeExtraccion(dicha, c.evidencia as UnidadDeEvidencia[], dicha.desempate, {
        derivacionCiega: false,
      });
      const juicio = esCorrecta(c, dicha);
      fila.aceptada = v.aceptada;
      fila.clase = juicio.clase;
      fila.dicha = dicha;
      fila.alcanceOmitido = v.alcance_omitido;
      fila.motivos = [...new Set(v.reparos.map((r) => r.motivo))];
      fila.porque = juicio.porque;
    }
  } catch (e) {
    // Un fallo de transporte NO es un dato: es el banco roto. Contarlo como
    // «la verja hizo su trabajo» inventaría una cifra, así que se para aquí.
    console.error(`\n  ⛔ ${c.id}: ${e instanceof Error ? e.message : "excepción"}`);
    console.error(`     El servidor local no está respondiendo lo que se le pide. Sin eso no hay medición.`);
    process.exit(1);
  }
  filas.push(fila);
  const casilla = fila.aceptada
    ? fila.clase === "correcta"
      ? "✅ r"
      : fila.clase === "contradicha"
        ? "🔴 FALSO ACEPTADO"
        : "🟡 incompleta"
    : fila.clase === "correcta"
      ? "💸 falso rechazo"
      : "✅ cazada";
  console.log(
    `  ${fila.id}  ${casilla.padEnd(18)} ${String(fila.ms / 1000).slice(0, 4)}s ${String(fila.tokens).padStart(5)}tk  ${fila.motivos.join(",") || "—"}  · ${fila.porque.slice(0, 70)}`,
  );
}

// ─────────────────────────── el informe ───────────────────────────

const n = filas.length;
const cuenta = (p: (f: Fila) => boolean) => filas.filter(p).length;
const rUtil = cuenta((f) => f.aceptada && f.clase === "correcta");
const contradichas = cuenta((f) => f.aceptada && f.clase === "contradicha");
const incompletas = cuenta((f) => f.aceptada && f.clase === "incompleta");
const falsoRechazo = cuenta((f) => !f.aceptada && f.clase === "correcta");
const cazadas = cuenta((f) => !f.aceptada && f.clase !== "correcta");
const pct = (x: number) => `${((100 * x) / n).toFixed(1)} %`;

console.log(`\n═══ LAS SEIS CASILLAS ═══\n`);
console.log(`  Se separa CONTRADICHA de INCOMPLETA a propósito: decir un valor falso y`);
console.log(`  dejar un campo sin decir no son el mismo fallo, y mezclarlos infla el falso`);
console.log(`  aceptado. Además, la omisión es en parte artefacto de este banco, que NO da`);
console.log(`  el esquema de campos; la verja no promete completitud, la informa.\n`);
console.log(`                        correcta        CONTRADICHA        incompleta`);
console.log(
  `  verja ACEPTA     ✅ r = ${String(rUtil).padStart(2)} (${pct(rUtil)})  🔴 ${String(contradichas).padStart(2)} (${pct(contradichas)})  🟡 ${String(incompletas).padStart(2)} (${pct(incompletas)})`,
);
console.log(`  verja RECHAZA    💸 ${String(falsoRechazo).padStart(2)} (${pct(falsoRechazo)})       ✅ ${String(cazadas).padStart(2)} (${pct(cazadas)}) la verja hizo su trabajo`);

console.log(`\n  ★ r · aceptado Y correcto          : ${rUtil}/${n} = ${pct(rUtil)}`);
console.log(`  ★ FALSO ACEPTADO de verdad         : ${contradichas}/${n} = ${pct(contradichas)}  ← el caro, el que no se recupera`);
console.log(`    aceptado pero incompleto         : ${incompletas}/${n} = ${pct(incompletas)}  (no dice nada falso)`);
const conOmision = filas.filter((f) => f.aceptada && f.clase === "incompleta" && (f.alcanceOmitido?.length ?? 0) > 0).length;
console.log(`      de esos, con \`alcance_omitido\` no vacío: ${conOmision}/${incompletas} — la verja SÍ avisaba de que dejaba evidencia sin usar`);
const aciertoBruto = cuenta((f) => f.clase === "correcta");
console.log(`\n  acierto del modelo SIN verja        : ${aciertoBruto}/${n} = ${pct(aciertoBruto)}`);
console.log(`  errores que la verja TAPA           : ${cazadas} de ${cuenta((f) => f.clase !== "correcta")}`);

const abstenciones = todos.filter((c) => c.respuesta.tipo === "abstencion").length;
const seAbstuvoBien = filas.filter((f, i) => todos[i]!.respuesta.tipo === "abstencion" && f.seAbstuvo).length;
console.log(`\n  casos que pedían ABSTENERSE: ${abstenciones} · el modelo se abstuvo en ${seAbstuvoBien}`);
console.log(`  cuentas declaradas: ${filas.reduce((a, f) => a + f.declaraciones, 0)} en ${cuenta((f) => f.declaraciones > 0)} casos`);
const ms = filas.reduce((a, f) => a + f.ms, 0);
console.log(`  tiempo: ${(ms / 1000).toFixed(0)} s en total, ${(ms / n / 1000).toFixed(1)} s por caso`);

const porMotivo = new Map<string, number>();
for (const f of filas) for (const m of f.motivos) porMotivo.set(m, (porMotivo.get(m) ?? 0) + 1);
if (porMotivo.size) {
  console.log(`\n  por qué rechazó la verja:`);
  for (const [m, k] of [...porMotivo].sort((a, b) => b[1] - a[1])) console.log(`     ${String(k).padStart(3)}  ${m}`);
}

// Artefacto sellado: sin `commit` y `generatedAt` una cifra no se puede defender.
const artefacto = {
  generatedAt: new Date().toISOString(),
  commit: (() => {
    try {
      return execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
    } catch {
      return "desconocido";
    }
  })(),
  modelo: MODELO,
  casos: n,
  contratoSinEsquema: true,
  derivacionCiega: false,
  r: rUtil,
  contradichas,
  incompletas,
  falsoRechazo,
  cazadas,
  aciertoBruto,
  filas,
};
const destino = `${RAIZ}/benchmarks/out/r-local.json`;
try {
  writeFileSync(destino, `${JSON.stringify(artefacto, null, 2)}\n`);
  console.log(`\n  artefacto sellado en benchmarks/out/r-local.json`);
} catch (e) {
  console.log(`\n  (no se pudo escribir el artefacto: ${e instanceof Error ? e.message : "error"})`);
}
