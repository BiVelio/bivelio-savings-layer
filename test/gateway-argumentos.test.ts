import { describe, it, expect } from "vitest";

import { decidirArranque, mensajeDeFalloDeArranque } from "../gateway/argumentos.js";

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

  it("un comando desconocido → ayuda con exit 1", () => {
    expect(decidirArranque(["gatewya"])).toEqual({ tipo: "ayuda", salida: 1 });
    expect(decidirArranque(["--puerto", "8402"])).toEqual({ tipo: "ayuda", salida: 1 });
  });

  it("⛔ `gateway --help` y `doctor -h` → ayuda, NO arrancar (antes arrancaban el proxy / corrían el doctor)", () => {
    expect(decidirArranque(["gateway", "--help"])).toEqual({ tipo: "ayuda", salida: 0 });
    expect(decidirArranque(["gateway", "-h"])).toEqual({ tipo: "ayuda", salida: 0 });
    expect(decidirArranque(["gateway", "--puerto", "8402", "--help"])).toEqual({ tipo: "ayuda", salida: 0 });
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

  it("`gateway --puerto 0`, `doctor` y `skill --codex` → arrancar, con el resto intacto", () => {
    expect(decidirArranque(["gateway", "--puerto", "0"])).toEqual({ tipo: "arrancar", comando: "gateway", resto: ["--puerto", "0"] });
    expect(decidirArranque(["gateway"])).toEqual({ tipo: "arrancar", comando: "gateway", resto: [] });
    expect(decidirArranque(["doctor"])).toEqual({ tipo: "arrancar", comando: "doctor", resto: [] });
    expect(decidirArranque(["skill", "--codex", "--proyecto"])).toEqual({ tipo: "arrancar", comando: "skill", resto: ["--codex", "--proyecto"] });
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

describe("bvsala · el fallo de arranque traducido al probador", () => {
  const conCodigo = (code: string, puerto: number): Error & { code: string; puerto: number } =>
    Object.assign(new Error(`listen ${code}: address already in use 127.0.0.1:${puerto}`), { code, puerto });

  it("EADDRINUSE → una sola línea con el puerto, la causa probable y la salida (--puerto M o apagar el otro)", () => {
    const linea = mensajeDeFalloDeArranque(conCodigo("EADDRINUSE", 8402), "gateway", 8402);
    expect(linea).toBe(
      "el puerto 8402 ya está en uso (¿otro gateway o un terminal lanzado antes?): usa --puerto 8403 o apaga el otro proceso",
    );
    expect(linea).not.toContain("\n"); // sin traza
    expect(linea).not.toContain("node:net");
  });

  it("EACCES → «puerto sin permiso» con la salida (un puerto ≥ 1024)", () => {
    const linea = mensajeDeFalloDeArranque(conCodigo("EACCES", 80), "gateway", 80);
    expect(linea).toContain("puerto sin permiso");
    expect(linea).toContain("80");
    expect(linea).toContain("--puerto");
    expect(linea).not.toContain("\n");
  });

  it("el puerto se lee del error (el REAL que falló), no del pedido", () => {
    expect(mensajeDeFalloDeArranque(conCodigo("EADDRINUSE", 9000), "gateway", 8402)).toContain("el puerto 9000 ya está en uso");
  });

  it("cualquier otro fallo → se dice tal cual, con el comando, sin inventar diagnóstico", () => {
    const linea = mensajeDeFalloDeArranque(new Error("algo raro"), "claude", 0);
    expect(linea).toContain("no se pudo arrancar el gateway");
    expect(linea).toContain("algo raro");
  });
});
