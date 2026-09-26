import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  DIAS_DE_RETENCION,
  DIAS_DE_RETENCION_REFERENCIAS,
  DIAS_DE_RETENCION_VERIFICACION,
} from "@/lib/metering/retencion";
import { CAMPOS_DEL_REGISTRO_DE_USO } from "@/lib/metering/usage";
import { CAMPOS_DEL_CABLE_DE_VERIFICACION } from "@/lib/verificacion/wire";

import {
  camposDe,
  GRUPOS_DE_LA_VERIFICACION,
  GRUPOS_DEL_REGISTRO_DE_USO,
  PLAZOS_DE_RETENCION,
  SIN_BORRADO_AUTOMATICO,
} from "./lo-que-sale";

/**
 * LA PÁGINA DE PRIVACIDAD ENUMERA EXACTAMENTE LO QUE VIAJA — ni un campo más,
 * ni uno menos.
 *
 * La LICENSE §5 remite a /privacy para el detalle de cada campo y de su
 * retención. Si el cable gana un campo y la página no, la página promete de
 * menos lo que llega a BiVelio: justo lo que un cliente saca en una auditoría.
 * Si la página nombra un campo que ya no viaja, promete de más. Las dos cosas
 * rompen aquí, en CI, antes de desplegar:
 *   · un campo nuevo en la lista blanca del ingest de uso o del canal de
 *     verificación, o en lo que emiten el SDK y el gateway, sin su línea en
 *     `lo-que-sale.ts`;
 *   · una tabla nueva en las funciones de ingesta sin su plazo (o su «sin
 *     borrado automático») en la página;
 *   · un plazo de retención que el cron no aplica.
 */

// apps/web/lib/legal → raíz del repo.
const leer = (ruta: string) => readFileSync(fileURLToPath(new URL(`../../../../${ruta}`, import.meta.url)), "utf8");
const ordenado = (xs: readonly string[]) => [...xs].sort();

/** Los campos de una `interface X { … }` de un fuente TS, leídos como texto. */
function camposDeInterfaz(fuente: string, nombre: string): string[] {
  const inicio = fuente.indexOf(`interface ${nombre} {`);
  if (inicio < 0) throw new Error(`no se encontró \`interface ${nombre}\``);
  const cuerpo = fuente.slice(inicio, fuente.indexOf("\n}\n", inicio));
  return [...cuerpo.matchAll(/^ {2}(\w+)\??:/gm)].map((m) => m[1]!);
}

describe("registro de uso: la página enumera la lista blanca del ingest, campo a campo", () => {
  const enLaPagina = camposDe(GRUPOS_DEL_REGISTRO_DE_USO);

  it("sin repetidos (cada campo vive en un solo grupo)", () => {
    expect(enLaPagina.length).toBe(new Set(enLaPagina).size);
  });

  it("⛔ los campos de la página son EXACTAMENTE los que admite el ingest (lib/metering/usage.ts)", () => {
    expect(CAMPOS_DEL_REGISTRO_DE_USO.length).toBeGreaterThan(20);
    expect(
      ordenado(enLaPagina),
      "campo nuevo en la lista blanca: añádelo a lib/legal/lo-que-sale.ts, a su frase en privacyPage (12 idiomas) y a la LICENSE §5",
    ).toEqual(ordenado(CAMPOS_DEL_REGISTRO_DE_USO));
  });

  it("⛔ todo lo que el SDK y el gateway ponen en el cable (UsageWire) está en la página", () => {
    // El gateway emite por el mismo UsageEmitter.toWire (gateway/medidor.ts →
    // informeMedido): con UsageWire se cubren las dos superficies.
    const cable = camposDeInterfaz(leer("src/metering/emitter.ts"), "UsageWire");
    expect(cable.length).toBeGreaterThan(20);
    expect(cable.filter((c) => !enLaPagina.includes(c))).toEqual([]);
  });
});

describe("verificación opcional (#324): la página enumera la lista blanca de su canal", () => {
  const enLaPagina = camposDe(GRUPOS_DE_LA_VERIFICACION);
  const listaBlanca = [
    ...CAMPOS_DEL_CABLE_DE_VERIFICACION.sobre,
    ...CAMPOS_DEL_CABLE_DE_VERIFICACION.conteo,
    ...CAMPOS_DEL_CABLE_DE_VERIFICACION.muestra,
  ];

  it("sin repetidos", () => {
    expect(enLaPagina.length).toBe(new Set(enLaPagina).size);
  });

  it("⛔ los campos de la página son EXACTAMENTE los que admite el canal (lib/verificacion/wire.ts)", () => {
    expect(CAMPOS_DEL_CABLE_DE_VERIFICACION.muestra.length).toBeGreaterThan(15);
    expect(
      ordenado(enLaPagina),
      "campo nuevo en el cable de verificación: añádelo a lib/legal/lo-que-sale.ts, a privacyPage y a la LICENSE §5",
    ).toEqual(ordenado(listaBlanca));
  });

  it("⛔ todo lo que el emisor del SDK pone en ese cable está en la página", () => {
    const emisor = leer("src/verification/emisor.ts");
    const cable = [
      ...camposDeInterfaz(emisor, "MuestraEnElCable"),
      ...camposDeInterfaz(emisor, "ConteoEnElCable"),
      ...camposDeInterfaz(emisor, "SobreDeVerificacion"),
    ];
    expect(cable.length).toBeGreaterThan(20);
    expect(cable.filter((c) => !enLaPagina.includes(c))).toEqual([]);
  });
});

describe("la página pinta ESTAS listas, y cada grupo tiene su texto", () => {
  const pagina = readFileSync(fileURLToPath(new URL("../../app/[locale]/privacy/page.tsx", import.meta.url)), "utf8");
  const en = JSON.parse(readFileSync(fileURLToPath(new URL("../../messages/en.json", import.meta.url)), "utf8")) as {
    privacyPage: {
      usage: { groups: Record<string, { title?: string; body?: string }> };
      verification: { groups: Record<string, { title?: string; body?: string }> };
      retention: { items: Record<string, string> };
    };
  };

  it("la página renderiza los grupos y los plazos desde lib/legal/lo-que-sale.ts (no una copia)", () => {
    for (const simbolo of ["GRUPOS_DEL_REGISTRO_DE_USO", "GRUPOS_DE_LA_VERIFICACION", "PLAZOS_DE_RETENCION"]) {
      expect(pagina).toContain(simbolo);
    }
    expect(pagina).toMatch(/g\.campos\.map/);
  });

  it("cada grupo y cada plazo tiene título y cuerpo en los mensajes (la paridad cubre los otros 11 idiomas)", () => {
    expect(Object.keys(en.privacyPage.usage.groups).sort()).toEqual(GRUPOS_DEL_REGISTRO_DE_USO.map((g) => g.clave).sort());
    expect(Object.keys(en.privacyPage.verification.groups).sort()).toEqual(
      GRUPOS_DE_LA_VERIFICACION.map((g) => g.clave).sort(),
    );
    for (const g of [...Object.values(en.privacyPage.usage.groups), ...Object.values(en.privacyPage.verification.groups)]) {
      expect(g.title).toBeTruthy();
      expect(g.body).toBeTruthy();
    }
    expect(Object.keys(en.privacyPage.retention.items).sort()).toEqual(PLAZOS_DE_RETENCION.map((p) => p.clave).sort());
  });

  it("⛔ lo que «nunca sale» dice lo mismo que la LICENSE §5(a)", () => {
    const licencia = leer("LICENSE").replace(/\s+/g, " ");
    const nunca = JSON.parse(readFileSync(fileURLToPath(new URL("../../messages/en.json", import.meta.url)), "utf8"))
      .privacyPage.never as { content: string; credentials: string };
    // La lista tras los dos puntos, sin etiquetas ni punto final.
    const lista = (s: string) => s.replace(/<\/?\w+>/g, "").split(": ")[1]!.replace(/\.$/, "");
    expect(licencia).toContain(lista(nunca.content));
    expect(licencia).toContain(lista(nunca.credentials));
  });
});

/** El cuerpo de la última definición de una función SQL en las migraciones. */
function cuerpoDeLaFuncion(nombre: string): string {
  const dir = fileURLToPath(new URL("../../../../db/migrations/", import.meta.url));
  const cabecera = `create or replace function bvsala.${nombre}(`;
  const ficheros = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .filter((f) => readFileSync(`${dir}${f}`, "utf8").includes(cabecera));
  const ultimo = ficheros[ficheros.length - 1];
  if (!ultimo) throw new Error(`ninguna migración define bvsala.${nombre}`);
  const sql = readFileSync(`${dir}${ultimo}`, "utf8");
  const inicio = sql.indexOf(cabecera);
  const abre = sql.indexOf("as $$", inicio);
  const cierra = sql.indexOf("$$;", abre + "as $$".length);
  return sql.slice(inicio, cierra);
}

describe("retención: los plazos de la página son los que aplica el cron", () => {
  const tablasConPlazo = PLAZOS_DE_RETENCION.flatMap((p) => [...p.tablas]);

  it("los días salen de lib/metering/retencion.ts, los mismos que usa el cron", () => {
    const dias = Object.fromEntries(PLAZOS_DE_RETENCION.map((p) => [p.clave, p.dias]));
    expect(dias).toEqual({
      seen: DIAS_DE_RETENCION,
      reference: DIAS_DE_RETENCION_REFERENCIAS,
      verificationSamples: DIAS_DE_RETENCION_VERIFICACION,
      verificationBatches: DIAS_DE_RETENCION,
    });
  });

  it("⛔ las tablas con plazo son EXACTAMENTE las que el cron /api/cron/retencion borra", () => {
    const cron = readFileSync(
      fileURLToPath(new URL("../../app/api/cron/retencion/route.ts", import.meta.url)),
      "utf8",
    );
    const borradas = [...cron.matchAll(/\.from\("(\w+)"\)\s*\.delete\(/g)].map((m) => m[1]!);
    expect(borradas.length).toBeGreaterThan(3);
    expect(ordenado([...new Set(borradas)])).toEqual(ordenado(tablasConPlazo));
    // Los ids de lote de la verificación se purgan con el corte de 30 días
    // (`corte`), no con el de las muestras: la página lo dice así.
    expect(cron).toContain("purgarVerificacion(supabase, corteVerificacion, corte)");
  });

  it("⛔ toda tabla que escriben las funciones de ingesta está en la página (con plazo o «sin borrado automático»)", () => {
    const declaradas = new Set([...tablasConPlazo, ...SIN_BORRADO_AUTOMATICO]);
    const escritas = new Set<string>();
    for (const f of ["ingest_usage_batch", "ingest_verification_batch"]) {
      for (const m of cuerpoDeLaFuncion(f).matchAll(/insert into bvsala\.(\w+)/g)) escritas.add(m[1]!);
    }
    expect(escritas.size).toBeGreaterThan(5);
    expect(
      [...escritas].filter((t) => !declaradas.has(t)),
      "tabla nueva en la ingesta: di en la página cuánto se guarda (PLAZOS_DE_RETENCION o SIN_BORRADO_AUTOMATICO)",
    ).toEqual([]);
  });
});
