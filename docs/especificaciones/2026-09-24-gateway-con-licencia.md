# Frente 3 · Especificación final: el gateway cumple la LICENSE §2 sin cortar ninguna petición en vuelo

Repositorio leído: `/Users/fisagol/bsl-comprador` @ `ffa93eb`. Es `9b47c9a` (origin/main + PR #310) más dos commits que no tocan esta área. Versión de partida 0.4.22; la de destino es 0.4.23. Todas las citas `fichero:línea` están comprobadas en ese árbol.

Tras el diseño original, las críticas de dos escépticos plantearon 9 defectos bloqueantes, y los 9 se resuelven aquí (§0). Hay cinco cambios de fondo:

1. **Revocación por jti.** `RevocationPoller` más `liveGateFromKey` con un `RevocationSnapshot` compartido.
2. **El token se ata a la organización de la `bvk_`.** La recogida online (E3) se hace siempre. `BIVELIO_LICENSE_KEY` pasa a ser solo el respaldo para cuando no hay red.
3. **El canal de entitlements queda siempre armado.** `BVSALA_GATEWAY_ELISION=0` apaga las palancas, pero no el canal. `blockReason()` refresca el canal con cualquier ruta.
4. **Cambio mínimo de servidor.** `decideEntitlement` bloquea con `reason: "no-license"` y así se cierra el free tier de verdad.
5. **El tráfico de suscripción no acredita ahorro.** Se reconoce por marcas de protocolo (`anthropic-beta: oauth-*`, `/backend-api/`, `chatgpt.com`), nunca por credenciales. En ese tráfico `baseline == actual`, así que la comisión es 0 por diseño y deja de serlo por casualidad.

---

## 0 · Resolución de cada defecto bloqueante

| # | Defecto (crítica) | Resolución |
|---|---|---|
| C1-1 | La revocación por canal no llega a Codex ni a rutas ≠ `/v1/messages`: el canal solo se refresca desde `tiene()` (entitlements.ts:55-58), y `tiene()` solo se llama dentro de `/v1/messages` (servidor.ts:534-540, 577-591, 620-626, 650-655). | Nuevo `CanalDeEntitlements.blockReason()` con el **mismo** disparador de refresco por TTL que `tiene()`. El veredicto lo llama en **todas** las peticiones, así que cualquier ruta refresca el canal. Hay test e2e con `POST /v1/responses` (§8.3, L8). |
| C1-2 | `BVSALA_GATEWAY_ELISION=0` elimina el canal y con él la revocación (servidor.ts:254-255; bin.ts:248). | El canal existe **siempre** que haya `serviceAccountKey`. `opts.elision === false` solo desarma las palancas: `const leversArmed = canal !== null && opts.elision !== false`. Test e2e con `elision:false` y `reason` → 402 (§8.3, L9). Cambian los textos de estado (§6.9). |
| C1-3 | No hay revocación por jti. `decideEntitlement` no bloquea si queda otra licencia válida o una suscripción activa (entitlement.ts:100-101). `gateFromKey` usa un snapshot vacío que nunca se actualiza (gate.ts:18-27). | Se replica `create.ts:118-163`: `RevocationSnapshot` alimentado por `RevocationPoller` contra `${base}/licenses/revocations` (público y firmado, route.ts:29-96). El gate se construye con `liveGateFromKey(token, publicKey, { revocation, now })` al arrancar y en cada adopción. El renovador consulta el mismo snapshot antes de adoptar un token. Sin `maxStalenessSeconds` (justificación en §11). |
| C1-4 | El token no se ata a la org de la `bvk_`. Con E2 activo no había ninguna llamada de red, y el refresher de 7 días no contrasta nada (refresher.ts:116). | **E3 se hace siempre.** 401 y 404 fallan tenga o no `BIVELIO_LICENSE_KEY`. Un 200 es la verdad (el token de la org de la `bvk_`), y un token offline de otra org se ignora con aviso. El token offline solo se usa si E3 es inalcanzable, con timeout de 3 s cuando ese respaldo concede. El renovador adopta el token que sirva la `bvk_` aunque cambie la org, así que un arranque offline con un token ajeno se corrige solo en cuanto vuelve la red. El servidor, además, bloquea a la org sin licencia (C1-5), de modo que el canal corta aunque la comprobación inicial se saltara. |
| C1-5 / C2-4 | El free tier no se cierra sin tocar el servidor: la ingesta acepta `no-license-record` (entitlement.ts:103-108; usage/route.ts:65-76), la 0.4.22 sigue en npm y el binario se puede parchear. | **Cambio de servidor** en este frente, desplegado ANTES del npm: la rama `no-license-record` pasa a `{ blocked: true, reason: "no-license" }`. Resultado: 402 en la ingesta y `reason` en `/api/org/entitlements`. Antes se ejecuta un diagnóstico de solo lectura (§7). El §10 se reescribe: el candado de cobro es el servidor, y la verja del gateway es cumplimiento más UX. |
| C2-1 | El modo suscripción obliga a tener licencia PRO. La rebaja de TTL, encendida por defecto, registra ahorro `measured` (medidor.ts:560-564, 609), y eso es comisión sobre una diferencia de precio de lista que no aparece en ninguna factura. Además, la premisa «no es distinguible» era falsa: `anthropic-beta: oauth-*` es obligatorio por protocolo (TERMINALES-DE-CODIFICACION.md:56; palanca.ts:222-223). | `isSubscriptionTraffic(pathname, anthropicBeta, upstreamBase)` en medidor.ts. Se evalúa con las cabeceras **originales** del cliente, antes de que las palancas añadan betas. En tráfico de suscripción, `construirInforme` pone `sobrecosteEvitado = 0` y `ahorroHermano = 0`, así que `baseline == actual` y la comisión es 0 por diseño. Las palancas siguen aplicándose (valor contra topes, PLAN-S4-PALANCA.md:216-218); solo deja de acreditarse dinero. Se reescribe la justificación del §3.4 y se retiran sus premisas (3) y (4). |
| C2-2 | «metered, not billed / no se monetiza» se contradice con una licencia de pago. Faltaban por localizar bin.ts:66, envoltorios.ts:169 (fijado por gateway-envoltorios.test.ts:56), doctor.ts:235-237 y codex.md:14-15, 95 y 102. | La nueva redacción es «metered at list-price equivalent, with no commission (there is no per-token invoice); the per-seat license applies». Se cambia en los tres literales del CLI, en codex.md y en claude-code.md. El test pasa a `toContain("no commission")`. En `onlyChatBody` ×12 se **retira** la oferta del gateway a quien solo usa suscripción, por coherencia con README:60-65 (§6.12). |
| C2-3 | El mensaje sin clave calla que hace falta pagar, y `no-license` enviaba a `/dashboard/install`, donde no se puede suscribir. | `service-key-missing` nombra las dos condiciones con sus dos URL (`/dashboard/account` para la suscripción, `/dashboard/install` paso 2 para la clave). `no-license` y la renovación mandan a `/dashboard/account`. Los tests comprueban las URL exactas (§8.1). |

Las mejoras no bloqueantes que se incorporan están marcadas con [NB] a lo largo del documento. Las rechazadas, con su motivo, están en §11.

---

## 1 · Principios (no negociables)

1. **LICENSE §2** (LICENSE:18-23): «The Software requires a valid, active License Key and does not operate without one». El gateway forma parte del Software (package.json `bin.bvsala = ./dist/gateway/bin.js`, línea 33). La LICENSE **no se modifica**: es el código el que pasa a cumplirla.
2. **Ninguna PETICIÓN en vuelo se corta jamás.** La licencia verja el arranque y cada petición NUEVA. Una sesión viva de Claude Code sí recibe un 402 en su siguiente turno si la licencia caduca; lo que nunca se toca es una petición que ya pasó la verja. Lo que sobrevive de «AVISAR, NUNCA ROMPER» (servidor.ts:42-46) es esto: el **metering** sigue siendo best-effort y no corta nada.
3. **No hay free tier** (README:277, fijado por readme-alineado.test.ts:42). El candado de cobro está en el **servidor** (ingesta y canal), que no se puede parchear. La verja del gateway da cumplimiento y UX, no seguridad de cobro.
4. **Solo se cobra sobre lo medido y defendible frente a una factura.** El tráfico de suscripción no tiene factura por tokens, así que no acredita ahorro. Nada más de la aritmética de facturación cambia.
5. **Nunca se lee, se imprime ni se persiste una credencial.** Ni la `bvk_` ni el token aparecen en ningún mensaje, log ni fichero, y hay tests que lo comprueban. La clasificación de suscripción usa marcas de protocolo, nunca el valor de `Authorization` ni el de `x-api-key`.

---

## 2 · Hechos verificados de los que depende esta especificación

| Hecho | Dónde (@ffa93eb) |
|---|---|
| Sin clave no se crea emisor ni canal, se llama a `avisarUnaVez("gateway-sin-clave")` y el tráfico pasa intacto | gateway/servidor.ts:208-233, 254-265 |
| El canal: un refresco en el constructor; `tiene()` es el ÚNICO disparador por TTL; TTL `min(refreshAfterSeconds·1000, 300000)`; timeout 10 s; `cerrar()` deja features vacías y reintenta en ≤ 60 s; el `reason` del 200 se ignora; un 401 se funde con el resto de fallos | gateway/entitlements.ts:25-26, 40-58, 69-105 |
| Las cuatro palancas exigen `canalElision !== null` y solo se evalúan en `/v1/messages` (y count_tokens) | servidor.ts:533-541, 577-591, 620-626, 650-655 |
| `/api/org/entitlements` devuelve `reason` SOLO cuando `decision.blocked` | apps/web/app/api/org/entitlements/route.ts:84-95 |
| `decideEntitlement`: `no-license-record` → no bloquea; `license-revoked`/`license-expired` solo si «tuvo licencia» | apps/web/lib/metering/entitlement.ts:95-114 |
| La ingesta devuelve 402 solo con `decision.blocked` y es fail-open ante error de BD | apps/web/app/api/metering/usage/route.ts:58-76 |
| `/api/license/current` con Bearer bvk_: 401 si la clave es desconocida; 404 si no hay fila `revoked=false` con token; 200 `{token, jti, plan, seats, expiresAt, graceDays}`; 503 si la BD falla; 501 sin admin; sella `last_used_at`. Devuelve la fila más nueva por `issued_at` aunque esté caducada | apps/web/app/api/license/current/route.ts:54-88, 100-134, 136-139 |
| `/licenses/revocations`: público, lista firmada `typ: BVSALA-REVOC`; 503 si falla el almacén; ETag/304 | apps/web/app/licenses/revocations/route.ts:29-96; src/license/revocation.ts:15, 51-90 |
| `revokeLicense` escribe primero el ledger y después `licenses.revoked`; «the SDK enforces the revocation ledger» | apps/web/lib/license/issue.ts:183-200 |
| El SDK online hace `liveGateFromKey` con snapshot + `RevocationPoller` + refresher con `revocados` | src/pipeline/create.ts:112-187 |
| `liveGateFromKey`: verifica una sola vez; `status()` usa reloj vivo más snapshot; `refreshAfter()`; `ResolvedGate` no expone el payload | src/license/live-gate.ts:14-28, 42-137 |
| `verifyCompactSignature` devuelve la cabecera; `verifyLicenseToken` no comprueba `typ` | src/license/verify.ts:201-272 |
| `normalizeLicenseKey`, `licenseKeyShape`, `deriveStatus` son públicos | src/license/verify.ts:144-183, 284-294; src/license/index.ts:1-6 |
| `RevocationPoller` admite `silenceWarnings`, `onEvent`, `floorSeconds`, `pollIntervalSeconds`, `jitterRatio`, `requestTimeoutMs`, `fetchImpl`, `nowSeconds`. Su aviso de «lista que NO verifica» sigue en castellano | src/license/poller.ts:46-84, 233-238 |
| `LicenseRefresher` NO se exporta en `dist/index.d.ts` (0 apariciones). Su aviso de 401/403/404 usa vocabulario del SDK | src/license/refresher.ts:143-150 |
| `EMBEDDED_PUBLIC_KEY` = define `__BV_SALA_PUBLIC_KEY__`, o `""` desde el fuente | src/license/verify.ts:62-64 |
| `gateway/bin` va en la misma configuración tsup que `index` (`defineNpm`), con `splitting:false`. Hoy `dist/gateway/bin.js` tiene **0** apariciones de `BEGIN PUBLIC KEY` (tree-shaking) y `dist/index.js` tiene 1 | tsup.config.ts:35, 77; `grep -c` sobre dist |
| `keys/license.pub.pem` está versionada: todo build local la embebe | `git ls-files keys/` |
| Nada ejecuta `gateway/bin.ts` desde el fuente; el arnés usa `dist/gateway/bin.js` | package.json:33; scripts/arnes-pasarela.mjs:35 |
| `BVSALA_METERING_URL` solo se lee en bin.ts:273 | grep |
| Ayuda, versión, doctor y skill salen antes de bin.ts:201. `bvsala claude --help` arranca el gateway | gateway/argumentos.ts:24-37; bin.ts:133-188 |
| `PIDE_AYUDA`/`PIDE_VERSION` incluyen las palabras sueltas `help`/`version` | argumentos.ts:15-16 |
| Envoltorio silenciado salvo con `BVSALA_GATEWAY_LOG=1`; las líneas de arranque van por `console.log/error` | bin.ts:207, 286-316 |
| El trial piloto dura 90 días + 3 de gracia, sin renovación automática, persistido fail-closed; ruta solo de allow-list | apps/web/app/api/license/trial/route.ts:24, 146-203 |
| La comisión se calcula solo sobre `ahorro = max(0, measured_baseline − measured_actual)` | apps/web/lib/billing/extracto.ts:128-163; tarifa.ts:121-135 |
| La rebaja de TTL y el hermano acreditan `measured` sin mirar el tipo de auth | gateway/medidor.ts:526-615 (560-564, 609); servidor.ts:650-655 |
| Los tests e2e de la rebaja con `anthropic-beta: oauth-2025-04-20` afirman que el cuerpo SE REESCRIBE (5m), no el dinero | test/gateway-palanca.test.ts:534-561 |
| El e2e «MEDIDA» del hermano no lleva beta oauth | test/gateway-hermano.test.ts:473-503 |
| 36 arranques de `arrancarGateway(`: servidor 24, coalescencia 5, sombra-vivo 3, promesas 2, palanca 1 (`gatewayCon`), hermano 1 (`gatewayCon`) | `grep -c` |
| Test que fija `describirEstadoDeElision("0")` con `/licence channel: CLOSED…/` | test/gateway-palanca.test.ts:495 |
| La nota del envoltorio de Codex (`not billed`) está fijada por su test | gateway/envoltorios.ts:167-170; test/gateway-envoltorios.test.ts:56 |
| El test de doctor prohíbe `bvk_[A-Za-z0-9_-]+` en su salida | test/gateway-doctor.test.ts:172 |
| `readme-alineado` fija `first month carries no commission`, `never from estimates`, `No free tier and no trial`, `cache-write TTL`; en terminales `TTL de escritura de caché` (l.18); prohíbe `≥ N %`; `€4 / seat / month` exactamente 2 veces | apps/web/lib/readme-alineado.test.ts:30-55 |
| `claves-usadas`, `parity` (mismas etiquetas y placeholders) y `tarifa-en-parametros` (sin dígitos en landing.calculadora/formula/dashboard.extracto) | apps/web/messages/*.test.ts |
| `BV_SALA_VERSION = "0.4.22"` y package.json 0.4.22; test `version-declarada` | src/version.ts:9; package.json:3 |

---

## 3 · Arquitectura final

```
bvsala <gateway|claude|codex|goose|qwen> [args]
 │
 ├─ decidirArranque → ayuda / versión / skill / doctor: SIN CAMBIOS (salen antes de todo)
 ├─ [nuevo] envoltorio && isChildInfoRequest(resto)  →  spawn(bin, resto) directo, sin gateway ni verja
 ├─ [nuevo] resolveStartupLicense(...)               →  !ok: stderr + exit 1
 │     E0 clave pública · E1 BIVELIO_SERVICE_KEY · E2 BIVELIO_LICENSE_KEY (si está) · E3 GET /api/license/current (SIEMPRE)
 ├─ envoltorio / anillo 2 / arrancarGateway({ license: { token, publicKey, licenseServerUrl, checkOnStart }, warn })
 │     ├─ live = buildLiveLicense(token)  (liveGateFromKey sobre RevocationSnapshot)
 │     ├─ canal de entitlements SIEMPRE (con clave): features + blockReason()
 │     ├─ RevocationPoller  → snapshot (jti revocados, ≈15 min)
 │     ├─ LicenseRenewer    → /api/license/current (1 h, 7 días de antelación; forzado ≤ 1/min al cortar)
 │     └─ handler: ANTES de leer el cuerpo → licenseVerdict(live.gate, canal?.blockReason())
 │                 ├─ sirve  → camino actual intacto
 │                 └─ corta  → 402 JSON (error.message), sin tocar el upstream
 └─ líneas de arranque: listening · license · metering · palancas
```

Ninguna otra parte del camino de una petición lee la licencia. Las palancas siguen leyendo **features** con `tiene()`, que es otra pregunta (fail-closed, y nunca corta).

---

## 4 · Contratos (firmas exactas)

### 4.1 Módulo nuevo `gateway/license.ts`

```ts
import {
  deriveStatus, isKeyset, licenseKeyShape, liveGateFromKey, normalizeLicenseKey,
  verifyCompactSignature, RevocationSnapshot,
  type LicenseKeyset, type LicenseStatus, type LicenseTokenPayload, type ResolvedGate,
  type RevocationPollerOptions,
} from "../src/license/index.js";

export const LICENSE_SERVER_URL = "https://savings.bivelio.com";
export const ACCOUNT_URL = "https://savings.bivelio.com/dashboard/account";
export const INSTALL_URL = "https://savings.bivelio.com/dashboard/install";
export const STARTUP_TIMEOUT_MS = 10_000;
export const STARTUP_TIMEOUT_WITH_FALLBACK_MS = 3_000;
export const FORCED_RENEWAL_MIN_INTERVAL_MS = 60_000;
export const RENEWAL_INTERVAL_MS = 3_600_000;
export const RENEWAL_LEAD_SECONDS = 7 * 86_400;
export const RENEWAL_TIMEOUT_MS = 30_000;

/** Token ya normalizado y verificado, con su payload validado. */
export interface VerifiedLicense { token: string; payload: LicenseTokenPayload; }

export type LicenseCheck =
  | { ok: true; license: VerifiedLicense }
  | { ok: false; shape: "empty" | "malformed" | "token"; reason: string };

/**
 * normalizeLicenseKey → licenseKeyShape → verifyCompactSignature → header.typ === "BVL"
 * → JSON → isLicensePayload. Nunca lanza.
 *  · shape "empty"     → { ok:false, shape:"empty", reason:"empty" }
 *  · shape "malformed" → { ok:false, shape:"malformed", reason:"malformed" }
 *  · firma mala        → reason = v.reason (p.ej. "bad signature", "unknown key id …")
 *  · typ ≠ "BVL"       → reason = `not a license token (typ ${typ})`
 *  · JSON roto         → reason = "payload is not valid JSON"
 *  · tipos incorrectos → reason = "license payload has the wrong field types"
 */
export function verifyGatewayLicense(raw: string, publicKey: string | LicenseKeyset): LicenseCheck;

/** jti/org_id/plan string no vacíos; seats/issued_at/expires_at finitos; grace_days finito ≥ 0; features string[]. */
export function isLicensePayload(p: unknown): p is LicenseTokenPayload;

/** deriveStatus(payload, floor(nowMs/1000), revoked). */
export function licenseState(payload: LicenseTokenPayload, nowMs: number, revoked?: ReadonlySet<string>): LicenseStatus;

export type Collection =
  | { kind: "token"; license: VerifiedLicense }       // 200 + verifica + BVL + campos
  | { kind: "not-verifying"; reason: string }         // 200 con token que no verifica contra ESTE build
  | { kind: "key-unknown" }                           // 401
  | { kind: "no-license" }                            // 404
  | { kind: "unreachable"; cause: string };           // el resto: 403, 5xx, 501, 503, timeout, red, JSON sin token

/**
 * GET `${licenseServerUrl sin barra final}/api/license/current`,
 * headers { authorization: `Bearer ${serviceAccountKey}`, accept: "application/json" }.
 * Timeout con AbortController + setTimeout(…).unref() (NO AbortSignal.timeout: tiene que
 * poder simularse con vi.useFakeTimers). Si llega `signal`, su abort también aborta.
 * `fetchImpl ?? globalThis.fetch`, resuelto EN LA LLAMADA, no al cargar el módulo.
 * cause: "timed out after N s" | "network error: <mensaje y cause.code>" | "HTTP <status>"
 *        | "unexpected response (no license token)". Nunca lanza.
 */
export function collectLicense(opts: {
  licenseServerUrl: string;
  serviceAccountKey: string;
  publicKey: string | LicenseKeyset;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<Collection>;

export type StartupFailureCode =
  | "no-public-key" | "service-key-missing" | "service-key-malformed"
  | "service-key-not-recognised" | "no-license" | "license-invalid"
  | "license-expired" | "unreachable";

export interface StartupInput {
  serviceAccountKey?: string;          // process.env.BIVELIO_SERVICE_KEY (se hace trim dentro)
  licenseKey?: string;                 // process.env.BIVELIO_LICENSE_KEY
  licenseServerUrl: string;            // LICENSE_SERVER_URL en bin.ts; un servidor local en tests
  publicKey: string | LicenseKeyset;   // EMBEDDED_PUBLIC_KEY en bin.ts
  fetchImpl?: typeof fetch;
  now?: () => number;                  // ms
  timeoutMs?: number;                  // sustituye a los defaults 10 000 / 3 000
}

export type StartupResult =
  | {
      ok: true;
      license: VerifiedLicense;
      source: "online" | "offline";
      status: "active" | "grace";
      line: string;             // sin prefijo; bin.ts antepone "[bvsala gateway] "
      lineIsWarning: boolean;   // true si status === "grace" || source === "offline"
      warnings: string[];       // sin prefijo; bin.ts los imprime por stderr
    }
  | { ok: false; code: StartupFailureCode; message: string }; // sin prefijo; bin.ts antepone "[bvsala <comando>] "

export function resolveStartupLicense(input: StartupInput): Promise<StartupResult>;

export interface FailureContext {
  tokenSource?: "BIVELIO_LICENSE_KEY" | "savings.bivelio.com";
  shape?: "malformed" | "token";
  reason?: string;
  expiresAt?: number;   // unix s
  graceDays?: number;
  cause?: string;
  keyLooksLikeLicense?: boolean;
}
export function startupFailureMessage(code: StartupFailureCode, ctx?: FailureContext): string;
export function licenseLine(payload: LicenseTokenPayload, source: "online" | "offline", status: "active" | "grace", cause?: string): string;
/** UTC YYYY-MM-DD */
export function isoDay(unixSeconds: number): string;

// ── En vivo ────────────────────────────────────────────────────────────
export type GatewayLicenseState = "active" | "grace" | "expired" | "revoked" | "no-license" | "blocked" | "invalid";
export type Verdict =
  | { serve: true; state: "active" | "grace" }
  | { serve: false; state: "expired" | "revoked" | "no-license" | "blocked" | "invalid"; detail: string };

/**
 * PURA. Primero manda el control plane (fail-closed):
 *   blockReason "license-revoked" → revoked · "license-expired" → expired · "no-license" → no-license
 *   cualquier otra cadena no vacía → blocked       (detail: "reported by savings.bivelio.com")
 * Después, el gate:
 *   active|grace → serve · expired → expired (detail: `grace period ended ${isoDay}` si el payload se conoce)
 *   revoked → revoked (detail: "license id revoked") · invalid|none|stale → invalid (detail: "license no longer verifies")
 */
export function licenseVerdict(gate: ResolvedGate, blockReason: string | null, payload?: LicenseTokenPayload): Verdict;

export function refusalMessage(state: Exclude<GatewayLicenseState, "active" | "grace">): string;
/** JSON.stringify({ type:"error", error:{ type:"license_error", status: state, message: refusalMessage(state) } }) */
export function refusalBody(state: Exclude<GatewayLicenseState, "active" | "grace">): string;
/** Línea para `warn` o null (§6.2). `from` es el último estado anunciado (null = ninguno). */
export function transitionLine(from: GatewayLicenseState | null, to: Verdict, payload: LicenseTokenPayload): string | null;

export interface LiveLicense { license: VerifiedLicense; gate: ResolvedGate; }
/** liveGateFromKey(license.token, publicKey, { revocation, now }). SIN maxStalenessSeconds. */
export function buildLiveLicense(license: VerifiedLicense, publicKey: string | LicenseKeyset,
  revocation: RevocationSnapshot, now?: () => number): LiveLicense;

/** Lo que arrancarGateway recibe. OBLIGATORIO. */
export interface GatewayLicense {
  token: string;
  publicKey: string | LicenseKeyset;
  /** Base del control plane. Con ella: poller de revocaciones, URL del canal y (si hay clave) renovador.
   *  Sin ella: cero llamadas de licencia (solo tests). */
  licenseServerUrl?: string;
  /** bin.ts: true si el arranque fue offline (source === "offline"): el renovador comprueba nada más arrancar. */
  checkOnStart?: boolean;
  now?: () => number;
  renewal?: { intervalMs?: number; leadSeconds?: number; timeoutMs?: number };
  revocations?: Pick<RevocationPollerOptions,
    "pollIntervalSeconds" | "floorSeconds" | "maxIntervalSeconds" | "jitterRatio" | "requestTimeoutMs">;
}

export interface LicenseRenewerOptions {
  licenseServerUrl: string;
  serviceAccountKey: string;
  publicKey: string | LicenseKeyset;
  revocation: RevocationSnapshot;
  current: () => VerifiedLicense;
  onAdopt: (l: VerifiedLicense) => void;
  onWarning: (line: string) => void;       // una vez por causa y proceso
  fetchImpl?: typeof fetch;
  now?: () => number;
  intervalMs?: number;                     // RENEWAL_INTERVAL_MS
  leadSeconds?: number;                    // RENEWAL_LEAD_SECONDS
  timeoutMs?: number;                      // RENEWAL_TIMEOUT_MS
}

export class LicenseRenewer {
  constructor(o: LicenseRenewerOptions);
  /** setInterval(check, intervalMs).unref(); con checkNow: void check({ force: true }) inmediato. Idempotente. */
  start(opts?: { checkNow?: boolean }): void;
  /** clearInterval + aborta la recogida en vuelo; después de stop() nunca adopta. Idempotente. */
  stop(): void;
  /** true si adoptó. Nunca lanza. */
  check(opts?: { force?: boolean }): Promise<boolean>;
}
```

**Regla de `LicenseRenewer.check`:**

1. Si hay una recogida en vuelo o está parado → `false`.
2. `cur = current()`; `granting = licenseState(cur.payload, now(), revocation.snapshot()) ∈ {active, grace}`.
3. Si `!force && granting && cur.payload.expires_at − nowS > leadSeconds` → `false` (sin red).
4. `r = await collectLicense({ …, signal })`.
5. `r.kind === "token"`: se adopta si `c.payload.jti !== cur.payload.jti`, `!revocation.has(c.payload.jti)`, `licenseState(c.payload, now(), snapshot) ∈ {active, grace}` y además se cumple **uno** de estos tres: `c.payload.org_id !== cur.payload.org_id` (manda la org de la `bvk_`), `c.payload.expires_at > cur.payload.expires_at`, o `!granting`. Al adoptar: `onAdopt(c)` y `true`.
6. `key-unknown` → `onWarning` una vez (§6.3). `no-license` → `onWarning` una vez. `not-verifying` → `onWarning` una vez por `reason`. `unreachable` → nada (best-effort).

**Por qué un renovador propio y no `LicenseRefresher`** (resuelve la sugerencia [NB] de C1/C2 sobre el aviso con vocabulario del SDK):

- `LicenseRefresher` solo adopta tokens estrictamente más nuevos y de la misma org (refresher.ts:163-164), y no tiene «forzar» (116). Eso rompe dos cosas que el gateway necesita: curarse tras una revocación (el reemitido puede no ser más nuevo) y el arranque offline con un token de otra org, porque en el gateway la identidad la da la `bvk_`.
- Su aviso habla de `'serviceAccountKey'`/`'licenseServerUrl'` y de «the SDK» (145-150).
- Doblar la clase del SDK con tres opciones nuevas añade riesgo al SDK; reutilizar `collectLicense`, que el arranque ya necesita, no. `src/license/refresher.ts` **no se toca**.

### 4.2 `gateway/servidor.ts`

```ts
export interface OpcionesGateway {
  // … campos actuales sin cambios …
  /** OBLIGATORIA (LICENSE §2): la licencia ya verificada al arrancar. */
  license: GatewayLicense;
  /** Solo tests: TTL del canal (por defecto 300 000). */
  entitlementsTtlMs?: number;
  /** Transiciones de licencia y avisos accionables. Por defecto console.error. bin.ts NO lo silencia. */
  warn?: (line: string) => void;
}
export interface GatewayArrancado {
  puerto: number;
  cerrar: () => Promise<void>;
  /** licenseVerdict(live.gate, canal?.blockReason() ?? null, live.license.payload).state */
  licenseStatus(): GatewayLicenseState;
}
export async function arrancarGateway(opts: OpcionesGateway): Promise<GatewayArrancado>; // se quita el `= {}`
```

### 4.3 `gateway/entitlements.ts`

```ts
export class CanalDeEntitlements {
  // actual…
  /** El último `reason` DEFINITIVO del control plane (un 200 con `reason`), o null.
   *  Pegajoso: solo lo cambia otro 200. Dispara el mismo refresco por TTL que `tiene()`. */
  blockReason(): string | null;
}
```

### 4.4 `gateway/medidor.ts`

```ts
/** Tráfico SIN factura por tokens, reconocido SOLO por marcas de protocolo (jamás credenciales):
 *  · algún elemento de `anthropic-beta` (separado por comas, con trim) empieza por "oauth-"
 *  · pathname empieza por "/backend-api/"
 *  · hostname de upstreamBase es "chatgpt.com" o termina en ".chatgpt.com" */
export function isSubscriptionTraffic(pathname: string, anthropicBeta: string | undefined, upstreamBase: string): boolean;

export function informeMedido(requestId, model, medido, atribucion?, elision?, rebaja?, hermano?,
  /** true → no se acredita ahorro de rebaja ni de hermano: baseline == actual. */
  subscription?: boolean): SavingsReport;
```

### 4.5 `gateway/argumentos.ts`

```ts
/** `bvsala <envoltorio> X` con X ∈ {"--help","-h","--version"} y NADA más.
 *  "-v", "help" y "version" quedan fuera A PROPÓSITO: en algunos terminales "-v" es verbose y
 *  las palabras sueltas pueden ser un prompt, y lanzarlas sin gateway sería una sesión sin medir. */
export function isChildInfoRequest(rest: readonly string[]): boolean;
```

### 4.6 Servidor web

```ts
// apps/web/lib/metering/entitlement.ts
export function decideEntitlement(...): EntitlementDecision;
// reason ∈ "valid-license" | "active-subscription" | "no-license" | "license-revoked" | "license-expired"
// "no-license-record" DESAPARECE.
```

Contrato que queda documentado en `org/entitlements/route.ts`: **`reason` presente ⇔ org bloqueada.** El gateway trata cualquier `reason` no vacío como corte.

---

## 5 · Política exacta

### 5.1 Arranque (`resolveStartupLicense`), orden estricto

```
E0  publicKey vacía ("" tras trim, o keyset sin claves)             → no-public-key            (sin red)
E1  key = serviceAccountKey?.trim(); !key                           → service-key-missing      (sin red)
    !key.startsWith("bvk_")                                          → service-key-malformed    (sin red;
                                                                       keyLooksLikeLicense = licenseKeyShape(normalizeLicenseKey(key)) === "token")
E2  licenseKey !== undefined:
      c = verifyGatewayLicense(licenseKey, publicKey)
      c.shape "empty"                → offline = null (se trata como ausente)
      !c.ok (malformed | token malo) → license-invalid {tokenSource:"BIVELIO_LICENSE_KEY", shape, reason}   (sin red)
      c.ok                           → offline = c.license
    offlineGrants = offline && licenseState(offline.payload, now) ∈ {active, grace}
E3  SIEMPRE: collectLicense(timeout = input.timeoutMs ?? (offlineGrants ? 3 000 : 10 000))
      key-unknown   → service-key-not-recognised                     (aunque haya offline)
      no-license    → no-license                                     (aunque haya offline)
      token t:
         s = licenseState(t.payload, now)
         warnings = offline && offline.payload.org_id !== t.payload.org_id ? [ORG_MISMATCH] : []
         s ∈ {active, grace}  → OK {license: t, source:"online", status: s, warnings}
         s = expired          → license-expired {expiresAt, graceDays de t}   (el online manda: si el offline
                                                                               fuera más nuevo, su fila está revocada)
      not-verifying reason:
         offlineGrants → OK {license: offline, source:"offline", warnings:[ONLINE_NOT_VERIFYING(reason)]}
         si no         → license-invalid {tokenSource:"savings.bivelio.com", reason}
      unreachable cause:
         offlineGrants → OK {license: offline, source:"offline", cause}
         offline (caducado) → license-expired {expiresAt, graceDays del offline, cause}   [NB C1: las dos causas]
         sin offline   → unreachable {cause}
```

- `licenseServerUrl` en bin.ts es **siempre** `LICENSE_SERVER_URL`. `BVSALA_METERING_URL` ya no redirige ni la licencia ni el canal, solo la ingesta, y con aviso (§6.4). [NB C1]
- Red caída y sin token de respaldo → **fail-closed, exit 1**. Es la letra del §2 y lo que hace el SDK. La salida de emergencia es `BIVELIO_LICENSE_KEY` y el mensaje la explica.

### 5.2 En vivo, por petición

Lugar: dentro de `createServer(async (req, res) => {`, justo después de `const inicioMs = Date.now();` (servidor.ts:393) y **antes** de `new AbortController()` y `res.on("close")` (399-402), de leer el cuerpo, de la coalescencia y de cualquier `fetch`.

```ts
const pathname = new URL(req.url ?? "/", "http://x").pathname;
const v = licenseVerdict(live.gate, canal?.blockReason() ?? null, live.license.payload);
announce(v);                                   // transitionLine(announced, v, payload) → warn; announced = v.state
if (!v.serve) {
  const t = nowMs();
  if (renewer && t - lastForcedMs >= FORCED_RENEWAL_MIN_INTERVAL_MS) { lastForcedMs = t; void renewer.check({ force: true }); }
  req.resume();
  res.writeHead(402, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "x-bvsala-license-status": v.state,
  });
  res.end(req.method === "HEAD" ? undefined : refusalBody(v.state));
  log(`[gateway] ${req.method} ${pathname} → 402 (license ${v.state})`);
  return;
}
```

- **Invariante de no-corte:** es el ÚNICO punto que lee `live.gate` o `blockReason()` en el camino de la petición. Una petición que pasó termina aunque el estado cambie un milisegundo después. Las palancas siguen leyendo `canal.tiene(...)`, que solo decide features: una petición que pasó puede quedarse sin palanca si el canal cambió entre medias, pero **se sirve**.
- Todas las rutas quedan verjadas (`HEAD /api/hello`, `GET /v1/models`, count_tokens, `…/responses`). El `upgrade` WebSocket sigue en 426 (servidor.ts:859-869) porque es un rechazo de protocolo.
- Estado anunciado inicial: `live` al construir. Si concede, `announced = "active" | "grace"`; si no concede (solo en tests), `announced = null`.
- **Cotas de propagación:**
  - Caducidad: inmediata (reloj vivo).
  - Bloqueo de org por el canal: ≤ 300 s más la duración de un refresco. La primera petición tras vencer el TTL decide con el valor anterior, porque el refresco es perezoso. [NB C1]
  - Revocación por jti: la cadencia del poller, anclada a `refreshAfter()` y acotada a [300 s, 900 s] ± 10 % (poller.ts:18-25, 92-118).
- **Tabla gate × canal:**

| gate.status() \ blockReason | null | "license-expired" | "license-revoked" | "no-license" | otro no vacío |
|---|---|---|---|---|---|
| active | sirve active | 402 expired | 402 revoked | 402 no-license | 402 blocked |
| grace | sirve grace | 402 expired | 402 revoked | 402 no-license | 402 blocked |
| expired | 402 expired | 402 expired | 402 revoked | 402 no-license | 402 blocked |
| revoked | 402 revoked | 402 expired | 402 revoked | 402 no-license | 402 blocked |
| invalid/none/stale | 402 invalid | 402 expired | 402 revoked | 402 no-license | 402 blocked |

(Conflicto canal-bloquea con gate-gracia: gana el corte.)

- **Canal 401** (clave borrada o rotada con el proceso vivo): NO corta. La licencia sigue verificada y el emisor ya avisa (servidor.ts:215-222). Se emite una línea propia en `log`. Las features caen a vacío: fail-closed de las palancas.
- **Adopción del renovador:** `live = buildLiveLicense(nueva, …)`, `log("[gateway] renewed license adopted (expires YYYY-MM-DD)")` y `announce(licenseVerdict(...))`.

### 5.3 Canal de entitlements

- Se crea si hay `serviceAccountKey`, **con independencia de `opts.elision`**. URL: `${license.licenseServerUrl}/api/org/entitlements` si viene `licenseServerUrl`; si no, `new URL("/api/org/entitlements", opts.meteringUrl ?? "https://savings.bivelio.com/api/metering/usage")`, como hoy (así los 36 tests siguen apuntando a su plataforma falsa). `ttlMs: opts.entitlementsTtlMs`.
- `leversArmed = canal !== null && opts.elision !== false` sustituye a `canalElision !== null` en las cuatro palancas (servidor.ts:534, 578, 621, 651).
- En `pedir()`: `if (res.status === 401) { this.cerrar("entitlements HTTP 401", LINEA_401); return; }`. En un 200 con forma válida: `this.razonDeBloqueo = typeof json.reason === "string" && json.reason.trim() !== "" ? json.reason.trim() : null`. `cerrar()` **no toca** `razonDeBloqueo`: un fallo de red no es una revocación.
- `cerrar(motivo, linea?)`: si `!avisado`, hace `log(linea ?? <texto actual>)`.

### 5.4 Por palanca y tipo de tráfico

| Palanca | Tráfico API key | Tráfico de suscripción (`isSubscriptionTraffic`) |
|---|---|---|
| Rebaja de TTL (`cache_ttl_tuning`, por defecto con PRO) | se aplica; ahorro `measured` acreditado (sin cambios) | **se aplica** (topes, PLAN-S4:216-218); **ahorro 0** (`baseline == actual`) |
| Modelo hermano (`sibling_model_routing`, opt-in) | se aplica; ahorro `measured` | se aplica; `actual` al servido; **ahorro 0** |
| Esfuerzo por turno | se aplica (no acredita) | igual |
| Diales de elisión | igual que hoy (suelo en carril propio, no comisiona) | igual |
| Gemela coalescida | `estimated` (no comisiona) | igual |

`isSubscriptionTraffic` se evalúa con `cabecerasOriginales["anthropic-beta"]` (servidor.ts:524, antes de que las palancas añadan betas), `url.pathname` y `upstreamBase`. Viaja como nuevo último parámetro de `medir(...)` en las tres llamadas medidas: stream (797), JSON (811) y abortado (836). En la réplica coalescida no hace falta, porque ya es `estimated`. Cuando `subscription && (rebaja || hermano)`, `medir` añade a su línea de log ` · subscription traffic: lever applied, saving not credited (no per-token invoice)`.

### 5.5 Modo suscripción: exige licencia igual (justificación reescrita)

1. El §2 licencia el Software, no un tipo de tráfico.
2. «No free tier and no trial»: eximir a la suscripción sería un free tier con otro nombre.
3. La licencia se comprueba **por org** al arrancar, no por petición. El gateway **sí** distingue el tráfico de suscripción por marcas de protocolo, y lo usa para **no acreditar ahorro**, no para eximir de licencia.
4. La cuota por asiento (€4/mes, €39/año) paga la medición y las palancas contra topes. La comisión en ese tráfico es 0 **por diseño** desde 0.4.23 (§5.4), no por casualidad (codex.md:109-118 lo marcaba como laguna).
5. El skill sigue gratis y no necesita gateway (bin.ts:146-169).

---

## 6 · Cambios por fichero y textos públicos exactos

Todo texto nuevo de `gateway/license.ts` (fallos, líneas, 402, transiciones, avisos) es **ASCII puro** (`/^[\x20-\x7E]+$/`, con `...` en vez de `…` y `-`/`:` en vez de `—`). Nunca contiene el valor de la `bvk_` ni del token.

### 6.1 `gateway/license.ts`: mensajes de fallo al arrancar

`startupFailureMessage(code, ctx)` devuelve exactamente lo siguiente (`E` = `isoDay(expiresAt)`, `G` = `isoDay(expiresAt + graceDays*86400)`):

- `no-public-key`:
  `this build has no embedded BiVelio verification key (it is running from source): install the published package (npm i -g @bivelio/savings-layer) or run pnpm build first.`
- `service-key-missing`:
  `BIVELIO_SERVICE_KEY is not set. The gateway needs two things and does not start without them: an active BiVelio subscription (https://savings.bivelio.com/dashboard/account) and its service key (bvk_..., created at https://savings.bivelio.com/dashboard/install, step 2). Export the key and relaunch: the license is collected with it automatically.`
- `service-key-malformed`:
  `BIVELIO_SERVICE_KEY does not look like a service key (service keys start with bvk_).` Con `keyLooksLikeLicense` se añade ` It looks like a license key: that one goes in BIVELIO_LICENSE_KEY.` Después, siempre: ` Create a service key at https://savings.bivelio.com/dashboard/install (step 2), export it and relaunch.`
- `service-key-not-recognised`:
  `BIVELIO_SERVICE_KEY is not recognised by savings.bivelio.com (HTTP 401): it was deleted or rotated, or it was copied incompletely. Create a new one at https://savings.bivelio.com/dashboard/install (step 2), export it and relaunch.`
- `no-license`:
  `your organization has no active BiVelio license, and the gateway does not start without one: there is no free tier. Subscribe at https://savings.bivelio.com/dashboard/account and relaunch; the license is collected automatically with your service key.`
- `license-expired`:
  `your BiVelio license expired on E and its grace period ended on G. Renew at https://savings.bivelio.com/dashboard/account and relaunch.` Con `cause` se añade ` (savings.bivelio.com could not be reached to look for a renewed license: <cause>)`.
- `license-invalid`, `tokenSource "BIVELIO_LICENSE_KEY"`, `shape "malformed"`:
  `BIVELIO_LICENSE_KEY is not a license key: a license key has three dot-separated parts and several hundred characters. Did you paste the bvk_ service key by mistake? That one goes in BIVELIO_SERVICE_KEY; the license key is the other value on https://savings.bivelio.com/dashboard/install. Or unset BIVELIO_LICENSE_KEY: the gateway collects the license online by itself.`
- `license-invalid`, `tokenSource "BIVELIO_LICENSE_KEY"`, `shape "token"`:
  `BIVELIO_LICENSE_KEY does not verify against this build's BiVelio key (<reason>). Copy the WHOLE key again from https://savings.bivelio.com/dashboard/install, or unset BIVELIO_LICENSE_KEY to collect it online; if it persists, update @bivelio/savings-layer or write to support@bivelio.com.`
- `license-invalid`, `tokenSource "savings.bivelio.com"`:
  `the license served by savings.bivelio.com does not verify against this build's BiVelio key (<reason>). Update @bivelio/savings-layer (npm i -g @bivelio/savings-layer); if it persists, write to support@bivelio.com.`
- `unreachable`:
  `could not collect your license from savings.bivelio.com (<cause>). The gateway does not start without a verified license. Check your connection and relaunch. If savings.bivelio.com is down, export BIVELIO_LICENSE_KEY=<your license key> (from https://savings.bivelio.com/dashboard/install) as a fallback: it is verified on this machine and used only when savings.bivelio.com cannot be reached, and it must be replaced by hand every billing period.`

Avisos de arranque (`warnings`):
- `ORG_MISMATCH`: `WARNING: BIVELIO_LICENSE_KEY belongs to a different organization than BIVELIO_SERVICE_KEY and is ignored; the license of the service key's organization is used. Unset BIVELIO_LICENSE_KEY or replace it with this organization's license key.`
- `ONLINE_NOT_VERIFYING`: `WARNING: the license served by savings.bivelio.com does not verify against this build's BiVelio key (<reason>); starting with BIVELIO_LICENSE_KEY. Update @bivelio/savings-layer (npm i -g @bivelio/savings-layer).`

`licenseLine(payload, source, status, cause?)`, con `PLAN = payload.plan.toUpperCase()` y `d = payload.grace_days`, `day(s)` según el número:
- `ORIGIN`:
  - online: `collected with your service key and verified on this machine`
  - offline con cause: `from BIVELIO_LICENSE_KEY, verified on this machine (savings.bivelio.com unreachable: <cause>)`
  - offline por not-verifying: `from BIVELIO_LICENSE_KEY, verified on this machine`
- active: `license: PLAN, active until E (+d days grace), ORIGIN`
- grace: `license: PLAN, IN GRACE: expired on E, keeps working until G. Renew at https://savings.bivelio.com/dashboard/account (ORIGIN)`

### 6.2 `gateway/license.ts`: 402 y transiciones

`refusalMessage(state)`:
- `expired`: `bvsala gateway: the BiVelio license for this organization has expired. New requests are refused until it is renewed at https://savings.bivelio.com/dashboard/account; requests already in flight were not interrupted.`
- `revoked`: `bvsala gateway: the BiVelio license for this organization is no longer active (revoked or cancelled). New requests are refused; requests already in flight were not interrupted. Check https://savings.bivelio.com/dashboard/account or write to support@bivelio.com.`
- `no-license`: `bvsala gateway: this organization has no active BiVelio license. New requests are refused until you subscribe at https://savings.bivelio.com/dashboard/account; requests already in flight were not interrupted.`
- `blocked`: `bvsala gateway: savings.bivelio.com reports the BiVelio license for this organization as not active. New requests are refused; requests already in flight were not interrupted. Check https://savings.bivelio.com/dashboard/account.`
- `invalid`: `bvsala gateway: the license loaded by this gateway no longer verifies. New requests are refused; requests already in flight were not interrupted. Relaunch the terminal; if it persists, write to support@bivelio.com.`

La forma `{type:"error", error:{type, status, message}}` sirve para los dos dialectos: Claude Code (Anthropic) y Codex (OpenAI) enseñan `error.message`. El 502 existente no se toca.

`transitionLine(from, to, payload)` (`CUT = {expired, revoked, no-license, blocked, invalid}`):
- `!to.serve && from !== to.state` → `[bvsala gateway] license ${to.state} (${to.detail}): new requests are refused with HTTP 402; requests in flight are not touched. ${REMEDY}`, con REMEDY:
  - expired → `Renew at https://savings.bivelio.com/dashboard/account`
  - revoked → `Check https://savings.bivelio.com/dashboard/account or write to support@bivelio.com`
  - no-license → `Subscribe at https://savings.bivelio.com/dashboard/account`
  - blocked → `Check https://savings.bivelio.com/dashboard/account`
  - invalid → `Relaunch the terminal; if it persists, write to support@bivelio.com`
- `to.serve && from ∈ CUT` → `[bvsala gateway] license ${to.state} again (expires E): serving new requests`
- `to.serve && to.state === "grace" && from !== "grace"` → `[bvsala gateway] license in grace: it expired on E and keeps working until G. Renew at https://savings.bivelio.com/dashboard/account`
- En cualquier otro caso → `null`. Nunca hay una línea por petición.

### 6.3 `LicenseRenewer`: avisos (`onWarning`, ASCII)

- `key-unknown`: `[bvsala gateway] license renewal: BIVELIO_SERVICE_KEY is no longer recognised (HTTP 401). This session keeps its current license until G; create a new key at https://savings.bivelio.com/dashboard/install and relaunch.`
- `no-license`: `[bvsala gateway] license renewal: savings.bivelio.com reports no active license for this organization (HTTP 404). This session keeps its current license until G; subscribe or renew at https://savings.bivelio.com/dashboard/account.`
- `not-verifying`: `[bvsala gateway] license renewal: the license served by savings.bivelio.com does not verify against this build's BiVelio key (<reason>); update @bivelio/savings-layer.`

Nota: si la licencia está revocada, el 402 corta aunque el aviso diga «keeps its current license until G». G es el techo por caducidad, no una garantía frente a revocaciones.

### 6.4 `gateway/bin.ts`

Imports nuevos: `EMBEDDED_PUBLIC_KEY` de `../src/license/index.js`; `resolveStartupLicense`, `LICENSE_SERVER_URL` de `./license.js`; `isChildInfoRequest` de `./argumentos.js`.

**Orden nuevo**, sin cambios hasta la línea 188 (doctor):

1. Tras el bloque doctor (188): **consulta al hijo sin gateway.**
   ```ts
   if (esEnvoltorio && isChildInfoRequest(resto)) await lanzarSinGateway(comando, resto); // Promise<never>
   ```
   `lanzarSinGateway`:
   - `bin = envoltorioDe(comando, 0, [], {}).bin`.
   - En win32, `resolverBinarioWindows(bin)`: `exe` → ruta; `solo-shim` → el mismo mensaje de bin.ts:349-352 y `process.exit(127)`.
   - `spawn(bin, resto, { stdio: "inherit" })` con el entorno heredado sin tocar.
   - `error` → `[bvsala ${comando}] could not launch \`${bin}\`: ${String(err)}. Is it installed and on the PATH?` y exit 127.
   - `exit` → `process.exit(code ?? (signal ? 1 : 0))`.
   - Devuelve `new Promise<never>(() => {})`.
2. **Verja de licencia** (antes de envoltorio, anillo 2 y cualquier lectura de fichero):
   ```ts
   const serviceAccountKey = process.env.BIVELIO_SERVICE_KEY?.trim() || undefined;
   const lic = await resolveStartupLicense({
     serviceAccountKey,
     licenseKey: process.env.BIVELIO_LICENSE_KEY,
     licenseServerUrl: LICENSE_SERVER_URL,
     publicKey: EMBEDDED_PUBLIC_KEY,
   });
   if (!lic.ok) { console.error(`[bvsala ${comando}] ${lic.message}`); process.exit(1); }
   ```
   La antigua lectura de bin.ts:201 se elimina y se usa esta `serviceAccountKey`, ya con trim.
3. En `arrancarGateway({...})` se añade:
   ```ts
   license: { token: lic.license.token, publicKey: EMBEDDED_PUBLIC_KEY, licenseServerUrl: LICENSE_SERVER_URL,
              checkOnStart: lic.source === "offline" },
   warn: (l) => console.error(l),
   ```
   `serviceAccountKey` va siempre, porque ya está garantizada.
4. Líneas de arranque, en este orden y con este texto exacto:
   - `[bvsala gateway] v${V} listening on http://127.0.0.1:${port} → ${upstream}`: sin cambio.
   - `(lic.lineIsWarning ? console.error : console.log)(\`[bvsala gateway] ${lic.line}\`)`
   - `for (const w of lic.warnings) console.error(\`[bvsala gateway] ${w}\`)`
   - `console.log("[bvsala gateway] metering: ON (service key present)")`, fijo.
   - Si `process.env.BVSALA_METERING_URL`: `console.error(\`[bvsala gateway] WARNING: BVSALA_METERING_URL=${url} redirects usage reporting away from savings.bivelio.com (development only): your dashboard will not see this usage. The license and the entitlements channel still use savings.bivelio.com.\`)`
   - Estados de palancas: igual que hoy, pero con `hayClave = true` (bin.ts:293, 301, 309).
5. Ayuda, con estas líneas nuevas o sustituidas:
   - 62-63, se añade una tercera línea: `                         Needs BIVELIO_SERVICE_KEY and an active BiVelio license.`
   - 65-66: `  codex [args…]          Run Codex CLI through the gateway (API key: api.openai.com;` / `                         ChatGPT auth: chatgpt.com/backend-api/codex, metered with no commission).`
   - 79-80: `  --help | -h            This help; also accepted after gateway, doctor or skill` / `                         (\`bvsala gateway --help\` starts nothing; \`bvsala claude --help\` or` / `                         \`--version\` go straight to the terminal, with no gateway).`
   - 84 sustituida y nueva 85:
     ```
       BIVELIO_SERVICE_KEY    Service key (bvk_…): REQUIRED. Identifies your organization, collects its
                              license (renewed by itself) and enables metering and seat identity.
       BIVELIO_LICENSE_KEY    License key (optional fallback): used only if savings.bivelio.com cannot be
                              reached at start; verified on this machine. Replace it every billing period.
     ```
   - 91, se añade una línea: `                         (The license check is not affected: the licence channel stays open.)`
   - 129 sustituida:
     ```
     The gateway is fail-closed, like the SDK: it starts only with BIVELIO_SERVICE_KEY and an active
     BiVelio license. It never interrupts a request in flight: if the license lapses, only NEW requests
     are refused (HTTP 402) until it is renewed. Metering is best-effort: with ingestion down, it
     forwards and warns. On a Claude or ChatGPT subscription there is no per-token invoice: that
     traffic is metered at list-price equivalent and never carries commission.
     ```
6. Comentario de cabecera (39-55): se añade que el arranque exige licencia (LICENSE §2).

### 6.5 `gateway/servidor.ts`

- Comentario 42-46: `AVISAR, NUNCA ROMPER LO QUE ESTÁ EN VUELO (decisión del dueño 2026-08-23, acotada el 2026-09-24 para cumplir LICENSE §2): ningún estado del METERING corta el tráfico; la LICENCIA verja el arranque (bin.ts) y cada petición NUEVA (402), y jamás una en curso. El candado de cobro sigue siendo el servidor (ingesta y canal), que es imparcheable.`
- `OpcionesGateway`, `GatewayArrancado` y `arrancarGateway` según §4.2. Al entrar: `if (!opts.license) throw new Error("arrancarGateway: a verified BiVelio license is required (LICENSE section 2)")`. Después: `const check = verifyGatewayLicense(opts.license.token, opts.license.publicKey); if (!check.ok) throw new Error(\`arrancarGateway: the license token does not verify (${check.reason})\`)`. Un token **caducado** sí se acepta, para poder probar el 402.
- Construcción, antes de `listen`: `revocation = new RevocationSnapshot()`, `live = buildLiveLicense(check.license, publicKey, revocation, now)`, canal según §5.3, `warn = opts.warn ?? ((l) => console.error(l))`.
- Construcción, **después** de `listen` (si `listen` falla no queda ningún timer):
  - Si hay `licenseServerUrl`: `poller = new RevocationPoller({ url: \`${base}/licenses/revocations\`, publicKeyPem: publicKey, snapshot: revocation, getRefreshAfter: () => live.gate.refreshAfter?.(), nowSeconds: () => Math.floor(now()/1000), fetchImpl: opts.fetchImpl, silenceWarnings: true, onEvent: (e) => { if (e.type === "rejected") logUnaVez(\`poller:${e.reason}\`, \`[gateway] revocation list rejected (${e.reason}); known revocations still apply\`) }, ...opts.license.revocations })` y `poller.start()`. Con `silenceWarnings: true` el aviso en castellano de poller.ts:233-238 nunca llega a la terminal del gateway, así que no depende del frente de textos.
  - Si hay `licenseServerUrl && serviceAccountKey`: `renewer = new LicenseRenewer({...; onAdopt, onWarning: warn; ...opts.license.renewal})` y `renewer.start({ checkNow: opts.license.checkOnStart === true })`.
- Verja por petición: §5.2.
- `leversArmed` en las cuatro palancas; `canalElision` se renombra a `canal`.
- `isSubscriptionTraffic` y `medir(…, subscription)`: §5.4.
- `cerrar()`: `renewer?.stop(); poller?.stop(); await emisor?.stopAndDrain(); await server.close(...)`.
- `licenseStatus()`: §4.2.
- Aviso sin clave (228-232): `[bvsala gateway] no BIVELIO_SERVICE_KEY: this in-process gateway forwards traffic but does not meter it (the bvsala CLI refuses to start without the key).`

### 6.6 `gateway/entitlements.ts`

Todo lo de §5.3. Cabecera 1-12 reescrita: «La pasarela verifica la LICENCIA por su cuenta (gateway/license.ts). Este canal responde a otras dos preguntas: qué features concede la org (fail-closed a apagado) y si el control plane la da por bloqueada (`reason`, pegajoso: solo lo pone o lo quita un 200)». Se quita la frase «no verifica licencias Ed25519 (no tiene la pública ni debe)».

`LINEA_401`: `[gateway] entitlements: BIVELIO_SERVICE_KEY is no longer recognised (HTTP 401): savings features disabled and usage is not being reported; create a new key at https://savings.bivelio.com/dashboard/install and relaunch`

### 6.7 `gateway/medidor.ts`

`isSubscriptionTraffic` según §4.4. En `construirInforme` se añade el parámetro `subscription = false` y `const acreditable = !coalescida && !subscription;`. `sobrecosteEvitado` y `ahorroHermano` pasan a exigir `acreditable` en lugar de `!coalescida`, y el resto queda igual. Se añade un comentario junto a 526-560: «Tráfico de suscripción: sin factura por tokens no hay nada contra lo que defender el ahorro; se aplica la palanca, no se acredita el dinero».

### 6.8 `gateway/argumentos.ts`

`isChildInfoRequest` = `rest.length === 1 && (rest[0] === "--help" || rest[0] === "-h" || rest[0] === "--version")`. `decidirArranque` no cambia.

### 6.9 `gateway/palanca.ts`, `hermano.ts`, `esfuerzo.ts`, `envoltorios.ts`, `doctor.ts`

- palanca.ts:196-200, rama `"0"`: `savings levers: OFF (BVSALA_GATEWAY_ELISION=0) - no TTL tuning and no context elision dials; the licence channel stays open for the license status`.
- hermano.ts:196: `sibling model routing: NOT ARMED - BVSALA_GATEWAY_ELISION=0 turns off the levers`.
- esfuerzo.ts:164: `per-turn effort: NOT ARMED - BVSALA_GATEWAY_ELISION=0 turns off the levers`.
- envoltorios.ts:168-170, nota chatgpt: `ChatGPT auth detected: the gateway routes to chatgpt.com/backend-api/codex. Subscription traffic is metered at list-price equivalent with no commission (there is no per-token invoice); the per-seat license applies as for any other use.`
- doctor.ts:
  - Cabecera (199-203): se añade tras la línea 2 `The gateway needs BIVELIO_SERVICE_KEY and an active BiVelio license in every mode: it collects the license with that key and does not start without one.` Sin `bvk_`, por la prohibición de test/gateway-doctor.test.ts:172.
  - 235-236: `third-party harness - Anthropic forbids it. Claude Code and Codex on a subscription are routed and metered at` / `list-price equivalent, with no commission (there is no per-token invoice); the per-seat license applies.`

### 6.10 Servidor web

- `apps/web/lib/metering/entitlement.ts:103-108`: `if (!tuvoLicencia) return { blocked: true, reason: "no-license" };`. Se reescribe el comentario 87-94: «Sin licencia válida ni suscripción que cubra → bloqueada. Una org que NUNCA tuvo licencia también: no hay free tier (README, LICENSE §1-2). Pilotos y probadores tienen siempre fila (trial/route.ts persiste fail-closed; el webhook emite con issueLicense), y una org con suscripción activa y la fila aún sin escribir no se bloquea (active-subscription)».
- `apps/web/app/api/metering/usage/route.ts:71`, `detail`: `This organization has no active BiVelio license or subscription. Subscribe or renew at https://savings.bivelio.com/dashboard/account`.
- `apps/web/app/api/org/entitlements/route.ts:7-24`: se documenta «`reason` presente ⇔ org bloqueada (la pasarela corta con cualquier `reason`)». No hay cambio de código: el `reason` sale de `decideEntitlement`.

### 6.11 Otros ficheros

- `.github/workflows/publish.yml`, tras la línea 92:
  ```yaml
            if ! grep -q "BEGIN PUBLIC KEY" package/dist/gateway/bin.js; then
              echo "::error::El gateway no lleva la clave pública embebida: bvsala no arrancaría con ninguna licencia."
              exit 1
            fi
  ```
- `scripts/simular-ci.sh`, tras la línea 53: `grep -q "BEGIN PUBLIC KEY" package/dist/gateway/bin.js || { echo "     FALLA: el gateway sin clave pública"; exit 1; }` y `echo "     ok  clave pública también en el gateway"`.
- `scripts/arnes-pasarela.mjs`:
  - Captura también stderr en `salida` y rechaza en `exit` con código ≠ 0 incluyendo esa salida.
  - Comentario de cabecera: «Desde 0.4.23 exige BIVELIO_SERVICE_KEY de una org con licencia y red a savings.bivelio.com, o BIVELIO_LICENSE_KEY si no hay red. OJO: con la clave exportada, el tráfico del arnés se mide en producción (ya pasaba).»
- `package.json` y `src/version.ts`: `0.4.23`.
- `tsup.config.ts`, `src/license/*`, `LICENSE`: **sin cambios**.

### 6.12 Copia pública

**README.md:67-76.** Se sustituye el párrafo entero que empieza por «**Claude Code, Codex CLI, Goose or Qwen Code with an API key?**» por:

> **Claude Code, Codex CLI, Goose or Qwen Code with an API key?** The package also ships a local measuring gateway: `bvsala claude` (or `bvsala codex`, `bvsala goose`, `bvsala qwen`) launches the terminal through it and your real spend shows up in your dashboard, token by token — nothing to configure, nothing persisted. For opencode, Crush, Droid, Cline or Kilo Code, `bvsala doctor` prints the exact config block for each one you have installed. Like the SDK, the gateway is fail‑closed: it starts only with your service key (`BIVELIO_SERVICE_KEY`) and an active BiVelio license, which it collects with that key and verifies against the key embedded in the package. Once running it never interrupts a request in flight: if the license lapses, only new requests are refused (HTTP 402) until it is renewed. It measures every request. With a PRO license it also applies one saving by default: it shortens the cache-write TTL while your session stays hot, which changes the price, never the content the model reads. The other levers (sibling model, per-turn effort) stay off until you switch them on. On a Claude or ChatGPT subscription there is no per-token invoice, so that traffic is metered at list-price equivalent and never carries commission; the per-seat license applies as for any other use.

Otros dos retoques en el README:
- Línea 109: `export BIVELIO_SERVICE_KEY=…   # service-account key: auto-renewal + seat metering (required by the gateway)`.
- Línea 278: `The license is a signed token your SDK and the gateway verify **offline**;` (el resto de la frase igual).

No se añade otra mención de `€4 / seat / month` (tiene que haber exactamente 2).

**docs/terminales/README.md** (viaja en npm):
- Líneas 10-15 («Qué es esto»), sustituidas por:
  > `bvsala gateway` es un proxy local medidor: escucha en `127.0.0.1`, reenvía cada petición **byte a byte** al proveedor (`https://api.anthropic.com` por defecto) y, una vez servida la respuesta, lee el `usage` del stream y lo convierte en coste. Tus prompts jamás salen de tu máquina hacia BiVelio — solo cuentas y coste. Es fail-closed como el SDK: arranca solo con tu clave de servicio (`BIVELIO_SERVICE_KEY`) y una licencia BiVelio activa, que recoge con esa clave y cuya firma verifica en tu máquina. Una vez arrancado, jamás corta una petición en curso: si la licencia caduca o se revoca, solo las peticiones NUEVAS reciben un HTTP 402 hasta renovarla. La medición es best-effort: con la ingesta caída, reenvía y avisa.
- Tras la línea 21, un párrafo nuevo: `En suscripción (login de claude.ai en Claude Code, cuenta ChatGPT en Codex) no hay factura por tokens: ese tráfico se mide a precio de lista equivalente y nunca se le acredita ahorro ni comisión; la licencia por asiento hace falta igual.` La línea 18 («TTL de escritura de caché») se conserva.
- 55: `export BIVELIO_SERVICE_KEY=bvk_…     # clave de servicio, desde tu panel. Obligatoria: sin ella el gateway no arranca`.
- 57: `--puerto 8500` pasa a `--port 8500`. [NB C2]
- 60-68 se sustituyen por:
  ````
  Al arrancar imprime, entre otras, estas líneas:

  ```
  [bvsala gateway] v0.4.23 listening on http://127.0.0.1:8402 → https://api.anthropic.com
  [bvsala gateway] license: PRO, active until 2026-10-24 (+14 days grace), collected with your service key and verified on this machine
  [bvsala gateway] metering: ON (service key present)
  ```

  Si no arranca (sale con código 1), el mensaje dice exactamente qué falta:

  | Mensaje | Qué pasa | Arreglo |
  |---|---|---|
  | `BIVELIO_SERVICE_KEY is not set` | falta la clave de servicio | créala en el panel (Instalar, paso 2), expórtala y relanza |
  | `BIVELIO_SERVICE_KEY is not recognised` | clave borrada, rotada o copiada a medias | crea otra |
  | `your organization has no active BiVelio license` | no hay suscripción | suscríbete en Cuenta y relanza |
  | `your BiVelio license expired on …` | licencia caducada y sin gracia | renueva en Cuenta |
  | `could not collect your license from savings.bivelio.com` | sin acceso a savings.bivelio.com | revisa la conexión; como respaldo, `BIVELIO_LICENSE_KEY` (se verifica sin red y se sustituye a mano cada período) |
  | un HTTP 402 en el terminal a mitad de sesión | la licencia caducó o se revocó con la sesión abierta | renueva; las peticiones que ya estaban en curso no se cortaron |

  Si lanzas `bvsala gateway` como servicio (launchd/systemd), un fallo de licencia queda en el log del servicio con código 1 y el terminal solo verá «connection refused»: mira ese log.
  ````
- Guías. En `claude-code.md:16`, `codex.md:16`, `goose.md:12`, `qwen-code.md:13`, `opencode.md:10`, `crush.md:13` y `droid.md:12`, la línea pasa a ser `` - `bvsala` instalado, `BIVELIO_SERVICE_KEY` exportada y una licencia BiVelio activa (la recoge el gateway con la clave; ver [README](README.md)). `` En `cline.md` y `kilo.md`, en «Qué necesitas», `` - `bvsala gateway` corriendo en `http://127.0.0.1:8402` (necesita `BIVELIO_SERVICE_KEY` y una licencia BiVelio activa; ver [README](README.md)). `` [NB C2]
- `claude-code.md:11-15`: se sustituye «pero ahí no hay factura por token que recortar» por «pero ahí no hay factura por token: el gateway lo mide a precio de lista equivalente y nunca le acredita ahorro ni comisión (la licencia por asiento hace falta igual)».
- `codex.md`:
  - 14-15: `suscripción ChatGPT (se enruta y se mide a precio de lista equivalente, **sin comisión**: no hay factura por tokens; la licencia por asiento hace falta igual; ver más abajo)`.
  - Título 95: `## Modo suscripción ChatGPT — validado, medido, sin comisión`.
  - 102: `este tráfico **no genera comisión**`.
  - 109-118, «Laguna conocida», se sustituye por: `**Comisión 0 por diseño (desde 0.4.23):** el gateway clasifica como suscripción el tráfico de \`/backend-api/…\` o con upstream chatgpt.com (y el de Claude Code con \`anthropic-beta: oauth-*\`) y no le acredita ahorro: \`baseline == actual\`. Laguna que queda: el registro no lleva etiqueta propia en el wire, así que el panel no distingue suscripción de API key (exige migración; fuera de este frente).`

**i18n ×12** (ca, de, en, es, fr, id, it, nl, pl, pt, tr, vi). Se dan EN y ES exactos. Los otros 10 idiomas los traduce el implementador desde EN, conservando etiquetas, `<code>`, URL, nombres de producto y sin añadir dígitos. «licencia activa» usa el término de licencia que ya emplea cada locale.

- `dashboard.installLicensePanel.gatewayNote`
  - EN: `<b>Coding terminal instead of an app?</b> The same package ships a local measuring gateway: <code>bvsala claude</code> launches Claude Code through it and this dashboard shows the spend, token by token. Also <code>bvsala codex</code>, <code>bvsala goose</code> and <code>bvsala qwen</code>; <code>bvsala doctor</code> prints the exact block for the rest. It uses the same service key from step 2 and collects your license by itself — like the SDK, it does not start without an active license.`
  - ES: `<b>¿Terminal de código en vez de una app?</b> El mismo paquete trae un gateway medidor local: <code>bvsala claude</code> lanza Claude Code a través de él y este panel enseña el gasto, token a token. También <code>bvsala codex</code>, <code>bvsala goose</code> y <code>bvsala qwen</code>; <code>bvsala doctor</code> imprime el bloque exacto del resto. Usa la misma clave de servicio del paso 2 y recoge tu licencia por sí solo — como el SDK, no arranca sin una licencia activa.`
- `landing.gateway.note` (se conserva «available / disponible» [NB C2])
  - EN: `The gateway measures every request and, like the SDK, runs only with an active license: it collects it with your service key and verifies its signature on your machine. With a PRO license it also applies one lever by default: it shortens the cache-write TTL while your session stays hot — that changes the price, never the content the model reads. The other levers stay off until you switch them on. The savings-mode skill is available for your caps, with its effect still to be measured. It also works with Codex CLI, Goose and Qwen Code — and bvsala doctor prints the exact configuration for the rest.`
  - ES: `El gateway mide cada petición y, como el SDK, solo funciona con una licencia activa: la recoge con tu clave de servicio y verifica su firma en tu máquina. Con licencia PRO aplica además una palanca por defecto: acorta el TTL de escritura de caché mientras la sesión sigue caliente — cambia el precio, nunca el contenido que lee el modelo. Las demás palancas van apagadas hasta que las enciendes. El skill savings-mode está disponible para tus topes, con su efecto pendiente de medir. Funciona también con Codex CLI, Goose y Qwen Code — y bvsala doctor imprime la configuración exacta del resto.`
- `howItWorks.caseCodeBody` (se retira «next phase», que ya era falso [NB C2])
  - EN: `On a subscription the fee is flat — but capped: the same skill installs with a single command and stretches the same weekly cap. With an API key there is a real token invoice — and the meter is already running: with your BiVelio license, “bvsala claude” launches Claude Code through the local gateway and your spend shows up in the panel, token by token, without touching a line of code. With PRO it also shortens the cache-write TTL while the session stays hot: a saving computed on your provider's own token count, never on an estimate.`
  - ES: `Con suscripción hay cuota fija — y topes: el mismo skill se instala con un solo comando y estira el mismo tope semanal. Con clave de API hay una factura por tokens real — y el medidor ya está en marcha: con tu licencia BiVelio, «bvsala claude» lanza Claude Code a través del gateway local y tu gasto aparece en el panel, token a token, sin tocar una línea de código. Con PRO acorta además el TTL de escritura de caché mientras la sesión sigue caliente: un ahorro calculado sobre el conteo de tokens de tu propio proveedor, nunca sobre una estimación.`
- `dashboard.projectorVerifier.onlyChatBody` (se retira la oferta del gateway a quien solo usa suscripción, por coherencia con README:60-65)
  - EN: `ChatGPT is truly closed: flat fee, no token invoice or cap worth trimming. But if you use Claude, we already help you save: the savings-mode skill (free, on the home page) stretches your subscription caps. And if you build an app with an API key, that is where BV-SALA measures and cuts real spend.`
  - ES: `ChatGPT sí es cerrado: cuota fija, sin factura ni topes por tokens que recortar. Pero si usas Claude, ya te ayudamos a ahorrar: el skill savings-mode (gratis, en la portada) estira tus topes de suscripción. Y si desarrollas una aplicación con clave de API, ahí BV-SALA mide y reduce el gasto de verdad.`
- `landing.skill.cxNota` [NB C2]
  - EN: se sustituye `…and under bvsala codex its effect is measured.` por `…and under bvsala codex (with a license) its effect is measured.`
  - ES: `…y bajo bvsala codex (con licencia) su efecto se mide.`
- `dashboard.installLicensePanel.step2`
  - EN: `<b>2 · Create & verify a service-account key</b> — a machine credential (<code>bvk_…</code>) that does two jobs: it reports counts-only usage (your seats & savings), and it lets the SDK and the gateway collect your <b>renewed license by themselves</b> every billing period. Separate from the license key; only its hash is stored. Create one, then <b>Test my key</b> to confirm it's live.`
  - ES: `<b>2 · Crea y verifica una clave de cuenta de servicio</b> — una credencial de máquina (<code>bvk_…</code>) que hace dos cosas: reporta uso de solo recuentos (tus asientos y ahorros) y permite que el SDK y el gateway recojan <b>por sí solos tu licencia renovada</b> en cada período de facturación. Es independiente de la clave de licencia; solo se almacena su hash. Crea una y luego pulsa <b>Probar mi clave</b> para confirmar que está activa.`
- Sin cambio: `landing.gateway.body`, `landing.gateway.title/eyebrow`, `howItWorks.caseCodeSub`, `howItWorks.s1Note`, `dashboard.sesiones.hint`, `landing.pricing.*`.

**Docs internas** (no viajan en npm):
- `docs/PLAN-S4-PALANCA.md:367` y `docs/PASARELA-F0.md:14`: se anota «acotado el 2026-09-24 a las peticiones en vuelo; la licencia verja el arranque y las peticiones nuevas».
- `docs/PLAN-PASARELA-API-KEY.md:181-185`: «comisión 0 por diseño desde 0.4.23; la etiqueta en el wire sigue pendiente».
- `docs/COMMERCIALIZATION-PLAN.md:148` («auto-downgrades to free tier»): «OBSOLETO: no hay free tier».

---

## 7 · Migraciones y cambio de servidor

- **No hay migración de esquema.** El único cambio de servidor es de lógica (`decideEntitlement`, §6.10).
- **Diagnóstico obligatorio antes de desplegar**, de solo lectura, lo ejecuta el dueño por la Management API según RUNBOOK-MIGRACIONES-PROD. Sin imprimir tokens (Regla 0c):
  ```sql
  -- A. Orgs con uso en 30 días, sin ninguna licencia y sin suscripción que cubra (lo que el cambio pasará a bloquear)
  select u.org_id, sum(u.requests) as peticiones_30d, max(u.day) as ultimo_dia
  from bvsala.usage_daily u
  where u.day >= current_date - 30
    and not exists (select 1 from bvsala.licenses l where l.org_id = u.org_id)
    and not exists (select 1 from bvsala.subscriptions s
                    where s.org_id = u.org_id
                      and s.status in ('active','trialing','past_due')
                      and (s.current_period_end is null or s.current_period_end > now() - interval '3 days'))
  group by u.org_id order by peticiones_30d desc;

  -- B. Licencias vivas: caducidad y existencia de token (NUNCA seleccionar la columna token)
  select org_id, plan, expires_at, grace_days, (token is not null) as tiene_token
  from bvsala.licenses where revoked = false order by expires_at;
  ```
  - **Go/no-go:** toda org de A que sea piloto, probador o cliente legítimo recibe su licencia antes del despliegue (vía trial de allow-list o checkout). A se vuelve a ejecutar hasta que solo queden orgs sin derecho.
  - B confirma que la org del dueño tiene una licencia con más de 14 días por delante. Si no, se reemite por la ruta de trial: 90 días + 3 de gracia y sin autorrenovación (trial/route.ts:24, 191).

---

## 8 · Tests

### 8.1 Nuevo `test/helpers/test-license.ts` (no es `.test.ts`; lo compila `typecheck` y lo usan los demás tests)

```ts
export const TEST_KEYS: { publicKey: string; privateKey: string };        // ed25519 spki/pkcs8 pem, uno por módulo
export function signLicense(payload: Record<string, unknown>, privateKey?: string,
  header?: Record<string, unknown>): string;                               // header por defecto {alg:"EdDSA",typ:"BVL",v:1}
export function signRevocationList(body: { seq: number; asOf: number; revoked: string[] }, privateKey?: string): string; // typ "BVSALA-REVOC", v:1
export function testPayload(over?: Record<string, unknown>, nowMs?: number): Record<string, unknown>;
// { jti:`lic-test-${n}`, org_id:"org-test", plan:"pro", seats:1,
//   features:["cache_ttl_tuning","sibling_model_routing","per_turn_effort","context_elision"],
//   issued_at: now/1000, expires_at: now/1000 + 30d, grace_days: 14, iss:"bivelio-test", ...over }
export function testLicense(over?: Record<string, unknown>, nowMs?: number): GatewayLicense; // { token, publicKey }
export function fakeGate(status: LicenseStatus): ResolvedGate;
export function mutableClock(startMs: number): { now: () => number; advance(ms: number): void };
```

### 8.2 Nuevo `test/gateway-license.test.ts` (unitario, sin servidores; `fetchImpl` = `vi.fn`)

**`resolveStartupLicense`** (`licenseServerUrl: "http://cp.test"`, `publicKey: TEST_KEYS.publicKey`):

1. `publicKey: ""` → `code "no-public-key"`; fetch no se llama.
2. `serviceAccountKey` `undefined` / `""` / `"   "` → `service-key-missing`. El mensaje contiene `BIVELIO_SERVICE_KEY is not set`, `https://savings.bivelio.com/dashboard/account` y `https://savings.bivelio.com/dashboard/install`. Fetch no se llama.
3. `"sk-ant-abc"` → `service-key-malformed` con `start with bvk_`. Con un token de licencia en la clave, el mensaje contiene `BIVELIO_LICENSE_KEY`. Fetch no se llama.
4. 200 con token activo → `ok`, `source "online"`, `status "active"`, `lineIsWarning false`. `line` contiene `license: PRO`, `active until ${isoDay}` y `collected with your service key`. Fetch llamado 1 vez a `http://cp.test/api/license/current` con `authorization: "Bearer bvk_test"` y `accept: "application/json"`.
5. 200 en gracia → `status "grace"`, `lineIsWarning true`; `line` contiene `IN GRACE` y `/dashboard/account`.
6. 200 caducado → `license-expired`, con las dos fechas YYYY-MM-DD y `/dashboard/account`.
7. 200 firmado por un atacante → `license-invalid`, con `does not verify` y `Update @bivelio/savings-layer`.
8. 200 cuyo «token» es una lista de revocaciones firmada con la clave de prueba → `license-invalid`, con `not a license token`.
9. 200 con `features: 5` en el payload → `license-invalid`, con `wrong field types`.
10. 200 sin `token` → `unreachable`, con `could not collect your license` y `BIVELIO_LICENSE_KEY`.
11. 401 → `service-key-not-recognised`, con `HTTP 401` y `/dashboard/install`.
12. 404 → `no-license`, con `no free tier` y `https://savings.bivelio.com/dashboard/account`.
13. 403, 501, 503, fetch que lanza `TypeError("fetch failed")`, y fetch que no resuelve pero respeta `init.signal` con `timeoutMs: 50` → `unreachable`. La causa respectiva es `HTTP 403`, `HTTP 501`, `HTTP 503`, `network error` y `timed out`.
14. Offline válido + online 200 misma org → `source "online"`, `warnings` vacío.
15. Offline válido + online 200 de otra org → `source "online"`, `warnings[0]` contiene `different organization`.
16. Offline válido + online inalcanzable → `source "offline"`, `lineIsWarning true`, `line` con `from BIVELIO_LICENSE_KEY` y la causa.
17. Offline válido, sin `timeoutMs`, fetch colgado, `vi.useFakeTimers()`: a los 2 999 ms no ha resuelto; a los 3 000 ms resuelve `offline`. Sin offline, lo mismo a los 10 000 ms resuelve `unreachable`.
18. Offline válido + online 404 → `no-license`. Offline válido + online 401 → `service-key-not-recognised`.
19. Offline caducado + online inalcanzable → `license-expired` con las fechas del offline y `could not be reached` más la causa.
20. Offline caducado + online 200 activo → `ok online`.
21. Offline `"bvk_abc"` → `license-invalid` con `Did you paste the bvk_`; fetch NO se llama.
22. Offline firmado por un atacante → `license-invalid` con `does not verify against this build`; fetch NO se llama.
23. Offline con `"\n"` detrás, entre comillas o con `"Bearer "` delante + online inalcanzable → `ok offline`.
24. Offline `""` / `"   "` → se trata como ausente (el timeout efectivo es 10 000).
25. Offline válido + online 200 que no verifica → `ok offline`, `warnings[0]` con `does not verify`.
26. En TODOS los casos, ni `message`, ni `line`, ni `warnings` contienen el valor de la `bvk_` ni el del token.
27. Todos los `message`, `line` y `warnings` cumplen `/^[\x20-\x7E]+$/` y no casan `/[áéíóúüñ¿¡]/i`.

**`licenseVerdict`** (tabla §5.2 completa con `fakeGate`): los 25 cruces de la tabla, más `blockReason ""` que se trata como null.

**`refusalBody`**: para cada estado, `JSON.parse` da `type "error"`, `error.type "license_error"` y `error.status === state`. `error.message` contiene `requests already in flight were not interrupted`, y además `/dashboard/account` (salvo `invalid`, que lleva `support@bivelio.com`). ASCII.

**`transitionLine`**:
- (active → expired) da una línea con `license expired` y `requests in flight are not touched`.
- (expired → expired) → null.
- (expired → active) contiene `again`.
- (active → grace) contiene `in grace`.
- (grace → grace) → null.
- (null → active) → null.
- (null → expired) da una línea.

**`LicenseRenewer`** (fetch `vi.fn`, reloj inyectado):
- Lejos de la caducidad y concediendo: `check()` no llama a fetch; `check({force:true})` sí.
- Dentro de la antelación: adopta uno más nuevo de la misma org. NO adopta el mismo jti, ni uno cuyo jti está en `revocation`, ni uno caducado.
- SÍ adopta uno de otra org (el de la clave manda).
- SÍ adopta uno no más nuevo si el actual está revocado en el snapshot.
- 401 repetido 3 veces → `onWarning` 1 vez con `no longer recognised`. 404 → 1 vez con `no active license`. Inalcanzable → 0 avisos.
- `stop()` durante una recogida en vuelo: el fetch recibe abort y no se adopta nada.
- `start({checkNow:true})` llama a fetch de inmediato aunque falte mucho para la caducidad.

**`isSubscriptionTraffic`**:
- `("/v1/messages","oauth-2025-04-20,claude-code-20250219","https://api.anthropic.com")` → true.
- `(" x , oauth-2026-01-01")` → true.
- `("claude-code-20250219")` → false.
- `(undefined)` → false.
- `("xoauth-1")` → false.
- `("/backend-api/codex/responses", undefined, "https://chatgpt.com")` → true.
- `("/v1/responses", undefined, "https://api.openai.com")` → false.
- `("/v1/responses", undefined, "https://chatgpt.com")` → true.

### 8.3 Nuevo `test/gateway-license-live.test.ts` (en proceso, servidores `node:http` reales en 127.0.0.1:0)

La plataforma falsa sirve:
- `GET /api/org/entitlements` → `{features, refreshAfterSeconds:300, reason?}`, configurable y mutable. `estado` puede forzar 500.
- `GET /api/license/current` → exige `authorization: Bearer bvk_test`; `{token}` configurable, o 401/404.
- `GET /licenses/revocations` → `{list: signRevocationList(...)}`.
- `POST /api/metering/usage` → 202 y captura lotes.

Los upstreams son un SSE rápido y uno lento controlado por promesa.

- **L1.** `arrancarGateway({ …sin license })` rechaza con `a verified BiVelio license is required`. Con un token de otra clave, rechaza con `does not verify`.
- **L2.** Licencia caducada más allá de la gracia desde el inicio:
  - `POST /v1/messages` → 402, `content-type application/json`, `x-bvsala-license-status: expired`, `body.type "error"`, `body.error.type "license_error"`, message con `/dashboard/account`.
  - El upstream recibe **0** peticiones.
  - `HEAD /api/hello` → 402 con cuerpo vacío. `GET /v1/models` → 402.
- **L3. Una petición en curso no se corta.** `mutableClock(t0)`, licencia con `expires_at = t0/1000+60` y `grace_days: 0`, `warn` a un array. La petición arranca; el cliente lee el primer chunk (`message_start`); el test hace `advance(120_000)` y libera el upstream. La respuesta llega con 200 y el texto íntegro igual al SSE completo. La **siguiente** petición recibe 402 `expired`. `warn` tiene exactamente 1 línea, con `license expired` y `requests in flight are not touched`.
- **L4.** Tres peticiones cortadas seguidas producen 1 sola línea de `warn`.
- **L5.** De activa a gracia (avance del reloj): la petición sirve 200 y `warn` gana 1 línea con `in grace`. Una segunda petición no añade nada.
- **L6. La renovación cura.** Arranque caducado con `licenseServerUrl` = plataforma, `/api/license/current` sirviendo un token nuevo y `serviceAccountKey "bvk_test"`. La 1.ª petición da 402 y dispara el check forzado. `esperar(() => gw.licenseStatus() === "active")`. La siguiente da 200 y `warn` contiene `license active again`.
- **L7. Canal con reason pegajoso.** `serviceAccountKey`, `meteringUrl` a la plataforma, `entitlementsTtlMs: 50`, reason `"license-revoked"`. Se espera hasta que una petición dé 402 `revoked`. La plataforma pasa a 500 durante ≥ 2 TTL y sigue dando 402. Pasa a 200 sin reason y, tras el refresco, da 200.
- **L8.** Lo mismo que L7 con `POST /v1/responses`, sin ninguna petición a `/v1/messages`: 402 tras el refresco. [C1-1]
- **L9.** `elision: false` con reason `"license-expired"` → 402 `expired`. [C1-2] Con reason ausente y features `cache_ttl_tuning`, el cuerpo 1h viaja **intacto** (palancas desarmadas).
- **L10. Revocación por jti.** `/licenses/revocations` lista el jti vigente; `revocations: { floorSeconds: 0.05, pollIntervalSeconds: 0.05, jitterRatio: 0 }`; `/api/license/current` responde 404. Tras el primer sondeo la petición da 402 `revoked` y `warn` contiene `license revoked`.
- **L10b.** Igual, pero `/api/license/current` sirve un token nuevo no revocado de la misma org: se cura a 200.
- **L11.** Sin `licenseServerUrl`, con un `fetchImpl` espía que registra URLs: no hay ninguna llamada a `/api/license/current` ni a `/licenses/revocations`.
- **L12.** Canal con 401: el `log` contiene `no longer recognised` 1 sola vez y las peticiones siguen dando 200.
- **L13.** Reason `"no-license"` → 402 `no-license`, message con `no active BiVelio license`.

### 8.4 Tests existentes que cambian

- **Los 36 arranques** (servidor 24, coalescencia 5, sombra-vivo 3, promesas 2, `gatewayCon` de palanca y de hermano): se añade `license: testLicense()`. Es un cambio mecánico, sin tocar aserciones.
- `test/gateway-servidor.test.ts`:
  - 249: el título pasa a «con licencia y SIN clave de servicio (solo en proceso): mismo passthrough, cero metering (la licencia verja; el metering es best-effort)».
  - 701: el título pasa a «⛔ con licencia y sin clave (en proceso), una petición en streaming… deja SU línea en el log». Se conserva `not metered: no BIVELIO_SERVICE_KEY`.
- `test/gateway-palanca.test.ts`:
  - 495: `expect(describirEstadoDeElision("0", true).linea).toMatch(/levers OFF \(BVSALA_GATEWAY_ELISION=0\).*no TTL tuning and no context elision dials/)` y `.not.toMatch(/licence channel: CLOSED/)`.
  - Nuevos en el bloque «CanalDeEntitlements» (fetch falso):
    - `blockReason()` es null al inicio; tras un 200 con `reason` devuelve ese reason; tras un 200 sin reason, null.
    - Bloqueado y después un fetch que lanza: sigue el reason.
    - Con TTL vencido, `blockReason()` hace un fetch nuevo **sin** llamar a `tiene()`.
    - Con 401, el log recibe una línea con `no longer recognised` y `tiene("context_elision")` es false.
  - Nuevo e2e: con la beta oauth y la rebaja de TTL, el upstream recibe el TTL `5m`, y en el lote `baselineCost === actualCost` y `netSavings === 0`. Si hace falta, se amplía `arrancarUpstreamFalso` con un usage que lleve `cache_creation.ephemeral_5m_input_tokens > 0`.
- `test/gateway-hermano.test.ts`:
  - Nuevo e2e junto a «MEDIDA»: igual pero con `{ "anthropic-beta": "oauth-2025-04-20" }`. `recibidas[0]` lleva el modelo `SERVIDO`; el registro lleva `model SERVIDO`, `basis "measured"`, `baselineCost === actualCost` y `netSavings 0`.
  - Unitario: `informeMedido("r", SERVIDO, medido, undefined, null, null, cambio, true)` da `baselineEstimate === actual`.
  - Título de la 442: «BVSALA_GATEWAY_ELISION=0 (palancas desarmadas) apaga también C».
- `test/gateway-tarifa.test.ts`: unitario, `informeMedido(..., rebaja{rebajadas:1,yaEran5m:0}, null, true)` da `netSavings 0` y `baseline === actual`.
- `test/gateway-envoltorios.test.ts:56`: `expect(e.nota).toContain("no commission")`; `expect(e.nota).not.toContain("not billed")`.
- `test/gateway-doctor.test.ts`: `texto` contiene `active BiVelio license` y `no commission`, y no contiene `but not billed`. La línea 172 sigue en verde.
- `test/gateway-argumentos.test.ts`, nuevo describe de `isChildInfoRequest`:
  - `["--help"]`, `["-h"]`, `["--version"]` → true.
  - `["-v"]`, `["help"]`, `["version"]`, `["--help","x"]`, `["-p","hola"]`, `[]` → false.
  - La 49-56 de `decidirArranque` no cambia.
- `test/sala-limpia-del-tarball.test.ts`, nuevo describe «el binario del gateway publicado» sobre el `package/` ya extraído. Se usa `spawnSync(process.execPath, …, { env, encoding:"utf8", timeout: 30_000 })`:
  - (a) `package/dist/gateway/bin.js` contiene `BEGIN PUBLIC KEY`.
  - (b) `bin.js gateway --port 0` con `ENTORNO_LIMPIO` → status 1; stderr con `BIVELIO_SERVICE_KEY is not set` y `/dashboard/account`.
  - (c) Envoltorio `.mjs` que hace `globalThis.fetch = () => { throw new Error("[sala-limpia] la red esta prohibida en este test") }`, fija `process.argv = [execPath, bin, "gateway", "--port", "0"]` e importa `bin.js`, con `{PATH, BIVELIO_SERVICE_KEY: "bvk_x"}` → status 1; stderr con `could not collect your license` y `BIVELIO_LICENSE_KEY`, sin `bvk_x`.
  - (d) `{PATH, BIVELIO_SERVICE_KEY:"bvk_x", BIVELIO_LICENSE_KEY:"bvk_y"}` → status 1; stderr con `Did you paste the bvk_`.
  - (e) `bin.js --version` → status 0 y stdout `0.4.23`. `bin.js doctor` → status 0.
  - (f) `bin.js claude --version` con `ENTORNO_LIMPIO`: stderr NO contiene `BIVELIO_SERVICE_KEY`, y el status es 0 (claude instalado) o 127 (no instalado).
  - (g) El bundle no contiene `BVSALA_DEV_OPEN` ni `devUnlicensed`.
- `apps/web/lib/metering/entitlement.test.ts`:
  - 63-68, con el título «una org SIN NINGUNA licencia ni suscripción SE BLOQUEA (no hay free tier)»: `blocked true`, `reason "no-license"`.
  - 104-107: comentario actualizado.
  - Nuevo: `decideEntitlement([], [sub()], AHORA)` da `blocked false`, `reason "active-subscription"`.
- `apps/web/app/api/org-entitlements.test.ts`:
  - Nuevo: sin licencias ni suscripciones → 200, `features []`, `reason "no-license"`.
  - Nuevo: org viva → `"reason" in json === false` (contrato reason ⇔ bloqueada).
- `apps/web/app/api/metering/usage/route.test.ts`: el mock devuelve para `"licenses"` una fila viva `[{ revoked:false, expires_at:"2099-01-01T00:00:00Z", grace_days:14 }]`. Nuevo test: licencias y suscripciones vacías → 402 con `reason "no-license"` y detail con `/dashboard/account`.
- `apps/web/lib/readme-alineado.test.ts` [NB C2: la guarda sobre el README no protegía nada]:
  - README: `toMatch(/active BiVelio license/)`, `toMatch(/only new requests are refused/)`, `toMatch(/never carries commission/)`.
  - Terminales: `toMatch(/licencia BiVelio activa/)` y `not.toMatch(/Nunca corta el tráfico: sin clave/)`.
  - Se conservan `cache-write TTL` y `TTL de escritura de caché`.
- Nuevo `apps/web/messages/gateway-license.test.ts` (mismo cargador que parity.test.ts):
  - Para los 6 cambios (gatewayNote, landing.gateway.note, caseCodeBody, onlyChatBody, cxNota, step2), cada locale distinto de `en` tiene un valor **distinto** del de `en`, para cazar lo que quedó sin traducir.
  - `en` gatewayNote: no casa `/needs no license/i` y casa `/active license/`.
  - `es` gatewayNote: no casa `/no hace falta clave de licencia/` y casa `/licencia activa/`.
  - `onlyChatBody` no contiene `bvsala claude` en ningún locale.
  - `caseCodeBody`: `en` no contiene `next phase`; `es` no contiene `siguiente fase`.
- Sin cambio: `parity.test.ts` (mismas claves, mismos `<b>`/`<code>`), `claves-usadas`, `tarifa-en-parametros`, `superficie-publica-limpia` (no cambia nada de `src/`), `no-solape-gateway-pipeline` (solo se importa `../src/license`), `version-declarada` (se sube a la par).

---

## 9 · Orden de despliegue

Todo por rama y PR, nunca en `main`.

0. **Dueño (solo lectura):** diagnóstico A y B de §7.
   - Si A lista orgs legítimas, reciben licencia antes de seguir. Las demás son el free tier que se cierra; opcionalmente se les escribe con enlace a Cuenta.
   - Si la licencia del dueño caduca en < 14 días, se reemite.
1. **PR-1 · web servidor:** `entitlement.ts`, detail de la ingesta, comentario de `org/entitlements`, tests (§8.4 web). Merge y Vercel prod. Efecto inmediato: las orgs sin licencia reciben 402 en la ingesta y `reason: no-license` en el canal. Los gateways ≤ 0.4.22 siguen haciendo de proxy, pero no reportan ni arman palancas: un passthrough sin valor.
2. **PR-2 · npm 0.4.23:** todo `gateway/*`, tests, README, `docs/terminales/*`, publish.yml, simular-ci.sh, arnes-pasarela.mjs, versión y docs internas. CI (`build:all → test`) verde, merge, tag `v0.4.23` y publish. `scripts/simular-ci.sh` antes del merge.
3. **PR-3 · web i18n ×12** más `messages/gateway-license.test.ts`: se hace merge **después** de que `npm view @bivelio/savings-layer version` devuelva `0.4.23` [NB C2], para que el panel no prometa «no arranca sin licencia» encima de un `npm i -g` que instala la 0.4.22.
4. **Casa:** `npm i -g @bivelio/savings-layer@0.4.23` (el global es 0.4.19).
   - `BIVELIO_SERVICE_KEY` exportada en TODOS los caminos de arranque (app, IDE, `command bvsala claude`). Sin ella, `bvsala` se niega a arrancar; ya no corre «control en silencio».
   - Comprobar que `bvsala claude` imprime `license: PRO, active until …`.
   - El arnés (`scripts/arnes-pasarela.mjs`) necesita la clave más red, o `BIVELIO_LICENSE_KEY`.
   - `anillo2-ab.zsh:198` no cambia: `--version|-v|--help|-h|mcp|update` pasan por `command bvsala claude`. `--help`, `-h` y `--version` van directos al hijo; `-v`, `mcp` y `update` pasan por la verja, que el dueño cumple.
5. **Probadores con cupón:** tienen fila con token (issue.ts:107-120). Correo con el cambio de comportamiento: antes, sin clave reenviaba; ahora no arranca. Tienen que exportar la `bvk_` que ya usan.

---

## 10 · Impacto en ingresos (corregido)

- **Cuota por asiento:** pasa de incobrable a exigible en el producto de terminal. El cierre lo da **el servidor** (PR-1): ninguna org sin licencia ni suscripción ingiere uso ni recibe features, sea cual sea la versión del binario, parcheado o no. La verja del gateway (PR-2) aporta cumplimiento del §2 y UX (mensajes exactos), no seguridad de cobro. La cuantía sale del diagnóstico A (número de orgs que hoy miden gratis); no se puede derivar del repo. Con 4 licencias PRO vivas al 12-09, el delta directo a corto plazo es de decenas de euros al mes. El valor es estructural: en el «cliente de agente» (bitácora 10-09) el asiento ES el ingreso.
- **Comisión:** 0 € de delta hacia arriba. Hacia abajo, deja de acreditarse ahorro en tráfico de suscripción. Hoy afecta, en la práctica, a pilotos internos y a probadores exentos (0028), así que ≈ 0 €. Evita a futuro cobrar sobre diferencias de precio de lista que ninguna factura del cliente puede defender. No se puede cuantificar desde BD porque el wire no etiqueta la auth.
- **Coste:** una llamada de ≤ 10 s al arrancar (normalmente ~300 ms; ≤ 3 s con respaldo offline), más dos llamadas de fondo (canal y revocaciones). Durante una caída del control plane no se pueden abrir sesiones nuevas si no se exportó `BIVELIO_LICENSE_KEY`; las vivas no se enteran. Esto afecta a soporte, no a ingresos.

---

## 11 · Riesgos residuales y alternativas rechazadas

**Riesgos residuales:**
1. **Caída del control plane:** las sesiones nuevas fallan (exit 1) sin `BIVELIO_LICENSE_KEY`. Es la letra del §2. Mitigación: el mensaje explica el respaldo y la línea de arranque dice siempre de dónde salió la licencia.
2. **Binario parcheado o ≤ 0.4.22:** la verja local se salta. El servidor sigue siendo el candado: sin licencia no hay panel, ni ingesta, ni features. Queda un proxy que no mide.
3. **Reloj local atrasado:** el gate usa `Date.now()`. Con el control plane alcanzable, el canal corta con la hora del **servidor** (`license-expired`, ≤ 300 s). Sin control plane no hay features ni panel. Se rechaza el suelo con cabeceras `date` [NB C1] porque no aporta protección real.
4. **Cota de abuso con salida bloqueada** (corregida [NB C1]): hasta `expires_at + grace_days`, que en el plan anual son hasta 365 + 14 días. Con la salida bloqueada no hay ingesta ni canal, así que el gateway es un passthrough sin palancas ni panel, sin valor frente a llamar al proveedor directamente. Bloquear selectivamente con MITM TLS solo `/licenses/revocations` deja vivo un jti revocado en procesos ya arrancados si la org sigue cubierta (paga), y el canal corta a toda org sin derecho.
5. **Clave `bvk_` borrada con el proceso vivo:** no corta (§5.2). El metering se para de inmediato (401) y el siguiente arranque falla.
6. **El tráfico de suscripción no lleva etiqueta en el wire:** el panel no lo distingue y diluye el % medido. Queda para otro frente: migración + RPC + lista blanca, siempre servidor primero.
7. **Las palancas siguen reescribiendo tráfico OAuth** (rebaja de TTL, hermano opt-in). Ya pasaba antes de este frente. PLAN-PASARELA-API-KEY.md:33 apoya la defensa ToS en «no reescribir». La decisión es del dueño y no se toma aquí.
8. **Licencias piloto de 90 d + 3 sin autorrenovación:** a la caducidad + 3 días, las peticiones nuevas reciben 402 hasta que se reemita. El renovador recoge la reemitida sola (cada hora dentro de los 7 días de antelación, o ≤ 1 min tras el corte).
9. **`doctor`, `skill`, `--help` y `--version` funcionan sin licencia:** es decisión de producto publicada (skill gratis, onlyChatBody), no usan el servicio ni la red, y el skill se publica también en la portada. La letra del §2 «does not operate without one» queda para revisión legal si el dueño lo quiere.
10. **Tests e2e con puertos reales y tiempos** (esperar ≤ 3 s, TTL de 50 ms): son sensibles a máquinas lentas. Se esperan condiciones con `esperar()`, nunca `sleep` fijos.
11. **`reason: license-revoked` cuando alguna fila se revocó alguna vez** (entitlement.ts:109-112), aunque la causa sea la caducidad: el 402 `revoked` dice «revoked or cancelled», que es neutro.

**Alternativas rechazadas:**
- **`maxStalenessSeconds` en el gateway:** cortaría a clientes al día por una caída NUESTRA de > 72 h (create.ts:18-29), y lo que protege (salida bloqueada) ya no tiene valor para el atacante (riesgo 4).
- **Reutilizar `LicenseRefresher`:** su adopción monotónica y de la misma org impide curar tras una revocación y corregir un arranque offline con un token ajeno; no tiene «forzar»; su aviso habla en vocabulario del SDK (§4.1).
- **`BIVELIO_LICENSE_KEY` activo sin llamada de red:** era el hueco C1-4.
- **Cachear el último token en disco** (`~/.bvsala`): sería una credencial nueva en reposo; la `bvk_` ya permite recuperarlo y existe el respaldo por variable.
- **Exigir licencia para acuñar una `bvk_`** (service-accounts/route.ts:59-61): no cierra nada que el servidor no cierre ya y rompe el orden «clave primero, suscripción después». Queda como opción futura.
- **Features desde el token:** los tokens son inmutables y las filas se rellenaron en 0023/0026/0027; se apagaría `cache_ttl_tuning` en silencio en las anuales.
- **Eximir de licencia el modo suscripción:** sería un free tier con otro nombre.
- **`BVSALA_METERING_URL` redirigiendo licencia y canal:** una plataforma falsa concedería features (palancas gratis) con cualquier token válido.
- **Consulta de licencia por red en cada petición:** mete red en el camino caliente.
- **Tocar la LICENSE:** no aporta y abre revisión legal.

---

## 12 · Criterios de aceptación

- `pnpm run build:all && pnpm test && pnpm --dir apps/web run typecheck && pnpm --dir apps/web run build` en verde. `scripts/simular-ci.sh` en verde, incluida la nueva comprobación de clave pública en `dist/gateway/bin.js`.
- En una máquina limpia:
  - `bvsala claude` sin clave: exit 1 con el mensaje de §6.1.
  - Con clave de una org sin licencia: exit 1 con `no-license`.
  - Con licencia: la línea `license: PRO, active until …`.
- Con la licencia caducando a mitad de sesión: el turno en curso termina; el siguiente recibe un 402 que Claude Code enseña con `error.message`; en stderr sale una sola línea de transición.
- Con `anthropic-beta: oauth-*`: los registros llevan `baselineCost === actualCost`.
- El diagnóstico A, repetido tras PR-1, lista solo orgs sin derecho, y `/api/metering/usage` les responde 402.