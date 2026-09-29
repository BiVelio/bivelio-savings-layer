// LA 0.4.34 AVISA DE TODO LO QUE LA 0.5 QUITA (criterio 6 de docs/CAMINO-A-0.5.md).
//
// Los 63 nombres que la 0.5 saca de la raíz del paquete (veredicto «quitar» en
// docs/INVENTARIO-API-0.5.json) llegaban por los `export *` de los barriles sin
// marca ninguna: quien los usara se enteraba al actualizar, con el build roto.
// Aquí se reexportan CON NOMBRE y con `@deprecated`, y src/index.ts los exporta
// explícitamente: un export con nombre tapa al del `export *`, así que el
// `.d.ts` publicado ve esta declaración y el IDE tacha el uso.
//
// Por qué aquí y no en su origen: el `@deprecated` es del EXPORT, no de la
// función. `sha256` o `randomId` siguen siendo piezas internas legítimas, y
// marcarlas en su fichero tacharía cada uso interno del código. En la 0.5 basta
// con borrar este fichero y cerrar los `export *` (test/api-publica-congelada).
//
// Las clases se reexportan como `const` + `type` del mismo nombre para que
// sigan valiendo como valor (`new X()`) y como tipo (`x: X`), y los interfaces
// como alias de tipo. Ninguna de estas líneas cambia qué se ejecuta.

import {
  type CanonicalRequest as CanonicalRequestInterno,
  canonicalize as canonicalizeInterno,
  modelFamilyOf as modelFamilyOfInterno,
  normalizeText as normalizeTextInterno,
  sha256 as sha256Interno,
  stableStringify as stableStringifyInterno,
  buildExactKey as buildExactKeyInterno,
  buildInflightKey as buildInflightKeyInterno,
} from "./canonicalization/index.js";
import {
  type CompactVerification as CompactVerificationInterno,
  EMBEDDED_PUBLIC_KEY as EMBEDDED_PUBLIC_KEYInterno,
  type LicenseKeyShape as LicenseKeyShapeInterno,
  type LicenseStatus as LicenseStatusInterno,
  type LicenseTokenPayload as LicenseTokenPayloadInterno,
  type ResolvedGate as ResolvedGateInterno,
  type ResolvedLicense as ResolvedLicenseInterno,
  type RevocationListBody as RevocationListBodyInterno,
  type RevocationListVerification as RevocationListVerificationInterno,
  type RevocationPollEvent as RevocationPollEventInterno,
  RevocationPoller as RevocationPollerInterno,
  type RevocationPollerOptions as RevocationPollerOptionsInterno,
  RevocationSnapshot as RevocationSnapshotInterno,
  computeNextDelay as computeNextDelayInterno,
  deriveStatus as deriveStatusInterno,
  gateFromKey as gateFromKeyInterno,
  isKeyset as isKeysetInterno,
  licenseKeyShape as licenseKeyShapeInterno,
  liveGateFromKey as liveGateFromKeyInterno,
  normalizeLicenseKey as normalizeLicenseKeyInterno,
  resolveLicense as resolveLicenseInterno,
  verifyCompactSignature as verifyCompactSignatureInterno,
  verifyLicenseToken as verifyLicenseTokenInterno,
  verifyRevocationList as verifyRevocationListInterno,
} from "./license/index.js";
import {
  UsageEmitter as UsageEmitterInterno,
  type UsageEmitterOptions as UsageEmitterOptionsInterno,
  deriveSeatId as deriveSeatIdInterno,
  detectCi as detectCiInterno,
} from "./metering/index.js";
import {
  DEFAULT_MAX_STALENESS_SECONDS as DEFAULT_MAX_STALENESS_SECONDSInterno,
  type ResolvedDeps as ResolvedDepsInterno,
  resolveDependencies as resolveDependenciesInterno,
} from "./pipeline/index.js";
import {
  REFERENCE_MAX_AGE_MS as REFERENCE_MAX_AGE_MSInterno,
  REFERENCE_MESSAGE_ALLOWANCE as REFERENCE_MESSAGE_ALLOWANCEInterno,
  REFERENCE_OUTPUT_SHARE as REFERENCE_OUTPUT_SHAREInterno,
  SavingsLedger as SavingsLedgerInterno,
} from "./tokenizer/index.js";
import {
  TraceCollector as TraceCollectorInterno,
} from "./telemetry/index.js";
import {
  adaptiveK as adaptiveKInterno,
  dedupe as dedupeInterno,
  executeRetrievalPlan as executeRetrievalPlanInterno,
} from "./retrieval/index.js";
import {
  cosine as cosineInterno,
  keyTokensMatch as keyTokensMatchInterno,
  multisetEqual as multisetEqualInterno,
  negationCount as negationCountInterno,
  numericTokens as numericTokensInterno,
  words as wordsInterno,
  sameAnswer as sameAnswerInterno,
} from "./cache/index.js";
import {
  evalArithmetic as evalArithmeticInterno,
} from "./resolvers/index.js";
import {
  evaluatePolicy as evaluatePolicyInterno,
} from "./policy/index.js";
import {
  isStrictCompatible as isStrictCompatibleInterno,
} from "./providers/index.js";
import {
  projectContext as projectContextInterno,
} from "./memory/index.js";
import {
  resolveConstraintBackend as resolveConstraintBackendInterno,
} from "./constraints/index.js";
import {
  shouldCompress as shouldCompressInterno,
  withProtectedSpans as withProtectedSpansInterno,
} from "./compression/index.js";
import {
  uniformColumns as uniformColumnsInterno,
} from "./serialization/index.js";
import {
  randomId as randomIdInterno,
} from "./util/index.js";

/** @deprecated Internal pipeline helper, removed from the public API in 0.5: no replacement. */
export type CanonicalRequest = CanonicalRequestInterno;
/** @deprecated Internal pipeline helper, removed from the public API in 0.5: no replacement. */
export const canonicalize: typeof canonicalizeInterno = canonicalizeInterno;
/** @deprecated Internal pipeline helper, removed from the public API in 0.5: no replacement. */
export const modelFamilyOf: typeof modelFamilyOfInterno = modelFamilyOfInterno;
/** @deprecated Internal pipeline helper, removed from the public API in 0.5: no replacement. */
export const normalizeText: typeof normalizeTextInterno = normalizeTextInterno;
/** @deprecated Internal helper, removed from the public API in 0.5. Use `createHash("sha256").update(text).digest("hex")` from `node:crypto`. */
export const sha256: typeof sha256Interno = sha256Interno;
/** @deprecated Internal pipeline helper, removed from the public API in 0.5: no replacement. */
export const stableStringify: typeof stableStringifyInterno = stableStringifyInterno;
/** @deprecated Internal pipeline helper, removed from the public API in 0.5: no replacement. */
export const buildExactKey: typeof buildExactKeyInterno = buildExactKeyInterno;
/** @deprecated Internal pipeline helper, removed from the public API in 0.5: no replacement. */
export const buildInflightKey: typeof buildInflightKeyInterno = buildInflightKeyInterno;
/** @deprecated Internal license machinery, removed from the public API in 0.5: no replacement. In the published package a license enters only through `licenseKey` / `serviceAccountKey`. */
export type CompactVerification = CompactVerificationInterno;
/** @deprecated Internal license machinery, removed from the public API in 0.5: no replacement. In the published package a license enters only through `licenseKey` / `serviceAccountKey`. */
export const EMBEDDED_PUBLIC_KEY: typeof EMBEDDED_PUBLIC_KEYInterno = EMBEDDED_PUBLIC_KEYInterno;
/** @deprecated Internal license machinery, removed from the public API in 0.5: no replacement. In the published package a license enters only through `licenseKey` / `serviceAccountKey`. */
export type LicenseKeyShape = LicenseKeyShapeInterno;
/** @deprecated Internal license machinery, removed from the public API in 0.5: no replacement. In the published package a license enters only through `licenseKey` / `serviceAccountKey`. */
export type LicenseStatus = LicenseStatusInterno;
/** @deprecated Internal license machinery, removed from the public API in 0.5: no replacement. In the published package a license enters only through `licenseKey` / `serviceAccountKey`. */
export type LicenseTokenPayload = LicenseTokenPayloadInterno;
/** @deprecated Internal license machinery, removed from the public API in 0.5: no replacement. In the published package a license enters only through `licenseKey` / `serviceAccountKey`. */
export type ResolvedGate = ResolvedGateInterno;
/** @deprecated Internal license machinery, removed from the public API in 0.5: no replacement. In the published package a license enters only through `licenseKey` / `serviceAccountKey`. */
export type ResolvedLicense = ResolvedLicenseInterno;
/** @deprecated Internal license machinery, removed from the public API in 0.5: no replacement. In the published package a license enters only through `licenseKey` / `serviceAccountKey`. */
export type RevocationListBody = RevocationListBodyInterno;
/** @deprecated Internal license machinery, removed from the public API in 0.5: no replacement. In the published package a license enters only through `licenseKey` / `serviceAccountKey`. */
export type RevocationListVerification = RevocationListVerificationInterno;
/** @deprecated Internal license machinery, removed from the public API in 0.5: no replacement. In the published package a license enters only through `licenseKey` / `serviceAccountKey`. */
export type RevocationPollEvent = RevocationPollEventInterno;
/** @deprecated Internal license machinery, removed from the public API in 0.5: no replacement. In the published package a license enters only through `licenseKey` / `serviceAccountKey`. */
export const RevocationPoller: typeof RevocationPollerInterno = RevocationPollerInterno;
/** @deprecated Internal license machinery, removed from the public API in 0.5: no replacement. In the published package a license enters only through `licenseKey` / `serviceAccountKey`. */
export type RevocationPoller = RevocationPollerInterno;
/** @deprecated Internal license machinery, removed from the public API in 0.5: no replacement. In the published package a license enters only through `licenseKey` / `serviceAccountKey`. */
export type RevocationPollerOptions = RevocationPollerOptionsInterno;
/** @deprecated Internal license machinery, removed from the public API in 0.5: no replacement. In the published package a license enters only through `licenseKey` / `serviceAccountKey`. */
export const RevocationSnapshot: typeof RevocationSnapshotInterno = RevocationSnapshotInterno;
/** @deprecated Internal license machinery, removed from the public API in 0.5: no replacement. In the published package a license enters only through `licenseKey` / `serviceAccountKey`. */
export type RevocationSnapshot = RevocationSnapshotInterno;
/** @deprecated Internal license machinery, removed from the public API in 0.5: no replacement. In the published package a license enters only through `licenseKey` / `serviceAccountKey`. */
export const computeNextDelay: typeof computeNextDelayInterno = computeNextDelayInterno;
/** @deprecated Internal license machinery, removed from the public API in 0.5: no replacement. In the published package a license enters only through `licenseKey` / `serviceAccountKey`. */
export const deriveStatus: typeof deriveStatusInterno = deriveStatusInterno;
/** @deprecated Internal license machinery, removed from the public API in 0.5: no replacement. In the published package a license enters only through `licenseKey` / `serviceAccountKey`. */
export const gateFromKey: typeof gateFromKeyInterno = gateFromKeyInterno;
/** @deprecated Internal license machinery, removed from the public API in 0.5: no replacement. In the published package a license enters only through `licenseKey` / `serviceAccountKey`. */
export const isKeyset: typeof isKeysetInterno = isKeysetInterno;
/** @deprecated Internal license machinery, removed from the public API in 0.5: no replacement. In the published package a license enters only through `licenseKey` / `serviceAccountKey`. */
export const licenseKeyShape: typeof licenseKeyShapeInterno = licenseKeyShapeInterno;
/** @deprecated Internal license machinery, removed from the public API in 0.5: no replacement. In the published package a license enters only through `licenseKey` / `serviceAccountKey`. */
export const liveGateFromKey: typeof liveGateFromKeyInterno = liveGateFromKeyInterno;
/** @deprecated Internal license machinery, removed from the public API in 0.5: no replacement. In the published package a license enters only through `licenseKey` / `serviceAccountKey`. */
export const normalizeLicenseKey: typeof normalizeLicenseKeyInterno = normalizeLicenseKeyInterno;
/** @deprecated Internal license machinery, removed from the public API in 0.5: no replacement. In the published package a license enters only through `licenseKey` / `serviceAccountKey`. */
export const resolveLicense: typeof resolveLicenseInterno = resolveLicenseInterno;
/** @deprecated Internal license machinery, removed from the public API in 0.5: no replacement. In the published package a license enters only through `licenseKey` / `serviceAccountKey`. */
export const verifyCompactSignature: typeof verifyCompactSignatureInterno = verifyCompactSignatureInterno;
/** @deprecated Internal license machinery, removed from the public API in 0.5: no replacement. In the published package a license enters only through `licenseKey` / `serviceAccountKey`. */
export const verifyLicenseToken: typeof verifyLicenseTokenInterno = verifyLicenseTokenInterno;
/** @deprecated Internal license machinery, removed from the public API in 0.5: no replacement. In the published package a license enters only through `licenseKey` / `serviceAccountKey`. */
export const verifyRevocationList: typeof verifyRevocationListInterno = verifyRevocationListInterno;
/** @deprecated Internal license machinery, removed from the public API in 0.5: no replacement. In the published package a license enters only through `licenseKey` / `serviceAccountKey`. */
export const UsageEmitter: typeof UsageEmitterInterno = UsageEmitterInterno;
/** @deprecated Internal license machinery, removed from the public API in 0.5: no replacement. In the published package a license enters only through `licenseKey` / `serviceAccountKey`. */
export type UsageEmitter = UsageEmitterInterno;
/** @deprecated Internal license machinery, removed from the public API in 0.5: no replacement. In the published package a license enters only through `licenseKey` / `serviceAccountKey`. */
export type UsageEmitterOptions = UsageEmitterOptionsInterno;
/** @deprecated Internal license machinery, removed from the public API in 0.5: no replacement. In the published package a license enters only through `licenseKey` / `serviceAccountKey`. */
export const deriveSeatId: typeof deriveSeatIdInterno = deriveSeatIdInterno;
/** @deprecated Internal license machinery, removed from the public API in 0.5: no replacement. In the published package a license enters only through `licenseKey` / `serviceAccountKey`. */
export const detectCi: typeof detectCiInterno = detectCiInterno;
/** @deprecated Internal constant, removed from the public API in 0.5. The default is documented on `licenseRevocation.maxStalenessSeconds`; set that option to change it. */
export const DEFAULT_MAX_STALENESS_SECONDS: typeof DEFAULT_MAX_STALENESS_SECONDSInterno = DEFAULT_MAX_STALENESS_SECONDSInterno;
/** @deprecated Internal pipeline helper, removed from the public API in 0.5: no replacement. */
export type ResolvedDeps = ResolvedDepsInterno;
/** @deprecated Internal pipeline helper, removed from the public API in 0.5: no replacement. */
export const resolveDependencies: typeof resolveDependenciesInterno = resolveDependenciesInterno;
/** @deprecated Internal constant of the reference-commission rule, removed from the public API in 0.5: no replacement (the rule is described in the documentation, not frozen as API). */
export const REFERENCE_MAX_AGE_MS: typeof REFERENCE_MAX_AGE_MSInterno = REFERENCE_MAX_AGE_MSInterno;
/** @deprecated Internal constant of the reference-commission rule, removed from the public API in 0.5: no replacement (the rule is described in the documentation, not frozen as API). */
export const REFERENCE_MESSAGE_ALLOWANCE: typeof REFERENCE_MESSAGE_ALLOWANCEInterno = REFERENCE_MESSAGE_ALLOWANCEInterno;
/** @deprecated Internal constant of the reference-commission rule, removed from the public API in 0.5: no replacement (the rule is described in the documentation, not frozen as API). */
export const REFERENCE_OUTPUT_SHARE: typeof REFERENCE_OUTPUT_SHAREInterno = REFERENCE_OUTPUT_SHAREInterno;
/** @deprecated Internal ledger of the pipeline, removed from the public API in 0.5. Read the four ledgers from the `SavingsReport` each call returns. */
export const SavingsLedger: typeof SavingsLedgerInterno = SavingsLedgerInterno;
/** @deprecated Internal ledger of the pipeline, removed from the public API in 0.5. Read the four ledgers from the `SavingsReport` each call returns. */
export type SavingsLedger = SavingsLedgerInterno;
/** @deprecated Internal pipeline helper, removed from the public API in 0.5. Read the stage traces from `report.traces`. */
export const TraceCollector: typeof TraceCollectorInterno = TraceCollectorInterno;
/** @deprecated Internal pipeline helper, removed from the public API in 0.5. Read the stage traces from `report.traces`. */
export type TraceCollector = TraceCollectorInterno;
/** @deprecated Internal pipeline helper, removed from the public API in 0.5: no replacement. */
export const adaptiveK: typeof adaptiveKInterno = adaptiveKInterno;
/** @deprecated Internal pipeline helper, removed from the public API in 0.5: no replacement. */
export const dedupe: typeof dedupeInterno = dedupeInterno;
/** @deprecated Internal pipeline helper, removed from the public API in 0.5: no replacement. */
export const executeRetrievalPlan: typeof executeRetrievalPlanInterno = executeRetrievalPlanInterno;
/** @deprecated Internal pipeline helper, removed from the public API in 0.5: no replacement. */
export const cosine: typeof cosineInterno = cosineInterno;
/** @deprecated Internal pipeline helper, removed from the public API in 0.5: no replacement. */
export const keyTokensMatch: typeof keyTokensMatchInterno = keyTokensMatchInterno;
/** @deprecated Internal pipeline helper, removed from the public API in 0.5: no replacement. */
export const multisetEqual: typeof multisetEqualInterno = multisetEqualInterno;
/** @deprecated Internal pipeline helper, removed from the public API in 0.5: no replacement. */
export const negationCount: typeof negationCountInterno = negationCountInterno;
/** @deprecated Internal pipeline helper, removed from the public API in 0.5: no replacement. */
export const numericTokens: typeof numericTokensInterno = numericTokensInterno;
/** @deprecated Internal pipeline helper, removed from the public API in 0.5: no replacement. */
export const words: typeof wordsInterno = wordsInterno;
/** @deprecated Internal pipeline helper, removed from the public API in 0.5: no replacement. */
export const sameAnswer: typeof sameAnswerInterno = sameAnswerInterno;
/** @deprecated Internal helper, removed from the public API in 0.5. Arithmetic questions are still answered locally by `arithmeticResolver` / `createDefaultResolvers()`. */
export const evalArithmetic: typeof evalArithmeticInterno = evalArithmeticInterno;
/** @deprecated Internal pipeline helper, removed from the public API in 0.5: no replacement. */
export const evaluatePolicy: typeof evaluatePolicyInterno = evaluatePolicyInterno;
/** @deprecated Internal pipeline helper, removed from the public API in 0.5: no replacement. */
export const isStrictCompatible: typeof isStrictCompatibleInterno = isStrictCompatibleInterno;
/** @deprecated Internal pipeline helper, removed from the public API in 0.5: no replacement. */
export const projectContext: typeof projectContextInterno = projectContextInterno;
/** @deprecated Internal pipeline helper, removed from the public API in 0.5: no replacement. */
export const resolveConstraintBackend: typeof resolveConstraintBackendInterno = resolveConstraintBackendInterno;
/** @deprecated Internal pipeline helper, removed from the public API in 0.5: no replacement. */
export const shouldCompress: typeof shouldCompressInterno = shouldCompressInterno;
/** @deprecated Internal pipeline helper, removed from the public API in 0.5: no replacement. */
export const withProtectedSpans: typeof withProtectedSpansInterno = withProtectedSpansInterno;
/** @deprecated Internal pipeline helper, removed from the public API in 0.5: no replacement. */
export const uniformColumns: typeof uniformColumnsInterno = uniformColumnsInterno;
/** @deprecated Internal helper, removed from the public API in 0.5. Use `crypto.randomUUID()`. */
export const randomId: typeof randomIdInterno = randomIdInterno;
