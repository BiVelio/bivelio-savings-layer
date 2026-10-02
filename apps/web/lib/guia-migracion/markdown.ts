/**
 * Un lector de Markdown MÍNIMO para pintar docs/MIGRAR-A-0.5.md en la web.
 *
 * Por qué no una dependencia: la web no lleva ninguna librería de Markdown y
 * esta página es la única que lo necesita. Lo que sale de aquí es un árbol de
 * datos que la página convierte en elementos de React, nunca HTML en crudo:
 * no hay `dangerouslySetInnerHTML` en la web y esta página no lo estrena.
 *
 * Cubre lo que usa la guía, y `markdown.test.ts` comprueba que la guía entera
 * se lee sin dejar nada fuera: títulos (con el mismo id que GitHub, para que
 * los enlaces internos de la guía funcionen igual allí y aquí), párrafos,
 * citas, listas (con bloques de código dentro), tablas, bloques de código,
 * separadores, y en línea `código`, **negrita**, *cursiva* y [enlaces](#ancla).
 */

export type EnLinea =
  | { t: "texto"; v: string }
  | { t: "codigo"; v: string }
  | { t: "negrita"; c: EnLinea[] }
  | { t: "cursiva"; c: EnLinea[] }
  | { t: "enlace"; href: string; c: EnLinea[] };

export type Bloque =
  | { t: "titulo"; nivel: number; id: string; c: EnLinea[] }
  | { t: "parrafo"; c: EnLinea[] }
  | { t: "codigo"; lenguaje: string; v: string }
  | { t: "cita"; c: Bloque[] }
  | { t: "lista"; ordenada: boolean; inicio: number; items: Bloque[][] }
  | { t: "tabla"; cabecera: EnLinea[][]; filas: EnLinea[][][] }
  | { t: "separador" };

const VALLA = /^(`{3,})\s*([\w-]*)\s*$/;
const TITULO = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const SEPARADOR = /^(-{3,}|\*{3,})\s*$/;
const MARCA_DE_LISTA = /^([-*+]|\d{1,9}\.)\s+/;
const FILA_SEPARADORA = /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

/** El id que GitHub da a un título: minúsculas, sin puntuación, espacios → «-». */
export function idDeTitulo(texto: string): string {
  return texto
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .trim()
    .replace(/\s/g, "-");
}

/** El texto plano de un fragmento en línea (para ids y para `aria-label`). */
export function textoPlano(c: readonly EnLinea[]): string {
  return c.map((n) => (n.t === "texto" || n.t === "codigo" ? n.v : textoPlano(n.c))).join("");
}

// ── En línea ────────────────────────────────────────────────────────────────

export function leerEnLinea(s: string): EnLinea[] {
  const out: EnLinea[] = [];
  let texto = "";
  const vaciar = () => {
    if (texto) out.push({ t: "texto", v: texto });
    texto = "";
  };
  let i = 0;
  while (i < s.length) {
    const ch = s[i]!;
    if (ch === "\\" && i + 1 < s.length && /[\\`*_[\]()#|<>-]/.test(s[i + 1]!)) {
      texto += s[i + 1];
      i += 2;
      continue;
    }
    if (ch === "`") {
      let n = 1;
      while (s[i + n] === "`") n++;
      const valla = "`".repeat(n);
      const fin = s.indexOf(valla, i + n);
      if (fin !== -1) {
        vaciar();
        const dentro = s.slice(i + n, fin);
        out.push({ t: "codigo", v: dentro.length > 1 && dentro.startsWith(" ") && dentro.endsWith(" ") ? dentro.slice(1, -1) : dentro });
        i = fin + n;
        continue;
      }
    }
    if (s.startsWith("**", i)) {
      const fin = s.indexOf("**", i + 2);
      if (fin > i + 2) {
        vaciar();
        out.push({ t: "negrita", c: leerEnLinea(s.slice(i + 2, fin)) });
        i = fin + 2;
        continue;
      }
    }
    // Cursiva solo con `*`: con `_` partiría BVSALA_GATEWAY_EFFORT en tres.
    if (ch === "*" && s[i + 1] !== " " && s[i + 1] !== "*") {
      const fin = s.indexOf("*", i + 1);
      if (fin > i + 1 && s[fin - 1] !== " ") {
        vaciar();
        out.push({ t: "cursiva", c: leerEnLinea(s.slice(i + 1, fin)) });
        i = fin + 1;
        continue;
      }
    }
    if (ch === "[") {
      const cierre = s.indexOf("](", i + 1);
      const fin = cierre === -1 ? -1 : s.indexOf(")", cierre + 2);
      if (cierre !== -1 && fin !== -1) {
        vaciar();
        out.push({ t: "enlace", href: s.slice(cierre + 2, fin).trim(), c: leerEnLinea(s.slice(i + 1, cierre)) });
        i = fin + 1;
        continue;
      }
    }
    texto += ch;
    i++;
  }
  vaciar();
  return out;
}

/** Parte una fila de tabla por `|`, sin partir dentro de `código` ni en `\|`. */
export function celdas(fila: string): string[] {
  let s = fila.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const out: string[] = [];
  let actual = "";
  let enCodigo = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === "\\" && s[i + 1] === "|") {
      actual += enCodigo ? "\\|" : "|";
      i++;
      continue;
    }
    if (ch === "`") enCodigo = !enCodigo;
    if (ch === "|" && !enCodigo) {
      out.push(actual.trim());
      actual = "";
      continue;
    }
    actual += ch;
  }
  out.push(actual.trim());
  // Dentro de `código`, `\|` es un `|` literal (GitHub lo pinta así en tablas).
  return out.map((c) => c.replace(/\\\|/g, "|"));
}

// ── Bloques ─────────────────────────────────────────────────────────────────

function sangria(l: string): number {
  return l.length - l.trimStart().length;
}

function empiezaBloque(l: string): boolean {
  return VALLA.test(l) || TITULO.test(l) || SEPARADOR.test(l) || l.startsWith(">") || MARCA_DE_LISTA.test(l) || l.startsWith("|");
}

export function leerBloques(lineas: readonly string[]): Bloque[] {
  const out: Bloque[] = [];
  let i = 0;
  while (i < lineas.length) {
    const l = lineas[i]!;
    if (l.trim() === "") {
      i++;
      continue;
    }
    const valla = VALLA.exec(l);
    if (valla) {
      const cierre = valla[1]!;
      const cuerpo: string[] = [];
      i++;
      while (i < lineas.length && !(lineas[i]!.trim().startsWith(cierre) && lineas[i]!.trim().replace(/`/g, "") === "")) {
        cuerpo.push(lineas[i]!);
        i++;
      }
      i++; // la valla de cierre
      out.push({ t: "codigo", lenguaje: valla[2] ?? "", v: cuerpo.join("\n") });
      continue;
    }
    const titulo = TITULO.exec(l);
    if (titulo) {
      const c = leerEnLinea(titulo[2]!);
      out.push({ t: "titulo", nivel: titulo[1]!.length, id: idDeTitulo(textoPlano(c)), c });
      i++;
      continue;
    }
    if (SEPARADOR.test(l)) {
      out.push({ t: "separador" });
      i++;
      continue;
    }
    if (l.startsWith(">")) {
      const dentro: string[] = [];
      while (i < lineas.length && lineas[i]!.startsWith(">")) {
        dentro.push(lineas[i]!.replace(/^>\s?/, ""));
        i++;
      }
      out.push({ t: "cita", c: leerBloques(dentro) });
      continue;
    }
    if (l.startsWith("|") && i + 1 < lineas.length && FILA_SEPARADORA.test(lineas[i + 1]!)) {
      const cabecera = celdas(l).map(leerEnLinea);
      i += 2;
      const filas: EnLinea[][][] = [];
      while (i < lineas.length && lineas[i]!.startsWith("|")) {
        filas.push(celdas(lineas[i]!).map(leerEnLinea));
        i++;
      }
      out.push({ t: "tabla", cabecera, filas });
      continue;
    }
    const marca = MARCA_DE_LISTA.exec(l);
    if (marca) {
      const ordenada = /\d/.test(marca[1]!);
      const items: Bloque[][] = [];
      const inicio = ordenada ? Number.parseInt(marca[1]!, 10) : 1;
      while (i < lineas.length) {
        const m = MARCA_DE_LISTA.exec(lineas[i]!);
        if (!m || /\d/.test(m[1]!) !== ordenada) break;
        const ancho = m[0].length;
        const item: string[] = [lineas[i]!.slice(ancho)];
        i++;
        // Continuación: líneas sangradas (al menos el ancho de la marca), con
        // líneas en blanco en medio si lo que sigue sigue sangrado.
        while (i < lineas.length) {
          const s = lineas[i]!;
          if (s.trim() === "") {
            let j = i;
            while (j < lineas.length && lineas[j]!.trim() === "") j++;
            if (j < lineas.length && sangria(lineas[j]!) >= ancho) {
              for (; i < j; i++) item.push("");
              continue;
            }
            break;
          }
          if (sangria(s) >= ancho) {
            item.push(s.slice(Math.min(ancho, sangria(s))));
            i++;
            continue;
          }
          // Línea perezosa: un párrafo que sigue sin sangría.
          if (!empiezaBloque(s) && item[item.length - 1]!.trim() !== "") {
            item.push(s);
            i++;
            continue;
          }
          break;
        }
        items.push(leerBloques(item));
        // Una línea en blanco entre ítems no corta la lista.
        let j = i;
        while (j < lineas.length && lineas[j]!.trim() === "") j++;
        const sigue = j < lineas.length ? MARCA_DE_LISTA.exec(lineas[j]!) : null;
        if (sigue && /\d/.test(sigue[1]!) === ordenada) i = j;
        else break;
      }
      out.push({ t: "lista", ordenada, inicio, items });
      continue;
    }
    // Párrafo: hasta una línea en blanco o el comienzo de otro bloque.
    const p: string[] = [];
    while (i < lineas.length && lineas[i]!.trim() !== "" && (p.length === 0 || !empiezaBloque(lineas[i]!))) {
      p.push(lineas[i]!.trim());
      i++;
    }
    out.push({ t: "parrafo", c: leerEnLinea(p.join(" ")) });
  }
  return out;
}

export function leerMarkdown(texto: string): Bloque[] {
  return leerBloques(texto.replace(/\r\n?/g, "\n").split("\n"));
}

/** Todos los enlaces del documento (para comprobar que ninguno queda roto). */
export function enlaces(bloques: readonly Bloque[]): string[] {
  const out: string[] = [];
  const enLinea = (c: readonly EnLinea[]) => {
    for (const n of c) {
      if (n.t === "enlace") out.push(n.href);
      if (n.t === "negrita" || n.t === "cursiva" || n.t === "enlace") enLinea(n.c);
    }
  };
  const recorrer = (bs: readonly Bloque[]) => {
    for (const b of bs) {
      if (b.t === "titulo" || b.t === "parrafo") enLinea(b.c);
      else if (b.t === "cita") recorrer(b.c);
      else if (b.t === "lista") b.items.forEach(recorrer);
      else if (b.t === "tabla") [b.cabecera, ...b.filas].forEach((f) => f.forEach(enLinea));
    }
  };
  recorrer(bloques);
  return out;
}

/** Los ids de todos los títulos, en orden. */
export function idsDeTitulos(bloques: readonly Bloque[]): string[] {
  const out: string[] = [];
  const recorrer = (bs: readonly Bloque[]) => {
    for (const b of bs) {
      if (b.t === "titulo") out.push(b.id);
      else if (b.t === "cita") recorrer(b.c);
      else if (b.t === "lista") b.items.forEach(recorrer);
    }
  };
  recorrer(bloques);
  return out;
}
