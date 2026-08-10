import { describe, it, expect, afterEach } from "vitest";

import { deriveSeatId, detectCi, hostDeMaquina } from "../src/metering/seat.js";

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
