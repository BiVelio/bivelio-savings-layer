import { getTranslations } from "next-intl/server";

/**
 * LA FACTURA DE EJEMPLO NO PROMETE UNA CIFRA.
 *
 * Aquí hubo primero un «$330 → $160» escrito a mano (un 51,5 % sin ningún
 * respaldo) y después una regla de tres sobre el suelo del artefacto sintético
 * del 2026-09-12 («$100 → $90»: el «al menos un 10 %» que la portada ya no
 * publica). Ninguna de las dos era lo que un cliente obtiene: el banco público
 * mide que el ahorro depende de cuánto repite el tráfico (≈ 31 % con un 30 %
 * de repeticiones exactas, ≈ 0 % sin ellas). El diagrama enseña ahora la factura de
 * partida y, con la capa, «depende de cuánto repite tu tráfico»: nada que la
 * medición no sostenga. Su tarjeta social dice lo mismo.
 */
const FACTURA_EJEMPLO = 100;

import { Link } from "@/i18n/navigation";

/**
 * «¿Dónde se instala el ahorro?» — la explicación sin jerga de dónde actúa la
 * capa (y dónde no aplica: ChatGPT, claude.ai, Claude Code). Un solo contenido
 * para dos superficies: la página pública de la landing y la pantalla del
 * dashboard. `variant` solo cambia los destinos de los CTA — el argumento es
 * exactamente el mismo dentro y fuera.
 *
 * La honestidad aquí es parte del producto: los casos «Nada que instalar» se
 * dicen tal cual, y el caso Claude Code lleva la insignia «Ya mide» — el
 * gateway `bvsala claude` está validado de punta a punta (gateway → ingesta →
 * panel, 2026-09-01) — y el cuerpo dice lo que hay: arranca con la licencia
 * BiVelio y, con PRO, la rebaja de TTL acredita ahorro medido sobre el conteo
 * del propio proveedor (docs/PLAN-PASARELA-API-KEY.md).
 */
export async function HowItWorks({ variant }: { variant: "landing" | "app" }) {
  const t = await getTranslations("howItWorks");
  const b = (chunks: React.ReactNode) => <b>{chunks}</b>;

  const cases: { name: string; sub: string; body: React.ReactNode[]; verdict: "no" | "casi" | "mide" | "si" | "skill" }[] = [
    { name: "ChatGPT", sub: t("caseChatSub"), body: [t("caseChatBody")], verdict: "no" },
    // «Skill disponible» desde el 02-09: claude.ai no tiene factura que medir,
    // pero sí topes — y el skill savings-mode existe justo para eso. La
    // insignia dice lo que hay (un skill), no lo que aún no se ha medido.
    { name: "Claude", sub: t("caseClaudeSub"), body: [t("caseClaudeBody")], verdict: "skill" },
    // «Ya mide», no «Aún no»: desde la 0.4.5 el medidor está validado de punta a
    // punta (gateway → ingesta → panel, 01-09). El ahorro ahí es solo el de la
    // rebaja de TTL con PRO, y el cuerpo lo dice tal cual — la insignia no promete más.
    { name: "Claude Code", sub: t("caseCodeSub"), body: [t("caseCodeBody")], verdict: "mide" },
    { name: t("caseAppName"), sub: t("caseAppSub"), body: [t.rich("caseAppBody", { b })], verdict: "si" },
  ];
  const verdictLabel = { no: t("verdictNothing"), casi: t("verdictNotYet"), mide: t("verdictMeasures"), si: t("verdictYes"), skill: t("verdictSkill") } as const;

  return (
    <>
      <section className="hiw-sec">
        <h2 className="hiw-h2">{t("s1Title")}</h2>
        <p className="hiw-sub">{t("s1Sub")}</p>
        <div className="hiw-diagram">
          <div className="hiw-flow-row">
            <span className="hiw-flow-label">{t("flowWithout")}</span>
            <div className="hiw-flow">
              <div className="hiw-node">
                <div className="t">{t("nodeApp")}</div>
                <div className="s">{t("nodeAppSubBefore")}</div>
              </div>
              <span className="hiw-arrow" aria-hidden />
              <div className="hiw-node">
                <div className="t">{t("nodeApi")}</div>
                <div className="s">{t("nodeApiSubBefore")}</div>
              </div>
            </div>
            <div className="hiw-bill">
              <div className="amt">${FACTURA_EJEMPLO}</div>
              <div className="cap">{t("billMonth")}</div>
            </div>
          </div>
          <div className="hiw-flow-row">
            <span className="hiw-flow-label">{t("flowWith")}</span>
            <div className="hiw-flow">
              <div className="hiw-node">
                <div className="t">{t("nodeApp")}</div>
                <div className="s">{t("nodeAppSubAfter")}</div>
              </div>
              <span className="hiw-arrow" aria-hidden />
              <div className="hiw-node layer">
                <div className="t">BV-SALA</div>
                <div className="s">{t("nodeLayerSub")}</div>
              </div>
              <span className="hiw-arrow" aria-hidden />
              <div className="hiw-node">
                <div className="t">{t("nodeApi")}</div>
                <div className="s">{t("nodeApiSubAfter")}</div>
              </div>
            </div>
            <div className="hiw-bill">
              <div className="amt less">{t("billWith")}</div>
              <div className="cap">{t("billDepends")}</div>
            </div>
          </div>
          <p className="hiw-note">{t.rich("s1Note", { b })}</p>
        </div>
      </section>

      <section className="hiw-sec">
        <h2 className="hiw-h2">{t("s2Title")}</h2>
        <p className="hiw-sub">{t("s2Sub")}</p>
        <div className="hiw-cases">
          {cases.map((c) => (
            <div key={c.name} className="hiw-case">
              <div>
                <div className="who">
                  {c.name}
                  <small>{c.sub}</small>
                </div>
                <span className={`hiw-verdict ${c.verdict}`}>{verdictLabel[c.verdict]}</span>
              </div>
              <div>
                {c.body.map((p, i) => (
                  <p key={i}>{p}</p>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="hiw-sec">
        <h2 className="hiw-h2">{t("s3Title")}</h2>
        <p className="hiw-sub">{t("s3Sub")}</p>
        <div className="hiw-two">
          <div className="hiw-mcard">
            <span className="k">{t("mBeforeK")}</span>
            <div className="v est">{t("mBeforeV")}</div>
            <p>{t("mBeforeBody")}</p>
          </div>
          <div className="hiw-mcard">
            <span className="k">{t("mAfterK")}</span>
            <div className="v real">{t("mAfterV")}</div>
            <p>{t("mAfterBody")}</p>
          </div>
        </div>
      </section>

      <section className="hiw-sec">
        <h2 className="hiw-h2">{t("s4Title")}</h2>
        <pre className="hiw-pre">
          <span className="n"># 1 · {t("snip1")}</span>{"\n"}
          {"pnpm add "}<span className="s">@bivelio/savings-layer</span>{"\n\n"}
          <span className="n"># 2 · {t("snip3")}</span>{"\n"}
          <span className="k">const</span>{" layer = createSavingsLayer({ provider });\n"}
          <span className="k">const</span>{" { text, report } = "}<span className="k">await</span>{" layer.generate({ model, messages });\n\n"}
          {"console.log(report.cost.netSavingsRatio)  "}
          <span className="g">{"// ← "}{t("snipResult")}</span>
        </pre>
        <div className="hiw-cta">
          {variant === "landing" ? (
            <>
              {/* El botón dice «ver el ahorro medido», y eso vive en #measured (el
                  banco publicado). #verify también existe en la portada, pero es
                  el verificador: una palanca sobre tus datos, no un ahorro medido;
                  llevar este botón allí prometería lo que la sección no enseña. */}
              <Link className="btn btn-primary" href="/#measured">{t("ctaVerify")}</Link>
              <Link className="btn btn-ghost" href="/signup">{t("ctaSignup")}</Link>
            </>
          ) : (
            <>
              <Link className="btn btn-primary" href="/dashboard/install">{t("ctaInstall")}</Link>
              <Link className="btn btn-ghost" href="/dashboard/verify">{t("ctaVerify")}</Link>
            </>
          )}
        </div>
      </section>
    </>
  );
}
