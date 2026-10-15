import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Un runtime de middleware de Caveman FALSO, para los tests de D05/D09: un
 * `node:http` en 127.0.0.1 que habla el protocolo 1.1 lo justo (capabilities,
 * optimize, retrieve, sessions/delete) y deja torcer cada respuesta.
 *
 * Por defecto se porta como el de verdad: sustituye cada tool_result por el
 * prefijo de recuperación + los primeros 16 caracteres, guarda el original bajo
 * un handle `cmw_` de 24 bytes aleatorios y lo devuelve por páginas sin partir
 * un carácter UTF-8. NO es Caveman ni deriva de su código: es un doble de test
 * escrito contra la especificación publicada.
 */

export interface RespuestaFalsa {
  status?: number;
  /** Texto crudo (para JSON roto, UTF-8 inválido…) o un objeto que se serializa. */
  cuerpo?: string | Buffer | object;
  demoraMs?: number;
  cabeceras?: Record<string, string>;
}

export interface PeticionRecibida {
  metodo: string;
  ruta: string;
  cabeceras: IncomingMessage["headers"];
  cuerpo: any;
  bytes: number;
}

const sha = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex");
const PREFIJO = (h: string) => `[caveman: shortened; exact original via caveman_retrieve handle=${h}]\n`;

export class SidecarFalso {
  private server: Server | null = null;
  port = 0;
  readonly peticiones: PeticionRecibida[] = [];
  runtimeBuild = "4.0.1";
  transforms: object[] = [
    {
      transform_id: "caveman.json",
      implementation_version: "1",
      safety_classes: ["S2"],
      deterministic: true,
      recovery: "exact_ccr",
      eligible_segment_kinds: ["tool_result"],
      requires_eval: false,
      not_smaller_fallback: "original",
      provenance: { kind: "native", source_manifest_sha256: null },
      conformance_digest: "0".repeat(64),
    },
  ];
  limites: Record<string, number> = {
    deadline_ms: 500,
    request_bytes: 64 * 1024 * 1024,
    segment_bytes: 4 * 1024 * 1024,
    page_bytes: 262_144,
  };
  /** handle → original y ámbito (JSON). */
  readonly originales = new Map<string, { texto: string; ambito: string; sha256: string }>();
  /** Si se define, decide la respuesta de cada ruta; `defecto()` da la del runtime «bueno». */
  alOptimizar?: (cuerpo: any, defecto: () => object) => RespuestaFalsa | Promise<RespuestaFalsa>;
  alRecuperar?: (cuerpo: any, defecto: () => RespuestaFalsa) => RespuestaFalsa | Promise<RespuestaFalsa>;
  alCapacidades?: (defecto: () => object) => RespuestaFalsa | Promise<RespuestaFalsa>;
  /** Con `retener`, cada optimize espera a `soltarUno()`. */
  retener = false;
  private retenidos: (() => void)[] = [];
  /** Llamadas a optimize que han llegado (incluidas las retenidas). */
  get optimizaciones(): PeticionRecibida[] {
    return this.peticiones.filter((p) => p.ruta.endsWith("/optimize"));
  }

  get endpoint(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async iniciar(): Promise<this> {
    this.server = createServer((req, res) => void this.atender(req, res));
    await new Promise<void>((r) => this.server!.listen(0, "127.0.0.1", () => r()));
    this.port = (this.server!.address() as AddressInfo).port;
    return this;
  }

  async cerrar(): Promise<void> {
    for (const r of this.retenidos.splice(0)) r();
    this.server?.closeAllConnections?.();
    await new Promise<void>((r) => this.server?.close(() => r()) ?? r());
  }

  soltarUno(): boolean {
    const r = this.retenidos.shift();
    r?.();
    return !!r;
  }

  get retenidosAhora(): number {
    return this.retenidos.length;
  }

  /** Lo que haría el runtime bueno con un cuerpo de optimize. */
  planPorDefecto(cuerpo: any): object {
    const replacements: object[] = [];
    const skipped: object[] = [];
    let antes = 0;
    let despues = 0;
    for (const s of cuerpo.segments as any[]) {
      const h = "cmw_" + randomBytes(24).toString("hex");
      const texto = PREFIJO(h) + String(s.content).slice(0, 16) + "…";
      antes += s.content.length;
      if (cuerpo.mode !== "compress" || Buffer.byteLength(texto) >= Buffer.byteLength(s.content)) {
        skipped.push({ segment_id: s.id, reason: cuerpo.mode === "compress" ? "not_smaller" : "record" });
        despues += s.content.length;
        continue;
      }
      this.originales.set(h, { texto: s.content, ambito: JSON.stringify(cuerpo.scope), sha256: s.sha256 });
      despues += texto.length;
      replacements.push({
        segment_id: s.id,
        source_id: s.source_id,
        original_sha256: s.sha256,
        text: texto,
        sha256: sha(texto),
        transform_id: cuerpo.policy.transforms[0],
        transform_version: "1",
        recovery_handle: h,
        tokens_before: Math.ceil(s.content.length / 4),
        tokens_after: Math.ceil(texto.length / 4),
        reused: false,
        unique_original: true,
      });
    }
    return {
      schema_version: 1,
      request_id: cuerpo.request_id,
      input_digest: "a".repeat(64),
      runtime_build: this.runtimeBuild,
      policy_revision: "rev-1",
      replacement_set_id: "b".repeat(64),
      status: cuerpo.mode !== "compress" ? "record" : replacements.length ? "optimized" : "bypassed",
      reason: cuerpo.mode !== "compress" ? "record" : replacements.length ? "eligible" : "not_smaller",
      replacements,
      skipped,
      measurement: {
        basis: "inferred",
        tokenizer: "o200k_base",
        scope: "segment",
        tokens_before: Math.ceil(antes / 4),
        tokens_after: Math.ceil(despues / 4),
        unique_tokens_reduced: 0,
        recovery_overhead_tokens: 12,
        overhead_coverage: "segment_and_declared_recovery_tool",
        verified_saved_usd: 0,
      },
      stability: { native: "persistent_choices", provider_bytes: "unobserved", provider_cache_hits: "unobserved" },
      recovery: { binding_id: "x", available: true, persistent: true, expires_at: 0 },
    };
  }

  /** Página por defecto: bytes [offset, offset+limit) sin partir un carácter. */
  paginaPorDefecto(cuerpo: any): RespuestaFalsa {
    const o = this.originales.get(cuerpo.handle);
    if (!o || o.ambito !== JSON.stringify(cuerpo.scope)) {
      return { status: 404, cuerpo: { schema_version: 1, error: { code: "not_found" } } };
    }
    const bytes = Buffer.from(o.texto, "utf8");
    let fin = Math.min(bytes.length, cuerpo.offset + cuerpo.limit);
    while (fin < bytes.length && fin > cuerpo.offset && (bytes[fin]! & 0xc0) === 0x80) fin--;
    return {
      cuerpo: {
        schema_version: 1,
        handle: cuerpo.handle,
        source_id: "s",
        text: bytes.subarray(cuerpo.offset, fin).toString("utf8"),
        original_sha256: o.sha256,
        total_bytes: bytes.length,
        complete: fin >= bytes.length,
        kind: "original_page",
        offset: cuerpo.offset,
        next_offset: fin >= bytes.length ? null : fin,
      },
    };
  }

  private capacidadesPorDefecto(): object {
    return {
      schema_version: 1,
      runtime_build: this.runtimeBuild,
      policy_revision: "rev-1",
      transforms: this.transforms,
      limits: this.limites,
      persistent: true,
      recovery: true,
      retention_seconds: 86_400,
      mode: "compress",
      protocol: { min: 1, max: 1 },
      features: ["tolerant_reader", "revision_tolerant", "http_status_v2", "originals_lifecycle"],
    };
  }

  private async atender(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const trozos: Buffer[] = [];
    for await (const c of req) trozos.push(c as Buffer);
    const crudo = Buffer.concat(trozos);
    let cuerpo: any = null;
    try {
      cuerpo = crudo.length ? JSON.parse(crudo.toString("utf8")) : null;
    } catch {
      cuerpo = null;
    }
    const ruta = (req.url ?? "").replace(/^.*\/caveman\/v1\/middleware/, "");
    this.peticiones.push({ metodo: req.method ?? "", ruta: req.url ?? "", cabeceras: req.headers, cuerpo, bytes: crudo.length });

    let r: RespuestaFalsa;
    if (ruta === "/capabilities") {
      const d = () => this.capacidadesPorDefecto();
      r = this.alCapacidades ? await this.alCapacidades(d) : { cuerpo: d() };
    } else if (ruta === "/optimize") {
      if (this.retener) await new Promise<void>((ok) => this.retenidos.push(ok));
      const d = () => this.planPorDefecto(cuerpo);
      r = this.alOptimizar ? await this.alOptimizar(cuerpo, d) : { cuerpo: d() };
    } else if (ruta === "/retrieve") {
      const d = () => this.paginaPorDefecto(cuerpo);
      r = this.alRecuperar ? await this.alRecuperar(cuerpo, d) : d();
    } else if (ruta === "/sessions/delete") {
      const amb = JSON.stringify(cuerpo?.scope);
      let n = 0;
      for (const [h, o] of this.originales) if (o.ambito === amb) (this.originales.delete(h), n++);
      r = {
        cuerpo: {
          schema_version: 1,
          status: "revoked",
          originals_deleted: true,
          deleted: { scopes: 1, choices: n, grants: n, originals: n },
        },
      };
    } else {
      r = { status: 404, cuerpo: { schema_version: 1, error: { code: "not_found" } } };
    }
    if (r.demoraMs) await new Promise((ok) => setTimeout(ok, r.demoraMs));
    if (res.destroyed || res.writableEnded) return;
    const datos =
      Buffer.isBuffer(r.cuerpo) ? r.cuerpo : typeof r.cuerpo === "string" ? Buffer.from(r.cuerpo, "utf8") : Buffer.from(JSON.stringify(r.cuerpo ?? {}));
    res.writeHead(r.status ?? 200, { "content-type": "application/json", "cache-control": "no-store", ...(r.cabeceras ?? {}) });
    res.end(datos);
  }
}

/** Un «binario» de mentira: bytes aleatorios en un fichero 0755, con su sha256. */
export async function binarioFalso(dir: string): Promise<{ ruta: string; sha256: string }> {
  const { writeFile, chmod } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const ruta = join(dir, "caveman-proxy-falso");
  const bytes = randomBytes(4096);
  await writeFile(ruta, bytes);
  await chmod(ruta, 0o755);
  return { ruta, sha256: sha(bytes) };
}
