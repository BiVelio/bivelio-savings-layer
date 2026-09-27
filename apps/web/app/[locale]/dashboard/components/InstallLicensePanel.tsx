import type { ReactNode } from "react";

import { getLocale, getTranslations } from "next-intl/server";

import { preciosDelPlan } from "@/lib/stripe/pricing";
import { formatearPrecio } from "@/lib/format/precio";

import { SnippetPorSistema } from "@/app/components/SnippetPorSistema";

import type { OrgContext } from "../data";
import { CopyButton } from "./CopyButton";
import { ServiceAccountKeySection } from "./ServiceAccountKeySection";
import { TrialKeyButton } from "./TrialKeyButton";

/**
 * EL FRAGMENTO TIENE QUE COMPILAR PEGADO TAL CUAL, y no compilaba: `yourProvider`,
 * `model`, `messages` y `response` eran identificadores inexistentes — cuatro
 * errores de tsc en las dos líneas que importan. Y en toda la documentación no
 * había UN SOLO ejemplo de proveedor real, así que el paso que convierte a quien
 * ha pagado en quien funciona terminaba en un ejercicio para el lector.
 *
 * `test/fragmento-instalacion.test.ts` lo compila de verdad contra los tipos
 * publicados, así que no puede volver a derivar en silencio.
 */
const WRAP = `import { createSavingsLayer, OpenAICompatibleProvider } from "@bivelio/savings-layer";

// 1 · your provider. LLM traffic goes straight to it — the SDK never proxies it.
//     Any OpenAI-compatible endpoint works: OpenAI, Azure, vLLM, a gateway.
const provider = new OpenAICompatibleProvider({
  baseUrl: "https://api.openai.com/v1",
  apiKey: process.env.OPENAI_API_KEY,
});

// 2 · the layer, wrapped around it.
const layer = createSavingsLayer({
  provider,
  licenseKey: process.env.BIVELIO_LICENSE_KEY,          // step 1 — unlocks the SDK
  serviceAccountKey: process.env.BIVELIO_SERVICE_KEY,   // step 2 — metering + auto-renewal
  licenseServerUrl: "https://savings.bivelio.com",      // revocation, renewal + metering — omit it and step 2 does nothing
});

// 3 · call it exactly where you called your provider before.
const { text, report } = await layer.generate({
  model: "openai/gpt-4o-mini",
  messages: [{ role: "user", content: "What is 2 + 2 * 3?" }],
});

console.log(text);                    // the answer
console.log(report.cost.netSavings);  // → 0..1: the share of the baseline you did not pay
console.log(report.cost.basis);       // → "measured" | "reference" | "estimated" | "unmeasured" — how it was obtained`;

/**
 * LA VÍA RECOMENDADA DESDE LA 0.4.26: `init` lee el package.json del proyecto,
 * detecta la pila e imprime el cableado exacto y una comprobación que no llama al
 * modelo. No escribe nada sin permiso (con `--write`, solo ficheros nuevos y tras
 * preguntar), así que puede ir primero sin letra pequeña. `@latest` a propósito:
 * una copia vieja en caché de npx no trae `init` (gateway/init.ts, y el informe de
 * onboarding del 27-09-2026, §7 y §9).
 */
const INIT = "npx @bivelio/savings-layer@latest init";

/**
 * Los agentes de código con envoltorio propio, en el orden de la ayuda de
 * `bvsala` (gateway/bin.ts). Tiene que coincidir con TERMINALES_CON_ENVOLTORIO
 * (gateway/envoltorios.ts): un comando que el binario no conoce imprime la ayuda
 * y sale con 1, y la web lo habría anunciado. El nombre del producto no se
 * traduce; Cursor y Gemini CLI NO van aquí porque no se pueden medir hoy
 * (docs/terminales/no-soportados.md): lo dice `agentsNote`.
 */
const AGENTES: readonly (readonly [comando: string, producto: string])[] = [
  ["claude", "Claude Code"],
  ["codex", "Codex CLI"],
  ["goose", "Goose"],
  ["qwen", "Qwen Code"],
  ["opencode", "opencode"],
  ["kilo", "Kilo CLI"],
  ["copilot", "GitHub Copilot CLI"],
  ["aider", "Aider"],
];

/**
 * Colorea UNA línea del fragmento para lectura: la línea de paso («// N ·») en
 * azul de marca, los comentarios en suave, las palabras clave en azul y las
 * cadenas en ámbar — la misma paleta que el snippet de la landing y el de
 * /how-it-works. Solo presentación: lo que copia el botón sigue siendo WRAP
 * tal cual, y el test que compila WRAP no ve nada de esto.
 */
function lineaColoreada(linea: string, key: number) {
  if (/^\s*\/\//.test(linea)) {
    const paso = /^\s*\/\/ \d+ ·/.test(linea);
    return (
      <span key={key} className={paso ? "n" : "c"}>
        {linea}
        {"\n"}
      </span>
    );
  }
  // Comentario final: «espacio + // + espacio». El «//» de una URL va pegado a
  // los dos puntos, así que no puede confundirse con un comentario.
  const m = linea.match(/^(.*?)(\s\/\/ .*)$/);
  const codigo = m ? m[1]! : linea;
  const comentario = m ? m[2]! : "";
  const partes: ReactNode[] = [];
  const rx = /("[^"]*")|\b(import|from|const|await|new)\b/g;
  let ultimo = 0;
  let tramo: RegExpExecArray | null;
  let i = 0;
  while ((tramo = rx.exec(codigo))) {
    if (tramo.index > ultimo) partes.push(codigo.slice(ultimo, tramo.index));
    partes.push(
      tramo[1] ? (
        <span key={`s${i}`} className="s">{tramo[1]}</span>
      ) : (
        <span key={`k${i}`} className="k">{tramo[2]}</span>
      ),
    );
    ultimo = tramo.index + tramo[0].length;
    i += 1;
  }
  if (ultimo < codigo.length) partes.push(codigo.slice(ultimo));
  return (
    <span key={key}>
      {partes}
      {comentario ? <span className="c">{comentario}</span> : null}
      {"\n"}
    </span>
  );
}

export async function InstallLicensePanel({ ctx }: { ctx: OrgContext }) {
  const t = await getTranslations("dashboard");
  const tSkill = await getTranslations("landing.skill");
  // El precio, del Price de Stripe y formateado aquí (servidor) para bajarlo ya
  // hecho al botón, que es de cliente.
  const locale = await getLocale();
  const precios = await preciosDelPlan();
  const precioMensual = formatearPrecio(locale, precios.monthly);
  const precioAnual = formatearPrecio(locale, precios.yearly);
  return (
    <section className="ck-sec">
      <div className="ck-head">
        <div>
          <p className="ck-eyebrow">{t("installLicensePanel.eyebrow")}</p>
          <h2>{t("installLicensePanel.heading")}</h2>
        </div>
      </div>

      {/* 1 · license key (unlocks the fail-closed SDK) */}
      <p className="ck-note" style={{ marginTop: 0 }}>
        {t.rich("installLicensePanel.step1", {
          b: (chunks) => <b>{chunks}</b>,
          code: (chunks) => <code>{chunks}</code>,
        })}
      </p>
      <TrialKeyButton monthly={precioMensual} yearly={precioAnual} />

      {/* 2 · service-account key (the machine credential for metering) */}
      <p className="ck-note">
        {t.rich("installLicensePanel.step2", {
          b: (chunks) => <b>{chunks}</b>,
          code: (chunks) => <code>{chunks}</code>,
        })}
      </p>
      <ServiceAccountKeySection />
      <div className="keycard" style={{ marginTop: 10 }}>
        <div>
          <div className="ck-note" style={{ margin: 0 }}>{t("installLicensePanel.currentKey")}</div>
          <div className="k">{ctx.serviceAccount ? `${ctx.serviceAccount.keyPrefix}…` : t("installLicensePanel.noneYet")}</div>
        </div>
        <div className="ck-note" style={{ margin: 0 }}>{t("installLicensePanel.shownOnce")}</div>
      </div>

      {/* Por qué esta clave NO es opcional: sin ella nadie recoge la licencia
          renovada y el despliegue se para al acabar la gracia, pagando. El panel
          la describía solo como telemetría, así que quien no quería telemetría la
          borraba del snippet y se quedaba sin producto sin ninguna pista. */}
      <p className="ck-note" style={{ marginTop: 10 }}>
        {t.rich("installLicensePanel.renewalNote", { b: (chunks) => <b>{chunks}</b> })}
      </p>

      {/* 3 · un comando: `init` detecta la pila e imprime el cableado exacto. Es la
          vía recomendada; el cableado a mano sigue debajo como alternativa. */}
      <p className="ck-note">
        {t.rich("installLicensePanel.step3", { b: (chunks) => <b>{chunks}</b> })}
      </p>
      <div className="code2">
        <span>{INIT}</span>
        <CopyButton text={INIT} />
      </div>
      <p className="ck-note">
        {t.rich("installLicensePanel.initNote", { code: (chunks) => <code>{chunks}</code> })}
      </p>

      {/* La alternativa: instalar (npm público, sin token) y cablear a mano. */}
      <p className="ck-note" style={{ marginTop: 12 }}>
        {t.rich("installLicensePanel.manualInstall", { b: (chunks) => <b>{chunks}</b> })}
      </p>
      <div className="code2">
        <span>pnpm add @bivelio/savings-layer</span>
        <CopyButton text="pnpm add @bivelio/savings-layer" />
      </div>
      <p className="ck-note">{t("installLicensePanel.manualWire")}</p>
      <div className="code2">
        <pre className="code-multi">{WRAP.split("\n").map((l, i) => lineaColoreada(l, i))}</pre>
        <CopyButton text={WRAP} />
      </div>

      <p className="ck-note" style={{ marginTop: 12 }}>
        {t.rich("installLicensePanel.finalNote", {
          code: (chunks) => <code>{chunks}</code>,
        })}
      </p>

      {/* Terminal (gateway) — la vía sin código: medir los agentes de código.
          La clave de servicio del paso 2 es la única credencial que se exporta:
          con ella el gateway recoge la licencia, sin la cual no arranca. */}
      <p className="ck-note" style={{ marginTop: 16 }}>
        {t.rich("installLicensePanel.gatewayNote", {
          b: (chunks) => <b>{chunks}</b>,
          code: (chunks) => <code>{chunks}</code>,
        })}
      </p>
      <div className="code2">
        <span>npm i -g @bivelio/savings-layer</span>
        <CopyButton text="npm i -g @bivelio/savings-layer" />
      </div>
      {/* La línea de la clave difiere por sistema: `export` es POSIX y en
          Windows (PowerShell) es `$env:VAR = "…"`. Pestañas con detección. */}
      <div style={{ marginTop: 8 }}>
        <SnippetPorSistema
          unix={
            <div className="code2">
              <span>export BIVELIO_SERVICE_KEY=bvk_…</span>
              <CopyButton text="export BIVELIO_SERVICE_KEY=" />
            </div>
          }
          windows={
            <div className="code2">
              <span>{'$env:BIVELIO_SERVICE_KEY = "bvk_…"'}</span>
              <CopyButton text={'$env:BIVELIO_SERVICE_KEY = ""'} />
            </div>
          }
        />
      </div>
      {/* Los comandos de los envoltorios son iguales en los dos sistemas: van
          fuera de las pestañas. Sin botón de copiar: se elige UNO de la lista. */}
      <div className="code2" style={{ marginTop: 8 }}>
        <pre className="code-multi">
          {AGENTES.map(([comando, producto]) => (
            <span key={comando}>
              <span className="k">bvsala</span>
              {` ${comando.padEnd(10)}`}
              <span className="c">{`# ${producto}`}</span>
              {"\n"}
            </span>
          ))}
          <span className="k">bvsala</span>
          {` ${"doctor".padEnd(10)}`}
          <span className="c">{`# ${t("installLicensePanel.doctorComment")}`}</span>
        </pre>
      </div>
      <p className="ck-note" style={{ marginTop: 10 }}>
        {t.rich("installLicensePanel.agentsNote", {
          b: (chunks) => <b>{chunks}</b>,
          code: (chunks) => <code>{chunks}</code>,
        })}
      </p>
      {/* Python: el cliente `bvsala` de packages/python habla con este mismo
          gateway y le pide el informe de cada petición (rutas locales, 0.4.26 o
          posterior). No está en PyPI y el repositorio es privado: la nota da la
          instalación que documenta packages/python/README.md y dice las dos
          cosas, en vez de inventar un `pip install` de PyPI que no existe. */}
      <p className="ck-note" style={{ marginTop: 10 }}>
        {t.rich("installLicensePanel.pythonNote", {
          b: (chunks) => <b>{chunks}</b>,
          code: (chunks) => <code>{chunks}</code>,
        })}
      </p>
      {/* El skill savings-mode, también aquí: el login no honra `next`, así que
          quien vino de la landing a por el zip aterriza en el panel — y lo
          encuentra sin volver atrás. Claves REUTILIZADAS de landing.skill: el
          panel y la landing no pueden contar dos historias del mismo skill. */}
      <p className="ck-note" style={{ marginTop: 14 }}>
        <a href="/api/skill/descargar">{tSkill("aiDescargar")}</a> · {tSkill("ccNota")}
      </p>
    </section>
  );
}
