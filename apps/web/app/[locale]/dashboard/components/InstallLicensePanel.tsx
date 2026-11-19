import type { ReactNode } from "react";

import { getLocale, getTranslations } from "next-intl/server";

import { tarifasDeLosPlanes } from "@/lib/stripe/pricing";
import { formatearPrecio } from "@/lib/format/precio";

import { ArrowRightIcon, CloudIcon, CodeIcon, KeyIcon, LaptopIcon, TerminalIcon } from "@/app/components/icons";
import { SnippetPorSistema } from "@/app/components/SnippetPorSistema";
// Importadas por fichero y no desde el índice: el índice arrastra `Recibo`, que
// trae el `Link` de next-intl, y este componente se renderiza también fuera de
// Next (`instalacion-renderiza.test.ts`).
import { CodeFrame } from "@/app/components/ui/CodeFrame";
import { Notice } from "@/app/components/ui/Notice";
import { puede } from "@/lib/org/permisos";

import type { OrgContext } from "../data";
import { ServiceAccountKeySection } from "./ServiceAccountKeySection";
import { TrialKeyButton } from "./TrialKeyButton";
import { MeasureClaimButton } from "./MeasureClaimButton";
import { LIMITES_MEDIR } from "@/lib/license/medir";

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

// 2 · the layer, wrapped around it. OPEN CORE: nothing else is required —
//     COMMUNITY mode (every local lever on, zero telemetry). The three lines
//     below read your keys from the environment: with none set they do nothing
//     and nothing is sent to BiVelio; with them, usage reaches this dashboard.
const layer = createSavingsLayer({
  provider,
  licenseKey: process.env.BIVELIO_LICENSE_KEY || undefined,        // step 1 (optional)
  serviceAccountKey: process.env.BIVELIO_SERVICE_KEY || undefined, // step 2 (optional) — metering + auto-renewal
  licenseServerUrl: "https://savings.bivelio.com",                 // revocation, renewal + metering
});

// 3 · call it exactly where you called your provider before.
const { text, report } = await layer.generate({
  model: "openai/gpt-4o-mini",
  messages: [{ role: "user", content: "What is 2 + 2 * 3?" }],
});

console.log(text);                    // the answer
console.log(report.cost.netSavingsRatio);  // → 0..1: the share of the baseline you did not pay
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
 * traduce; Cursor NO va aquí (no es un envoltorio: se configura por la UI con
 * su override de base URL, docs/terminales/cursor.md): lo dice `agentsNote`.
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
  ["gemini", "Gemini CLI"],
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

/**
 * El titular de «Empezar» son dos frases («Tres pasos. Tus prompts nunca…»):
 * la Firma de campaña pone la segunda en serif cursiva. Se parte por la
 * primera frase terminada en «.», «!» o «?» seguida de espacio, que es como
 * viene en los doce idiomas; si un catálogo no la trae así, el titular se
 * pinta entero sin cursiva y no se pierde nada.
 */
export function partirEnDosFrases(texto: string): [string, string] | null {
  const m = /^(.+?[.!?])\s+(\S[\s\S]*)$/u.exec(texto);
  return m ? [m[1]!, m[2]!] : null;
}

function TitularDeDosFrases({ texto }: { texto: string }) {
  const partes = partirEnDosFrases(texto);
  if (!partes) return <>{texto}</>;
  return (
    <>
      {partes[0]} <em>{partes[1]}</em>
    </>
  );
}

/**
 * REDISEÑO 2026-11 — DOS TAREAS, NO UNA PARED DE COMANDOS. La página responde
 * primero a «¿qué quieres conectar?» (una aplicación con el SDK, o un agente
 * de código con el gateway) y a «¿local o Cloud?», y después da cada recorrido
 * en su sección, con sus anclas de siempre (`#sdk`, `#gateway`) y una nueva
 * para las credenciales (`#cloud`).
 *
 * Los comandos y el fragmento son los MISMOS (`INIT`, `WRAP`, `AGENTES`): solo
 * cambia el envoltorio, que ahora es el marco de código compartido con su
 * botón de copiar y, donde ayuda, el resultado esperado al lado. Las claves
 * NO van en ese marco: la licencia y la clave de servicio conservan su propio
 * control de copia y su «se muestra una sola vez».
 *
 * ESTE COMPONENTE SE RENDERIZA TAMBIÉN FUERA DE NEXT (`renderToString` en
 * `instalacion-renderiza.test.ts`, con un `ctx` casi vacío): por dentro solo
 * hay componentes síncronos o de cliente, y `ctx` se lee con cuidado.
 */

export async function InstallLicensePanel({ ctx }: { ctx: OrgContext }) {
  const t = await getTranslations("dashboard");
  const tSkill = await getTranslations("landing.skill");
  // El precio, del Price de Stripe y formateado aquí (servidor) para bajarlo ya
  // hecho al botón, que es de cliente.
  const locale = await getLocale();
  // Pro (2026-09-29): la modalidad con comisión ya no se vende a clientes nuevos.
  const pro = (await tarifasDeLosPlanes()).pro;
  const precioMensual = formatearPrecio(locale, { amount: pro.monthly.asientoCentimos, currency: pro.monthly.currency });
  const precioAnual = formatearPrecio(locale, { amount: pro.yearly.asientoCentimos, currency: pro.yearly.currency });
  const copiar = (texto: string) => ({ texto, etiqueta: t("copyButton.copy"), etiquetaCopiado: t("copyButton.copied") });
  const terminal = t("installLicensePanel.terminal");
  const u = await getTranslations("ui");
  const esperado = u("code.expected");
  // La interfaz refleja la autorización, no la sustituye: las rutas deciden.
  const gestionaClaves = puede(ctx.role, "gestionar_claves");
  return (
    <div className="ins">
      {/* 0 · Qué se conecta, y en qué modo. */}
      <section className="ins-choose" aria-labelledby="ins-tasks-title">
        <div className="pfc-sec-cab ins-cab">
          <p className="pfc-rotulo">{t("installLicensePanel.eyebrow")}</p>
          <h2 className="pfc-sec-t" id="ins-tasks-title">
            <TitularDeDosFrases texto={t("installLicensePanel.heading")} />
          </h2>
        </div>
        <div className="ins-tasks">
          <a className="ins-task" href="#sdk">
            <span className="ins-task-ic" aria-hidden>
              <CodeIcon />
            </span>
            <span className="ins-task-t">{t("installLicensePanel.sdkTitle")}</span>
            <span className="ins-task-s">{t("installLicensePanel.sdkLede")}</span>
            {/* El comando REAL de cada recorrido, a la vista antes de bajar: el
                mismo `INIT` de la sección, no un texto de adorno. */}
            <span className="ins-task-cmd" aria-hidden>
              <span className="ins-task-prompt">$</span> {INIT}
            </span>
            <span className="ins-task-go" aria-hidden>
              <ArrowRightIcon />
            </span>
          </a>
          <a className="ins-task" href="#gateway">
            <span className="ins-task-ic" aria-hidden>
              <TerminalIcon />
            </span>
            <span className="ins-task-t">{t("installLicensePanel.gatewayTitle")}</span>
            <span className="ins-task-s">{t("installLicensePanel.gatewayLede")}</span>
            <span className="ins-task-cmd" aria-hidden>
              <span className="ins-task-prompt">$</span> bvsala {AGENTES[0]![0]}
            </span>
            <span className="ins-task-go" aria-hidden>
              <ArrowRightIcon />
            </span>
          </a>
        </div>
        <dl className="ins-modes">
          <div className="ins-mode">
            <dt>
              <span className="ins-mode-ic" aria-hidden>
                <LaptopIcon />
              </span>
              {t("installLicensePanel.modeLocalTitle")}
            </dt>
            <dd>{t("installLicensePanel.modeLocalBody")}</dd>
          </div>
          <div className="ins-mode">
            <dt>
              <span className="ins-mode-ic" aria-hidden>
                <CloudIcon />
              </span>
              {t("installLicensePanel.modeCloudTitle")}
            </dt>
            <dd>
              {t("installLicensePanel.modeCloudBody")} <a href="#cloud">{t("installLicensePanel.modeCloudLink")}</a>
            </dd>
          </div>
        </dl>
      </section>

      {/* A · Conexión Cloud: licencia y clave de servicio. Opcional con el motor abierto. */}
      <section className="ck-sec ins-sec" id="cloud" aria-labelledby="ins-cloud-title">
        <div className="pfc-sec-cab ins-cab">
          <p className="pfc-rotulo">{t("installLicensePanel.cloudEyebrow")}</p>
          <div className="ins-sec-head">
            <h2 className="pfc-sec-t" id="ins-cloud-title">{t("installLicensePanel.cloudTitle")}</h2>
            <span className="pfc-insignia ins-optional">{t("installLicensePanel.optional")}</span>
          </div>
        </div>
        {gestionaClaves ? null : (
          <Notice tono="info" role="note" className="ins-role">
            {t("installLicensePanel.roleLimited")}
          </Notice>
        )}
        <div className="ins-card">
          {/* 1 · license key (unlocks the fail-closed SDK) */}
          <p className="ck-note ins-step">
            {t.rich("installLicensePanel.step1", {
              b: (chunks) => <b>{chunks}</b>,
              code: (chunks) => <code>{chunks}</code>,
            })}
          </p>
          <TrialKeyButton monthly={precioMensual} yearly={precioAnual} />

          {/* La alternativa gratuita y sin tarjeta: la licencia Medir (modo sombra).
              No se le ofrece a quien ya paga. */}
          {ctx.medir !== "de-pago" ? (
            <div className="ins-measure">
              <p className="ck-note ins-step">
                <b>{t("measurePlan.title")}</b>
              </p>
              <MeasureClaimButton seats={LIMITES_MEDIR.asientos} />
            </div>
          ) : null}
        </div>

        <div className="ins-card">
          {/* 2 · service-account key (the machine credential for metering) */}
          <p className="ck-note ins-step">
            {t.rich("installLicensePanel.step2", {
              b: (chunks) => <b>{chunks}</b>,
              code: (chunks) => <code>{chunks}</code>,
            })}
          </p>
          <ServiceAccountKeySection />
          <div className="keycard ins-keycard">
            <span className="ins-key-ic" aria-hidden>
              <KeyIcon />
            </span>
            <div className="ins-key-txt">
              <div className="ck-note">{t("installLicensePanel.currentKey")}</div>
              <div className="k">{ctx.serviceAccount ? `${ctx.serviceAccount.keyPrefix}…` : t("installLicensePanel.noneYet")}</div>
            </div>
            <div className="ck-note ins-key-once">{t("installLicensePanel.shownOnce")}</div>
          </div>

          {/* Por qué esta clave NO es opcional: sin ella nadie recoge la licencia
              renovada y el despliegue se para al acabar la gracia, pagando. El panel
              la describía solo como telemetría, así que quien no quería telemetría la
              borraba del snippet y se quedaba sin producto sin ninguna pista. */}
          <p className="ck-note">
            {t.rich("installLicensePanel.renewalNote", { b: (chunks) => <b>{chunks}</b> })}
          </p>
          <p className="ck-note ins-perms">{t("installLicensePanel.permissionsNote")}</p>
        </div>
      </section>

      {/* B · Integrar una aplicación (SDK). */}
      <section className="ck-sec ins-sec" id="sdk" aria-labelledby="ins-sdk-title">
        <div className="pfc-sec-cab ins-cab">
          <p className="pfc-rotulo">{t("installLicensePanel.sdkEyebrow")}</p>
          <h2 className="pfc-sec-t" id="ins-sdk-title">{t("installLicensePanel.sdkTitle")}</h2>
        </div>
        {/* 3 · un comando: `init` detecta la pila e imprime el cableado exacto. Es la
            vía recomendada; el cableado a mano sigue debajo como alternativa. */}
        <p className="ck-note ins-step">
          {t.rich("installLicensePanel.step3", { b: (chunks) => <b>{chunks}</b> })}
        </p>
        <CodeFrame etiqueta={terminal} copiar={copiar(INIT)} salida={{ etiqueta: esperado, contenido: t("installLicensePanel.initExpected") }}>
          <span>{INIT}</span>
        </CodeFrame>
        <p className="ck-note">
          {t.rich("installLicensePanel.initNote", { code: (chunks) => <code>{chunks}</code> })}
        </p>

        {/* La alternativa: instalar (npm público, sin token) y cablear a mano. */}
        <p className="ck-note ins-step">
          {t.rich("installLicensePanel.manualInstall", { b: (chunks) => <b>{chunks}</b> })}
        </p>
        <CodeFrame etiqueta={terminal} copiar={copiar("pnpm add @bivelio/savings-layer")}>
          <span>pnpm add @bivelio/savings-layer</span>
        </CodeFrame>
        <p className="ck-note">{t("installLicensePanel.manualWire")}</p>
        <CodeFrame
          etiqueta="TypeScript"
          lineas={WRAP.split("\n").length}
          copiar={copiar(WRAP)}
          salida={{ etiqueta: esperado, contenido: t("installLicensePanel.wireExpected") }}
        >
          <pre className="code-multi">{WRAP.split("\n").map((l, i) => lineaColoreada(l, i))}</pre>
        </CodeFrame>

        <p className="ck-note">
          {t.rich("installLicensePanel.finalNote", {
            code: (chunks) => <code>{chunks}</code>,
          })}
        </p>
      </section>

      {/* C · Terminal (gateway) — la vía sin código: medir los agentes de código.
          Open core: sin claves arranca en modo Community (todo el ahorro local,
          cero telemetría); la clave de servicio es OPCIONAL y añade el panel y
          los entitlements de la org. */}
      <section className="ck-sec ins-sec" id="gateway" aria-labelledby="ins-gateway-title">
        <div className="pfc-sec-cab ins-cab">
          <p className="pfc-rotulo">{t("installLicensePanel.gatewayEyebrow")}</p>
          <h2 className="pfc-sec-t" id="ins-gateway-title">{t("installLicensePanel.gatewayTitle")}</h2>
        </div>
        <p className="ck-note ins-step">
          {t.rich("installLicensePanel.gatewayNote", {
            b: (chunks) => <b>{chunks}</b>,
            code: (chunks) => <code>{chunks}</code>,
          })}
        </p>
        <CodeFrame etiqueta={terminal} copiar={copiar("npm i -g @bivelio/savings-layer")}>
          <span>npm i -g @bivelio/savings-layer</span>
        </CodeFrame>
        {/* La línea de la clave difiere por sistema: `export` es POSIX y en
            Windows (PowerShell) es `$env:VAR = "…"`. Pestañas con detección.
            OPCIONAL: sin ella, modo Community. */}
        <SnippetPorSistema
          etiqueta={terminal}
          unix={
            <CodeFrame etiqueta={terminal} copiar={copiar("export BIVELIO_SERVICE_KEY=")}>
              <span>export BIVELIO_SERVICE_KEY=bvk_…  </span>
              <span className="c"># optional: cloud dashboard + org entitlements</span>
            </CodeFrame>
          }
          windows={
            <CodeFrame etiqueta="PowerShell" copiar={copiar('$env:BIVELIO_SERVICE_KEY = ""')}>
              <span>{'$env:BIVELIO_SERVICE_KEY = "bvk_…"  '}</span>
              <span className="c"># optional: cloud dashboard + org entitlements</span>
            </CodeFrame>
          }
        />
        {/* Los comandos de los envoltorios son iguales en los dos sistemas: van
            fuera de las pestañas. Sin botón de copiar: se elige UNO de la lista. */}
        <CodeFrame etiqueta={terminal} salida={{ etiqueta: esperado, contenido: t("installLicensePanel.agentsExpected") }}>
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
        </CodeFrame>
        <p className="ck-note">
          {t.rich("installLicensePanel.agentsNote", {
            b: (chunks) => <b>{chunks}</b>,
            code: (chunks) => <code>{chunks}</code>,
          })}
        </p>
        {/* Python: el cliente `bvsala` de packages/python habla con este mismo
            gateway y le pide el informe de cada petición (rutas locales, 0.4.26 o
            posterior). Está en PyPI como `bivelio-savings-layer`
            (docs/PUBLICAR-PYPI.md): la nota da el `pip install` que documenta
            packages/python/README.md, y el `import bvsala` que no se deduce del
            nombre del paquete. */}
        <p className="ck-note">
          {t.rich("installLicensePanel.pythonNote", {
            b: (chunks) => <b>{chunks}</b>,
            code: (chunks) => <code>{chunks}</code>,
          })}
        </p>
        {/* El skill savings-mode, también aquí: el login no honra `next`, así que
            quien vino de la landing a por el zip aterriza en el panel — y lo
            encuentra sin volver atrás. Claves REUTILIZADAS de landing.skill: el
            panel y la landing no pueden contar dos historias del mismo skill. */}
        <p className="ck-note ins-skill">
          <span className="ins-skill-ic" aria-hidden>
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" focusable="false">
              <path d="M8 2.5v7.5M4.75 7 8 10.25 11.25 7M3 13h10" />
            </svg>
          </span>
          <span>
            <a href="/api/skill/descargar">{tSkill("aiDescargar")}</a> · {tSkill("ccNota")}
          </span>
        </p>
      </section>
    </div>
  );
}
