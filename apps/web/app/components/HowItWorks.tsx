import type { ReactNode } from "react";

import { getLocale, getTranslations } from "next-intl/server";

import { CodeFrame, EvidenceBadge, Recibo, SectionHead } from "@/app/components/ui";
import { Link } from "@/i18n/navigation";
import { Badge, type BadgeTone } from "@/vendor/affectui/badge-clean";
import { IntegrationBeam } from "@/vendor/affectui/integration-beam";
import { LayerStack, type LayerIcon } from "@/vendor/affectui/layer-stack";

/**
 * LA FACTURA DE EJEMPLO NO PROMETE UNA CIFRA.
 *
 * Aquí hubo primero un «$330 → $160» escrito a mano (un 51,5 % sin ningún
 * respaldo) y después una regla de tres sobre el suelo del artefacto sintético
 * del 2026-09-12 («$100 → $90»: el «al menos un 10 %» que la portada ya no
 * publica). Ninguna de las dos era lo que un cliente obtiene: el banco público
 * mide que el ahorro depende de cuánto repite el tráfico (≈ 31 % con un 30 %
 * de repeticiones exactas, ≈ 0 % sin ellas). El recibo enseña ahora la factura de
 * partida y, con la capa, «depende de cuánto repite tu tráfico»: nada que la
 * medición no sostenga. Su tarjeta social dice lo mismo. Y como no es una cifra
 * medida, el recibo lleva la franja permanente de «ejemplo ilustrativo».
 */
const FACTURA_EJEMPLO = 100;

/** Las cinco piezas del mapa (`pieces.<clave>.*`), de arriba abajo, con su icono en la lámina. */
const PIEZAS: readonly { clave: "sdk" | "gateway" | "measure" | "cloud" | "evidence"; icono: LayerIcon }[] = [
  { clave: "sdk", icono: "plug" },
  { clave: "gateway", icono: "bolt" },
  { clave: "measure", icono: "pulse" },
  { clave: "cloud", icono: "database" },
  { clave: "evidence", icono: "spark" },
];

/**
 * El tono de la insignia de cada caso (Badge de affectUI). El color acompaña;
 * el veredicto lo dicen las palabras: «nada que instalar» es neutro, no un error.
 */
const TONO_DEL_VEREDICTO: Record<"no" | "casi" | "mide" | "si" | "skill", BadgeTone> = {
  no: "neutral",
  casi: "warning",
  mide: "info",
  skill: "info",
  si: "success",
};

/**
 * «¿Dónde se instala el ahorro?» — la explicación sin jerga de dónde actúa la
 * capa (y dónde no aplica: ChatGPT, claude.ai, Claude Code). Un contenido para
 * dos superficies: la página pública y la pantalla del panel.
 *
 *  - `landing` lo cuenta entero: la arquitectura ilustrada (el camino de una
 *    petición), las dos formas de instalarlo (SDK en proceso / gateway como
 *    proxy local), los casos, el mapa de piezas, estimación frente a medición
 *    y la instalación.
 *  - `app` es la versión breve y contextual del panel: la arquitectura, los
 *    casos, las dos cifras y una acción de instalar. Sin tipografía editorial:
 *    allí los títulos son los del panel (`.hiw-h2`).
 *
 * Lo que el dibujo NO puede decir mal: el contenido de la petición va al
 * proveedor que configure el cliente, no a BiVelio; el panel Cloud va APARTE,
 * rotulado como telemetría, y solo existe si se conecta (lo que recibe lo
 * define /privacy). Las cifras de conexiones de la demo de affectUI no están.
 *
 * La honestidad aquí es parte del producto: los casos «Nada que instalar» se
 * dicen tal cual, y el caso Claude Code lleva la insignia «Ya mide» — el
 * gateway `bvsala claude` está validado de punta a punta (gateway → ingesta →
 * panel, 2026-09-01) — y el cuerpo dice lo que hay: arranca con la licencia
 * BiVelio y, con PRO, la rebaja de TTL acredita ahorro medido sobre el conteo
 * del propio proveedor (docs/PLAN-PASARELA-API-KEY.md).
 */
export async function HowItWorks({
  variant,
  profundiza,
  instalacion,
}: {
  variant: "landing" | "app";
  /**
   * Solo en la página pública: secciones para quien quiere comprobarlo por sí
   * mismo (las ideas en vídeo, los cuatro libros, el verificador de formato).
   * Las pinta la página y entran aquí justo antes de la instalación.
   */
  profundiza?: ReactNode;
  /**
   * Solo en la página pública: el resto de la instalación completa (el comando
   * `init`, el gateway y el skill), dentro de la última sección y antes de sus
   * botones. La portada enlaza aquí: #install-sdk, #install-gateway y #skill.
   */
  instalacion?: ReactNode;
}) {
  const t = await getTranslations("howItWorks");
  const tUi = await getTranslations("ui");
  const locale = await getLocale();
  const entera = variant === "landing";
  const b = (chunks: ReactNode) => <b>{chunks}</b>;

  /** En la página pública, titular editorial; en el panel, el título de sección del panel. */
  const cabecera = (id: string, titulo: string, opciones: { eyebrow?: string; acento?: string; lede?: ReactNode } = {}) =>
    entera ? (
      <SectionHead id={id} eyebrow={opciones.eyebrow} titulo={titulo} acento={opciones.acento} lede={opciones.lede} />
    ) : (
      <>
        {/* Panel (Firma de campaña): rótulo entre filetes encima y el acento
            en `<em>`, que la hoja del panel pone en serif cursiva. */}
        {opciones.eyebrow ? <p className="hiw-rotulo">{opciones.eyebrow}</p> : null}
        <h2 className="hiw-h2" id={id}>
          {titulo}
          {opciones.acento ? (
            <>
              {" "}
              <em>{opciones.acento}</em>
            </>
          ) : null}
        </h2>
        {opciones.lede ? <p className="hiw-sub">{opciones.lede}</p> : null}
      </>
    );

  const cases: { name: string; sub: string; body: ReactNode[]; verdict: "no" | "casi" | "mide" | "si" | "skill" }[] = [
    { name: "ChatGPT", sub: t("caseChatSub"), body: [t("caseChatBody")], verdict: "no" },
    // «Skill disponible» desde el 02-09: claude.ai no tiene factura que medir,
    // pero sí topes — y el skill savings-mode existe justo para eso. La
    // insignia dice lo que hay (un skill), no lo que aún no se ha medido.
    { name: "Claude", sub: t("caseClaudeSub"), body: [t("caseClaudeBody")], verdict: "skill" },
    // «Ya mide», no «Aún no»: desde la 0.4.5 el medidor está validado de punta a
    // punta (gateway → ingesta → panel, 01-09). El ahorro ahí es el de la rebaja
    // de TTL, gratis y sin clave (el panel es lo que añade la clave de Savings
    // Cloud), y el cuerpo lo dice tal cual — la insignia no promete más.
    { name: "Claude Code", sub: t("caseCodeSub"), body: [t("caseCodeBody")], verdict: "mide" },
    { name: t("caseAppName"), sub: t("caseAppSub"), body: [t.rich("caseAppBody", { b })], verdict: "si" },
  ];
  const verdictLabel = { no: t("verdictNothing"), casi: t("verdictNotYet"), mide: t("verdictMeasures"), si: t("verdictYes"), skill: t("verdictSkill") } as const;

  const formas = (["sdk", "gateway"] as const).map((clave) => ({
    clave,
    href: clave === "sdk" ? "/how-it-works#install-sdk" : "/how-it-works#install-gateway",
    kicker: t(`ways.${clave}.kicker`),
    title: t(`ways.${clave}.title`),
    body: t(`ways.${clave}.body`),
    puntos: [t(`ways.${clave}.p1`), t(`ways.${clave}.p2`), t(`ways.${clave}.p3`)],
    cta: t(`ways.${clave}.cta`),
  }));

  const facturaDeEjemplo = new Intl.NumberFormat(locale, { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(FACTURA_EJEMPLO);

  return (
    <>
      <section className="hiw-sec hiw-arch" aria-labelledby="architecture">
        {cabecera("architecture", t("beam.title"), { eyebrow: t("beam.eyebrow"), acento: t("beam.accent"), lede: t("beam.lede") })}
        <div className="hiw-stage">
          <IntegrationBeam
            inputs={[
              { title: t("beam.app"), sub: t("beam.appSub"), icon: "app" },
              { title: t("beam.agent"), sub: t("beam.agentSub"), icon: "agent" },
            ]}
            center={{ title: t("beam.hub"), sub: t("beam.hubSub"), icon: "layer" }}
            output={{ title: t("beam.provider"), sub: t("beam.providerSub"), icon: "provider" }}
            aside={{ title: t("beam.cloud"), sub: t("beam.cloudSub"), icon: "cloud", link: t("beam.telemetry") }}
            caption={t("beam.caption")}
            label={t("beam.alt")}
          />
        </div>
        <ul className="hiw-facts">
          <li>
            <h3>{t("beam.f1Title")}</h3>
            <p>{t("beam.f1Body")}</p>
          </li>
          <li>
            <h3>{t("beam.f2Title")}</h3>
            <p>{t("beam.f2Body")}</p>
          </li>
          <li>
            <h3>{t("beam.f3Title")}</h3>
            <p>{t.rich("beam.f3Body", { link: (c) => <Link href="/privacy">{c}</Link> })}</p>
          </li>
        </ul>
      </section>

      {entera && (
        <section className="hiw-sec" aria-labelledby="install-paths">
          {cabecera("install-paths", t("ways.title"), { eyebrow: t("ways.eyebrow"), lede: t("ways.lede") })}
          <div className="hiw-ways">
            {formas.map((f) => (
              <article key={f.clave} className="hiw-way">
                <p className="kicker">{f.kicker}</p>
                <h3>{f.title}</h3>
                <p>{f.body}</p>
                <ul className="hiw-way-points">
                  {f.puntos.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
                <Link className="btn btn-ghost" href={f.href}>
                  {f.cta}
                </Link>
              </article>
            ))}
          </div>
        </section>
      )}

      <section className="hiw-sec" aria-labelledby="cases">
        {cabecera("cases", t("s2Title"), { eyebrow: entera ? undefined : t("cases.eyebrow"), lede: t("s2Sub") })}
        <div className="hiw-cases">
          {cases.map((c) => (
            <div key={c.name} className="hiw-case" data-veredicto={c.verdict}>
              <div>
                <div className="who">
                  <span className="hiw-who-n">{c.name}</span>
                  <small>{c.sub}</small>
                </div>
                <Badge className="hiw-insignia" tone={TONO_DEL_VEREDICTO[c.verdict]} dot>
                  {verdictLabel[c.verdict]}
                </Badge>
              </div>
              <div>
                {c.body.map((p, i) => (
                  <p key={i}>{p}</p>
                ))}
              </div>
            </div>
          ))}
        </div>
        <p className="hiw-note hiw-scope">{t.rich("cases.skillNote", { link: (c) => <Link href="/how-it-works#skill">{c}</Link> })}</p>
      </section>

      {entera && (
        <section className="hiw-sec" aria-labelledby="pieces">
          {cabecera("pieces", t("pieces.title"), { eyebrow: t("pieces.eyebrow"), lede: t("pieces.lede") })}
          <div className="hiw-stage hiw-stage--pieces">
            <LayerStack
              label={t("pieces.tablist")}
              items={PIEZAS.map(({ clave, icono }) => ({
                title: t(`pieces.${clave}.name`),
                hint: t(`pieces.${clave}.hint`),
                icon: icono,
                facts: [
                  { label: t("pieces.what"), value: t(`pieces.${clave}.what`) },
                  { label: t("pieces.where"), value: t(`pieces.${clave}.where`) },
                  { label: t("pieces.account"), value: t(`pieces.${clave}.account`) },
                ],
              }))}
            />
          </div>
        </section>
      )}

      <section className="hiw-sec" aria-labelledby="measurement">
        {cabecera("measurement", t("s3Title"), { eyebrow: entera ? undefined : t("s3Eyebrow"), lede: t("s3Sub") })}
        <div className="hiw-measure">
          <div className="hiw-two">
            <div className="hiw-mcard">
              <span className="k">{t("mBeforeK")}</span>
              <div className="v est">{t("mBeforeV")}</div>
              <p>{t("mBeforeBody")}</p>
              <EvidenceBadge tipo="sombra" label={tUi("evidence.sombra")} />
            </div>
            <div className="hiw-mcard">
              <span className="k">{t("mAfterK")}</span>
              <div className="v real">{t("mAfterV")}</div>
              <p>{t("mAfterBody")}</p>
              <EvidenceBadge tipo="tus-datos" label={tUi("evidence.tusDatos")} />
            </div>
          </div>
          {/* La factura de ejemplo: de partida, una cifra redonda; con la capa, «depende». */}
          <Recibo
            className="hiw-recibo"
            titulo={t("receipt.title")}
            ilustrativo={tUi("recibo.ilustrativo")}
            filas={[
              { etiqueta: t("flowWithout"), valor: facturaDeEjemplo },
              { etiqueta: t("flowWith"), valor: t("billWith"), mono: false, tono: "ahorro" },
            ]}
            procedencia={{ texto: `${t("billWith")} ${t("billDepends")}.`, href: "/benchmarks", enlace: tUi("recibo.comoSeMidio") }}
          />
        </div>
      </section>

      {entera ? profundiza : null}

      <section className="hiw-sec" aria-labelledby="install" id={entera ? "install-sdk" : undefined}>
        {cabecera("install", t("s4Title"), { eyebrow: entera ? undefined : t("s4Eyebrow") })}
        <CodeFrame className="hiw-code" ariaLabel={t("s4Title")}>
          <span className="n"># 1 · {t("snip1")}</span>{"\n"}
          {"pnpm add "}<span className="s">@bivelio/savings-layer</span>{"\n\n"}
          <span className="n"># 2 · {t("snip3")}</span>{"\n"}
          <span className="k">const</span>{" layer = createSavingsLayer({ provider });\n"}
          <span className="k">const</span>{" { text, report } = "}<span className="k">await</span>{" layer.generate({ model, messages });\n\n"}
          {"console.log(report.cost)  "}
          <span className="g">{"// ← "}{t("snipResult")}</span>
        </CodeFrame>
        {entera ? instalacion : null}
        <div className="hiw-cta">
          {entera ? (
            <>
              {/* El botón dice «ver el ahorro medido», y eso vive en #measured de
                  la portada (los recibos del banco publicado). El verificador
                  (#verify, más arriba en esta página) es otra cosa: una palanca
                  sobre tus datos, no un ahorro medido; llevar este botón allí
                  prometería lo que la sección no enseña. */}
              <Link className="btn btn-primary" href="/#measured">{t("ctaVerify")}</Link>
              <Link className="btn btn-ghost" href="/signup">{t("ctaSignup")}</Link>
              <Link className="btn btn-quiet" href="/benchmarks">{t("more.benchmarks")}</Link>
              <Link className="btn btn-quiet" href="/privacy">{t("more.privacy")}</Link>
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
