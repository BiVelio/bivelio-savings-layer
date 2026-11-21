import { describe, it, expect } from "vitest";

import {
  argumentoDesconocido,
  decidirArranque,
  flagDePuerto,
  isChildInfoRequest,
  mensajeDeFalloDeArranque,
} from "../gateway/argumentos.js";

/**
 * La decisión «ayuda / versión / arrancar» del CLI, como función pura. Hasta
 * 0.4.20 vivía inline en bin.ts y solo miraba el PRIMER argumento: `bvsala
 * gateway --help` arrancaba el proxy, `bvsala doctor -h` ejecutaba el doctor y
 * `bvsala --version` imprimía la ayuda entera con exit 1 (verificación de
 * cinco agentes sobre la 0.4.20, 2026-09-13).
 */
describe("bvsala · la decisión de arranque", () => {
  it("sin argumentos, `help`, `--help` y `-h` → ayuda con exit 0", () => {
    expect(decidirArranque([])).toEqual({ tipo: "ayuda", salida: 0 });
    expect(decidirArranque(["help"])).toEqual({ tipo: "ayuda", salida: 0 });
    expect(decidirArranque(["--help"])).toEqual({ tipo: "ayuda", salida: 0 });
    expect(decidirArranque(["-h"])).toEqual({ tipo: "ayuda", salida: 0 });
  });

  it("un comando desconocido → ayuda con exit 1, y dice cuál no existe", () => {
    expect(decidirArranque(["gatewya"])).toEqual({ tipo: "ayuda", salida: 1, desconocido: "gatewya" });
    expect(decidirArranque(["--port", "8402"])).toEqual({ tipo: "ayuda", salida: 1, desconocido: "--port" });
    // Solo el error lo lleva: pedir la ayuda no es un comando desconocido.
    expect(decidirArranque(["--help"])).not.toHaveProperty("desconocido");
  });

  it("⛔ `gateway --help` y `doctor -h` → ayuda, NO arrancar (antes arrancaban el proxy / corrían el doctor)", () => {
    expect(decidirArranque(["gateway", "--help"])).toEqual({ tipo: "ayuda", salida: 0 });
    expect(decidirArranque(["gateway", "-h"])).toEqual({ tipo: "ayuda", salida: 0 });
    expect(decidirArranque(["gateway", "--port", "8402", "--help"])).toEqual({ tipo: "ayuda", salida: 0 });
    expect(decidirArranque(["doctor", "-h"])).toEqual({ tipo: "ayuda", salida: 0 });
    expect(decidirArranque(["doctor", "--help"])).toEqual({ tipo: "ayuda", salida: 0 });
    expect(decidirArranque(["skill", "--help"])).toEqual({ tipo: "ayuda", salida: 0 });
  });

  it("⛔ `--version`, `-v` y `version` → solo la versión (antes: la ayuda entera y exit 1)", () => {
    expect(decidirArranque(["--version"])).toEqual({ tipo: "version" });
    expect(decidirArranque(["-v"])).toEqual({ tipo: "version" });
    expect(decidirArranque(["version"])).toEqual({ tipo: "version" });
    // También detrás de un subcomando propio.
    expect(decidirArranque(["gateway", "--version"])).toEqual({ tipo: "version" });
  });

  it("`gateway --port 0`, `doctor` y `skill --codex` → arrancar, con el resto intacto", () => {
    expect(decidirArranque(["gateway", "--port", "0"])).toEqual({ tipo: "arrancar", comando: "gateway", resto: ["--port", "0"] });
    expect(decidirArranque(["gateway"])).toEqual({ tipo: "arrancar", comando: "gateway", resto: [] });
    expect(decidirArranque(["doctor"])).toEqual({ tipo: "arrancar", comando: "doctor", resto: [] });
    expect(decidirArranque(["skill", "--codex", "--project"])).toEqual({ tipo: "arrancar", comando: "skill", resto: ["--codex", "--project"] });
  });

  it("los envoltorios NO interceptan -h/--help/--version: esos argumentos son del terminal hijo", () => {
    // `bvsala claude --help` tiene que enseñar la ayuda de Claude Code, no la
    // nuestra; y `bvsala codex --version` la versión de Codex.
    expect(decidirArranque(["claude", "--help"])).toEqual({ tipo: "arrancar", comando: "claude", resto: ["--help"] });
    expect(decidirArranque(["codex", "--version"])).toEqual({ tipo: "arrancar", comando: "codex", resto: ["--version"] });
    expect(decidirArranque(["goose", "-h"])).toEqual({ tipo: "arrancar", comando: "goose", resto: ["-h"] });
    expect(decidirArranque(["qwen", "-v"])).toEqual({ tipo: "arrancar", comando: "qwen", resto: ["-v"] });
  });
});

describe("isChildInfoRequest — la pregunta al terminal hijo va directa, sin gateway ni licencia", () => {
  it("`--help`, `-h` y `--version`, SOLOS, son una pregunta al hijo", () => {
    expect(isChildInfoRequest(["--help"])).toBe(true);
    expect(isChildInfoRequest(["-h"])).toBe(true);
    expect(isChildInfoRequest(["--version"])).toBe(true);
  });

  it("⛔ `-v`, las palabras sueltas, cualquier otro argumento o ninguno → sesión (pasa por la verja)", () => {
    // `-v` es verbose en algunos terminales y `help`/`version` pueden ser un
    // prompt: lanzarlos sin gateway sería una sesión sin medir ni licencia.
    expect(isChildInfoRequest(["-v"])).toBe(false);
    expect(isChildInfoRequest(["help"])).toBe(false);
    expect(isChildInfoRequest(["version"])).toBe(false);
    expect(isChildInfoRequest(["--help", "x"])).toBe(false);
    expect(isChildInfoRequest(["-p", "hola"])).toBe(false);
    expect(isChildInfoRequest([])).toBe(false);
  });
});

describe("bvsala · el fallo de arranque traducido al probador", () => {
  const conCodigo = (code: string, puerto: number): Error & { code: string; puerto: number } =>
    Object.assign(new Error(`listen ${code}: address already in use 127.0.0.1:${puerto}`), { code, puerto });

  it("EADDRINUSE → una sola línea con el puerto, la causa probable y la salida (--port M o apagar el otro)", () => {
    const linea = mensajeDeFalloDeArranque(conCodigo("EADDRINUSE", 8402), "gateway", 8402);
    expect(linea).toBe(
      "port 8402 is already in use (another gateway, or a terminal launched earlier?): use --port 8403 or stop the other process",
    );
    expect(linea).not.toContain("\n"); // sin traza
    expect(linea).not.toContain("node:net");
  });

  it("EACCES → «puerto sin permiso» con la salida (un puerto ≥ 1024)", () => {
    const linea = mensajeDeFalloDeArranque(conCodigo("EACCES", 80), "gateway", 80);
    expect(linea).toContain("permission denied");
    expect(linea).toContain("80");
    expect(linea).toContain("--port");
    expect(linea).not.toContain("\n");
  });

  it("el puerto se lee del error (el REAL que falló), no del pedido", () => {
    expect(mensajeDeFalloDeArranque(conCodigo("EADDRINUSE", 9000), "gateway", 8402)).toContain("port 9000 is already in use");
  });

  it("cualquier otro fallo → se dice tal cual, con el comando, sin inventar diagnóstico", () => {
    const linea = mensajeDeFalloDeArranque(new Error("algo raro"), "claude", 0);
    expect(linea).toContain("could not start the gateway");
    expect(linea).toContain("algo raro");
  });
});

/**
 * `--port=N` se ignoraba EN SILENCIO (solo se miraba `indexOf("--port")`): el
 * gateway arrancaba en 8402 y `doctor --port=9000` imprimía recetas para 8402.
 */
describe("bvsala · flagDePuerto: `--port N` y `--port=N` son lo mismo", () => {
  it("⛔ las dos formas dan el mismo puerto", () => {
    expect(flagDePuerto(["--port", "9777"])).toEqual({ tipo: "puerto", puerto: 9777 });
    expect(flagDePuerto(["--port=9777"])).toEqual({ tipo: "puerto", puerto: 9777 });
    expect(flagDePuerto(["--upstream", "openai", "--port=9777"])).toEqual({ tipo: "puerto", puerto: 9777 });
    expect(flagDePuerto(["--upstream=openai", "--port", "0"])).toEqual({ tipo: "puerto", puerto: 0 });
  });

  it("sin el flag: ausente (el puerto por defecto lo pone quien llama)", () => {
    expect(flagDePuerto([])).toEqual({ tipo: "ausente" });
    expect(flagDePuerto(["--upstream", "openai"])).toEqual({ tipo: "ausente" });
  });

  it("⛔ un `--port…` que no se entiende es un ERROR, nunca el puerto por defecto en silencio", () => {
    expect(flagDePuerto(["--port="])).toEqual({ tipo: "error", valor: "--port=" });
    expect(flagDePuerto(["--port"]).tipo).toBe("error");
    expect(flagDePuerto(["--port", "--upstream"]).tipo).toBe("error");
    expect(flagDePuerto(["--port=abc"])).toEqual({ tipo: "error", valor: "--port=abc" });
    expect(flagDePuerto(["--port", "9000x"])).toEqual({ tipo: "error", valor: "9000x" });
    expect(flagDePuerto(["--port=-1"]).tipo).toBe("error");
    expect(flagDePuerto(["--ports", "9000"])).toEqual({ tipo: "error", valor: "--ports" });
    expect(flagDePuerto(["--port9000"])).toEqual({ tipo: "error", valor: "--port9000" });
    // Number("") es 0 y Number("0x10") es 16: ninguno cuela como puerto.
    expect(flagDePuerto(["--port", ""]).tipo).toBe("error");
    expect(flagDePuerto(["--port=0x10"]).tipo).toBe("error");
  });
});

describe("A2-16 · argumentoDesconocido: un flag mal escrito es un error que nombra el flag y sugiere el bueno", () => {
  it("las formas buenas de gateway y doctor pasan", () => {
    expect(argumentoDesconocido("gateway", [])).toBeNull();
    expect(argumentoDesconocido("gateway", ["--port", "9000", "--upstream", "openai"])).toBeNull();
    expect(argumentoDesconocido("gateway", ["--port=9000", "--upstream=https://api.openai.com"])).toBeNull();
    // Sin valor: lo dice resolverUpstream («needs a value»), no este filtro.
    expect(argumentoDesconocido("gateway", ["--upstream"])).toBeNull();
    expect(argumentoDesconocido("gateway", ["--upstream", "--port", "0"])).toBeNull();
    expect(argumentoDesconocido("doctor", ["--port", "9000"])).toBeNull();
    // `--write` lo sigue contestando el doctor con «does not exist yet».
    expect(argumentoDesconocido("doctor", ["--write"])).toBeNull();
    // Y con la terminal detrás, que es la forma que citan las guías del tarball
    // (docs/terminales/crush.md y droid.md): en la 1.2.1 `doctor --write crush`
    // contestaba «does not exist yet»; sin esto contestaba «unexpected argument».
    expect(argumentoDesconocido("doctor", ["--write", "crush"])).toBeNull();
    expect(argumentoDesconocido("doctor", ["--write", "droid", "--port", "9000"])).toBeNull();
    // Solo UN valor: un segundo argumento suelto sigue siendo un error.
    expect(argumentoDesconocido("doctor", ["--write", "crush", "otra-cosa"])).toContain("unexpected argument");
    // Lo que empieza por --port lo juzga flagDePuerto, con su mensaje de siempre.
    expect(argumentoDesconocido("gateway", ["--ports", "9000"])).toBeNull();
  });

  it("⛔ `--upsteam openai`, `-p 9000` y `--Port 9000` son errores con la sugerencia", () => {
    expect(argumentoDesconocido("gateway", ["--upsteam", "openai", "--port", "39512"])).toBe(
      "[bvsala gateway] unknown option --upsteam (did you mean --upstream?). gateway accepts --port N, --upstream U (and --help). Nothing was started.",
    );
    expect(argumentoDesconocido("gateway", ["-p", "9000"])).toContain("unknown option -p (did you mean --port?)");
    expect(argumentoDesconocido("gateway", ["--Port", "9000"])).toContain("unknown option --Port (did you mean --port?)");
    expect(argumentoDesconocido("doctor", ["-p", "9000"])).toContain("[bvsala doctor] unknown option -p (did you mean --port?)");
    expect(argumentoDesconocido("doctor", ["--prot", "9000"])).toContain("(did you mean --port?)");
  });

  it("sin nada parecido, la lista de lo que se acepta; y el valor de un argumento no se repite nunca", () => {
    const e = argumentoDesconocido("gateway", ["--verbose"]);
    expect(e).toBe("[bvsala gateway] unknown option --verbose. gateway accepts --port N, --upstream U (and --help). Nothing was started.");
    const conValor = argumentoDesconocido("gateway", ["--upsteam=sk-clave-inventada"]);
    expect(conValor).toContain("--upsteam");
    expect(conValor).not.toContain("sk-clave-inventada");
    const suelto = argumentoDesconocido("gateway", ["sk-clave-inventada-pegada"]);
    expect(suelto).toContain("unexpected argument");
    expect(suelto).not.toContain("sk-clave-inventada");
    // El doctor no anuncia un --write que aún no existe.
    expect(argumentoDesconocido("doctor", ["--verbose"])).toContain("doctor accepts --port N (and --help)");
  });
});
