/**
 * EL VIGÍA DE CONEXIONES — ¿a quién llama un gateway «local» por su cuenta?
 *
 * Lanza un comando (o vigila un pid) y muestrea cada `--cada-ms` las conexiones
 * del árbol de procesos con `lsof`. Al final lista cada extremo remoto que NO es
 * loopback, cuándo apareció y su nombre inverso si lo tiene. Con un gateway
 * apuntado a un upstream falso en 127.0.0.1 y sin claves reales, cualquier
 * extremo remoto es tráfico que el producto decide por sí mismo: telemetría,
 * catálogos de precios, comprobación de versión, licencias.
 *
 *   pnpm vigia:conexiones -- --segundos 60 -- ./bifrost-http -app-dir ./bifrost -port 8080
 *   pnpm vigia:conexiones -- --pid 12345 --segundos 30
 *
 * Con `--proxy-registro` arranca además un proxy HTTP local que REGISTRA cada
 * destino y lo reenvía sin tocarlo, y lanza el comando con HTTP(S)_PROXY
 * apuntándole (y NODE_USE_ENV_PROXY=1 para Node). Eso caza las conexiones
 * cortas que el muestreo pierde — LiteLLM baja su tabla de precios de GitHub al
 * importarse en menos de lo que tarda una muestra— siempre que el cliente HTTP
 * del producto respete las variables de proxy (httpx, reqwest y net/http sí;
 * fasthttp no).
 *
 * Límites (dichos en el informe): un muestreo no ve una conexión que abre y
 * cierra entre dos muestras, el proxy no ve a quien ignora las variables, ninguno
 * ve la resolución DNS, y ninguno distingue QUÉ viaja: solo A QUIÉN. Es un
 * indicio que se contrasta con el código y la documentación, no una auditoría de
 * red.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { reverse } from "node:dns/promises";
import { createServer, request as peticionHttp } from "node:http";
import { connect } from "node:net";

import { esElPrincipal, extremosRemotos, type Extremo } from "./nucleo.js";

/** El pid y todos sus descendientes (pgrep -P, recursivo). */
function arbol(pid: number): number[] {
  const out = [pid];
  for (let i = 0; i < out.length; i++) {
    try {
      const hijos = execFileSync("pgrep", ["-P", String(out[i])], { encoding: "utf8" })
        .split("\n")
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n) && n > 0);
      out.push(...hijos);
    } catch {
      // pgrep sale con 1 si no hay hijos
    }
  }
  return out;
}

function muestra(pids: number[]): Extremo[] {
  try {
    const salida = execFileSync("lsof", ["-nP", "-a", "-p", pids.join(","), "-i", "-F", "n"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return extremosRemotos(salida);
  } catch (e) {
    // lsof sale con 1 cuando no encuentra nada que listar
    const salida = (e as { stdout?: string }).stdout;
    return typeof salida === "string" ? extremosRemotos(salida) : [];
  }
}

/**
 * Un proxy HTTP que apunta cada destino (CONNECT host:puerto o la URL absoluta
 * de una petición en claro) y lo reenvía tal cual. Solo escucha en loopback.
 */
function proxyDeRegistro(apuntar: (destino: string) => void): Promise<{ puerto: number; cerrar: () => void }> {
  const s = createServer((req, res) => {
    const url = req.url ?? "";
    apuntar(`HTTP ${req.method} ${url.split("?")[0]}`);
    let destino: URL;
    try {
      destino = new URL(url);
    } catch {
      res.writeHead(400).end();
      return;
    }
    const salida = peticionHttp(destino, { method: req.method, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    salida.on("error", () => res.writeHead(502).end());
    req.pipe(salida);
  });
  s.on("connect", (req, cliente, cabeza) => {
    const [host, puerto] = (req.url ?? "").split(":");
    apuntar(`CONNECT ${req.url}`);
    const remoto = connect(Number(puerto ?? 443), host ?? "", () => {
      cliente.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (cabeza.length) remoto.write(cabeza);
      remoto.pipe(cliente);
      cliente.pipe(remoto);
    });
    remoto.on("error", () => cliente.destroy());
    cliente.on("error", () => remoto.destroy());
  });
  return new Promise((resolver) =>
    s.listen(0, "127.0.0.1", () => {
      const d = s.address();
      resolver({ puerto: typeof d === "object" && d ? d.port : 0, cerrar: () => s.close() });
    }),
  );
}

function arg(nombre: string): string | undefined {
  const i = process.argv.indexOf(nombre);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function principal(): Promise<void> {
  const segundos = Number(arg("--segundos") ?? 60);
  const cadaMs = Number(arg("--cada-ms") ?? 200);
  // El comando empieza tras el primer `--` que NO va seguido de una opción de
  // este script: pnpm puede reenviar su propio `--` delante de `--segundos`.
  const separador = process.argv.findIndex((a, i) => a === "--" && !(process.argv[i + 1] ?? "--").startsWith("--"));
  let hijo: ChildProcess | null = null;
  let pid: number;
  const t0 = Date.now();
  const porProxy: { segundo: number; destino: string }[] = [];
  const proxy = process.argv.includes("--proxy-registro")
    ? await proxyDeRegistro((destino) => porProxy.push({ segundo: (Date.now() - t0) / 1000, destino }))
    : null;
  if (arg("--pid")) {
    pid = Number(arg("--pid"));
  } else {
    const comando = separador >= 0 ? process.argv.slice(separador + 1) : [];
    if (comando.length === 0) throw new Error("uso: vigia-conexiones [--segundos N] [--cada-ms N] (--pid P | -- comando args…)");
    const env = proxy
      ? {
          ...process.env,
          HTTP_PROXY: `http://127.0.0.1:${proxy.puerto}`,
          HTTPS_PROXY: `http://127.0.0.1:${proxy.puerto}`,
          http_proxy: `http://127.0.0.1:${proxy.puerto}`,
          https_proxy: `http://127.0.0.1:${proxy.puerto}`,
          NO_PROXY: "127.0.0.1,localhost,::1",
          no_proxy: "127.0.0.1,localhost,::1",
          NODE_USE_ENV_PROXY: "1",
        }
      : process.env;
    hijo = spawn(comando[0]!, comando.slice(1), { stdio: ["ignore", "ignore", "inherit"], env });
    if (!hijo.pid) throw new Error(`no se pudo lanzar ${comando[0]}`);
    pid = hijo.pid;
  }
  const vistos = new Map<string, { extremo: Extremo; primeraVezS: number; muestras: number }>();
  let terminado = false;
  hijo?.once("exit", () => (terminado = true));
  while (!terminado && Date.now() - t0 < segundos * 1000) {
    for (const e of muestra(arbol(pid))) {
      const k = `${e.host}:${e.puerto}`;
      const v = vistos.get(k);
      if (v) v.muestras++;
      else vistos.set(k, { extremo: e, primeraVezS: (Date.now() - t0) / 1000, muestras: 1 });
    }
    await new Promise((r) => setTimeout(r, cadaMs));
  }
  hijo?.kill("SIGTERM");
  proxy?.cerrar();
  if (proxy) {
    console.log(`Destinos pedidos al proxy de registro (${porProxy.length}):`);
    if (porProxy.length === 0) console.log("  ninguno");
    for (const p of porProxy) console.log(`  t=${p.segundo.toFixed(1)} s  ${p.destino}`);
  }

  console.log(`Extremos remotos no locales en ${((Date.now() - t0) / 1000).toFixed(0)} s (muestreo cada ${cadaMs} ms):`);
  if (vistos.size === 0) console.log("  ninguno");
  for (const { extremo, primeraVezS, muestras } of [...vistos.values()].sort((a, b) => a.primeraVezS - b.primeraVezS)) {
    let nombre = "";
    try {
      nombre = (await reverse(extremo.host.replace(/^\[|\]$/g, ""))).join(", ");
    } catch {
      nombre = "(sin nombre inverso)";
    }
    console.log(`  t=${primeraVezS.toFixed(1)} s  ${extremo.host}:${extremo.puerto}  ${nombre}  (${muestras} muestras)`);
  }
}

if (esElPrincipal(import.meta.url)) {
  principal().then(
    () => process.exit(0),
    (e) => {
      console.error(e instanceof Error ? e.message : e);
      process.exit(1);
    },
  );
}
