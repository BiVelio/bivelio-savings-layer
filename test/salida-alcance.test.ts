import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  alcanceDeEstilo,
  descomponerAhorro,
  mereceProducto,
  seDistinguen,
  superficie,
  ultimoArtefacto,
  RESULTADOS,
  type Alcance,
} from "../benchmarks/salida/alcance.js";
import { NOMBRE_SKILL } from "../gateway/skill.js";

/**
 * NINGÚN ESTILO SE CONVIERTE EN PRODUCTO POR ENCIMA DE LO QUE ALCANZA.
 *
 * El precedente es `apps/web/messages/cifra-del-heroe.test.ts`: lo prometido
 * nunca puede pasarse de lo medido. Aquí la promesa no es un porcentaje en una
 * landing sino algo más caro de deshacer — EMPAQUETAR un estilo como skill
 * instalable. Un skill instalado se inyecta en cada petición y cobra su peso en
 * entrada tanto si el cliente lo nota como si no.
 *
 * La verja tiene dos mitades:
 *   · la ARITMÉTICA, sobre datos sintéticos, para que las trampas conocidas no
 *     puedan colarse (contar el thinking como alcanzable, publicar la media en
 *     vez del suelo, elegir el modelo que mejor viene, olvidar el peso propio);
 *   · el ARTEFACTO vivo, que decide qué se puede empaquetar: si la medición
 *     dice que un estilo no merece producto, el repo no puede llevar ese estilo
 *     como skill instalable. El build se pone rojo el día que alguien lo añada
 *     sin volver a medir.
 */

const RAIZ = join(new URL(".", import.meta.url).pathname, "..");

const ic = (media: number, inferior: number, superior: number) => ({ media, inferior, superior });

describe("la superficie de un estilo de salida", () => {
  const masa = { thinking: 172.19, prosa: 53.24, toolUse: 231.47 };
  const factura = 3756.64;

  it("solo cuenta la PROSA: el thinking es interno del modelo y el JSON de tool_use es el fichero", () => {
    const s = superficie(masa, factura);
    expect(s.alcanzable).toBe(53.24);
    // Las dos masas grandes quedan FUERA, visibles pero no sumadas.
    expect(s.fueraDeAlcance).toBe(172.19);
    expect(s.toolUse).toBe(231.47);
    expect(s.alcanzable).toBeLessThan(s.fueraDeAlcance + s.toolUse);
  });

  it("el share alcanzable es una fracción de la factura ENTERA, no de la salida", () => {
    const s = superficie(masa, factura);
    expect(s.shareAlcanzableDeFactura).toBeCloseTo(53.24 / 3756.64, 6);
    // La trampa que se quiere impedir: dividir por la salida infla x8.
    expect(s.shareAlcanzableDeFactura).toBeLessThan(53.24 / (masa.thinking + masa.prosa + masa.toolUse));
  });
});

describe("la descomposición del ahorro medido", () => {
  it("cuando el rango de calibraciones cruza el 100 %, la prosa explica el ahorro entero", () => {
    // 20.708 chars de prosa ahorrados frente a 7.878 tokens de salida ahorrados:
    // con calibración baja la prosa sola YA se pasa del ahorro total.
    const d = descomponerAhorro(20708, 7878, [2.29, 2.38, 3.05]);
    expect(d.shareProsa.inferior).toBeLessThan(1);
    expect(d.shareProsa.superior).toBeGreaterThan(1);
    // Y entonces el tool_use no aporta nada demostrable: el rango cruza el cero.
    expect(d.toolUseAhorrado.inferior).toBeLessThan(0);
    expect(d.toolUseAhorrado.superior).toBeGreaterThan(0);
  });

  it("evalúa TODAS las calibraciones, no la que más conviene", () => {
    const d = descomponerAhorro(10000, 5000, [2, 4]);
    expect(d.calibraciones).toEqual([2, 4]);
    expect(d.shareProsa.inferior).toBeCloseTo(0.5, 4); // 10000/4/5000
    expect(d.shareProsa.superior).toBeCloseTo(1.0, 4); // 10000/2/5000
  });

  it("sin calibraciones o sin ahorro no inventa un reparto: falla", () => {
    expect(() => descomponerAhorro(100, 10, [])).toThrow();
    expect(() => descomponerAhorro(100, 0, [2.4])).toThrow();
  });
});

describe("el neto de un estilo descuenta SIEMPRE su propio peso", () => {
  const comun = {
    reduccionProsaPct: ic(90, 80, 96),
    prosaUsd: 100,
    facturaUsd: 10_000,
    peticiones: 10_000,
    calibraciones: [2.5, 3],
    precios: { barato: 0.00025, caro: 0.001 },
  };

  it("el bruto que se juzga es el SUELO del IC, nunca la media", () => {
    const a = alcanceDeEstilo({ estilo: "x", pesoChars: 1000, ...comun });
    expect(a.brutoUsd.media).toBeCloseTo(90, 4);
    expect(a.brutoUsd.suelo).toBeCloseTo(80, 4);
    // El neto sale del suelo: 80 − coste, no 90 − coste.
    expect(a.netoUsd.barato).toBeCloseTo(80 - a.costePropioUsd.barato!, 4);
  });

  it("usa la calibración MÁS BAJA: el peso propio se cuenta en su peor caso", () => {
    const a = alcanceDeEstilo({ estilo: "x", pesoChars: 1000, ...comun });
    expect(a.tokensPorPeticion).toBe(400); // 1000 / 2,5 (no / 3)
  });

  it("dos estilos con el MISMO efecto: gana el más magro", () => {
    const magro = alcanceDeEstilo({ estilo: "magro", pesoChars: 1000, ...comun });
    const gordo = alcanceDeEstilo({ estilo: "gordo", pesoChars: 4000, ...comun });
    expect(magro.brutoUsd.suelo).toBe(gordo.brutoUsd.suelo);
    for (const m of ["barato", "caro"]) {
      expect(gordo.costePropioUsd[m]!).toBeCloseTo(4 * magro.costePropioUsd[m]!, 4);
      expect(gordo.netoUsd[m]!).toBeLessThan(magro.netoUsd[m]!);
    }
  });

  it("un estilo que pesa más de lo que ahorra da neto NEGATIVO, no cero", () => {
    const a = alcanceDeEstilo({ estilo: "obeso", pesoChars: 100_000, ...comun });
    expect(a.netoUsd.caro).toBeLessThan(0);
  });
});

describe("la puerta de producto", () => {
  const alcance = (netos: Record<string, number>, factura = 10_000): Alcance => ({
    estilo: "x",
    pesoChars: 1,
    tokensPorPeticion: 1,
    reduccionProsaPct: ic(0, 0, 0),
    brutoUsd: { media: 0, suelo: 0 },
    costePropioUsd: {},
    netoUsd: netos,
    netoShareDeFactura: Object.fromEntries(Object.entries(netos).map(([k, v]) => [k, v / factura])),
  });

  it("juzga por el modelo PEOR, no por el mejor: un producto se vende a todos", () => {
    // Uno solo por debajo del umbral tumba el veredicto aunque el otro luzca.
    const v = mereceProducto(alcance({ bueno: 500, malo: 50 }));
    expect(v.merece).toBe(false);
    expect(v.peorShare).toBeCloseTo(0.005, 6);
  });

  it("aprueba solo si TODOS los modelos pasan el 1 % de la factura", () => {
    expect(mereceProducto(alcance({ a: 150, b: 200 })).merece).toBe(true);
    expect(mereceProducto(alcance({ a: 99, b: 200 })).merece).toBe(false);
  });
});

describe("dos estilos se distinguen solo si su IC no cruza el cero", () => {
  it("un IC que cruza el cero es RUIDO por muy grande que sea la media", () => {
    expect(seDistinguen(ic(-2.32, -5.87, 0.57))).toBe(false);
    expect(seDistinguen(ic(9, -1, 19))).toBe(false);
  });

  it("señal en los dos sentidos", () => {
    expect(seDistinguen(ic(4, 1.2, 7))).toBe(true);
    expect(seDistinguen(ic(-4, -7, -1.2))).toBe(true);
  });
});

describe("⛔ el artefacto medido manda sobre lo que el repo empaqueta", () => {
  const ruta = ultimoArtefacto(join(RAIZ, RESULTADOS), "salida-alcance-");
  const art = JSON.parse(readFileSync(ruta, "utf8")) as {
    superficie: { shareAlcanzableDeFactura: number };
    factura: { shareSalida: number };
    alcances: Alcance[];
    veredicto: Record<string, { merece: boolean; motivo: string }>;
    comparaciones: Record<string, { seDistinguen: boolean }>;
  };

  it("la superficie alcanzable nunca puede pasarse de la salida entera", () => {
    expect(art.superficie.shareAlcanzableDeFactura).toBeGreaterThan(0);
    expect(art.superficie.shareAlcanzableDeFactura).toBeLessThan(art.factura.shareSalida);
  });

  it("mide todos los estilos del banco, sin dejarse ninguno fuera del veredicto", () => {
    expect(art.alcances.length).toBeGreaterThanOrEqual(2);
    for (const a of art.alcances) expect(art.veredicto[a.estilo]).toBeDefined();
  });

  for (const estilo of ["caveman", "savings-mode"]) {
    it(`${estilo}: solo se empaqueta como skill si la medición dice que merece producto`, () => {
      const v = art.veredicto[estilo];
      expect(v, `el artefacto no trae veredicto de ${estilo}`).toBeDefined();
      if (v!.merece) return; // aprobado por medición: empaquetarlo es legítimo.
      // Rechazado: el repo NO puede llevarlo como skill instalable.
      expect(
        existsSync(join(RAIZ, "skills", estilo)),
        `${estilo} no merece producto (${v!.motivo}) y sin embargo skills/${estilo}/ existe`,
      ).toBe(estilo === NOMBRE_SKILL);
    });
  }

  it("el instalador solo conoce un skill, y es uno que el banco midió", () => {
    const nombres = readdirSync(join(RAIZ, "skills"));
    expect(nombres).toContain(NOMBRE_SKILL);
    expect(art.veredicto[NOMBRE_SKILL]).toBeDefined();
  });

  it("no se publica «un estilo es mejor que otro» mientras su diferencia sea RUIDO", () => {
    // Regla precisa, sin heurística de adjetivos: si el banco NO distingue dos
    // estilos, la superficie de producto no puede NOMBRARLOS A LOS DOS. Sin los
    // dos nombres delante no hay comparación que publicar, y con ellos la única
    // lectura posible es la que la medición no sostiene.
    const superficieDeProducto = ["skills", "apps/web/lib/skill"]
      .map((f) => join(RAIZ, f))
      .filter((d) => existsSync(d))
      .flatMap((d) =>
        readdirSync(d, { recursive: true, encoding: "utf8" })
          .filter((x) => /\.(md|ts)$/.test(x))
          .map((x) => join(d, x)),
      )
      .filter((p) => existsSync(p) && !p.endsWith(".test.ts"));

    for (const [par, c] of Object.entries(art.comparaciones)) {
      if (c.seDistinguen) continue;
      const [a, b] = par.split(" menos ") as [string, string];
      for (const p of superficieDeProducto) {
        const texto = readFileSync(p, "utf8");
        expect(
          texto.includes(a) && texto.includes(b),
          `${p} nombra a la vez «${a}» y «${b}», que el banco NO distingue (IC de la diferencia cruza el cero)`,
        ).toBe(false);
      }
    }
  });
});
