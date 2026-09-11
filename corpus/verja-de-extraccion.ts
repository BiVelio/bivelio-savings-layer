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
 * LAS SEIS COMPROBACIONES, de más barata a más valiosa:
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
 *   6. LA CUENTA DECLARADA CUADRA. ★★ (1.1.0) Si el valor no está escrito porque
 *      se calculó, quien responde declara la operación y sus operandos, y la
 *      verja comprueba ESA cuenta: los operandos copiados de unidades citadas y
 *      el resultado igual al valor afirmado. Es lo que permite sostener un total,
 *      un vencimiento a plazo o unos intereses sin tener que ADIVINAR nada.
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
 * 60 casos de facturación (32 es + 28 ca), 2026-09-11. Esto es lo que mide la
 * verja CUANDO LA RESPUESTA NO DECLARA SU CUENTA y la búsqueda ciega está
 * encendida, que es el defecto heredado de la 1.0.0. Con la cuenta declarada las
 * cifras son otras y están más abajo. Las dos hay que leerlas juntas, porque
 * mover una mueve la otra en sentido contrario:
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
 * ─── LOS 23 FALSOS RECHAZOS DE LA 1.0.0, Y CÓMO SE ARREGLARON ───────────────
 *
 * Todos eran aritmética legítima de varios pasos: 13 fechas calculadas («emisión
 * 30/06/2024 + 60 días»), 4 productos de unidades por precio unitario, 2 bases
 * con sus tipos encadenados, 2 intereses por días, 2 restas de fechas.
 *
 * Se probó a admitir tres términos EN LA BÚSQUEDA y se midió el precio: el falso
 * rechazo bajaba al 31,7 % (−6,6 puntos) pero los escapes de `importe-vecino`
 * pasaban del 3,6 % al 10,7 % — se TRIPLICA el fallo de la comprobación estrella.
 * Mal negocio, y de ahí la lección: ADIVINAR la derivación no escala. Cada
 * término amplía el espacio de forma combinatoria y la probabilidad de que un
 * número inventado resulte derivable por casualidad crece más rápido que la
 * recuperación de derivaciones legítimas.
 *
 * ─── LA CUENTA DECLARADA (1.1.0), MEDIDA EN EL MISMO BANCO ──────────────────
 *
 * 60 casos, 202 mutantes, tres posturas. La del medio es el adversario REALISTA
 * (se equivoca en el valor y mantiene su declaración, que es lo que hace un
 * modelo que lee mal un número); la de la derecha es el adversario MÁXIMO (tras
 * equivocarse, REBUSCA una cuenta que justifique su número falso):
 *
 *                                   1.0.0 ciega   declarada   declarada
 *                                    (adivinar)    heredada   oportunista
 *   falso rechazo                        38,3 %       3,3 %       3,3 %
 *   falso aceptado                        7,4 %       9,4 %      10,4 %
 *   falso aceptado · campos visibles      4,8 %       4,2 %       5,4 %
 *   en bruto                             15/202      19/202      21/202
 *   ídem, campos visibles                 8/166       7/166       9/166
 *
 * CÓMO SE LEE, porque la segunda fila engaña y la tercera es la que compara:
 *
 *   · El falso rechazo se derrumba de 38,3 % a 3,3 %. Los 2 casos que quedan no
 *     son aritmética que la verja no sepa comprobar: son operandos escritos EN
 *     PALABRAS («el tipo del BCE más OCHO puntos porcentuales»), donde no hay
 *     ningún «8» que copiar. Leer números en palabras es otra puerta y su precio
 *     no está medido.
 *   · El falso aceptado EN BRUTO sube, y TODO el aumento está en campos
 *     `booleano` del modo `cita-movida-a-distractora`. Una verja determinista no
 *     puede comprobar que un «sí/no» cite la unidad correcta —haría falta
 *     entender la frase—, y la 1.0.0 esos casos los cazaba POR ACCIDENTE: los
 *     tapaba su propio falso rechazo en OTRO campo del mismo caso. Al dejar de
 *     rechazar de más, deja de tapar. El 4,8 % → 4,2 % de la tercera fila es la
 *     comparación limpia: sobre lo que la verja puede juzgar, el adversario
 *     realista escapa MENOS.
 *   · Y el precio honesto de la palanca es la columna oportunista: un escape más
 *     (8/166 → 9/166) frente a 35 puntos menos de falso rechazo. La declaración
 *     no le cierra la puerta al que rebusca; se la estrecha a las cuentas que
 *     puede construir copiando de las unidades que cita.
 *
 * DOS AGUJEROS MÍOS QUE CAZÓ EL BANCO, no las pruebas unitarias:
 *   (a) se podía RECORTAR un operando de dentro de otro número: `suma(01, 07,
 *       2,90) = 10,90` sobre una unidad que solo dice «vigente l'01/07/2025 és
 *       del 2,90 %». Una fecha regala cuatro operandos pequeños y con operandos
 *       pequeños se arma casi cualquier cifra. Cura: `literalEstaCopiado`, con
 *       centinelas asimétricos —otra vez— porque excluir la coma por la derecha
 *       rechazaba media docena de cuentas correctas.
 *   (b) un operando de tipo `{ campo }` no exigía citas, así que un campo se
 *       sostenía apoyándose en un hermano mientras su propia cita no sostenía
 *       nada: `cita-movida-a-distractora` pasaba de 7 escapes a 12. Cura: si mi
 *       número sale de otro campo, mi evidencia tiene que incluir la suya.
 *
 * ⚠️ EL LÍMITE DURO SIGUE EN PIE, y la cuenta declarada no lo toca: la verja NO
 * PUEDE VER que había que abstenerse cuando el motivo de abstención no deja
 * huella. Una contradicción se ve (hay dos unidades que chocan); la evidencia
 * INSUFICIENTE no — por fuera es idéntica a la suficiente. De ahí el 70 % de
 * escapes de ese modo, igual antes y después. La consecuencia es de ENRUTADO: una
 * tarea cuya respuesta correcta pueda ser una abstención no debe enviarse a
 * sustitución local, porque su verja no la protege.
 *
 * Y UN LÍMITE HERMANO, que esta medición dejó a la vista: un campo `booleano` o
 * `referencia` cita una unidad y la verja no puede comprobar que sea la correcta.
 * Un «sí/no» con la cita movida pasa. También es enrutado.
 */

import {
  type CampoRespuesta,
  type DerivacionDeclarada,
  type OperandoDeclarado,
  type Respuesta,
  type UnidadDeEvidencia,
  type ValorCampo,
} from "./tipos.js";

/** Versión de ESTA verja. Va en el veredicto: un perfil de validación que se
 * factura tiene que poder decir con qué reglas se aprobó. */
export const VERSION_DE_LA_VERJA = "1.1.0";

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
  /** Un operando de la cuenta declarada no está copiado de una unidad citada. */
  | "operando-no-copiado"
  /** ★ La cuenta declarada no da el valor afirmado — o depende de un campo que no se sostiene. */
  | "derivacion-no-cuadra"
  /** Sin búsqueda ciega: el valor no está escrito y nadie declaró de dónde sale. */
  | "derivacion-no-declarada"
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


// ─────────────────── la cuenta DECLARADA (el campo `operation`) ───────────────────
//
// POR QUÉ ESTO ES MEJOR QUE BUSCAR, dicho con la aritmética a la vista. Buscar la
// cuenta obliga a recorrer todas las combinaciones de números de las unidades
// citadas: con n números y k términos son n^k fórmulas, y basta que UNA dé el
// valor afirmado para aprobarlo. Un número inventado tiene por tanto n^k tiros.
// Comprobar una cuenta declarada es UN tiro: la fórmula que dijo quien respondió,
// con los operandos que dijo, copiados de las unidades que citó.
//
// Y el coste para quien responde es cero: ya hizo la cuenta.

/** Un operando ya resuelto: o un número, o una fecha ISO. */
type OperandoResuelto = { numero: number; iso?: never } | { iso: string; numero?: never };

/** Los espacios exóticos que mete un PDF, plegados al espacio normal. */
function espaciosNormales(s: string): string {
  return s.replace(/[\s\u00a0\u202f\u2009]+/g, " ").trim();
}

/**
 * Si un literal está COPIADO de un texto, y no recortado de dentro de otro
 * número. Exige que la aparición tenga frontera por los dos lados: ni dígito, ni
 * coma, ni punto, ni «/», ni «-» pegados.
 *
 * POR QUÉ, con el caso que lo trajo. La calibración de la cuenta declarada dejó
 * pasar `suma(01, 07, 2,90) = 10,90` sobre una unidad que solo dice «vigente
 * l'01/07/2025 és del 2,90 %»: el «01» y el «07» son el DÍA y el MES de la fecha.
 * Sin frontera, cualquier fecha del texto regala cuatro operandos pequeños, y con
 * operandos pequeños se construye casi cualquier cifra. Es el mismo error que el
 * ISO «2025-03-12» casando como «25-03-12», y se arregla igual: con centinelas.
 *
 * El signo cuenta como parte del número: de «-450,00» se copia «-450,00», no
 * «450,00». Declarar la mitad de un número no es copiarlo.
 */
export function literalEstaCopiado(texto: string, literal: string): boolean {
  const t = espaciosNormales(texto);
  const l = espaciosNormales(literal);
  if (!l) return false;
  const digito = (c: string | undefined) => c !== undefined && /\d/.test(c);

  for (let i = t.indexOf(l); i >= 0; i = t.indexOf(l, i + 1)) {
    const antes = t[i - 1];
    const despues = t[i + l.length];
    // Por la IZQUIERDA: no se puede empezar a mitad de un número («05» dentro de
    // «10/05/2025»), ni después del signo que le pertenece («450,00» dentro de
    // «-450,00» es otro número).
    const empiezaAMedias =
      digito(antes) ||
      antes === "/" ||
      antes === "-" ||
      antes === "+" ||
      ((antes === "." || antes === ",") && digito(t[i - 2]));
    // Por la DERECHA la asimetría es la misma que en `fechasDe`, y por la misma
    // razón: un separador solo forma parte del número SI LE SIGUE UN DÍGITO.
    // «2.000» dentro de «2.000,00» se corta («,0»), pero «30/06/2024,» seguido de
    // coma y espacio es una fecha entera bien copiada — y excluir la coma a secas
    // rechazaba media docena de cuentas correctas.
    const acabaAMedias =
      digito(despues) ||
      ((despues === "." || despues === "," || despues === "/" || despues === "-") &&
        digito(t[i + l.length + 1]));
    if (!empiezaAMedias && !acabaAMedias) return true;
  }
  return false;
}

/**
 * Resuelve un operando declarado. Las dos formas se comprueban de forma distinta
 * y ninguna admite un «confía en mí»:
 *
 *   · copiado de una unidad: la unidad tiene que estar CITADA por el campo (no
 *     vale sacar un operando de evidencia que el campo no señala) y el literal
 *     tiene que APARECER en su texto. Se exige aparición literal, no igualdad de
 *     valor: «2.000,00» vale porque está escrito así; un «2000» que nadie
 *     escribió, no. Copiar es comprobable; «sale de la u3» no lo es.
 *   · otro campo: tiene que existir en la respuesta y estar ya sostenido. Si
 *     todavía no lo está, se devuelve `pendiente` y el que llama lo reintenta en
 *     la pasada siguiente; si nunca se resuelve (dependencia que no se sostiene,
 *     o un ciclo), el campo se rechaza. Falla cerrada también aquí.
 */
function resuelveOperando(
  op: OperandoDeclarado,
  citas: readonly string[],
  porId: ReadonlyMap<string, UnidadDeEvidencia>,
  yaResueltos: ReadonlyMap<string, OperandoResuelto>,
  camposPorNombre: ReadonlyMap<string, CampoRespuesta>,
): { ok: OperandoResuelto } | { pendiente: true } | { fallo: string } {
  if (op.campo !== undefined) {
    const hermano = camposPorNombre.get(op.campo);
    if (!hermano) return { fallo: `el operando apunta al campo «${op.campo}», que no está en la respuesta` };
    // LA CITA NO SE LAVA POR EL CAMINO. Si mi número sale de otro campo, mi
    // evidencia tiene que incluir la de ese campo: lo contrario deja sostener un
    // valor sin que sus propias citas sostengan nada, y el banco lo cazó —el modo
    // `cita-movida-a-distractora` pasó de 7 escapes a 12 en cuanto se admitieron
    // operandos de tipo campo sin esta exigencia.
    const sinCitar = hermano.citas.filter((c) => !citas.includes(c));
    if (sinCitar.length)
      return {
        fallo:
          `el operando sale del campo «${op.campo}», que se apoya en ${sinCitar.join(", ")}; ` +
          "para usarlo hay que citar también esa evidencia",
      };
    const v = yaResueltos.get(op.campo);
    return v ? { ok: v } : { pendiente: true };
  }
  if (op.unidad === undefined || op.literal === undefined) return { fallo: "operando sin `unidad`+`literal` ni `campo`" };
  if (!citas.includes(op.unidad))
    return { fallo: `el operando sale de «${op.unidad}», que el campo NO cita` };
  const u = porId.get(op.unidad);
  if (!u) return { fallo: `el operando sale de «${op.unidad}», que no se entregó` };
  if (!literalEstaCopiado(u.texto, op.literal))
    return {
      fallo:
        `«${op.literal}» no está escrito como tal en ${op.unidad}: un operando se COPIA entero, ` +
        "no se recorta de dentro de otro número ni de una fecha",
    };
  const fechas = fechasDe(op.literal);
  if (fechas.length === 1 && fechas[0]) return { ok: { iso: fechas[0] } };
  const n = valorNumerico(op.literal);
  if (n === null) return { fallo: `«${op.literal}» no es ni un número ni una fecha reconocible` };
  return { ok: { numero: n } };
}

const DIA_EN_MS = 86_400_000;

/**
 * Cuántos operandos admite como mucho una cuenta declarada.
 *
 * ES EL TECHO DE LO MEDIDO, no una limitación técnica. Al comprobar una cuenta
 * declarada los términos no multiplican los tiros del adversario —sigue teniendo
 * uno— pero sí le dan libertad para CONSTRUIR una cuenta que cuadre con los
 * números que tiene a mano: cuantos más términos, más fácil es acertar un número
 * falso. Cuánto cuesta eso exactamente está medido en el banco hasta TRES
 * términos, que es lo que el declarador explora. Admitir doce sería superficie
 * cuyo precio nadie ha medido, y este repositorio tiene una lección sobre eso.
 *
 * Para subirlo: ensanchar primero el declarador del banco, volver a correr
 * `pnpm verja:calibrar` y mirar la columna del oportunista.
 */
const MAX_OPERANDOS = 3;

function aFecha(iso: string): number {
  const [a, m, d] = iso.split("-");
  return Date.UTC(Number(a), Number(m) - 1, Number(d));
}

function deFecha(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Aplica la operación declarada. Devuelve el resultado como número o como fecha
 * ISO, o el motivo por el que la cuenta no se puede ni hacer (aridad equivocada,
 * una fecha donde iba un número). Ninguna operación adivina nada: si los
 * operandos no son del tipo que pide, es un fallo, no una interpretación.
 */
function aplicaOperacion(
  d: DerivacionDeclarada,
  ops: readonly OperandoResuelto[],
): { numero: number } | { iso: string } | { fallo: string } {
  const nums = ops.map((o) => o.numero);
  const todosNumeros = (): number[] | null => (nums.every((n) => n !== undefined) ? (nums as number[]) : null);
  const aridad = (min: number, max = min): string | null =>
    ops.length < min || ops.length > max
      ? `«${d.operacion}» necesita ${min === max ? min : `entre ${min} y ${max}`} operandos y le pasaron ${ops.length}`
      : null;

  switch (d.operacion) {
    case "suma":
    case "producto":
    case "resta":
    case "base-mas-porcentajes": {
      const falta = aridad(2, MAX_OPERANDOS);
      if (falta) return { fallo: falta };
      const ns = todosNumeros();
      if (!ns) return { fallo: `«${d.operacion}» no admite fechas como operandos` };
      if (d.operacion === "suma") return { numero: ns.reduce((a, b) => a + b, 0) };
      if (d.operacion === "producto") return { numero: ns.reduce((a, b) => a * b, 1) };
      const [cabeza, ...resto] = ns as [number, ...number[]];
      if (d.operacion === "resta") return { numero: resto.reduce((a, b) => a - b, cabeza) };
      return { numero: cabeza * (1 + resto.reduce((a, b) => a + b, 0) / 100) };
    }
    case "porcentaje": {
      const falta = aridad(2);
      if (falta) return { fallo: falta };
      const ns = todosNumeros();
      if (!ns) return { fallo: "«porcentaje» no admite fechas como operandos" };
      return { numero: (ns[0]! * ns[1]!) / 100 };
    }
    case "interes-por-dias": {
      const falta = aridad(4);
      if (falta) return { fallo: falta };
      const ns = todosNumeros();
      if (!ns) return { fallo: "«interes-por-dias» no admite fechas como operandos" };
      const [principal, tipo, dias, baseDias] = ns as [number, number, number, number];
      if (baseDias === 0) return { fallo: "base de días 0" };
      return { numero: (principal * (tipo / 100) * dias) / baseDias };
    }
    case "fecha-mas-dias":
    case "fecha-mas-semanas": {
      const falta = aridad(2, MAX_OPERANDOS);
      if (falta) return { fallo: falta };
      const cabeza = ops[0];
      if (!cabeza?.iso) return { fallo: `«${d.operacion}» necesita una fecha como primer operando` };
      const plazos = ops.slice(1).map((o) => o.numero);
      if (plazos.some((n) => n === undefined)) return { fallo: "el plazo tiene que ser un número" };
      const dias = (plazos as number[]).reduce((a, b) => a + b, 0) * (d.operacion === "fecha-mas-semanas" ? 7 : 1);
      if (!Number.isInteger(dias)) return { fallo: `un plazo de ${dias} días no es un número entero de días` };
      return { iso: deFecha(aFecha(cabeza.iso) + dias * DIA_EN_MS) };
    }
    case "dias-entre-fechas": {
      const falta = aridad(2);
      if (falta) return { fallo: falta };
      const [a, b] = ops as [OperandoResuelto, OperandoResuelto];
      if (!a.iso || !b.iso) return { fallo: "«dias-entre-fechas» necesita dos fechas" };
      return { numero: Math.round((aFecha(b.iso) - aFecha(a.iso)) / DIA_EN_MS) };
    }
  }
}

/** El valor de un campo como número, si su clase lo tiene. */
function numeroDelValor(v: ValorCampo): number | null {
  switch (v.clase) {
    case "importe":
      return Number(v.cantidad);
    case "porcentaje":
      return Number(v.valor);
    case "entero":
      return v.valor;
    default:
      return null;
  }
}

/**
 * Comprueba LA cuenta declarada de un campo. Tres resultados posibles, y el del
 * medio es el que permite encadenar campos sin ensanchar nada:
 *
 *   `{ cuadra: true }`  la cuenta da el valor afirmado
 *   `{ pendiente: true }`  depende de otro campo que todavía no se ha resuelto
 *   `{ reparo }`  no cuadra, y con el motivo exacto
 */
function comprobarDerivacion(
  campo: CampoRespuesta,
  porId: ReadonlyMap<string, UnidadDeEvidencia>,
  yaResueltos: ReadonlyMap<string, OperandoResuelto>,
  camposPorNombre: ReadonlyMap<string, CampoRespuesta>,
): { cuadra: true } | { pendiente: true } | { reparo: ReparoDeLaVerja } {
  const d = campo.derivacion;
  if (!d) return { reparo: { motivo: "derivacion-no-cuadra", campo: campo.nombre, detalle: "sin derivación declarada" } };

  const resueltos: OperandoResuelto[] = [];
  for (const op of d.operandos) {
    const r = resuelveOperando(op, campo.citas, porId, yaResueltos, camposPorNombre);
    if ("pendiente" in r) return { pendiente: true };
    if ("fallo" in r)
      return {
        reparo: {
          motivo: op.campo !== undefined ? "derivacion-no-cuadra" : "operando-no-copiado",
          campo: campo.nombre,
          detalle: r.fallo,
        },
      };
    resueltos.push(r.ok);
  }

  const salida = aplicaOperacion(d, resueltos);
  if ("fallo" in salida)
    return { reparo: { motivo: "derivacion-no-cuadra", campo: campo.nombre, detalle: salida.fallo } };

  if (campo.valor.clase === "fecha") {
    if (!("iso" in salida))
      return {
        reparo: {
          motivo: "derivacion-no-cuadra",
          campo: campo.nombre,
          detalle: `«${d.operacion}» da un número y el campo es una fecha`,
        },
      };
    return salida.iso === campo.valor.iso
      ? { cuadra: true }
      : {
          reparo: {
            motivo: "derivacion-no-cuadra",
            campo: campo.nombre,
            detalle: `la cuenta declarada (${d.operacion}) da ${salida.iso} y el campo afirma ${campo.valor.iso}`,
          },
        };
  }

  const esperado = numeroDelValor(campo.valor);
  if (esperado === null)
    return {
      reparo: {
        motivo: "derivacion-no-cuadra",
        campo: campo.nombre,
        detalle: `un valor de clase «${campo.valor.clase}» no se calcula`,
      },
    };
  if (!("numero" in salida))
    return {
      reparo: {
        motivo: "derivacion-no-cuadra",
        campo: campo.nombre,
        detalle: `«${d.operacion}» da una fecha y el campo es un número`,
      },
    };
  // Medio céntimo, igual que el rastreo literal: un corpus que distinga
  // 39,3198 de 39,32 rechaza por redondeo y no por contenido.
  return Math.abs(salida.numero - esperado) < 0.005
    ? { cuadra: true }
    : {
        reparo: {
          motivo: "derivacion-no-cuadra",
          campo: campo.nombre,
          detalle: `la cuenta declarada (${d.operacion}) da ${salida.numero.toFixed(4)} y el campo afirma ${esperado}`,
        },
      };
}

/**
 * Si el valor del campo está ESCRITO en alguno de los textos citados. Literal: sin
 * cuentas, ni declaradas ni adivinadas. Es el camino barato y el único que no
 * añade ninguna superficie.
 */
export function valorEstaEscrito(v: ValorCampo, textos: string[]): boolean {
  switch (v.clase) {
    case "importe":
      return textos.some((t) => contieneNumero(t, Number(v.cantidad)));
    case "porcentaje":
      return textos.some((t) => contieneNumero(t, Number(v.valor)));
    case "entero":
      return textos.some((t) => contieneNumero(t, v.valor));
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
 * La BÚSQUEDA CIEGA de dos términos: el camino de antes, el que existe para las
 * respuestas que no declaran su cuenta. Se queda porque quitarlo rompería a quien
 * ya usa la verja sin declarar nada, y porque su precio está medido. Pero la
 * salida buena es declarar: ver `comprobarDerivacion`.
 */
function seRastreaCiego(v: ValorCampo, textos: string[]): boolean {
  const n = numeroDelValor(v);
  return n !== null && seDeriva(n, textos);
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
  /**
   * `derivacionCiega` (por defecto `true`): si la verja puede intentar ADIVINAR
   * la cuenta cuando el valor no está escrito y la respuesta no la declara. Es
   * el comportamiento de la 1.0.0 y se queda encendido por defecto para no
   * romper a quien ya la usa.
   *
   * Apagarla es la postura que recomienda el banco de calibración: con la cuenta
   * declarada no hace falta adivinar, y adivinar es justo lo que deja pasar un
   * importe inventado que resulta derivable por casualidad. Las dos cifras de
   * esa decisión están medidas en `corpus/calibrar-la-verja.ts`.
   */
  opciones?: { derivacionCiega?: boolean },
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
    const porRastrear: Array<{ campo: CampoRespuesta; textos: string[] }> = [];

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

      if (esRastreable(campo.valor) && textos.length) {
        rastreables += 1;
        porRastrear.push({ campo, textos });
      } else if (esRastreable(campo.valor)) {
        rastreables += 1;
      }
    }

    // ── El rastreo, EN DOS FASES Y POR PASADAS ──
    //
    // Antes era una sola pasada porque un campo solo podía apoyarse en el texto.
    // Con la cuenta declarada un campo puede apoyarse en OTRO CAMPO —los
    // intereses de demora se calculan sobre unos días de mora que son a su vez
    // una resta de fechas—, y eso obliga a resolver por pasadas: cada pasada
    // resuelve lo que ya tiene sus dependencias resueltas. Cuando una pasada no
    // avanza, lo que queda no se sostiene: o depende de algo que falló, o es un
    // ciclo. En los dos casos se RECHAZA, que es lo que hace una verja que falla
    // cerrada.
    const resueltos = new Map<string, OperandoResuelto>();
    const camposPorNombre = new Map(respuesta.campos.map((c) => [c.nombre, c]));
    const registra = (campo: CampoRespuesta) => {
      if (campo.valor.clase === "fecha") resueltos.set(campo.nombre, { iso: campo.valor.iso });
      else {
        const n = numeroDelValor(campo.valor);
        if (n !== null) resueltos.set(campo.nombre, { numero: n });
      }
    };

    // Fase 1 · lo que está ESCRITO. Un campo declarado se comprueba por su
    // cuenta aunque además aparezca literal: una cuenta declarada que no cuadra
    // es una mentira sobre la propia aritmética, y pasarla por alto porque el
    // número esté escrito convertiría el campo `operation` en decoración.
    const pendientes = porRastrear.filter(({ campo, textos }) => {
      if (!campo.derivacion && valorEstaEscrito(campo.valor, textos)) {
        rastreados += 1;
        registra(campo);
        return false;
      }
      return true;
    });

    // Fase 2 · las cuentas DECLARADAS, por pasadas.
    let quedan = pendientes.filter(({ campo }) => campo.derivacion);
    let avanza = true;
    while (quedan.length && avanza) {
      avanza = false;
      const siguiente: typeof quedan = [];
      for (const p of quedan) {
        const r = comprobarDerivacion(p.campo, porId, resueltos, camposPorNombre);
        if ("pendiente" in r) {
          siguiente.push(p);
          continue;
        }
        avanza = true;
        if ("cuadra" in r) {
          rastreados += 1;
          registra(p.campo);
        } else reparos.push(r.reparo);
      }
      quedan = siguiente;
    }
    for (const p of quedan)
      reparos.push({
        motivo: "derivacion-no-cuadra",
        campo: p.campo.nombre,
        detalle:
          "la cuenta declarada depende de un campo que no se sostiene, o de sí misma: " +
          "una dependencia circular no se resuelve y por eso se rechaza",
      });

    // Fase 3 · lo que no está escrito y nadie declaró. Aquí vive la búsqueda
    // ciega de dos términos, con su precio medido; `derivacionCiega: false` la
    // apaga y entonces la única forma de sostener un valor calculado es
    // declararlo.
    for (const { campo, textos } of pendientes) {
      if (campo.derivacion) continue;
      if (opciones?.derivacionCiega !== false && seRastreaCiego(campo.valor, textos)) {
        rastreados += 1;
        registra(campo);
        continue;
      }
      reparos.push(
        opciones?.derivacionCiega === false
          ? {
              motivo: "derivacion-no-declarada",
              campo: campo.nombre,
              detalle:
                `el valor afirmado no está escrito en sus unidades citadas (${campo.citas.join(", ")}) ` +
                "y la respuesta no declara de qué cuenta sale",
            }
          : {
              motivo: "valor-no-rastreable",
              campo: campo.nombre,
              detalle: `el valor afirmado no aparece en ninguna de sus unidades citadas (${campo.citas.join(", ")})`,
            },
      );
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
