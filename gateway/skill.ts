/**
 * `bvsala skill` — instala el skill «savings-mode» en Claude Code.
 *
 * Por qué existe: los usuarios de SUSCRIPCIÓN no tienen factura que medir,
 * pero tienen topes (ventana de 5 h + tope semanal). En el corpus real del
 * medidor, la salida del modelo es ~12 % del presupuesto ponderado por dinero
 * siendo <1 % de los tokens, y los tool_results son el mayor quemador del
 * contexto. Un skill (instrucciones, cero proxy, cero ToS) ataca exactamente
 * esas dos masas. El efecto NO se anuncia con cifra hasta medirlo con el
 * gateway (doctrina: medido o nada).
 *
 * Diseño: función pura sobre un FS inyectado — el binario solo la llama.
 */
import { join } from "node:path";

export interface FsDeSkill {
  existe(ruta: string): boolean;
  leer(ruta: string): string;
  escribir(ruta: string, contenido: string): void;
  crearDir(ruta: string): void;
}

export interface OpcionesInstalarSkill {
  /** Raíces candidatas donde buscar el SKILL.md empaquetado, en orden. */
  origenes: string[];
  /** HOME del usuario (para ~/.claude/skills). */
  home: string;
  /** Directorio de trabajo (para .claude/skills del proyecto con --proyecto). */
  cwd: string;
  /** true = instalar en el proyecto (.claude/skills) en vez de en el HOME. */
  proyecto: boolean;
  /** true = sobrescribir una instalación previa. */
  forzar: boolean;
  fs: FsDeSkill;
}

export interface ResultadoInstalarSkill {
  ok: boolean;
  /** Ruta del SKILL.md instalado (o existente, si se negó a sobrescribir). */
  destino: string;
  mensaje: string;
}

export const NOMBRE_SKILL = "savings-mode";

/** El SKILL.md empaquetado, probando las raíces en orden (repo y npm difieren). */
export function origenDelSkill(origenes: string[], fs: Pick<FsDeSkill, "existe">): string | null {
  for (const raiz of origenes) {
    const ruta = join(raiz, "skills", NOMBRE_SKILL, "SKILL.md");
    if (fs.existe(ruta)) return ruta;
  }
  return null;
}

export function instalarSkill(o: OpcionesInstalarSkill): ResultadoInstalarSkill {
  const origen = origenDelSkill(o.origenes, o.fs);
  if (!origen) {
    return {
      ok: false,
      destino: "",
      mensaje: `[bvsala skill] no encuentro el SKILL.md empaquetado (raíces probadas: ${o.origenes.join(", ")})`,
    };
  }
  const base = o.proyecto ? join(o.cwd, ".claude", "skills") : join(o.home, ".claude", "skills");
  const dir = join(base, NOMBRE_SKILL);
  const destino = join(dir, "SKILL.md");
  const contenido = o.fs.leer(origen);

  if (o.fs.existe(destino) && !o.forzar) {
    const igual = o.fs.leer(destino) === contenido;
    return {
      ok: igual,
      destino,
      mensaje: igual
        ? `[bvsala skill] ya instalado y al día: ${destino}`
        : `[bvsala skill] ya existe ${destino} con contenido DISTINTO — no lo piso; usa --forzar para sobrescribir`,
    };
  }

  o.fs.crearDir(dir);
  o.fs.escribir(destino, contenido);
  return {
    ok: true,
    destino,
    mensaje:
      `[bvsala skill] instalado: ${destino}\n` +
      `[bvsala skill] arranca (o reinicia) Claude Code y pídele «savings mode» — o deja que se active solo al hablar de límites.\n` +
      `[bvsala skill] para medir su efecto de verdad: trabaja unos días con él y otros sin él bajo \`bvsala claude\`, y compara en el panel.`,
  };
}
