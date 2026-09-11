import { describe, it, expect } from "vitest";

import casosEs from "../corpus/facturacion-y-cobros/casos-es.json";
import casosCa from "../corpus/facturacion-y-cobros/casos-ca.json";
import { verjaDeExtraccion } from "../corpus/verja-de-extraccion.js";
import { declararLoQueHagaFalta } from "../corpus/declarar-la-derivacion.js";
import type { CasoDelCorpus, Respuesta, UnidadDeEvidencia } from "../corpus/tipos.js";

/**
 * LA VERJA SOBRE LA VERJA — corre la calibración contra el golden set en cada
 * `pnpm test` y suspende si alguien afloja la comprobación que importa.
 *
 * POR QUÉ NO BASTA CON LAS PRUEBAS UNITARIAS. Las de `verja-de-extraccion`
 * comprueban casos escritos a mano: pasan siempre que la lógica haga lo que su
 * autor pensó. Lo que NO pueden ver es el precio agregado de una decisión — que
 * ensanchar la puerta de derivación un término compre seis puntos de falso
 * rechazo a cambio de triplicar los escapes del importe vecino. Eso solo se ve
 * corriendo los 60 casos, y si no está en el CI caduca en el primer refactor.
 *
 * Las cotas de aquí son TECHOS medidos el 2026-09-11, no objetivos:
 *   · tres modos fuertes están a CERO escapes y ahí tienen que quedarse;
 *   · `importe-vecino` está en 1 de 28 — era 0 antes de admitir el valor
 *     derivado, y ese escape único es el precio medido de esa decisión;
 *   · el falso rechazo está en 38,3 % y se deja margen hasta 45 % para que un
 *     caso nuevo del corpus no rompa el CI por sí solo;
 *   · el falso aceptado global está en 7,4 % con techo en 10 %.
 *
 * Y DESDE LA 1.1.0, la cuenta declarada, con sus propios techos medidos el
 * 2026-09-11 (último bloque de este fichero):
 *   · falso rechazo 3,3 % con la cuenta declarada y la búsqueda ciega apagada;
 *   · el adversario REALISTA —se equivoca en el valor y mantiene su declaración—
 *     no escapa ni una vez en los dos modos numéricos;
 *   · el adversario MÁXIMO —rebusca una cuenta que justifique el número falso—
 *     escapa 1 de 28 y 1 de 14, y esos dos escapes son el precio de la palanca.
 *
 * Si una de estas suspende, la pregunta no es «cómo subo el techo» sino qué se
 * rompió: un escape nuevo en `importe-vecino` es un dato falso entregado como
 * bueno, que es el único fallo de esta pieza que no se recupera.
 */

const TODOS = [
  ...(casosEs as unknown as { casos: CasoDelCorpus[] }).casos,
  ...(casosCa as unknown as { casos: CasoDelCorpus[] }).casos,
];

const clona = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const desempateDe = (c: CasoDelCorpus) => (c as { desempate?: { regla: string; ganadora: string | null } }).desempate;

/** Cambia dos cifras de sitio: 968.00 → 986.00. El importe de la línea de al lado. */
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

/** Corre un mutante sobre todo el corpus y devuelve cuántos ESCAPAN. */
function escapes(mutar: (c: CasoDelCorpus) => Respuesta | null): { escapes: number; aplicados: number } {
  let e = 0;
  let n = 0;
  for (const c of TODOS) {
    const r = mutar(c);
    if (!r) continue;
    n += 1;
    if (verjaDeExtraccion(r, c.evidencia as UnidadDeEvidencia[], desempateDe(c)).aceptada) e += 1;
  }
  return { escapes: e, aplicados: n };
}

describe("calibración de la verja contra el golden set de facturación", () => {
  it("el corpus de trabajo no se ha vaciado", () => {
    expect(TODOS.length).toBeGreaterThanOrEqual(60);
  });

  it("el falso rechazo se mantiene bajo el techo medido", () => {
    const rechazadas = TODOS.filter(
      (c) => !verjaDeExtraccion(c.respuesta, c.evidencia as UnidadDeEvidencia[], desempateDe(c)).aceptada,
    ).length;
    const tasa = (100 * rechazadas) / TODOS.length;
    expect(tasa).toBeLessThanOrEqual(45);
  });
});

describe("★ los modos fuertes, fijados en su cifra medida", () => {
  it("importe-vecino: como mucho 1 de 28 — es la comprobación estrella", () => {
    const r = escapes((c) => {
      const resp = clona(c.respuesta);
      if (resp.tipo !== "valor") return null;
      const campo = resp.campos.find((x) => x.valor.clase === "importe");
      if (!campo || campo.valor.clase !== "importe") return null;
      const nuevo = vecino(campo.valor.cantidad);
      if (nuevo === campo.valor.cantidad) return null;
      campo.valor.cantidad = nuevo;
      return resp;
    });
    expect(r.aplicados).toBeGreaterThan(20);
    // Un escape más que este significa que `seDeriva` se ha ensanchado y que
    // el importe de la línea de al lado ha empezado a colarse. No subir la cota:
    // mirar qué cambió.
    expect(r.escapes).toBeLessThanOrEqual(1);
  });

  it("cita-fantasma: CERO", () => {
    const r = escapes((c) => {
      const resp = clona(c.respuesta);
      if (resp.tipo !== "valor" || !resp.campos.length) return null;
      resp.campos[0]!.citas = ["u-fantasma"];
      return resp;
    });
    expect(r.aplicados).toBeGreaterThan(40);
    expect(r.escapes).toBe(0);
  });

  it("sin-cita: CERO", () => {
    const r = escapes((c) => {
      const resp = clona(c.respuesta);
      if (resp.tipo !== "valor" || !resp.campos.length) return null;
      resp.campos[0]!.citas = [];
      return resp;
    });
    expect(r.aplicados).toBeGreaterThan(40);
    expect(r.escapes).toBe(0);
  });

  it("fecha-invertida: CERO", () => {
    const r = escapes((c) => {
      const resp = clona(c.respuesta);
      if (resp.tipo !== "valor") return null;
      const campo = resp.campos.find((x) => x.valor.clase === "fecha");
      if (!campo || campo.valor.clase !== "fecha") return null;
      const [a, m, d] = campo.valor.iso.split("-");
      if (!a || !m || !d || m === d) return null;
      campo.valor.iso = `${a}-${d}-${m}`;
      return resp;
    });
    expect(r.aplicados).toBeGreaterThan(8);
    expect(r.escapes).toBe(0);
  });
});

describe("los modos que la verja ve MAL, fijados para que no empeoren en silencio", () => {
  it("cita-movida-a-distractora: escapa algo, pero no más del 20 %", () => {
    const r = escapes((c) => {
      const resp = clona(c.respuesta);
      if (resp.tipo !== "valor" || !resp.campos.length) return null;
      const d = c.evidencia.find((u) => u.papel === "distractora");
      if (!d) return null;
      resp.campos[0]!.citas = [d.id];
      return resp;
    });
    expect((100 * r.escapes) / r.aplicados).toBeLessThanOrEqual(20);
  });

  it("⚠️ contestar en vez de abstenerse ESCAPA, y está documentado como límite duro", () => {
    // No es un fallo a corregir: la evidencia insuficiente no deja huella
    // visible, así que por fuera es idéntica a la suficiente. La consecuencia
    // es de ENRUTADO — una tarea que pueda tener que abstenerse no debe ir a
    // sustitución local. Esta prueba fija el hecho para que nadie lo olvide.
    const r = escapes((c) => {
      if (c.respuesta.tipo !== "abstencion") return null;
      const u = c.evidencia[0];
      if (!u) return null;
      return {
        tipo: "valor",
        campos: [
          {
            nombre: "inventado",
            valor: { clase: "identificador", valor: u.texto.slice(0, 12).trim() },
            critico: true,
            citas: [u.id],
          },
        ],
      };
    });
    expect(r.aplicados).toBeGreaterThan(0);
    expect(r.escapes).toBeGreaterThan(0);
  });
});


describe("★ la cuenta declarada (1.1.0): lo que gana y lo que cuesta", () => {
  /** La misma respuesta del corpus, con su cuenta declarada por el declarador. */
  const declarada = (c: CasoDelCorpus) => declararLoQueHagaFalta(c.respuesta, c.evidencia);
  const SIN_CIEGA = { derivacionCiega: false } as const;

  it("declarar derrumba el falso rechazo, y por eso existe la palanca", () => {
    const rechazaCiega = TODOS.filter(
      (c) => !verjaDeExtraccion(c.respuesta, c.evidencia as UnidadDeEvidencia[], desempateDe(c)).aceptada,
    ).length;
    const rechazaDeclarada = TODOS.filter(
      (c) =>
        !verjaDeExtraccion(declarada(c), c.evidencia as UnidadDeEvidencia[], desempateDe(c), SIN_CIEGA).aceptada,
    ).length;
    const tasa = (100 * rechazaDeclarada) / TODOS.length;
    // Medido 3,3 % (2 de 60). El techo deja sitio a casos nuevos del corpus, pero
    // no a una regresión: si esto sube de 8 %, el declarador dejó de encontrar
    // cuentas que antes encontraba.
    expect(tasa).toBeLessThanOrEqual(8);
    // Y la comparación es el argumento entero: 23 rechazos contra 2.
    expect(rechazaDeclarada).toBeLessThan(rechazaCiega - 15);
  });

  it("los dos que siguen rechazados son los del operando escrito EN PALABRAS", () => {
    // «el tipo del BCE más OCHO puntos porcentuales»: no hay ningún «8» que
    // copiar, así que no hay cuenta declarable. Se fija aquí para que, si alguien
    // abre la puerta de los números en palabras, tenga que venir con su precio
    // medido y cambiar esta prueba a conciencia.
    const siguen = TODOS.filter(
      (c) =>
        !verjaDeExtraccion(declarada(c), c.evidencia as UnidadDeEvidencia[], desempateDe(c), SIN_CIEGA).aceptada,
    ).map((c) => c.id);
    expect(siguen).toEqual(["fac-es-013", "fac-ca-010"]);
  });

  it("ADVERSARIO REALISTA: se equivoca en el importe y mantiene su declaración → CERO escapes", () => {
    let escapes = 0;
    let aplicados = 0;
    for (const c of TODOS) {
      const resp = clona(declarada(c));
      if (resp.tipo !== "valor") continue;
      const campo = resp.campos.find((x) => x.valor.clase === "importe");
      if (!campo || campo.valor.clase !== "importe") continue;
      const nuevo = vecino(campo.valor.cantidad);
      if (nuevo === campo.valor.cantidad) continue;
      campo.valor.cantidad = nuevo;
      aplicados += 1;
      if (verjaDeExtraccion(resp, c.evidencia as UnidadDeEvidencia[], desempateDe(c), SIN_CIEGA).aceptada)
        escapes += 1;
    }
    expect(aplicados).toBeGreaterThan(20);
    // Con la búsqueda ciega encendida y sin declarar, este mismo mutante escapaba
    // 1 de 28. Un modelo que lee mal un número no rehace su justificación, así
    // que su propia cuenta lo delata.
    expect(escapes).toBe(0);
  });

  it("ADVERSARIO MÁXIMO: rebusca una cuenta para el número falso → como mucho 1 de 28", () => {
    let escapes = 0;
    let aplicados = 0;
    for (const c of TODOS) {
      const resp = clona(c.respuesta);
      if (resp.tipo !== "valor") continue;
      const campo = resp.campos.find((x) => x.valor.clase === "importe");
      if (!campo || campo.valor.clase !== "importe") continue;
      const nuevo = vecino(campo.valor.cantidad);
      if (nuevo === campo.valor.cantidad) continue;
      campo.valor.cantidad = nuevo;
      aplicados += 1;
      // Declarar DESPUÉS de ensuciar: el adversario justifica el valor falso.
      const conCuenta = declararLoQueHagaFalta(resp, c.evidencia);
      if (verjaDeExtraccion(conCuenta, c.evidencia as UnidadDeEvidencia[], desempateDe(c), SIN_CIEGA).aceptada)
        escapes += 1;
    }
    expect(aplicados).toBeGreaterThan(20);
    // Este es el precio de la palanca y no hay que maquillarlo: la declaración no
    // cierra la puerta al adversario que rebusca, se la estrecha. Un escape más
    // significa que la lista de operaciones se ha ensanchado.
    expect(escapes).toBeLessThanOrEqual(1);
  });
});
