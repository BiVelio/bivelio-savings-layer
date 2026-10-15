import {
  ErrorDePrivacidad,
  ErrorDeRecuperacion,
  PeticionInvalida,
  resultadoDeBypass,
  type OptimizeRequest,
  type OptimizeResult,
  type RetrieveContext,
  type RetrievedPage,
  type SavingsTransformer,
  type Scope,
} from "./contrato.js";
import { Cortacircuitos, type EstadoCortacircuitos } from "./guardas.js";
import type { MetricasTransformador } from "./metricas.js";

/**
 * LA OPERACIÓN DEL TRANSFORMADOR (D09): interruptor por proyecto, versión
 * activa con marcha atrás, y la diferencia entre «vivo» y «listo».
 *
 * La regla que gobierna todo el fichero es la del plan (p. 15): **revertir
 * detiene las transformaciones NUEVAS y conserva las fuentes y las
 * representaciones vivas.** De ahí:
 *
 *   · Apagar (global o por proyecto) sólo afecta a `optimize`. `retrieve` y
 *     `release` siguen funcionando con los handles ya emitidos: el modelo que
 *     tiene un handle en su contexto tiene que poder seguir pidiéndolo.
 *   · Cada época se queda con la versión con la que se le aplicó la primera
 *     sustitución. Cambiar la versión activa sólo afecta a épocas NUEVAS: una
 *     época viva no ve cambiar sus bytes de sustitución a mitad de sesión (eso
 *     rompería la caché del proveedor y la estabilidad del prefijo).
 *   · Retirar una versión (`versionesRetiradas`) impide que haga nada nuevo —
 *     ni en sus épocas, que pasan a `version_retired` y envían el original—,
 *     pero sus handles se siguen recuperando A TRAVÉS DE ELLA hasta que caduque
 *     la retención o se haga `release`.
 *   · Si la RECUPERACIÓN de una versión falla (3 fallos de infraestructura
 *     seguidos al hacer retrieve), esa versión deja de emitir omisiones nuevas
 *     durante 30 s (`recovery_unavailable`): sin recuperación comprobada no se
 *     manda contenido con omisiones (runbook «Recovery caído»). El retrieve en
 *     sí nunca se bloquea; pasado el plazo, el siguiente retrieve hace de
 *     sonda.
 *   · Configuración ilegible, versión desconocida o un error inesperado del
 *     motor → passthrough (bypass). Lo único que no se convierte en bypass es
 *     lo que debe parar: Privacy y una petición mal construida.
 *
 * Nada de esto lee el entorno del proceso (src/ es seguro para navegador):
 * quien arranca le pasa el suyo a `configDesdeEntorno` o su propia configuración.
 */

export interface ConfigOperacion {
  /** Interruptor general. Por defecto, apagado: el transformador es opt-in. */
  encendido: boolean;
  /** La versión para épocas NUEVAS. null = ninguna (nada nuevo se transforma). */
  versionActiva: string | null;
  /** Versiones que ya no transforman nada (marcha atrás); siguen sirviendo retrieve. */
  versionesRetiradas: ReadonlySet<string>;
  /** Interruptor por proyecto: estos proyectos no transforman nada nuevo. */
  proyectosApagados: ReadonlySet<string>;
}

export const CONFIG_APAGADA: ConfigOperacion = Object.freeze({
  encendido: false,
  versionActiva: null,
  versionesRetiradas: new Set<string>(),
  proyectosApagados: new Set<string>(),
});

const RE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const RE_PROYECTO = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Lee la configuración de un entorno (el del proceso en Node, o un equivalente). FALLA
 * CERRADO: cualquier valor que no se entiende deja el transformador APAGADO
 * (passthrough) y lo dice en `avisos`. Nunca lanza.
 *
 *   BVSALA_TRANSFORMADOR                    on | off (por defecto off)
 *   BVSALA_TRANSFORMADOR_VERSION            id de la versión activa
 *   BVSALA_TRANSFORMADOR_RETIRADAS          ids separados por comas
 *   BVSALA_TRANSFORMADOR_PROYECTOS_APAGADOS ids de proyecto separados por comas
 */
export function configDesdeEntorno(env: Readonly<Record<string, string | undefined>>): {
  config: ConfigOperacion;
  avisos: string[];
} {
  const avisos: string[] = [];
  const apagada = (aviso: string) => {
    avisos.push(aviso);
    return { config: CONFIG_APAGADA, avisos };
  };
  try {
    const interruptor = (env["BVSALA_TRANSFORMADOR"] ?? "").trim().toLowerCase();
    if (interruptor === "" || interruptor === "off" || interruptor === "0" || interruptor === "false") {
      return { config: CONFIG_APAGADA, avisos };
    }
    if (interruptor !== "on" && interruptor !== "1" && interruptor !== "true") {
      return apagada("BVSALA_TRANSFORMADOR con un valor no reconocido: transformador apagado");
    }
    const version = (env["BVSALA_TRANSFORMADOR_VERSION"] ?? "").trim();
    if (!RE_VERSION.test(version)) {
      return apagada("BVSALA_TRANSFORMADOR_VERSION ausente o inválida: transformador apagado");
    }
    const lista = (nombre: string, re: RegExp): Set<string> | null => {
      const crudo = (env[nombre] ?? "").trim();
      if (crudo === "") return new Set();
      const ids = crudo.split(",").map((x) => x.trim());
      return ids.every((x) => re.test(x)) ? new Set(ids) : null;
    };
    const retiradas = lista("BVSALA_TRANSFORMADOR_RETIRADAS", RE_VERSION);
    if (!retiradas) return apagada("BVSALA_TRANSFORMADOR_RETIRADAS inválida: transformador apagado");
    const apagados = lista("BVSALA_TRANSFORMADOR_PROYECTOS_APAGADOS", RE_PROYECTO);
    if (!apagados) return apagada("BVSALA_TRANSFORMADOR_PROYECTOS_APAGADOS inválida: transformador apagado");
    return {
      config: { encendido: true, versionActiva: version, versionesRetiradas: retiradas, proyectosApagados: apagados },
      avisos,
    };
  } catch {
    return apagada("configuración ilegible: transformador apagado");
  }
}

/** Lo que una versión puede ofrecer además del contrato, para readiness y métricas. */
export interface ConSalud {
  listo?(signal?: AbortSignal): Promise<{ listo: boolean; motivo: string; runtimeBuild?: string }>;
  readonly estadoCortacircuitos?: EstadoCortacircuitos;
}

/** Qué versión atiende cada época. Interfaz para poder respaldarla con almacenamiento duradero. */
export interface RegistroDeEpocas {
  leer(clave: string): string | undefined;
  /** false si no cabe: entonces la época no se fija y no se emite nada que dependa de ella. */
  fijar(clave: string, version: string): boolean;
  olvidarSesion(prefijo: string): void;
}

export class RegistroDeEpocasEnMemoria implements RegistroDeEpocas {
  private readonly m = new Map<string, string>();
  constructor(private readonly max = 100_000) {}
  leer(clave: string): string | undefined {
    return this.m.get(clave);
  }
  fijar(clave: string, version: string): boolean {
    if (this.m.has(clave)) return this.m.get(clave) === version;
    if (this.m.size >= this.max) return false;
    this.m.set(clave, version);
    return true;
  }
  olvidarSesion(prefijo: string): void {
    for (const k of this.m.keys()) if (k.startsWith(prefijo)) this.m.delete(k);
  }
}

const claveDeEpoca = (s: Scope): string => JSON.stringify([s.tenantId, s.projectId, s.sessionId, s.branchId, s.epoch]);
/** Prefijo común a todas las épocas y ramas de una sesión (el JSON sin cerrar). */
const prefijoDeSesion = (s: Scope): string => JSON.stringify([s.tenantId, s.projectId, s.sessionId]).slice(0, -1) + ",";

export interface OpcionesGobierno {
  /** Las versiones disponibles, por id (el mismo id que `versionActiva`). */
  versiones: Readonly<Record<string, SavingsTransformer & ConSalud>>;
  /** Se lee en CADA llamada: cambiarla surte efecto sin reiniciar. Si lanza, apagado. */
  config: () => ConfigOperacion;
  metricas?: MetricasTransformador;
  epocas?: RegistroDeEpocas;
  /** Reloj monótono (latencia y cortacircuitos de recuperación). */
  ahora?: () => number;
  /** Fallos de recuperación seguidos que cortan las omisiones nuevas. Por defecto 3. */
  fallosDeRecuperacionParaCortar?: number;
}

/** Lo que cuenta como recuperación CAÍDA (no lo es un handle ajeno ni una política cambiada). */
const FALLOS_DE_RECUPERACION = new Set(["recovery_unavailable", "runtime_unavailable", "integrity_failure", "error"]);

export class TransformadorGobernado implements SavingsTransformer {
  private readonly versiones: Readonly<Record<string, SavingsTransformer & ConSalud>>;
  private readonly leerConfig: () => ConfigOperacion;
  private readonly metricas: MetricasTransformador | undefined;
  private readonly epocas: RegistroDeEpocas;
  private readonly ahora: () => number;
  private readonly recuperacion = new Map<string, Cortacircuitos>();

  constructor(o: OpcionesGobierno) {
    this.versiones = o.versiones;
    this.leerConfig = o.config;
    this.metricas = o.metricas;
    this.epocas = o.epocas ?? new RegistroDeEpocasEnMemoria();
    this.ahora = o.ahora ?? (() => (typeof performance !== "undefined" ? performance.now() : Date.now()));
    for (const id of Object.keys(this.versiones)) {
      this.recuperacion.set(
        id,
        new Cortacircuitos({ fallosSeguidos: o.fallosDeRecuperacionParaCortar ?? 3, abiertoMs: 30_000, ahora: this.ahora }),
      );
    }
    for (const [id, t] of Object.entries(this.versiones)) {
      if (t.estadoCortacircuitos !== undefined) this.metricas?.vigilarCortacircuitos(id, () => t.estadoCortacircuitos!);
      const cc = this.recuperacion.get(id)!;
      this.metricas?.vigilarCortacircuitos(`${id}/recuperacion`, () => cc.estado);
    }
  }

  private config(): ConfigOperacion {
    try {
      return this.leerConfig() ?? CONFIG_APAGADA;
    } catch {
      return CONFIG_APAGADA;
    }
  }

  async optimize(req: OptimizeRequest, signal: AbortSignal): Promise<OptimizeResult> {
    const t0 = this.ahora();
    const bytes = req.segments.reduce((n, s) => n + (s.utf8?.length ?? 0), 0);
    let res: OptimizeResult;
    try {
      res = await this.decidir(req, signal);
    } catch (e) {
      if (e instanceof ErrorDePrivacidad || e instanceof PeticionInvalida) throw e;
      // Un fallo inesperado del motor nunca para el tráfico: original autorizado.
      res = resultadoDeBypass(req, "runtime_unavailable");
    }
    this.metricas?.latencia(bytes, this.ahora() - t0);
    this.metricas?.decision(res.reason, res.status === "applied", req.scope.projectId);
    return res;
  }

  private async decidir(req: OptimizeRequest, signal: AbortSignal): Promise<OptimizeResult> {
    const cfg = this.config();
    if (!cfg.encendido || cfg.proyectosApagados.has(req.scope.projectId)) return resultadoDeBypass(req, "disabled");
    const clave = claveDeEpoca(req.scope);
    const fijada = this.epocas.leer(clave);
    const version = fijada ?? cfg.versionActiva;
    if (version === null) return resultadoDeBypass(req, "disabled");
    const t = this.versiones[version];
    if (!t) return resultadoDeBypass(req, "disabled");
    if (cfg.versionesRetiradas.has(version)) return resultadoDeBypass(req, "version_retired");
    if (req.mode === "recoverable" && this.recuperacion.get(version)?.estado === "open") {
      return resultadoDeBypass(req, "recovery_unavailable");
    }
    const res = await t.optimize(req, signal);
    if (res.status === "applied" && fijada === undefined && !this.epocas.fijar(clave, version)) {
      // Sin poder fijar la época no se puede garantizar el retrieve: no se emite la omisión.
      return resultadoDeBypass(req, "capacity", { runtimeBuild: res.runtimeBuild });
    }
    return res;
  }

  async retrieve(scope: Scope, handle: string, cursor?: string, context?: RetrieveContext): Promise<RetrievedPage> {
    // Ni el interruptor ni la retirada cierran esto: los handles vivos se siguen sirviendo.
    try {
      const version = this.epocas.leer(claveDeEpoca(scope));
      const t = version === undefined ? undefined : this.versiones[version];
      if (!t) throw new ErrorDeRecuperacion("not_found");
      // Nunca se bloquea: sólo se decide si este resultado cuenta (y si es la sonda).
      const cc = this.recuperacion.get(version!)!;
      const adm = cc.admitir();
      try {
        const p = await t.retrieve(scope, handle, cursor, context);
        if (adm.ok) cc.registrar("exito", adm.sonda);
        this.metricas?.recuperacion("ok");
        return p;
      } catch (e) {
        const codigo = e instanceof ErrorDePrivacidad || e instanceof ErrorDeRecuperacion ? e.codigo : "error";
        if (adm.ok) {
          if (FALLOS_DE_RECUPERACION.has(codigo)) cc.registrar("fallo", adm.sonda);
          else if (codigo === "cancelled") cc.liberar(adm.sonda);
          else cc.registrar("exito", adm.sonda);
        }
        throw e;
      }
    } catch (e) {
      const codigo = e instanceof ErrorDePrivacidad || e instanceof ErrorDeRecuperacion ? e.codigo : "error";
      this.metricas?.recuperacion(codigo);
      throw e;
    }
  }

  async release(scope: Scope): Promise<{ revoked: boolean }> {
    // A TODAS las versiones: la sesión pudo tener épocas en más de una.
    const r = await Promise.allSettled(Object.values(this.versiones).map((t) => t.release(scope)));
    this.epocas.olvidarSesion(prefijoDeSesion(scope));
    return { revoked: r.every((x) => x.status === "fulfilled" && x.value.revoked) };
  }

  /**
   * Liveness: ¿está vivo el proceso y entiende su configuración? SIN E/S y sin
   * inferencia: un sidecar caído no hace que el orquestador reinicie el SDK.
   */
  vivo(): { vivo: true; encendido: boolean; versionActiva: string | null; versionesRegistradas: string[] } {
    const cfg = this.config();
    return { vivo: true, encendido: cfg.encendido, versionActiva: cfg.versionActiva, versionesRegistradas: Object.keys(this.versiones) };
  }

  /**
   * Readiness: ¿transformaría si le llega trabajo? Apagado es «listo» (sirve en
   * passthrough). Encendido exige que la versión activa exista, no esté
   * retirada y que su dependencia mínima (binario + versión del runtime)
   * responda — sin optimizar nada.
   */
  async listo(signal?: AbortSignal): Promise<{ listo: boolean; motivo: string; version?: string; runtimeBuild?: string }> {
    const cfg = this.config();
    if (!cfg.encendido) return { listo: true, motivo: "disabled" };
    const v = cfg.versionActiva;
    if (v === null || !this.versiones[v]) return { listo: false, motivo: "version_unknown" };
    if (cfg.versionesRetiradas.has(v)) return { listo: false, motivo: "version_retired", version: v };
    const t = this.versiones[v]!;
    if (!t.listo) return { listo: true, motivo: "ready", version: v };
    try {
      const r = await t.listo(signal);
      return { listo: r.listo, motivo: r.motivo, version: v, ...(r.runtimeBuild ? { runtimeBuild: r.runtimeBuild } : {}) };
    } catch {
      return { listo: false, motivo: "runtime_unavailable", version: v };
    }
  }
}

/**
 * El atajo de arranque: la configuración del entorno (fallando cerrado) más las
 * versiones que el operador registra. `env` es el entorno del proceso en Node; aquí se
 * recibe como parámetro para no tocar `process` desde src/.
 */
export function gobernadoDesdeEntorno(
  env: Readonly<Record<string, string | undefined>>,
  versiones: Readonly<Record<string, SavingsTransformer & ConSalud>>,
  extra: Omit<OpcionesGobierno, "versiones" | "config"> = {},
): { gobernado: TransformadorGobernado; avisos: string[] } {
  const { config, avisos } = configDesdeEntorno(env);
  return { gobernado: new TransformadorGobernado({ ...extra, versiones, config: () => config }), avisos };
}
