/**
 * LA VERJA DE EXTRACCIÓN — decide si una respuesta de extracción se ACEPTA o si
 * hay que repetir la tarea con el proveedor aprobado. Función pura: sin disco,
 * sin red y sin LLM.
 *
 * POR QUÉ EXISTE, Y POR QUÉ ANTES QUE NINGUNA GPU. Medido el 2026-09-11 sobre el
 * corpus real (19.045 peticiones, $4.288,61): una tarea aceptada cuesta $0,5811
 * de media. Con ese precio, la aritmética del plan del CTO dice que a un modelo
 * local le bastaría con acertar el 0,09 % de las tareas para pagarse. Que el
 * número salga absurdo es precisamente la señal de que la fórmula se deja fuera
 * lo único que de verdad decide: el FALSO ACEPTADO. Una respuesta plausible y
 * equivocada no cuesta lo que cuesta repetirla — cuesta lo que cuesta haberla
 * dado por buena. Por eso la primera pieza del piloto local no es un modelo
 * corriendo: es esto.
 *
 * LA DIFERENCIA CON `validar.ts`, QUE ES LA QUE IMPORTA. Aquel valida CASOS del
 * golden set y tiene delante la respuesta correcta. Esta verja corre en
 * PRODUCCIÓN, donde la respuesta correcta no existe: solo hay la consulta, las
 * unidades de evidencia y lo que el modelo dijo. Así que no puede comprobar si
 * la respuesta es CIERTA. Lo que sí puede comprobar, y de forma determinista, es
 * si la respuesta está SOSTENIDA por la evidencia que se le dio. Un valor que no
 * aparece en ninguna unidad citada es una invención, y eso se ve sin saber cuál
 * era la respuesta buena.
 *
 * LAS CINCO COMPROBACIONES, de más barata a más valiosa:
 *
 *   1. FORMA. Importes con dos decimales y punto, fechas ISO, `opcion` dentro de
 *      su conjunto cerrado, todo importe con su `base`. Es la más barata y la
 *      que menos atrapa: un modelo que inventa suele inventar bien formado.
 *   2. LA CITA EXISTE. Todo campo cita al menos una unidad, y esas unidades
 *      están en la evidencia que se entregó. Citar `u9` cuando solo hay ocho
 *      unidades es alucinación pura.
 *   3. EL VALOR SE RASTREA HASTA SU CITA. ★ Esta es la que caza el falso
 *      aceptado. Si el campo dice 12.480,55 €, alguna unidad citada tiene que
 *      contener ese número — escrito como lo escribe un documento español
 *      («12.480,55»), no como lo escribe el JSON («12480.55»). Esa distancia
 *      entre las dos escrituras es deliberada en `tipos.ts` y es justo lo que
 *      impide aprobar por coincidencia de cadenas.
 *   4. LA CONTRADICCIÓN SE RESUELVE O SE DECLARA. Si en la evidencia hay
 *      unidades que chocan y nadie aplicó una regla de desempate, la única
 *      respuesta honesta es abstenerse. Contestar igualmente es el error más
 *      caro del dominio y aquí se rechaza.
 *   5. ABSTENERSE TAMBIÉN SE DEMUESTRA. Una abstención sin citas que enseñen el
 *      hueco no es abstenerse, es callarse; y un «no lo sé» no puede pasar por
 *      una respuesta trabajada.
 *
 * FALLA CERRADA, SIEMPRE. Ante un campo que no se sabe rastrear, un formato que
 * no se reconoce o cualquier excepción interna, el veredicto es RECHAZAR. El
 * coste de rechazar de más es repetir la tarea con el proveedor —dinero, y
 * medible—. El coste de aceptar de menos es entregar un dato falso, que no se
 * mide y no se recupera. Esa asimetría es la que fija el defecto.
 *
 * LO QUE ESTA VERJA NO HACE, Y HAY QUE DECIRLO EN VOZ ALTA. No comprueba que la
 * respuesta conteste a la consulta, ni que sea la interpretación correcta de la
 * evidencia, ni que no falte un campo que nadie pidió. Un valor puede estar
 * perfectamente rastreado y ser la respuesta a otra pregunta. Para eso hace
 * falta el golden set (`evaluar.ts`), que sí tiene la respuesta delante. Esta
 * verja acota el daño; no certifica el acierto.
 *
 * ─── LO QUE MIDE, MEDIDO (banco: `corpus/calibrar-la-verja.ts`) ─────────────
 *
 * 60 casos de facturación (32 es + 28 ca), 2026-09-11. Las dos cifras hay que
 * leerlas juntas, porque mover una mueve la otra en sentido contrario:
 *
 *   FALSO RECHAZO   38,3 %  (23/60)  cuesta dinero: repetir tareas correctas
 *   FALSO ACEPTADO   7,4 %  (15/202) entrega datos falsos: no se recupera
 *
 * El desglose importa mucho más que la media, porque los modos no son iguales
 * de graves ni la verja los ve igual de bien:
 *
 *   cita-fantasma               0 escapes / 50   referencia inventada
 *   sin-cita                    0 escapes / 50   afirmar sin señalar de dónde
 *   fecha-invertida             0 escapes / 14   leer 12/03 como 3 de diciembre
 *   importe-vecino              1 escape  / 28   el importe de la línea de al lado
 *   cita-movida-a-distractora   7 escapes / 50   valor bueno, cita equivocada
 *   contesta-en-vez-de-abstenerse  7 escapes / 10   ← el peor, y el que peor ve
 *
 * Ese único escape de `importe-vecino` NO estaba antes de abrir la puerta de
 * derivación: era 0/28. Es el precio exacto de admitir el valor calculado, y se
 * escribe aquí en vez de redondearlo a cero porque es la cifra que hay que
 * vigilar si algún día se toca `seDeriva`.
 *
 * ⚠️ EL LÍMITE DURO, que no es un error a corregir sino una propiedad: la verja
 * NO PUEDE VER que había que abstenerse cuando el motivo de abstención no deja
 * huella en la evidencia. Una contradicción se ve (hay dos unidades que chocan);
 * la evidencia INSUFICIENTE no se ve — por fuera es idéntica a la suficiente. De
 * ahí el 70 % de escapes de ese modo. La consecuencia es de ENRUTADO, no de
 * código: una tarea cuya respuesta correcta pueda ser una abstención no debe
 * enviarse a sustitución local, porque su verja no la protege.
 *
 * ─── LOS 23 FALSOS RECHAZOS, Y POR QUÉ NO SE ARREGLAN ENSANCHANDO ───────────
 *
 * Todos son aritmética legítima de varios pasos: 13 son fechas calculadas
 * («emisión 30/06/2024 + 60 días»), 8 importes de tres términos (base + IVA +
 * recargo de equivalencia), 2 porcentajes encadenados y 2 enteros.
 *
 * Se probó a admitir tres términos y se midió el precio: el falso rechazo baja
 * al 31,7 % (−6,6 puntos) pero los escapes de `importe-vecino` pasan del 3,6 %
 * al 10,7 % — se TRIPLICA el fallo de la comprobación estrella. Es mal negocio y
 * por eso la puerta se queda en dos términos.
 *
 * La lección de fondo: ADIVINAR la derivación no escala. Cada término nuevo
 * amplía el espacio de forma combinatoria y la probabilidad de que un número
 * inventado resulte derivable por casualidad crece más rápido que la
 * recuperación de derivaciones legítimas. La salida no es una puerta más ancha:
 * es que quien responde DECLARE la operación («total = base + cuota, sobre u5 y
 * u4»), y entonces la verja comprueba UNA fórmula declarada en vez de buscar
 * entre cientos. Es además lo que ya pide el contrato de resultado del plan del
 * CTO, con su campo `operation`.
 */

import {
  type CampoRespuesta,
  type Respuesta,
  type UnidadDeEvidencia,
  type ValorCampo,
} from "./tipos.js";

/** Versión de ESTA verja. Va en el veredicto: un perfil de validación que se
 * factura tiene que poder decir con qué reglas se aprobó. */
export const VERSION_DE_LA_VERJA = "1.0.0";

/**
 * Por qué se rechazó. El motivo es el producto de la verja tanto como el sí o el
 * no: «rechazado» sin motivo no permite arreglar el modelo ni el recuperador.
 */
export type MotivoDeRechazo =
  /** Un importe sin dos decimales, una fecha que no es ISO, una opción fuera de su conjunto. */
  | "forma-invalida"
  /** Un campo sin ninguna cita. */
  | "campo-sin-cita"
  /** Una cita que apunta a una unidad que no se entregó. */
  | "cita-inexistente"
  /** ★ El valor afirmado no aparece en ninguna de sus unidades citadas. */
  | "valor-no-rastreable"
  /** Hay evidencia contradictoria y se contestó con un valor sin declarar desempate. */
  | "contradiccion-no-resuelta"
  /** Una abstención sin citas, o sin decir qué falta. */
  | "abstencion-sin-prueba"
  /** La respuesta no tiene ningún campo. */
  | "respuesta-vacia"
  /** Cualquier excepción interna: la verja falla CERRADA. */
  | "error-interno";

export interface ReparoDeLaVerja {
  motivo: MotivoDeRechazo;
  /** El campo afectado, cuando el reparo es de un campo concreto. */
  campo?: string;
  /** Qué se esperaba y qué se encontró, sin volcar el texto entero de la unidad. */
  detalle: string;
}

export interface VeredictoDeLaVerja {
  aceptada: boolean;
  version: string;
  reparos: ReparoDeLaVerja[];
  /**
   * Qué unidades de evidencia NO sostienen ningún campo. No es un fallo: es el
   * `omitted_scope` que el plan del CTO exige en el contrato de resultado. Una
   * respuesta que ignora la mitad de la evidencia puede ser correcta, pero quien
   * la reciba tiene derecho a saberlo.
   */
  alcance_omitido: string[];
  /** Campos rastreados hasta su cita / campos con valor rastreable en principio. */
  cobertura: { rastreados: number; rastreables: number };
}

// ─────────────────────────── normalización de números ───────────────────────────

/**
 * Convierte un número escrito como lo escribe un documento español o catalán a
 * su valor. Devuelve `null` si la cadena no es un número reconocible.
 *
 * La regla que resuelve la ambigüedad: si aparecen punto y coma, manda el ÚLTIMO
 * como separador decimal. Si solo hay puntos y el último grupo tiene exactamente
 * tres cifras, son millares («12.480» = 12480); en cualquier otro caso el punto
 * es decimal («12.48» = 12,48). Es la convención de los documentos del corpus y
 * está aquí escrita para que se pueda discutir, no enterrada en una regex.
 */
export function valorNumerico(bruto: string): number | null {
  const s = bruto.replace(/[\s  '’]/g, "");
  if (!/^[-+]?[\d.,]+$/.test(s) || !/\d/.test(s)) return null;
  const ultimaComa = s.lastIndexOf(",");
  const ultimoPunto = s.lastIndexOf(".");
  let limpio: string;
  if (ultimaComa >= 0 && ultimoPunto >= 0) {
    limpio =
      ultimaComa > ultimoPunto
        ? s.replace(/\./g, "").replace(",", ".")
        : s.replace(/,/g, "");
  } else if (ultimaComa >= 0) {
    // Coma sola: decimal en es/ca. «1,5» = 1,5 y «1.234,5» ya cayó arriba.
    limpio = s.replace(/,/g, ".");
  } else if (ultimoPunto >= 0) {
    const cola = s.slice(ultimoPunto + 1);
    const hayVarios = (s.match(/\./g) ?? []).length > 1;
    limpio = hayVarios || cola.length === 3 ? s.replace(/\./g, "") : s;
  } else {
    limpio = s;
  }
  const n = Number(limpio);
  return Number.isFinite(n) ? n : null;
}

/** Todos los números que aparecen en un texto, ya convertidos a valor. */
function numerosDe(texto: string): number[] {
  const salida: number[] = [];
  for (const trozo of texto.match(/[-+]?\d[\d.,\s ']*\d|\d/g) ?? []) {
    const n = valorNumerico(trozo);
    if (n !== null) salida.push(n);
  }
  return salida;
}

/**
 * Si un número aparece en el texto. La comparación es por VALOR y con una
 * tolerancia de medio céntimo: «12.480,55» y «12480.550» son el mismo importe, y
 * un corpus que los distinga rechaza por ortografía en vez de por contenido.
 */
function contieneNumero(texto: string, buscado: number): boolean {
  return numerosDe(texto).some((n) => Math.abs(n - buscado) < 0.005);
}

// ──────────────────────────── normalización de fechas ────────────────────────────

/**
 * Meses en castellano y catalán, ya plegados (sin acentos y en minúscula), que
 * es como llegan de `plegado()`. `abril` y `octubre` se escriben igual en los
 * dos idiomas y por eso aparecen una sola vez.
 */
const MESES: Readonly<Record<string, number>> = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7,
  agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
  gener: 1, febrer: 2, marc: 3, maig: 5, juny: 6, juliol: 7,
  agost: 8, setembre: 9, novembre: 11, desembre: 12,
};

/** Pliega acentos y pasa a minúsculas, para que «març» case con «marc». */
function plegado(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

/**
 * Las fechas que aparecen en un texto, en ISO. Reconoce dd/mm/aaaa, dd-mm-aaaa,
 * aaaa-mm-dd y la forma larga «12 de marzo de 2025» / «12 de març de 2025».
 *
 * Deliberadamente NO reconoce mm/dd/aaaa: en un documento español eso no
 * existe, y admitirlo haría pasar por rastreable un 04/07 que dice otra cosa.
 * La ambigüedad de formato es, en `tipos.ts`, un motivo legítimo de abstención.
 */
function fechasDe(texto: string): string[] {
  const salida: string[] = [];
  const dos = (n: number) => String(n).padStart(2, "0");

  // Los grupos se comprueban uno a uno en vez de darse por hechos con `!`: en
  // una verja que falla cerrada, silenciar un `undefined` es exactamente la
  // clase de atajo que convierte un fallo en un aprobado.
  for (const m of texto.matchAll(/(\d{4})-(\d{1,2})-(\d{1,2})/g)) {
    const [, año, mes, dia] = m;
    if (!año || !mes || !dia) continue;
    salida.push(`${año}-${dos(+mes)}-${dos(+dia)}`);
  }
  // Los centinelas son asimétricos a propósito, y cada lado protege de algo
  // distinto:
  //   · Por la IZQUIERDA no puede haber dígito ni «/» ni «-», porque si no un
  //     ISO «2025-03-12» casaría ADEMÁS como «25-03-12» y metería en la lista un
  //     2012-03-25 que nadie escribió. Una fecha inventada que pase por
  //     rastreable es justo el fallo que esta verja existe para evitar.
  //   · Por la DERECHA solo se excluye un dígito (año partido a medias). El
  //     punto NO puede excluirse: «Fecha de emisión 12/03/2025.» acaba en punto
  //     y es la forma más común de escribirla. Excluirlo hacía que la verja
  //     rechazara una fecha correcta — lo cazó su propia prueba.
  for (const m of texto.matchAll(/(?<![\d/-])(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})(?!\d)/g)) {
    const [, dia, mes, añoBruto] = m;
    if (!dia || !mes || !añoBruto) continue;
    const año = añoBruto.length === 2 ? 2000 + +añoBruto : +añoBruto;
    salida.push(`${año}-${dos(+mes)}-${dos(+dia)}`);
  }
  const plano = plegado(texto);
  for (const m of plano.matchAll(/(\d{1,2})\s+de\s+([a-z]+)\s+de\s+(\d{4})/g)) {
    const [, dia, nombreMes, año] = m;
    if (!dia || !nombreMes || !año) continue;
    const mes = MESES[nombreMes];
    if (mes) salida.push(`${año}-${dos(mes)}-${dos(+dia)}`);
  }
  return salida;
}

// ───────────────────────────────── la verja ─────────────────────────────────

/** Si el valor de un campo es de los que se pueden rastrear hasta un texto. */
function esRastreable(v: ValorCampo): boolean {
  return v.clase !== "booleano" && v.clase !== "referencia";
}

/** Comprueba la FORMA de un valor. Devuelve el reparo, o `null` si está bien. */
function reparoDeForma(campo: CampoRespuesta): ReparoDeLaVerja | null {
  const v = campo.valor;
  const mal = (detalle: string): ReparoDeLaVerja => ({
    motivo: "forma-invalida",
    campo: campo.nombre,
    detalle,
  });
  switch (v.clase) {
    case "importe":
      if (!/^-?\d+\.\d{2}$/.test(v.cantidad))
        return mal(`importe «${v.cantidad}» no es decimal con punto y dos cifras`);
      if (!v.base) return mal("importe sin `base`: el número correcto sobre la base equivocada es una respuesta equivocada");
      return null;
    case "porcentaje":
      return /^-?\d+\.\d{2}$/.test(v.valor)
        ? null
        : mal(`porcentaje «${v.valor}» no tiene dos decimales`);
    case "fecha":
      return /^\d{4}-\d{2}-\d{2}$/.test(v.iso) ? null : mal(`fecha «${v.iso}» no es ISO aaaa-mm-dd`);
    case "entero":
      return Number.isInteger(v.valor) ? null : mal(`entero «${v.valor}» no lo es`);
    case "opcion":
      return v.opciones.includes(v.valor)
        ? null
        : mal(`opción «${v.valor}» fuera de su conjunto declarado`);
    case "identificador":
      return v.valor.trim() ? null : mal("identificador vacío");
    case "booleano":
    case "referencia":
      return null;
  }
}

/**
 * Si un número se DERIVA de los que hay en los textos citados con una sola
 * operación de factura.
 *
 * POR QUÉ EXISTE ESTA PUERTA, Y POR QUÉ ES ESTRECHA. La calibración contra el
 * golden set (60 casos) rechazaba 38 respuestas CORRECTAS porque el valor no
 * estaba escrito: «total con IVA 968,00» sale de sumar la base 800,00 y la
 * cuota 168,00, y ninguna unidad escribe el 968. Un total, una diferencia o una
 * cuota son la mitad de los campos de una factura; exigirlos literales no hacía
 * la verja más estricta, la hacía inservible.
 *
 * La puerta admite SOLO lo que se puede comprobar con dos números y una
 * operación: suma, resta y aplicación de un porcentaje. No es una calculadora
 * simbólica y no debe serlo — cuanto más ancha sea esta puerta, más fácil es que
 * un número inventado resulte derivable por casualidad. El precio exacto de
 * abrirla está medido en el banco de calibración: lo que sube el falso aceptado
 * frente a lo que baja el falso rechazo.
 */
function seDeriva(buscado: number, textos: string[]): boolean {
  const ns = textos.flatMap(numerosDe);
  if (ns.length < 2) return false;
  const cerca = (x: number) => Math.abs(x - buscado) < 0.005;
  for (let i = 0; i < ns.length; i += 1) {
    for (let j = 0; j < ns.length; j += 1) {
      if (i === j) continue;
      const a = ns[i]!;
      const b = ns[j]!;
      if (cerca(a + b) || cerca(a - b)) return true;
      // Un porcentaje aplicado: base × tipo / 100, y la base más su cuota.
      if (cerca((a * b) / 100) || cerca(a + (a * b) / 100)) return true;
    }
  }
  return false;
}

/** Si el valor del campo aparece —o se deriva— de alguno de los textos citados. */
function seRastrea(v: ValorCampo, textos: string[]): boolean {
  switch (v.clase) {
    case "importe": {
      const n = Number(v.cantidad);
      return textos.some((t) => contieneNumero(t, n)) || seDeriva(n, textos);
    }
    case "porcentaje": {
      const n = Number(v.valor);
      return textos.some((t) => contieneNumero(t, n)) || seDeriva(n, textos);
    }
    case "entero":
      return textos.some((t) => contieneNumero(t, v.valor)) || seDeriva(v.valor, textos);
    case "fecha":
      return textos.some((t) => fechasDe(t).includes(v.iso));
    case "identificador": {
      const buscado = plegado(v.valor).replace(/[\s-]/g, "");
      return textos.some((t) => plegado(t).replace(/[\s-]/g, "").includes(buscado));
    }
    default:
      return false;
  }
}

/**
 * El veredicto. `evidencia` son las unidades que se le ENTREGARON al modelo —
 * no todas las del expediente: citar algo que no se entregó es alucinación
 * aunque el dato exista en otra parte.
 */
export function verjaDeExtraccion(
  respuesta: Respuesta,
  evidencia: readonly UnidadDeEvidencia[],
  /**
   * La regla de desempate que el sistema que respondió declara haber aplicado.
   *
   * Sin esto la verja era simplemente incorrecta: exigía abstenerse en CUANTO
   * veía dos unidades contradictorias, y el golden set está lleno de casos que
   * traen la contradicción **y** la regla que la resuelve (una rectificativa
   * manda sobre la factura que rectifica, lo posterior manda sobre lo anterior).
   * La calibración lo cazó de golpe: 13 de 60 respuestas correctas rechazadas
   * por este motivo. Lo que hay que exigir no es que no haya contradicción, sino
   * que alguien la haya RESUELTO explícitamente.
   *
   * `"ninguna"` —o no pasar nada— significa que nadie desempató, y entonces sí:
   * contestar con un valor ante evidencia que choca es el error más caro del
   * dominio.
   */
  desempate?: { regla: string; ganadora: string | null },
): VeredictoDeLaVerja {
  const base = { version: VERSION_DE_LA_VERJA, alcance_omitido: [] as string[] };
  try {
    const porId = new Map(evidencia.map((u) => [u.id, u]));
    const reparos: ReparoDeLaVerja[] = [];
    const usadas = new Set<string>();

    // ── Abstención: también hay que demostrarla ──
    if (respuesta.tipo === "abstencion") {
      if (!respuesta.citas.length)
        reparos.push({
          motivo: "abstencion-sin-prueba",
          detalle: "abstenerse sin citar la unidad que enseña el hueco o el choque no es abstenerse",
        });
      if (!respuesta.que_falta?.trim())
        reparos.push({
          motivo: "abstencion-sin-prueba",
          detalle: "una abstención tiene que decir qué falta EXACTAMENTE para poder responder",
        });
      for (const c of respuesta.citas) {
        if (!porId.has(c))
          reparos.push({ motivo: "cita-inexistente", detalle: `la abstención cita «${c}», que no se entregó` });
        else usadas.add(c);
      }
      return {
        ...base,
        aceptada: reparos.length === 0,
        reparos,
        alcance_omitido: evidencia.filter((u) => !usadas.has(u.id)).map((u) => u.id),
        cobertura: { rastreados: 0, rastreables: 0 },
      };
    }

    // ── Respuesta con valor ──
    if (!respuesta.campos.length) {
      return {
        ...base,
        aceptada: false,
        reparos: [{ motivo: "respuesta-vacia", detalle: "una respuesta de tipo valor sin ningún campo" }],
        alcance_omitido: evidencia.map((u) => u.id),
        cobertura: { rastreados: 0, rastreables: 0 },
      };
    }

    let rastreables = 0;
    let rastreados = 0;

    for (const campo of respuesta.campos) {
      const deForma = reparoDeForma(campo);
      if (deForma) reparos.push(deForma);

      if (!campo.citas?.length) {
        reparos.push({
          motivo: "campo-sin-cita",
          campo: campo.nombre,
          detalle: "ningún campo puede afirmarse sin señalar la unidad que lo sostiene",
        });
        continue;
      }

      const textos: string[] = [];
      for (const c of campo.citas) {
        const u = porId.get(c);
        if (!u) {
          reparos.push({
            motivo: "cita-inexistente",
            campo: campo.nombre,
            detalle: `cita «${c}», que no está entre las ${evidencia.length} unidades entregadas`,
          });
          continue;
        }
        usadas.add(c);
        textos.push(u.texto);
      }

      // Una `referencia` señala una unidad: basta con que exista.
      if (campo.valor.clase === "referencia" && !porId.has(campo.valor.unidad)) {
        reparos.push({
          motivo: "cita-inexistente",
          campo: campo.nombre,
          detalle: `apunta a la unidad «${campo.valor.unidad}», que no se entregó`,
        });
      }

      if (esRastreable(campo.valor)) {
        rastreables += 1;
        if (textos.length && seRastrea(campo.valor, textos)) rastreados += 1;
        else if (textos.length)
          reparos.push({
            motivo: "valor-no-rastreable",
            campo: campo.nombre,
            detalle: `el valor afirmado no aparece en ninguna de sus unidades citadas (${campo.citas.join(", ")})`,
          });
      }
    }

    // ── La contradicción SIN RESOLVER obliga a abstenerse ──
    // Con una regla declarada y una unidad ganadora, la contradicción está
    // resuelta y contestar con un valor es lo correcto. Sin ella, no.
    const contradictorias = evidencia.filter((u) => u.papel === "contradictoria");
    const resuelta = Boolean(desempate && desempate.regla !== "ninguna" && desempate.ganadora);
    if (contradictorias.length >= 2 && !resuelta) {
      reparos.push({
        motivo: "contradiccion-no-resuelta",
        detalle:
          `la evidencia trae ${contradictorias.length} unidades contradictorias y se contestó con un valor ` +
          "sin declarar qué regla de desempate se aplicó; la única respuesta honesta es abstenerse",
      });
    }

    return {
      ...base,
      aceptada: reparos.length === 0,
      reparos,
      alcance_omitido: evidencia.filter((u) => !usadas.has(u.id)).map((u) => u.id),
      cobertura: { rastreados, rastreables },
    };
  } catch (e) {
    // Falla CERRADA: una excepción interna jamás puede convertirse en un «sí».
    return {
      ...base,
      aceptada: false,
      reparos: [
        {
          motivo: "error-interno",
          detalle: `la verja falló y por eso rechaza: ${e instanceof Error ? e.name : "excepción"}`,
        },
      ],
      alcance_omitido: evidencia.map((u) => u.id),
      cobertura: { rastreados: 0, rastreables: 0 },
    };
  }
}
