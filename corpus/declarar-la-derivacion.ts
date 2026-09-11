/**
 * EL DECLARADOR — el modelo simulado que dice QUÉ CUENTA HIZO.
 *
 * ⚠️ ESTO NO ES PARTE DE LA VERJA Y NO DEBE LLEGAR A PRODUCCIÓN. Es andamiaje de
 * medición. En producción la cuenta la declara quien responde, porque ya la hizo:
 * es un campo más de su salida (`operation` en el contrato del plan del CTO) y no
 * le cuesta nada. Aquí, para poder MEDIR qué pasaría si la declarara, hace falta
 * alguien que la ponga — y ese alguien es este fichero.
 *
 * LA ASIMETRÍA QUE HACE HONESTA LA MEDICIÓN, y que es la razón de que buscar aquí
 * esté bien y buscar dentro de la verja esté mal:
 *
 *   · EL DECLARADOR BUSCA. Puede permitírselo: un modelo que de verdad calculó
 *     «base + IVA + recargo» conoce su propia cuenta sin buscarla. Que aquí haya
 *     que buscarla es una limitación del banco, no del diseño.
 *   · LA VERJA NO BUSCA. Recibe UNA fórmula y la comprueba. Ahí está el dinero:
 *     un número inventado tiene n^k tiros si la verja busca entre n números y k
 *     términos, y exactamente UNO si la verja solo comprueba lo declarado.
 *
 * POR ESO EL BANCO LO USA DOS VECES, y las dos cifras que salen no son la misma
 * cosa:
 *
 *   HONESTO      se le da el valor CORRECTO y busca cómo justificarlo. Mide
 *                cuánto falso rechazo desaparece cuando quien responde declara.
 *   OPORTUNISTA  se le da el valor MUTADO —inventado— y busca cómo justificarlo
 *                igualmente. Es el adversario máximo: un modelo que, después de
 *                equivocarse, rebusca una cuenta que cuadre. Mide lo que la
 *                declaración NO protege.
 *
 * Es el mismo código: lo único que cambia es el valor que se le pide justificar.
 * Eso es deliberado. Un declarador «adversario» distinto del honesto sería una
 * forma elegante de medirse a uno mismo con la regla que más favorece.
 *
 * EL ÚNICO LÍMITE DE LA BÚSQUEDA es computacional y está escrito: como mucho
 * `MAX_CANDIDATOS` números y `MAX_FECHAS` fechas por campo. No se poda nada por
 * criterio semántico («una base de días solo puede ser 360 o 365»), porque una
 * poda así debilitaría al adversario y haría la cifra del oportunista más bonita
 * de lo que es.
 *
 * LO QUE NO SABE DECLARAR, y es la causa de los dos falsos rechazos que quedan:
 * un operando escrito EN PALABRAS. «El interés será el del BCE más OCHO puntos
 * porcentuales» no trae ningún «8» que copiar, así que ninguna cuenta se puede
 * declarar con operandos copiados. Leer números en palabras es la siguiente
 * puerta y no se abre aquí: su precio no está medido, y este repositorio ya tiene
 * una lección sobre abrir puertas cuyo precio no se ha medido.
 */
import type {
  CampoRespuesta,
  DerivacionDeclarada,
  OperandoDeclarado,
  Respuesta,
  UnidadDeEvidencia,
  ValorCampo,
} from "./tipos.js";
import { literalEstaCopiado, valorEstaEscrito, valorNumerico } from "./verja-de-extraccion.js";

const MAX_CANDIDATOS = 24;
const MAX_FECHAS = 8;
/** Medio céntimo, la misma tolerancia que usa la verja. */
const CERCA = 0.005;

type CandidatoNumero = { valor: number; operando: OperandoDeclarado };
type CandidatoFecha = { iso: string; operando: OperandoDeclarado };

const MESES: Readonly<Record<string, number>> = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7,
  agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
  gener: 1, febrer: 2, marc: 3, maig: 5, juny: 6, juliol: 7,
  agost: 8, setembre: 9, novembre: 11, desembre: 12,
};

function plegado(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

const dos = (n: number) => String(n).padStart(2, "0");

/**
 * Las fechas de un texto CON SU LITERAL tal y como está escrito, que es lo que
 * hay que poder copiar en el operando. La verja, al comprobar, exige que ese
 * literal aparezca en la unidad: si aquí se normalizara, el operando no casaría.
 */
function fechasConLiteral(texto: string): Array<{ iso: string; literal: string }> {
  const salida: Array<{ iso: string; literal: string }> = [];
  for (const m of texto.matchAll(/(\d{4})-(\d{1,2})-(\d{1,2})/g)) {
    const [todo, a, mes, d] = m;
    if (a && mes && d) salida.push({ iso: `${a}-${dos(+mes)}-${dos(+d)}`, literal: todo });
  }
  for (const m of texto.matchAll(/(?<![\d/-])(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})(?!\d)/g)) {
    const [todo, d, mes, añoBruto] = m;
    if (!d || !mes || !añoBruto) continue;
    const año = añoBruto.length === 2 ? 2000 + +añoBruto : +añoBruto;
    salida.push({ iso: `${año}-${dos(+mes)}-${dos(+d)}`, literal: todo });
  }
  // La forma larga se localiza sobre el texto plegado y el literal se recorta del
  // ORIGINAL por posición: «12 de març de 2025» tiene que viajar con su acento.
  const plano = plegado(texto);
  for (const m of plano.matchAll(/(\d{1,2})\s+de\s+([a-z]+)\s+de\s+(\d{4})/g)) {
    const [todo, d, nombreMes, año] = m;
    if (!d || !nombreMes || !año || m.index === undefined) continue;
    const mes = MESES[nombreMes];
    if (mes) salida.push({ iso: `${año}-${dos(mes)}-${dos(+d)}`, literal: texto.slice(m.index, m.index + todo.length) });
  }
  return salida;
}

/** Los números de un texto con su literal escrito. */
function numerosConLiteral(texto: string): Array<{ valor: number; literal: string }> {
  const salida: Array<{ valor: number; literal: string }> = [];
  for (const m of texto.match(/[-+]?\d[\d.,\s ']*\d|\d/g) ?? []) {
    const literal = m.trim();
    const valor = valorNumerico(literal);
    if (valor !== null) salida.push({ valor, literal });
  }
  return salida;
}

const numeroDelValor = (v: ValorCampo): number | null =>
  v.clase === "importe" ? Number(v.cantidad)
  : v.clase === "porcentaje" ? Number(v.valor)
  : v.clase === "entero" ? v.valor
  : null;

/** El valor ya conocido de otro campo de la respuesta, para poder encadenar. */
export type ValorDeCampo = { numero: number; iso?: never } | { iso: string; numero?: never };

function candidatos(
  campo: CampoRespuesta,
  porId: ReadonlyMap<string, UnidadDeEvidencia>,
  hermanos: ReadonlyMap<string, ValorDeCampo>,
): { numeros: CandidatoNumero[]; fechas: CandidatoFecha[] } {
  const numeros: CandidatoNumero[] = [];
  const fechas: CandidatoFecha[] = [];
  for (const id of campo.citas) {
    const u = porId.get(id);
    if (!u) continue;
    // Solo se proponen operandos que la verja aceptaría como copiados. Si no se
    // filtrara aquí, el declarador devolvería la PRIMERA cuenta que encuentra —a
    // veces una construida con el día y el mes de una fecha— la verja la
    // rechazaría, y el caso se contaría como falso rechazo teniendo una cuenta
    // buena disponible. El banco mediría entonces el orden de un bucle.
    for (const { valor, literal } of numerosConLiteral(u.texto))
      if (literalEstaCopiado(u.texto, literal)) numeros.push({ valor, operando: { unidad: id, literal } });
    for (const { iso, literal } of fechasConLiteral(u.texto))
      if (literalEstaCopiado(u.texto, literal)) fechas.push({ iso, operando: { unidad: id, literal } });
  }
  // Los hermanos YA sostenidos también son operandos: es lo que permite que los
  // intereses de demora se apoyen en unos días de mora que a su vez son una
  // resta de fechas, sin ensanchar ninguna búsqueda.
  for (const [nombre, v] of hermanos) {
    if (nombre === campo.nombre) continue;
    if (v.numero !== undefined) numeros.push({ valor: v.numero, operando: { campo: nombre } });
    else if (v.iso !== undefined) fechas.push({ iso: v.iso, operando: { campo: nombre } });
  }
  return { numeros: numeros.slice(0, MAX_CANDIDATOS), fechas: fechas.slice(0, MAX_FECHAS) };
}

const DIA_EN_MS = 86_400_000;
const aFecha = (iso: string): number => {
  const [a, m, d] = iso.split("-");
  return Date.UTC(Number(a), Number(m) - 1, Number(d));
};
const deFecha = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/**
 * Busca UNA cuenta que dé `campo.valor` con operandos copiados de las unidades
 * que el campo cita. Devuelve la primera que encuentra en un orden fijo —de la
 * más específica a la más genérica— o `null` si ninguna cuadra.
 *
 * El orden es fijo a propósito: si dependiera del caso, dos corridas del banco
 * podrían declarar cosas distintas y la medición dejaría de ser reproducible.
 */
export function declararDerivacion(
  campo: CampoRespuesta,
  evidencia: readonly UnidadDeEvidencia[],
  hermanos: ReadonlyMap<string, ValorDeCampo> = new Map(),
): DerivacionDeclarada | null {
  const porId = new Map(evidencia.map((u) => [u.id, u]));
  const { numeros, fechas } = candidatos(campo, porId, hermanos);
  const cerca = (a: number, b: number) => Math.abs(a - b) < CERCA;

  if (campo.valor.clase === "fecha") {
    const objetivo = campo.valor.iso;
    for (const f of fechas) {
      const base = aFecha(f.iso);
      for (const n of numeros) {
        if (!Number.isInteger(n.valor)) continue;
        if (deFecha(base + n.valor * DIA_EN_MS) === objetivo)
          return { operacion: "fecha-mas-dias", operandos: [f.operando, n.operando] };
        if (deFecha(base + n.valor * 7 * DIA_EN_MS) === objetivo)
          return { operacion: "fecha-mas-semanas", operandos: [f.operando, n.operando] };
      }
      // Dos plazos sumados: el vencimiento a 30 días MÁS una prórroga de 15.
      for (const a of numeros)
        for (const b of numeros) {
          if (a === b || !Number.isInteger(a.valor) || !Number.isInteger(b.valor)) continue;
          if (deFecha(base + (a.valor + b.valor) * DIA_EN_MS) === objetivo)
            return { operacion: "fecha-mas-dias", operandos: [f.operando, a.operando, b.operando] };
        }
    }
    return null;
  }

  const objetivo = numeroDelValor(campo.valor);
  if (objetivo === null) return null;
  /** Si una cuenta da el valor que hay que justificar. */
  const da = (resultado: number) => cerca(resultado, objetivo);

  // Días entre dos fechas: la más específica, y la que alimenta al interés.
  for (const a of fechas)
    for (const b of fechas) {
      if (a === b) continue;
      if (cerca(Math.round((aFecha(b.iso) - aFecha(a.iso)) / DIA_EN_MS), objetivo))
        return { operacion: "dias-entre-fechas", operandos: [a.operando, b.operando] };
    }

  // TODAS las cuentas se evalúan HACIA DELANTE y se comparan con la misma
  // tolerancia que usa la verja. Despejar un operando —«la base de días sale de
  // dividir»— parecía más listo y estaba mal: el objetivo viene REDONDEADO a dos
  // decimales, así que despejar amplifica ese redondeo y 365 se convierte en
  // 365,0236, que ningún candidato iguala. Lo cazó el caso del interés de demora.
  for (const a of numeros)
    for (const b of numeros) {
      if (a === b) continue;
      if (da(a.valor - b.valor)) return { operacion: "resta", operandos: [a.operando, b.operando] };
      if (da(a.valor + b.valor)) return { operacion: "suma", operandos: [a.operando, b.operando] };
      if (da(a.valor * b.valor)) return { operacion: "producto", operandos: [a.operando, b.operando] };
      if (da((a.valor * b.valor) / 100)) return { operacion: "porcentaje", operandos: [a.operando, b.operando] };
    }

  // Tres términos: la suma y la base con sus tipos encadenados.
  for (const a of numeros)
    for (const b of numeros) {
      if (a === b) continue;
      for (const c of numeros) {
        if (c === a || c === b) continue;
        if (da(a.valor + b.valor + c.valor))
          return { operacion: "suma", operandos: [a.operando, b.operando, c.operando] };
        if (da(a.valor * (1 + (b.valor + c.valor) / 100)))
          return { operacion: "base-mas-porcentajes", operandos: [a.operando, b.operando, c.operando] };
      }
    }

  // Interés por días: cuatro operandos en orden (principal, tipo, días, base).
  for (const principal of numeros)
    for (const tipo of numeros) {
      if (tipo === principal) continue;
      for (const dias of numeros) {
        if (dias === principal || dias === tipo) continue;
        for (const baseDias of numeros) {
          if (baseDias === principal || baseDias === tipo || baseDias === dias || baseDias.valor === 0) continue;
          if (da((principal.valor * (tipo.valor / 100) * dias.valor) / baseDias.valor))
            return {
              operacion: "interes-por-dias",
              operandos: [principal.operando, tipo.operando, dias.operando, baseDias.operando],
            };
        }
      }
    }

  return null;
}

/**
 * Declara la cuenta de los campos que la necesitan en UNA respuesta entera, por
 * pasadas, para que un campo pueda apoyarse en otro ya declarado.
 *
 * No toca los campos cuyo valor está escrito literalmente en su evidencia: quien
 * copia un número no declara ninguna cuenta, y meterle una sería inventar
 * declaraciones que ningún modelo emitiría.
 */
export function declararLoQueHagaFalta(
  respuesta: Respuesta,
  evidencia: readonly UnidadDeEvidencia[],
): Respuesta {
  if (respuesta.tipo !== "valor") return respuesta;
  const copia: Respuesta = JSON.parse(JSON.stringify(respuesta)) as Respuesta;
  if (copia.tipo !== "valor") return copia;

  const porId = new Map(evidencia.map((u) => [u.id, u]));
  const textosDe = (c: CampoRespuesta) =>
    c.citas.map((id) => porId.get(id)?.texto).filter((x): x is string => x !== undefined);

  // Los campos cuyo valor ESTÁ ESCRITO no declaran nada —quien copia no calcula—
  // pero sí sirven de operando para los que sí, y por eso se registran. El
  // predicado es el mismo que usa la verja, importado y no reescrito: dos copias
  // de «está escrito» es una que un día dirá lo contrario que la otra.
  const conocidos = new Map<string, ValorDeCampo>();
  for (const campo of copia.campos) {
    if (!valorEstaEscrito(campo.valor, textosDe(campo))) continue;
    if (campo.valor.clase === "fecha") conocidos.set(campo.nombre, { iso: campo.valor.iso });
    else {
      const n = numeroDelValor(campo.valor);
      if (n !== null) conocidos.set(campo.nombre, { numero: n });
    }
  }
  const pendientes = copia.campos.filter((c) => !conocidos.has(c.nombre));
  let avanza = true;
  while (avanza) {
    avanza = false;
    for (const campo of pendientes) {
      if (campo.derivacion) continue;
      const d = declararDerivacion(campo, evidencia, conocidos);
      if (!d) continue;
      campo.derivacion = d;
      avanza = true;
      if (campo.valor.clase === "fecha") conocidos.set(campo.nombre, { iso: campo.valor.iso });
      else {
        const n = numeroDelValor(campo.valor);
        if (n !== null) conocidos.set(campo.nombre, { numero: n });
      }
    }
  }
  return copia;
}
