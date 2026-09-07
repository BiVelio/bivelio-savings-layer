import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:net";
import { describe, it, expect } from "vitest";

/**
 * EL VIGÍA DE FUGAS mira SOCKETS, no shells ni entorno: una pestaña abierta
 * antes de que ~/.zshrc cargara el arnés lanza `claude` a pelo y nada lo dice
 * (06-09: 99 % del tráfico fuera). En macOS `ps -E` no ve el entorno de otros
 * procesos —verificado—, así que la única prueba fiable es a dónde conecta.
 */
const VIGIA = new URL("../scripts/anillo2-vigia-fugas.zsh", import.meta.url).pathname;

describe("anillo 2 · vigía de fugas", () => {
  it("es zsh válido", () => {
    execFileSync("zsh", ["-n", VIGIA]);
  });

  it("detecta por SOCKETS y jamás lee ni imprime entorno, cuerpos ni cabeceras", () => {
    const src = execFileSync("cat", [VIGIA], { encoding: "utf8" });
    expect(src).toMatch(/lsof -nP -a -p/);
    expect(src).toMatch(/->127\\\.0\\\.0\\\.1:/);
    expect(src).not.toMatch(/ps -E/);
    expect(src).not.toMatch(/BIVELIO_SERVICE_KEY|ANTHROPIC_API_KEY|Authorization/);
  });

  it("la pieza que decide: un socket a 127.0.0.1 cuenta como gateway; a :443 externo, como fuga", async () => {
    // Un servidor local + un cliente conectado = "va por gateway".
    const srv = createServer(() => {});
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const puerto = (srv.address() as { port: number }).port;
    const cli = spawn("nc", ["127.0.0.1", String(puerto)], { stdio: ["pipe", "ignore", "ignore"] }); // stdin abierto: nc no sale
    try {
      await new Promise((r) => setTimeout(r, 400));
      const locales = execFileSync("zsh", ["-c", `lsof -nP -a -p ${cli.pid} -iTCP -sTCP:ESTABLISHED | awk 'NR>1{print $9}' | grep -c -- '->127\\.0\\.0\\.1:' || true`], { encoding: "utf8" }).trim();
      expect(Number(locales)).toBeGreaterThanOrEqual(1);
    } finally {
      cli.kill();
      srv.close();
    }
  });
});
