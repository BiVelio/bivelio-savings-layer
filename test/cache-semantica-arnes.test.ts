import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

import { InMemorySemanticCache } from "../src/cache/semantic.js";
import { ejecutarSeco, parsearArgumentos, RUTA_FIXTURE, serializarArtefacto } from "../benchmarks/cache-semantica/arnes.js";
import { descargarVerificado, sha256Hex, verificarHuellaLfs } from "../benchmarks/cache-semantica/datos.js";
import { renderizarDocumento, RUTA_DOCUMENTO } from "../benchmarks/cache-semantica/documento.js";
import { rutaEvidencia } from "../benchmarks/cache-semantica/publicar.js";
import { FUENTE_CASOS, FUENTE_ETIQUETAS, FUENTE_LMARENA, type Fuente } from "../benchmarks/cache-semantica/fuentes.js";
import {
  conducirStream,
  conducirTripletas,
  contar,
  filtrarBrazos,
  puntuarTripletas,
  sondearSuelos,
  verificarPuntuador,
  type CasoTripleta,
  type FilaEtiqueta,
} from "../benchmarks/cache-semantica/nucleo.js";
import { decidirPublicacion, type Artefacto } from "../benchmarks/cache-semantica/publicar-verja.js";

/**
 * EL BANCO DE PRECISIÓN DE LA CACHÉ SEMÁNTICA, EN SECO.
 *
 * La medición de verdad baja conjuntos públicos y no corre en CI. Lo que sí
 * corre aquí, sin red, es todo lo que decide qué cifra sale: el puntuador, los
 * conductores (por la capa real), el filtro de datos no comerciales, la
 * procedencia del artefacto, la verja del publicador y la plantilla.
 */

const fixture = readFileSync(RUTA_FIXTURE, "utf8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l) as CasoTripleta & { label: FilaEtiqueta["label"]; reason_categories: string[] });

/** Todo el texto del fixture: ningún artefacto, documento ni evidencia puede llevar una línea de él. */
const textos = fixture.flatMap((f) => [f.cached_request, f.current_request, f.cached_answer]);

const caso = (uid: string) => fixture.find((f) => f.uid === uid)!;

describe("puntuador", () => {
  it("cuenta TP/FP/FN/TN y deja `uncertain` fuera de los denominadores, contado aparte", () => {
    const c = contar([
      { acierto: true, label: "reuse" },
      { acierto: true, label: "reject" },
      { acierto: false, label: "reuse" },
      { acierto: false, label: "reject" },
      { acierto: true, label: "uncertain" },
      { acierto: false, label: "uncertain" },
    ]);
    expect(c).toEqual({ casos: 6, tp: 1, fp: 1, fn: 1, tn: 1, inciertos: 2, aciertosInciertos: 1, aciertos: 3 });
  });

  it("reproduce un mini-baseline sintético y falla si las cifras no casan", () => {
    const etiquetas: FilaEtiqueta[] = [
      { uid: "a", label: "reuse" },
      { uid: "b", label: "reuse" },
      { uid: "c", label: "reject" },
      { uid: "d", label: "uncertain" },
    ];
    const baseline = [
      { uid: "a", decision: "reuse" as const },
      { uid: "b", decision: "reject" as const },
      { uid: "c", decision: "reuse" as const },
      { uid: "d", decision: "reuse" as const },
    ];
    const bien = verificarPuntuador(etiquetas, baseline, { precision: { k: 1, n: 2 }, recall: { k: 1, n: 2 } });
    expect(bien.ok).toBe(true);
    const mal = verificarPuntuador(etiquetas, baseline, { precision: { k: 1, n: 1 }, recall: { k: 1, n: 2 } });
    expect(mal.ok).toBe(false);
    expect(() => verificarPuntuador([], baseline)).toThrow(/no label/);
  });

  it("puntuarTripletas: métricas por brazo y split, categorías de los falsos positivos y procedencia de las etiquetas", () => {
    const r = puntuarTripletas(
      [
        { uid: "x1", arm: "arena", split: "test", acierto: true, consultada: true, guardada: true },
        { uid: "x2", arm: "arena", split: "test", acierto: true, consultada: true, guardada: true },
        { uid: "x3", arm: "arena", split: "calibration", acierto: false, consultada: false, guardada: false },
        { uid: "x4", arm: "arena", split: "calibration", acierto: false, consultada: true, guardada: false },
      ],
      [
        { uid: "x1", label: "reuse", label_source: "first_model_review" },
        { uid: "x2", label: "reject", reason_categories: ["incomplete_format", "task_mismatch"], label_source: "second_model_adjudication" },
        { uid: "x3", label: "reuse", label_source: "first_model_review" },
        { uid: "x4", label: "reject", label_source: "manual_scope_override" },
      ],
    );
    expect(r.total.conteo).toMatchObject({ tp: 1, fp: 1, fn: 1, tn: 1 });
    expect(r.total.precision?.point).toBe(0.5);
    expect(Object.keys(r.porSplit)).toEqual(["calibration", "test"]);
    expect(r.categoriasFalsosPositivos).toEqual({ incomplete_format: 1, task_mismatch: 1 });
    // Disjuntos: x3 no se consultó; x4 se consultó pero su petición guardada nunca se escribió.
    expect(r.noConsultados).toBe(1);
    expect(r.sinGuardar).toBe(1);
    expect(r.fuentesDeEtiqueta).toEqual({ first_model_review: 2, second_model_adjudication: 1, manual_scope_override: 1 });
  });
});

describe("conductor de tripletas, por la capa real", () => {
  it("el par idéntico acierta y sirve la respuesta guardada; cambiar un número no acierta", async () => {
    const [identico, numero] = await conducirTripletas([caso("syn-cal-03"), caso("syn-test-04")]);
    expect(identico).toMatchObject({ uid: "syn-cal-03", acierto: true, consultada: true });
    expect(identico!.similarity).toBeCloseTo(1, 6);
    expect(numero).toMatchObject({ uid: "syn-test-04", acierto: false, consultada: true });
  });

  it("si la política veta la petición GUARDADA, no se escribe y el caso no puede acertar (lo que hace la capa)", async () => {
    // «my» marca personalización: la capa no guarda esa petición, aunque la
    // segunda (sin marca) sí se consulte. Los componentes sueltos no lo verían.
    const vetada = { ...caso("syn-cal-03"), uid: "p-1", cached_request: "explain how my binary search works" };
    const [r] = await conducirTripletas([vetada]);
    expect(r).toMatchObject({ acierto: false, consultada: true, guardada: false });
    const [ok] = await conducirTripletas([caso("syn-cal-03")]);
    expect(ok).toMatchObject({ guardada: true });
  });

  it("cada caso vive en su tenant: la respuesta de un caso no la recibe otro", async () => {
    // Mismo texto guardado en dos casos distintos: si compartieran tenant, el
    // segundo acertaría contra el primero y la independencia (Wilson) sería falsa.
    const a = { ...caso("syn-cal-03"), uid: "t-a", current_request: "unrelated text about volcano formation" };
    const b = { ...caso("syn-cal-03"), uid: "t-b", cached_request: "tell me about the history of jazz music" };
    const r = await conducirTripletas([a, b]);
    expect(r.map((x) => x.acierto)).toEqual([false, false]);
  });

  it("sin --incluir-orcas, fuera los brazos `search_*` (derivados de ORCAS)", () => {
    expect(filtrarBrazos(fixture, false).some((c) => c.arm.startsWith("search_"))).toBe(false);
    expect(filtrarBrazos(fixture, true).some((c) => c.arm.startsWith("search_"))).toBe(true);
  });
});

describe("sondas: los parámetros publicados se leen del código", () => {
  it("el suelo efectivo es el mayor de los dos, haya verificador o no", async () => {
    const sin = await sondearSuelos(() => new InMemorySemanticCache({ similarityThreshold: 0.6, acceptThreshold: 0.9 }));
    expect(sin).toEqual({ similarityFloor: 0.6, acceptFloor: 0.9, embedder: "built_in", effectiveFloor: 0.9 });
    // Con verificador, confidence = min(similitud, verificador): la similitud
    // sigue teniendo que pasar el suelo de aceptación.
    const con = await sondearSuelos(
      () => new InMemorySemanticCache({ similarityThreshold: 0.6, acceptThreshold: 0.9, verify: () => 1, embed: () => [1, 0] }),
    );
    expect(con).toEqual({ similarityFloor: 0.6, acceptFloor: 0.9, embedder: "custom", effectiveFloor: 0.9 });
  });
});

describe("stream: el espejo FIFO sabe qué clases eran alcanzables", () => {
  it("con un tope pequeño hay desalojos y ningún acierto correcto cae sobre una clase ausente", async () => {
    const filas = [
      { id: 1, prompt: "explain how a binary search works", idSet: 1 },
      { id: 2, prompt: "describe the water cycle in simple terms", idSet: 2 },
      { id: 3, prompt: "write a haiku about autumn leaves", idSet: 3 },
      // La clase 1 ya se desalojó (tope 2): su repetición no puede acertar.
      { id: 4, prompt: "explain how a binary search works", idSet: 1 },
      // La clase 3 sigue en la caché: su repetición acierta y es correcta.
      { id: 5, prompt: "write a haiku about autumn leaves", idSet: 3 },
    ];
    const r = await conducirStream(filas, { maxRegistros: 2 });
    expect(r.desalojos).toBeGreaterThan(0);
    expect(r.correctosNoAlcanzables).toBe(0);
    expect(r.aciertosDetalle.map((h) => [h.id, h.servedBy, h.correcto])).toEqual([[5, 3, true]]);
    expect(r.alcanzables).toBe(1);
  });
});

describe("artefacto en seco (lo que corre la CI)", () => {
  let artefacto: Artefacto;

  it("se genera por la capa real, con procedencia y en modo dry-run", async () => {
    artefacto = await ejecutarSeco(parsearArgumentos(["--seco"]));
    expect(artefacto.mode).toBe("dry-run");
    expect(artefacto.commit === null || /^[0-9a-f]{40}$/.test(artefacto.commit)).toBe(true);
    expect(typeof artefacto.dirty).toBe("boolean");
    expect(artefacto.sdkVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(artefacto.config).toMatchObject({ embedder: "built_in", maxRecordsIsDefault: true, policy: true, incluirOrcas: false });
    expect(artefacto.config.effectiveFloor).toBe(Math.max(artefacto.config.similarityFloor, artefacto.config.acceptFloor));
    expect(artefacto.tripletas?.brazos).toEqual(["synthetic"]);
    expect(artefacto.casos.some((c) => c.arm.startsWith("search_"))).toBe(false);
    expect(artefacto.lmarena?.correctosNoAlcanzables).toBe(0);
  });

  it("no lleva ni una línea de texto del fixture, y se serializa sin perder nada", () => {
    const json = serializarArtefacto(artefacto);
    for (const t of textos) expect(json).not.toContain(t);
    expect(JSON.parse(json)).toEqual(JSON.parse(JSON.stringify(artefacto)));
  });

  it("el publicador lo rechaza: en seco no se midió nada", () => {
    const d = decidirPublicacion(artefacto);
    expect(d.ok).toBe(false);
    expect(d.blockers.join("\n")).toMatch(/dry run/);
  });

  describe("verja del publicador (D21)", () => {
    const vivo = (): Artefacto => ({
      ...structuredClone(artefacto),
      mode: "live",
      commit: "0".repeat(40),
      dirty: false,
      fuentes: [
        { ...FUENTE_CASOS },
        { ...FUENTE_ETIQUETAS },
        { ...FUENTE_LMARENA, sha256Extraido: "a".repeat(64) },
      ],
      verificacionPuntuador: { ok: true, precision: { k: 364, n: 365 }, recall: { k: 364, n: 505 }, esperado: { precision: { k: 364, n: 365 }, recall: { k: 364, n: 505 } } },
    });

    it("acepta un artefacto en vivo completo", () => {
      const d = decidirPublicacion(vivo());
      expect(d.blockers).toEqual([]);
      expect(d.ok).toBe(true);
    });

    it("bloquea un árbol sucio y un artefacto sin commit", () => {
      expect(decidirPublicacion({ ...vivo(), dirty: true }).blockers.join()).toMatch(/dirty/);
      expect(decidirPublicacion({ ...vivo(), commit: null }).blockers.join()).toMatch(/no commit/);
    });

    it("bloquea una fuente sin revisión o sin huella, y una leída por rangos sin sha256 del extracto", () => {
      const sinRevision: Fuente = { ...FUENTE_CASOS, revision: "" };
      const sinHuella: Fuente = { ...FUENTE_ETIQUETAS, sha256: undefined };
      const b = decidirPublicacion({ ...vivo(), fuentes: [sinRevision, sinHuella, { ...FUENTE_LMARENA }] }).blockers.join("\n");
      expect(b).toMatch(/no pinned revision/);
      expect(b).toMatch(/no sha256/);
      expect(b).toMatch(/read by ranges/);
    });

    it("bloquea lo de origen no comercial (fuente, brazo o config) salvo autorización explícita del dueño", () => {
      const conOrcas: Artefacto = {
        ...vivo(),
        config: { ...vivo().config, incluirOrcas: true },
        casos: [...vivo().casos, { uid: "s1", arm: "search_llama", split: "test", decision: "miss" }],
        fuentes: [...vivo().fuentes, { ...FUENTE_CASOS, id: "nc", origenNoComercial: true }],
      };
      const d = decidirPublicacion(conOrcas);
      expect(d.ok).toBe(false);
      expect(d.blockers.join()).toMatch(/non-commercial.*source nc.*config\.incluirOrcas.*arm search_llama/);
      const autorizado = decidirPublicacion(conOrcas, { permitirOrigenNoComercial: true });
      expect(autorizado.ok).toBe(true);
      expect(autorizado.warnings.join()).toMatch(/owner allowed it/);
    });

    it("bloquea otro embebedor (es un diagnóstico) y un puntuador que no reproduce las cifras del proyecto", () => {
      expect(decidirPublicacion({ ...vivo(), config: { ...vivo().config, embedder: "dataset:emb_gte" } }).ok).toBe(false);
      const v = vivo();
      v.verificacionPuntuador = { ...v.verificacionPuntuador!, ok: false };
      expect(decidirPublicacion(v).blockers.join()).toMatch(/self-check failed/);
    });

    it("el documento sale del artefacto: titular = suelo de Wilson, sin texto de los datos, con la evidencia por sha256", () => {
      const a = vivo();
      const doc = renderizarDocumento(a, { rutaEvidencia: "benchmarks/evidencia/x.json", sha256Evidencia: "f".repeat(64) });
      const suelo = ((a.tripletas!.puntuacion.total.precision!.lower) * 100).toFixed(1);
      expect(doc).toContain(`**Precision floor: ${suelo} %.**`);
      expect(doc).toContain("f".repeat(64));
      expect(doc).toContain(`git checkout ${a.commit}`);
      for (const t of textos) expect(doc).not.toContain(t);
      for (const seccion of ["## What is measured", "## Headline", "## A. Triplets", "## B. Stream", "## Limitations", "## Data and licenses", "## Reproduce"]) {
        expect(doc).toContain(seccion);
      }
      expect(() => renderizarDocumento({ ...a, tripletas: undefined }, { rutaEvidencia: "", sha256Evidencia: "" })).toThrow();
    });
  });
});

/**
 * NINGUNA CIFRA SIN EL CÓDIGO QUE LA RESPALDA. El documento publicado dice «every
 * figure on this page is read from that file; do not edit it by hand», y hasta
 * aquí nada lo comprobaba: se podía retocar el titular a mano y la CI seguía en
 * verde. Ahora el documento versionado tiene que ser, byte a byte, lo que la
 * plantilla genera desde la evidencia que cita; la evidencia, la de esa huella;
 * y esa evidencia, una que la verja del publicador acepta (en vivo, árbol
 * limpio, fuentes fijadas, nada de origen no comercial).
 *
 * Si cambia la plantilla, se regenera desde la misma evidencia:
 *   cp <evidencia> benchmarks/out/cache-semantica/resultado.json && pnpm cache-semantica:publicar
 */
describe("el documento publicado es exactamente el que sale de su evidencia", () => {
  it(`${RUTA_DOCUMENTO} = la plantilla sobre la evidencia que cita, con su sha256 y aceptada por la verja`, () => {
    const doc = readFileSync(new URL(`../${RUTA_DOCUMENTO}`, import.meta.url), "utf8");
    const cita = /from the measurement artifact `([^`]+)` \(sha256 `([0-9a-f]{64})`\)/.exec(doc);
    expect(cita, "el documento tiene que citar su evidencia y su sha256").not.toBeNull();
    const [, ruta, sha] = cita!;
    const bytes = readFileSync(new URL(`../${ruta}`, import.meta.url));
    expect(sha256Hex(bytes), "la evidencia versionada no es la que el documento cita").toBe(sha);
    const a = JSON.parse(bytes.toString("utf8")) as Artefacto;
    expect(decidirPublicacion(a)).toMatchObject({ ok: true, blockers: [] });
    expect(ruta).toBe(rutaEvidencia(a));
    expect(doc, "documento retocado a mano o plantilla cambiada sin regenerar").toBe(
      renderizarDocumento(a, { rutaEvidencia: ruta!, sha256Evidencia: sha! }),
    );
  });
});

describe("datos: lo que no casa con lo fijado aborta", () => {
  const respuesta = (cuerpo: string, cabeceras: Record<string, string> = {}, status = 200) =>
    new Response(cuerpo, { status, headers: cabeceras });

  it("una descarga con otro sha256 aborta y no escribe", async () => {
    const f: Fuente = { ...FUENTE_CASOS, sha256: "0".repeat(64), bytes: 3 };
    await expect(descargarVerificado(f, "/nonexistent/never-written", async () => respuesta("abc"))).rejects.toThrow(/sha256 mismatch/);
  });

  it("el oid LFS, el tamaño y la revisión que declara el hub tienen que ser los fijados", async () => {
    const buenas = {
      "x-linked-etag": `"${FUENTE_LMARENA.lfsOid}"`,
      "x-linked-size": String(FUENTE_LMARENA.bytes),
      "x-repo-commit": FUENTE_LMARENA.revision,
    };
    await expect(verificarHuellaLfs(FUENTE_LMARENA, async () => respuesta("", buenas, 302))).resolves.toBeUndefined();
    await expect(
      verificarHuellaLfs(FUENTE_LMARENA, async () => respuesta("", { ...buenas, "x-linked-etag": '"deadbeef"' }, 302)),
    ).rejects.toThrow(/LFS oid/);
    await expect(
      verificarHuellaLfs(FUENTE_LMARENA, async () => respuesta("", { ...buenas, "x-linked-size": "1" }, 302)),
    ).rejects.toThrow(/bytes/);
    await expect(
      verificarHuellaLfs(FUENTE_LMARENA, async () => respuesta("", { ...buenas, "x-repo-commit": "main" }, 302)),
    ).rejects.toThrow(/revision/);
  });
});

describe("argumentos", () => {
  it("rechaza flags desconocidos y el embebedor del dataset fuera del stream", () => {
    expect(() => parsearArgumentos(["--nope"])).toThrow(/unknown flag/);
    expect(() => parsearArgumentos(["--embebedor", "dataset:emb"])).toThrow(/only applies/);
    expect(parsearArgumentos(["--conjunto", "lmarena", "--embebedor", "dataset:emb"]).embebedor).toBe("dataset:emb");
    expect(() => parsearArgumentos(["--n", "-1"])).toThrow();
  });
});
