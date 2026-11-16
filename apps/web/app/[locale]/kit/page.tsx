import type { CSSProperties, ReactNode } from "react";
import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";

import { CodeFrame, EmptyState, EvidenceBadge, Notice, PageHeader, Recibo, SectionHead, Skeleton, SkeletonText, type TipoDeEvidencia } from "@/app/components/ui";
import { ProofIcon } from "@/app/components/icons";
import { capturaDisponible } from "@/lib/portada/panel-del-banco";

import { KitInteractivo } from "./KitInteractivo";

/**
 * MUESTRARIO DE LA FUNDACIÓN — SOLO EN DESARROLLO (`pnpm dev` → /es/kit).
 *
 * Todas las primitivas de app/components/ui y las piezas vendorizadas de
 * affectUI en una página, para verlas juntas al tocar tokens. En producción no
 * existe: `notFound()` antes de pintar nada, igual que /captura-panel.
 *
 * LAS CIFRAS SON DE MUESTRA y por eso cada recibo lleva su franja «Ejemplo
 * ilustrativo». Los rótulos de demostración van en español a propósito: esta
 * página no se traduce porque no se publica.
 */
export const dynamic = "force-dynamic";
export const metadata = { robots: { index: false, follow: false } };

const TIPOS: TipoDeEvidencia[] = ["ab-sdk", "replay-gateway", "tus-datos", "benchmark", "sintetico", "estimacion", "sombra"];
const REJILLA: CSSProperties = { display: "grid", gap: 24, gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 300px), 1fr))", alignItems: "start" };
const FILA: CSSProperties = { display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" };

function Bloque({ titulo, children }: { titulo: string; children: ReactNode }) {
  return (
    <section style={{ padding: "40px 0" }}>
      <SectionHead eyebrow="Fundación" titulo={titulo} pequeno />
      {children}
    </section>
  );
}

export default async function Muestrario({ params }: { params: Promise<{ locale: string }> }) {
  if (!capturaDisponible()) notFound();
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("ui");

  const etiqueta: Record<TipoDeEvidencia, string> = {
    "ab-sdk": t("evidence.abSdk"),
    "replay-gateway": t("evidence.replayGateway"),
    "tus-datos": t("evidence.tusDatos"),
    benchmark: t("evidence.benchmark"),
    sintetico: t("evidence.sintetico"),
    estimacion: t("evidence.estimacion"),
    sombra: t("evidence.sombra"),
  };

  return (
    <div className="lp">
      <main className="wrap">
        <PageHeader
          eyebrow="Muestrario · solo desarrollo"
          titulo="Optimiza tus llamadas a LLM."
          acento="Comprueba cada ahorro."
          acentoEnLinea
          tamano="xl"
          lede="Tokens, tipografías y primitivas de la fundación visual. Las cifras de esta página son de muestra."
          acciones={
            <>
              <a className="btn btn-lg" href="#recibo">
                Primario
              </a>
              <a className="btn btn-lg ghost" href="#codigo">
                Secundario
              </a>
            </>
          }
        />

        <Bloque titulo="Botones e insignias">
          <div style={{ ...FILA, marginBottom: 16 }}>
            <button className="btn" type="button">
              Tinta
            </button>
            <button className="btn ghost" type="button">
              Fantasma
            </button>
            <button className="btn btn-brand" type="button">
              Marca
            </button>
            <button className="btn btn-quiet" type="button">
              Texto
            </button>
            <button className="btn" type="button" disabled>
              Deshabilitado
            </button>
            <span className="tag">Etiqueta</span>
            <span className="pill live">
              <span className="dot" /> En vivo
            </span>
            <span className="pill mock">Simulado</span>
            <span className="pill await">En espera</span>
          </div>
          <div style={FILA}>
            {TIPOS.map((tipo) => (
              <EvidenceBadge key={tipo} tipo={tipo} label={etiqueta[tipo]} />
            ))}
            <EvidenceBadge tipo="ab-sdk" label={etiqueta["ab-sdk"]} pequeno />
          </div>
        </Bloque>

        <Bloque titulo="El recibo verificable">
          <div id="recibo" style={REJILLA}>
            <Recibo
              titulo="Recibo de una llamada"
              meta="Modelo · periodo · base de medición"
              ilustrativo={t("recibo.ilustrativo")}
              filas={[
                { etiqueta: "Coste de referencia", valor: "0,0420" },
                { etiqueta: "Caché de prefijo", valor: "−0,0131", tono: "ahorro" },
                { etiqueta: "Formato compacto", valor: "−0,0046", tono: "ahorro" },
                { etiqueta: "Coste observado", valor: "0,0243", tono: "coste" },
                { etiqueta: "Fuera de la base", valor: "—", tono: "atenuado" },
              ]}
              total={{ etiqueta: "Ahorro acreditado", valor: "0,0177", tono: "ahorro" }}
              evidencia={{ tipo: "ab-sdk", label: etiqueta["ab-sdk"] }}
              procedencia={{ texto: "Grupo de control frente a tratado, mismo tráfico.", href: "/benchmarks", enlace: t("recibo.comoSeMidio") }}
            />
            <Recibo
              compacto
              titulo="Sesión del gateway"
              ilustrativo={t("recibo.ilustrativo")}
              filas={[
                { etiqueta: "Modelo", valor: "modelo-de-ejemplo", mono: false },
                { etiqueta: "Peticiones", valor: "128" },
                { etiqueta: "Tokens evitados", valor: "41 260", tono: "ahorro" },
              ]}
              total={{ etiqueta: t("recibo.total"), valor: "—" }}
              evidencia={{ tipo: "replay-gateway", label: etiqueta["replay-gateway"] }}
              procedencia={{ texto: "Tráfico grabado y repetido." }}
            />
            <Recibo
              compacto
              titulo="Sin resguardo"
              ilustrativo={t("recibo.ilustrativo")}
              filas={[
                { etiqueta: "Entrada", valor: "1 204" },
                { etiqueta: "Salida", valor: "318" },
              ]}
            />
          </div>
        </Bloque>

        <Bloque titulo="Código">
          <div id="codigo" style={REJILLA}>
            <CodeFrame
              etiqueta="Terminal"
              copiar={{ texto: "bvsala claude", etiqueta: t("copy"), etiquetaCopiado: t("copied") }}
              salida={{ etiqueta: t("code.expected"), contenido: "gateway listo en 127.0.0.1" }}
            >
              <span className="k">bvsala</span> claude
            </CodeFrame>
            <CodeFrame etiqueta="savings.config.ts" lineas={4} copiar={{ texto: "…", etiqueta: t("copy"), etiquetaCopiado: t("copied") }}>
              <span className="c">{"// ejemplo largo: con números de línea\n"}</span>
              <span className="k">import</span>
              {" { createSavingsLayer } "}
              <span className="k">from</span> <span className="s">{'"@bivelio/savings-layer"'}</span>
              {";\n\n"}
              <span className="k">export const</span>
              {" layer = createSavingsLayer({ provider: "}
              <span className="s">{'"openai"'}</span>
              {" });"}
            </CodeFrame>
          </div>
        </Bloque>

        <Bloque titulo="Avisos y estados">
          <div style={REJILLA}>
            <div style={{ display: "grid", gap: 12 }}>
              <Notice tono="info" titulo="Información">
                La conexión Cloud es opcional.
              </Notice>
              <Notice tono="ok" titulo="Correcto">
                La clave responde.
              </Notice>
              <Notice tono="warn" titulo="Atención">
                Cobertura parcial en este periodo.
              </Notice>
              <Notice tono="danger" titulo="Error" role="note">
                No se pudo leer el extracto.
              </Notice>
            </div>
            <EmptyState
              icono={<ProofIcon />}
              titulo={t("state.empty")}
              texto="Cuando llegue la primera llamada medida, aparecerá aquí con su procedencia."
              acciones={
                <a className="btn" href="#recibo">
                  Acción
                </a>
              }
            />
            <div className="card">
              <Skeleton ancho="40%" alto={14} />
              <div style={{ height: 14 }} />
              <SkeletonText lineas={3} />
              <div style={{ height: 14 }} />
              <Skeleton alto={72} radio={12} />
            </div>
          </div>
        </Bloque>

        <Bloque titulo="Tabla">
          <div className="tbl-scroll">
            <table className="tbl tbl--static">
              <thead>
                <tr>
                  <th>Modelo</th>
                  <th>Peticiones</th>
                  <th>Referencia</th>
                  <th>Observado</th>
                  <th>Evidencia</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>modelo-a</td>
                  <td>1 204</td>
                  <td>12,40</td>
                  <td className="pos">9,85</td>
                  <td>
                    <EvidenceBadge tipo="tus-datos" label={etiqueta["tus-datos"]} pequeno />
                  </td>
                </tr>
                <tr>
                  <td>modelo-b</td>
                  <td>318</td>
                  <td>3,10</td>
                  <td>—</td>
                  <td>
                    <EvidenceBadge tipo="sombra" label={etiqueta.sombra} pequeno />
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </Bloque>

        <Bloque titulo="Piezas affectUI vendorizadas">
          <KitInteractivo locale={locale} copiar={t("copy")} copiado={t("copied")} />
        </Bloque>
      </main>
    </div>
  );
}
