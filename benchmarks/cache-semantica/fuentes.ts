/**
 * Las fuentes FIJADAS del banco de precisión de la caché semántica.
 *
 * Cada una con su URL a una revisión inmutable, su huella (sha256 u oid LFS),
 * su tamaño, su licencia y la fecha en que se consultó. El harness aborta si lo
 * que baja no casa con lo fijado, y el publicador se niega a publicar un
 * artefacto al que le falte cualquiera de estas piezas: una cifra sin
 * procedencia verificable no se publica.
 *
 * LICENCIAS (consultadas el 2026-09-27; decisión del dueño pendiente, ver
 * docs/SEMANTIC-CACHE-PRECISION.md § Data & licenses):
 *
 *  · GPTCache (repositorio MIT en el commit fijado: su LICENSE es «The MIT License (MIT)»).
 *    Sus 1.536 tripletas `reuse_compatibility` se reparten en tres brazos de 512:
 *    `arena` (prompts de SemBenchmarkLmArena) y `search_llama` / `search_gpt`
 *    (prompts de SemBenchmarkSearchQueries, DERIVADO DE ORCAS). Las etiquetas
 *    están asistidas por modelo (1.298 `first_model_review`, 232
 *    `second_model_adjudication`, 6 `manual_scope_override`).
 *  · SemBenchmarkLmArena: tarjeta de HF apache-2.0; los prompts vienen de
 *    LM-Arena arena-human-preference-100k, cuya tarjeta dice «User prompts are
 *    licensed under CC-BY-4.0, and model outputs are governed by the terms of
 *    use set by the respective model providers.» Aquí solo se leen `id`,
 *    `prompt` e `ID_Set`: ninguna respuesta de modelo. Según la misma tarjeta,
 *    cada clase es un prompt real de LM-Arena más de 1 a 23 variantes escritas
 *    por un modelo, y «a cache hit is considered correct if the retrieved
 *    response belongs to the same class as the query».
 *  · ORCAS / MS MARCO: «The MS MARCO and ORCAS datasets are intended for
 *    non-commercial research purposes only» (https://microsoft.github.io/msmarco/ORCAS.html).
 *    Por eso todo lo derivado de ORCAS queda FUERA por defecto
 *    (`--incluir-orcas` para uso interno) y el publicador se niega a publicarlo.
 *  · La «NC-ND» que se atribuye a vCache es la licencia del PAPER en arXiv
 *    (2502.03771), no la de los datasets.
 */

export const CONSULTADO = "2026-09-27";

export interface Fuente {
  /** Identificador estable, el que viaja en el artefacto. */
  id: string;
  /** Nombre legible (sale en el documento publicado, en inglés). */
  nombre: string;
  url: string;
  /** Commit o revisión inmutable. */
  revision: string;
  /** sha256 del fichero tal cual se descarga. */
  sha256?: string;
  /** Oid LFS (sha256 del objeto) cuando el fichero no se baja entero. */
  lfsOid?: string;
  bytes: number;
  filas: number;
  licencia: string;
  urlLicencia: string;
  consultado: string;
  /** Todo el fichero deriva de datos solo para investigación no comercial. */
  origenNoComercial: boolean;
  /** Brazos (columna `arm`) derivados de datos no comerciales, si el fichero los mezcla. */
  brazosNoComerciales?: string[];
}

const GPTCACHE_COMMIT = "4838dc38dd4bf15c71a0f54624fe550f38925abc";
const GPTCACHE_RAW = `https://raw.githubusercontent.com/zilliztech/GPTCache/${GPTCACHE_COMMIT}/examples/benchmark/reuse_compatibility`;
const LICENCIA_GPTCACHE = "MIT (repository); arms search_llama and search_gpt derive from ORCAS (non-commercial research only)";
const URL_LICENCIA_GPTCACHE = `https://github.com/zilliztech/GPTCache/blob/${GPTCACHE_COMMIT}/LICENSE`;
const BRAZOS_ORCAS = ["search_llama", "search_gpt"];

export const FUENTE_CASOS: Fuente = {
  id: "gptcache-reuse-compatibility-cases",
  nombre: "GPTCache reuse_compatibility · cases.jsonl",
  url: `${GPTCACHE_RAW}/cases.jsonl`,
  revision: GPTCACHE_COMMIT,
  sha256: "97eedb5978f4f9a5558eee29a26a26ca269a839c2e3d9654cf31422525993627",
  bytes: 2_099_239,
  filas: 1_536,
  licencia: LICENCIA_GPTCACHE,
  urlLicencia: URL_LICENCIA_GPTCACHE,
  consultado: CONSULTADO,
  origenNoComercial: false,
  brazosNoComerciales: BRAZOS_ORCAS,
};

export const FUENTE_ETIQUETAS: Fuente = {
  id: "gptcache-reuse-compatibility-labels",
  nombre: "GPTCache reuse_compatibility · labels.jsonl (model-assisted labels)",
  url: `${GPTCACHE_RAW}/labels.jsonl`,
  revision: GPTCACHE_COMMIT,
  sha256: "797c0c8a69946f195c04629caa31a16aad1d1d23328cbb5ce823b726ff669e22",
  bytes: 1_376_532,
  filas: 1_536,
  licencia: LICENCIA_GPTCACHE,
  urlLicencia: URL_LICENCIA_GPTCACHE,
  consultado: CONSULTADO,
  origenNoComercial: false,
  brazosNoComerciales: BRAZOS_ORCAS,
};

export const FUENTE_BASELINE_JEV: Fuente = {
  id: "gptcache-reuse-compatibility-baseline-jev-070",
  nombre: "GPTCache reuse_compatibility · baseline_jev_070.jsonl (the project's LLM evaluator)",
  url: `${GPTCACHE_RAW}/baseline_jev_070.jsonl`,
  revision: GPTCACHE_COMMIT,
  sha256: "fd9c1e838d5468bfde986752ea1d40af3e01ec79a9599aa2fd9f4bd0ee5cb8bd",
  bytes: 415_915,
  filas: 1_536,
  licencia: LICENCIA_GPTCACHE,
  urlLicencia: URL_LICENCIA_GPTCACHE,
  consultado: CONSULTADO,
  origenNoComercial: false,
  brazosNoComerciales: BRAZOS_ORCAS,
};

const LMARENA_REV = "c6f36229bef6a5f7936e5b9d982bd5766ef2f862";

export const FUENTE_LMARENA: Fuente = {
  id: "vcache-sembenchmark-lmarena",
  nombre: "vCache SemBenchmarkLmArena · train.parquet (columns id, prompt, ID_Set)",
  url: `https://huggingface.co/datasets/vCache/SemBenchmarkLmArena/resolve/${LMARENA_REV}/train.parquet`,
  revision: LMARENA_REV,
  lfsOid: "ee562ac2d9395cedad16bfdcdd3caa6b17d04368646daa7c3253deac92746c1b",
  bytes: 6_595_558_805,
  filas: 63_796,
  licencia: "Apache-2.0 (dataset card); prompts from LM-Arena arena-human-preference-100k, CC-BY-4.0",
  urlLicencia: "https://huggingface.co/datasets/lmarena-ai/arena-human-preference-100k",
  consultado: CONSULTADO,
  origenNoComercial: false,
};

/** Documentada, NUNCA descargada por el harness: deriva de ORCAS. */
export const FUENTE_SEARCHQUERIES: Fuente = {
  id: "vcache-sembenchmark-searchqueries",
  nombre: "vCache SemBenchmarkSearchQueries (derived from ORCAS; not used)",
  url: "https://huggingface.co/datasets/vCache/SemBenchmarkSearchQueries",
  revision: "5159bff8ccf5d7c57dd82cbb24a76e2e5d24f1c0",
  bytes: 0,
  filas: 150_000,
  licencia: "Apache-2.0 (dataset card); derived from ORCAS, non-commercial research only",
  urlLicencia: "https://microsoft.github.io/msmarco/ORCAS.html",
  consultado: CONSULTADO,
  origenNoComercial: true,
};

export const FUENTES_TRIPLETAS = [FUENTE_CASOS, FUENTE_ETIQUETAS] as const;

/** ¿Este brazo de las tripletas deriva de ORCAS? */
export function esBrazoNoComercial(brazo: string): boolean {
  return BRAZOS_ORCAS.includes(brazo) || brazo.startsWith("search_");
}
