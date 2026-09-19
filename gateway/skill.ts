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

/**
 * LA PUERTA CODEX: Codex CLI no tiene skills — tiene `AGENTS.md` (global en
 * ~/.codex/, o del repo), SIEMPRE activo. La misma disciplina del skill viaja
 * como BLOQUE MARCADO dentro de ese fichero: se genera del propio SKILL.md
 * (una sola fuente, cero deriva), y el instalador solo toca lo que hay entre
 * sus marcas — el resto del AGENTS.md del usuario es sagrado.
 */
export const MARCA_INICIO = "<!-- bvsala:savings-mode:inicio -->";
export const MARCA_FIN = "<!-- bvsala:savings-mode:fin -->";

export function bloqueAgentsMd(skillMd: string): string {
  const cuerpo = skillMd.replace(/^---\n[\s\S]*?\n---\n*/, "").trim();
  return (
    `${MARCA_INICIO}\n${cuerpo}\n\n` +
    // AGENTS.md no tiene activación por descripción: esto va SIEMPRE. Decirlo
    // y dar la salida es parte del contrato.
    `_Always on (AGENTS.md has no activation step). Delete this block to turn it off; \`bvsala skill --codex --forzar\` restores it._\n` +
    `${MARCA_FIN}`
  );
}

export function instalarAgentsMd(o: OpcionesInstalarSkill): ResultadoInstalarSkill {
  const origen = origenDelSkill(o.origenes, o.fs);
  if (!origen) {
    return {
      ok: false,
      destino: "",
      mensaje: `[bvsala skill] cannot find the bundled SKILL.md (roots tried: ${o.origenes.join(", ")})`,
    };
  }
  const bloque = bloqueAgentsMd(o.fs.leer(origen));
  const dir = o.proyecto ? o.cwd : join(o.home, ".codex");
  const destino = join(dir, "AGENTS.md");

  if (!o.fs.existe(destino)) {
    o.fs.crearDir(dir);
    o.fs.escribir(destino, bloque + "\n");
    return { ok: true, destino, mensaje: mensajeCodex(destino, "installed") };
  }

  const actual = o.fs.leer(destino);
  const ini = actual.indexOf(MARCA_INICIO);
  const fin = actual.indexOf(MARCA_FIN);

  if (ini === -1 || fin === -1 || fin < ini) {
    // Sin bloque nuestro: se AÑADE al final; ni un byte ajeno se toca.
    o.fs.escribir(destino, actual.trimEnd() + "\n\n" + bloque + "\n");
    return { ok: true, destino, mensaje: mensajeCodex(destino, "appended to the existing AGENTS.md") };
  }

  const existente = actual.slice(ini, fin + MARCA_FIN.length);
  if (existente === bloque) {
    return { ok: true, destino, mensaje: `[bvsala skill] already installed and up to date: ${destino}` };
  }
  if (!o.forzar) {
    return {
      ok: false,
      destino,
      mensaje: `[bvsala skill] the savings-mode block in ${destino} has DIFFERENT content — not overwriting it; use --forzar to update it`,
    };
  }
  o.fs.escribir(destino, actual.slice(0, ini) + bloque + actual.slice(fin + MARCA_FIN.length));
  return { ok: true, destino, mensaje: mensajeCodex(destino, "block updated") };
}

function mensajeCodex(destino: string, que: string): string {
  return (
    `[bvsala skill] ${que}: ${destino}\n` +
    `[bvsala skill] AGENTS.md is ALWAYS active in Codex (there is no activation step); delete the block to turn it off.\n` +
    `[bvsala skill] to measure its effect: work a few days with it and a few without, under \`bvsala codex\`, and compare in the dashboard.`
  );
}

export function instalarSkill(o: OpcionesInstalarSkill): ResultadoInstalarSkill {
  const origen = origenDelSkill(o.origenes, o.fs);
  if (!origen) {
    return {
      ok: false,
      destino: "",
      mensaje: `[bvsala skill] cannot find the bundled SKILL.md (roots tried: ${o.origenes.join(", ")})`,
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
        ? `[bvsala skill] already installed and up to date: ${destino}`
        : `[bvsala skill] ${destino} already exists with DIFFERENT content — not overwriting it; use --forzar to overwrite`,
    };
  }

  o.fs.crearDir(dir);
  o.fs.escribir(destino, contenido);
  return {
    ok: true,
    destino,
    mensaje:
      `[bvsala skill] installed: ${destino}\n` +
      `[bvsala skill] start (or restart) Claude Code and ask for "savings mode" — or let it activate on its own when you mention limits.\n` +
      `[bvsala skill] to measure its real effect: work a few days with it and a few without, under \`bvsala claude\`, and compare in the dashboard.`,
  };
}
