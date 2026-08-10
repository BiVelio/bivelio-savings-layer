import { describe, it, expect, afterEach } from "vitest";

import { hostname } from "node:os";
import { readFileSync } from "node:fs";

import { deriveSeatId, detectCi, esNombreEfimero, hostDeMaquina } from "../src/metering/seat.js";

const USAGE_ID_PATTERN = /^[A-Za-z0-9._:/-]{1,128}$/;

const CI_KEYS = [
  "CI", "CONTINUOUS_INTEGRATION", "GITHUB_ACTIONS", "GITLAB_CI", "CIRCLECI",
  "TRAVIS", "JENKINS_URL", "BUILDKITE", "TF_BUILD", "TEAMCITY_VERSION",
  "BITBUCKET_BUILD_NUMBER", "CODEBUILD_BUILD_ID", "HEROKU_TEST_RUN_ID", "DRONE",
];

const saved: Record<string, string | undefined> = {};
afterEach(() => {
  for (const k of Object.keys(saved)) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
    delete saved[k];
  }
});
function stashCiEnv() {
  for (const k of CI_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
}

describe("deriveSeatId", () => {
  it("produces a stable, charset-valid, opaque id", async () => {
    const a = await deriveSeatId("bvk_key_one");
    const b = await deriveSeatId("bvk_key_one");
    expect(a).toBeDefined();
    expect(a).toBe(b); // stable across calls on the same machine + key
    expect(USAGE_ID_PATTERN.test(a!)).toBe(true);
    expect(a!.startsWith("m-")).toBe(true);
  });

  it("differs by service-account key (per-account seats)", async () => {
    const a = await deriveSeatId("bvk_key_one");
    const b = await deriveSeatId("bvk_key_two");
    expect(a).not.toBe(b);
  });
});

describe("detectCi", () => {
  it("is false with no CI markers", () => {
    stashCiEnv();
    expect(detectCi()).toBe(false);
  });

  it("is true when a CI marker is present", () => {
    stashCiEnv();
    process.env["GITHUB_ACTIONS"] = "true";
    expect(detectCi()).toBe(true);
  });

  it("ignores falsey marker values", () => {
    stashCiEnv();
    process.env["CI"] = "false";
    expect(detectCi()).toBe(false);
  });
});

/**
 * La identidad de asiento es la base de la facturación por asiento, y en
 * contenedores era inestable: HOSTNAME es el id del contenedor (Docker) o lleva
 * el sufijo del pod (k8s), así que cambiaba en CADA reinicio. Como
 * billable_seats exige >= 3 días distintos por asiento, un contenedor que se
 * reinicia a diario nunca acumula tres días con el mismo id y la base
 * facturable cae a CERO.
 */
describe("identidad de asiento en entornos efímeros", () => {
  const guardado = { ...process.env };
  afterEach(() => {
    for (const k of Object.keys(process.env)) if (!(k in guardado)) delete process.env[k];
    Object.assign(process.env, guardado);
  });

  it("sobrevive al reinicio de un contenedor Docker (HOSTNAME cambia)", async () => {
    process.env.HOSTNAME = "3f2a1b9c8d7e";           // id de contenedor
    const antes = await deriveSeatId("sa-key");
    process.env.HOSTNAME = "ff11ee22dd33";           // reinicio → id nuevo
    const despues = await deriveSeatId("sa-key");
    expect(antes).toBeDefined();
    expect(despues).toBe(antes);
  });

  it("sobrevive al reprogramado de un pod de Kubernetes", async () => {
    process.env.KUBERNETES_SERVICE_HOST = "10.0.0.1";
    process.env.HOSTNAME = "api-7d9f8b6c5d-x2k9p";
    const antes = await deriveSeatId("sa-key");
    process.env.HOSTNAME = "api-7d9f8b6c5d-q7w3z";   // otro pod
    const despues = await deriveSeatId("sa-key");
    expect(despues).toBe(antes);
  });

  it("un hostname REAL sí distingue máquinas (no se ha roto el caso normal)", async () => {
    delete process.env.KUBERNETES_SERVICE_HOST;
    process.env.HOSTNAME = "portatil-de-ana";
    const a = await deriveSeatId("sa-key");
    process.env.HOSTNAME = "servidor-de-produccion";
    const b = await deriveSeatId("sa-key");
    expect(a).not.toBe(b);
  });

  it("BVSALA_SEAT_ID manda sobre cualquier deducción", async () => {
    process.env.BVSALA_SEAT_ID = "worker-03";
    process.env.HOSTNAME = "da-igual";
    expect(await deriveSeatId("sa-key")).toBe("worker-03");
  });

  it("un BVSALA_SEAT_ID con caracteres inválidos se ignora, no se propaga", async () => {
    process.env.BVSALA_SEAT_ID = "tiene espacios y ñ";
    process.env.HOSTNAME = "portatil-de-ana";
    const sid = await deriveSeatId("sa-key");
    expect(sid).not.toBe("tiene espacios y ñ");
    expect(sid).toMatch(/^m-[0-9a-f]{32}$/);
  });
});

/**
 * El colapso de asientos no era solo de contenedores: `HOSTNAME` es una
 * variable de bash INTERACTIVO y bajo systemd/launchd no existe, así que la
 * huella quedaba en platform|arch|execPath|USER|HOME — idéntica en una flota de
 * VMs clonadas. Diez máquinas facturaban como UN asiento. El fallback a
 * `os.hostname()` (que en Node existe siempre) cierra el hueco sin meter un
 * import de builtin en el bundle de navegador.
 */
describe("hostDeMaquina — el nombre estable de la máquina", () => {
  const guardado = { ...process.env };
  afterEach(() => {
    for (const k of Object.keys(process.env)) if (!(k in guardado)) delete process.env[k];
    Object.assign(process.env, guardado);
  });

  it("sin HOSTNAME en el entorno (systemd/launchd) cae a os.hostname()", async () => {
    const host = await hostDeMaquina({}, async () => "vm-prod-01");
    expect(host).toBe("vm-prod-01");
  });

  it("el HOSTNAME del entorno, si existe y es estable, sigue mandando", async () => {
    const host = await hostDeMaquina({ HOSTNAME: "portatil-de-ana" }, async () => "otro");
    expect(host).toBe("portatil-de-ana");
  });

  it("un os.hostname() efímero (id de contenedor) se descarta igual", async () => {
    expect(await hostDeMaquina({}, async () => "3f2a1b9c8d7e")).toBeUndefined();
  });

  it("dentro de Kubernetes no se usa ningún nombre, venga de donde venga", async () => {
    const host = await hostDeMaquina(
      { KUBERNETES_SERVICE_HOST: "10.0.0.1", HOSTNAME: "api-7d9f8b6c5d-x2k9p" },
      async () => "lo-que-sea",
    );
    expect(host).toBeUndefined();
  });

  it("integración: sin HOSTNAME/COMPUTERNAME el asiento sigue derivándose y es estable", async () => {
    delete process.env.HOSTNAME;
    delete process.env.COMPUTERNAME;
    delete process.env.KUBERNETES_SERVICE_HOST;
    const a = await deriveSeatId("sa-key");
    const b = await deriveSeatId("sa-key");
    expect(a).toBeDefined();
    expect(a).toBe(b);
  });
});

/**
 * El heurístico de "nombre efímero" era `-[0-9a-z]{5,10}-[0-9a-z]{5}$` y daba
 * FALSO POSITIVO sobre nombres de máquina corrientes. Como ahora se aplica
 * SIEMPRE (antes solo a `$HOSTNAME`, que bajo systemd casi nunca existe), un
 * falso positivo descarta el hostname bueno, la huella se queda sin host y la
 * flota de VMs clonadas vuelve a facturar UN asiento — el defecto que este
 * módulo cierra.
 */
describe("esNombreEfimero — distingue una máquina de un contenedor", () => {
  it("NO marca como efímeros los nombres de máquina corrientes", () => {
    for (const h of [
      "app-worker-node1", "web-server-prod1", "api-worker-node1",
      "bivelio-gateway-node1", "srv-london-node7", "db-shard-node2",
      "app-backend-blue1", "portatil-de-ana", "vm-prod-01",
    ]) {
      expect(esNombreEfimero(h), `${h} no es efímero`).toBe(false);
    }
  });

  it("SÍ marca los identificadores efímeros de verdad", () => {
    for (const h of [
      "3f2a1b9c8d7e",              // id corto de contenedor Docker
      "api-7d9f8b6c5d-x2k9p",      // <deploy>-<rs>-<pod> de k8s
      "web-5f4b7c8d9-q7w2z",   // k8s genera sus sufijos sin vocales y sin 0/1/3
      "169.254.79.129",            // hostname que en realidad es una IP
      "ip-10-0-1-23",              // EC2 con DHCP
    ]) {
      expect(esNombreEfimero(h), `${h} es efímero`).toBe(true);
    }
  });
});

describe("identidad de asiento en plataformas sin máquina (FaaS)", () => {
  const guardado = { ...process.env };
  afterEach(() => {
    for (const k of Object.keys(process.env)) if (!(k in guardado)) delete process.env[k];
    Object.assign(process.env, guardado);
  });

  it("en Lambda/Vercel/Cloud Run no se usa hostname: cada sandbox tendría el suyo", async () => {
    // Si el hostname del sandbox entrara en la huella, cada invocación sería un
    // asiento nuevo; `billable_seats` exige >= 3 días DISTINTOS por asiento, así
    // que la base facturable de la org se desplomaría a CERO.
    for (const marca of ["AWS_LAMBDA_FUNCTION_NAME", "VERCEL", "K_SERVICE", "FUNCTIONS_WORKER_RUNTIME"]) {
      const host = await hostDeMaquina({ [marca]: "1" }, async () => "sandbox-efimero-123");
      expect(host, `${marca} debe anular el hostname`).toBeUndefined();
    }
  });

  it("el asiento de una función serverless es ESTABLE entre invocaciones", async () => {
    process.env.AWS_LAMBDA_FUNCTION_NAME = "mi-funcion";
    delete process.env.HOSTNAME;
    const a = await deriveSeatId("sa-key");
    const b = await deriveSeatId("sa-key");
    expect(a).toBeDefined();
    expect(a).toBe(b);
  });
});

describe("el fallback REAL a os.hostname() (no un lector inyectado)", () => {
  const guardado = { ...process.env };
  afterEach(() => {
    for (const k of Object.keys(process.env)) if (!(k in guardado)) delete process.env[k];
    Object.assign(process.env, guardado);
  });

  it("sin HOSTNAME en el entorno, lee el hostname real de la máquina", async () => {
    // Éste es el test que faltaba: los demás inyectan su propio lector, así que
    // desactivar `nodeHostname()` por completo —o sea, revertir el arreglo—
    // dejaba la suite entera en verde.
    const real = hostname();
    if (esNombreEfimero(real)) return; // la máquina que corre los tests es efímera
    const host = await hostDeMaquina({});
    expect(host).toBe(real);
  });

  it("dos VMs clonadas con nombres distintos NO comparten asiento", async () => {
    // El caso del bloqueante: 10 VMs Ubuntu clonadas bajo systemd. Con el
    // heurístico viejo, "app-worker-node1" y "app-worker-node2" se daban por
    // efímeros, la huella perdía el host y las dos derivaban el MISMO id.
    delete process.env.KUBERNETES_SERVICE_HOST;
    process.env.HOSTNAME = "app-worker-node1";
    const a = await deriveSeatId("sa-key");
    process.env.HOSTNAME = "app-worker-node2";
    const b = await deriveSeatId("sa-key");
    expect(a).toBeDefined();
    expect(a).not.toBe(b);
  });
});

/**
 * El fallback solo es viable porque el especificador se construye en ejecución
 * (`["node","os"].join(":")`), que es lo que impide al bundler resolverlo y meter
 * `node:os` en el bundle que se sirve al navegador. Si alguien "limpia" ese join
 * a un literal, la web pública rompe — y sin esta guardia, en silencio.
 */
describe("el bundle de navegador no arrastra builtins de node", () => {
  it("public/vendor/bv-sala.js no contiene node:os", () => {
    const bundle = readFileSync(
      new URL("../apps/web/public/vendor/bv-sala.js", import.meta.url),
      "utf8",
    );
    expect(bundle).toContain("BVSALA_SEAT_ID"); // el código de asiento SÍ está dentro
    expect(bundle).not.toContain("node:os");
  });
});
