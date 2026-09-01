import type { ReactNode } from "react";

import { getLocale, getTranslations } from "next-intl/server";

import { preciosDelPlan } from "@/lib/stripe/pricing";
import { formatearPrecio } from "@/lib/format/precio";

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
  licenseServerUrl: "https://savings.bivelio.com",      // license check, kill-switch + metering
});

// 3 · call it exactly where you called your provider before.
const { text, report } = await layer.generate({
  model: "openai/gpt-4o-mini",
  messages: [{ role: "user", content: "What is 2 + 2 * 3?" }],
});

console.log(text);                    // the answer
console.log(report.cost.netSavings);  // → your net savings, per request`;

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

      {/* 3 · install (public npm, zero auth) */}
      <p className="ck-note">
        {t.rich("installLicensePanel.step3", { b: (chunks) => <b>{chunks}</b> })}
      </p>
      <div className="code2">
        <span>pnpm add @bivelio/savings-layer</span>
        <CopyButton text="pnpm add @bivelio/savings-layer" />
      </div>

      {/* 4 · wire + run */}
      <p className="ck-note">{t.rich("installLicensePanel.step4", { b: (chunks) => <b>{chunks}</b> })}</p>
      <div className="code2">
        <pre className="code-multi">{WRAP.split("\n").map((l, i) => lineaColoreada(l, i))}</pre>
        <CopyButton text={WRAP} />
      </div>

      <p className="ck-note" style={{ marginTop: 12 }}>
        {t.rich("installLicensePanel.finalNote", {
          code: (chunks) => <code>{chunks}</code>,
        })}
      </p>

      {/* 5 · terminal (gateway) — la vía sin código: medir Claude Code/Codex.
          Solo mide; la clave de servicio del paso 2 es la única credencial. */}
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
      <div className="code2" style={{ marginTop: 8 }}>
        <span>bvsala claude</span>
        <CopyButton text="bvsala claude" />
      </div>
    </section>
  );
}
