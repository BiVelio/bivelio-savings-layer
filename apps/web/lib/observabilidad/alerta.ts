/**
 * Avisar a un humano de que algo va mal.
 *
 * QUÉ ARREGLA. Todo lo que se rompía en este producto acababa en un
 * `console.error` dentro de una función de Vercel. Esos registros no despiertan a
 * nadie: hay que ir a buscarlos, sabiendo ya que ha pasado algo. O sea que el
 * primer aviso de cualquier fallo era un cliente enfadado — y en un producto
 * fail-closed que cobra por suscripción, "el cliente se entera antes que tú"
 * significa que se entera con su producción parada.
 *
 * DELIBERADAMENTE PEQUEÑO. No hay Sentry, ni una cuenta nueva, ni una dependencia
 * más: un POST a un webhook que ya tengas (Slack, Discord, un Zapier, lo que sea)
 * y, si no hay ninguno configurado, un registro con un prefijo estable que se
 * puede buscar y sobre el que se puede poner una alerta de Vercel. Una
 * herramienta que no está instalada no avisa de nada, así que lo importante es
 * que esto funcione HOY con lo que ya hay.
 */

export type NivelDeAlerta = "critico" | "aviso";

export interface Alerta {
  nivel: NivelDeAlerta;
  /** Qué ha pasado, en una línea legible por una persona a las 3 de la mañana. */
  asunto: string;
  /** Datos para diagnosticar. NUNCA metas aquí un secreto ni un token. */
  detalle?: Record<string, unknown>;
}

/** Prefijo estable y buscable. No lo cambies: puede haber alertas atadas a él. */
export const MARCA = "[bv-sala:ALERTA]";

/** Buzón por defecto. Decisión del dueño (2026-08-12). Ajustable por entorno. */
const DESTINO_POR_DEFECTO = "support@bivelio.com";
/** Remitente. Cualquier dirección del dominio verificado en Resend sirve. */
const REMITENTE = "BiVelio Savings <alertas@bivelio.com>";
/** El procedimiento, versionado junto al código que dispara la alerta. */
const MANUAL = "https://github.com/BiVelio/bivelio-savings-layer/blob/main/docs/RUNBOOK-ALERTAS.md";

/**
 * Correo, por la cuenta de Resend que la plataforma YA tiene (dominio
 * `bivelio.com` verificado). Con `fetch` directo y sin SDK: una dependencia más
 * en el camino de un avisador es una cosa más que puede romperse justo cuando
 * hace falta.
 *
 * SOLO LO CRÍTICO LLEGA POR CORREO. Mandar también los avisos entrenaría a
 * ignorarlos, y entonces el correo que importa se pierde entre los que no. Los
 * `aviso` se quedan en el registro y en el webhook, si lo hay.
 */
async function porCorreo(nivel: NivelDeAlerta, asunto: string, detalle?: Record<string, unknown>) {
  if (nivel !== "critico") return;
  const clave = process.env.RESEND_API_KEY;
  if (!clave) return;
  const destino = (process.env.BVSALA_ALERT_EMAIL || DESTINO_POR_DEFECTO)
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean);
  if (destino.length === 0) return;

  // EL CORREO LLEVA SU PROPIO MANUAL. Una alerta sin procedimiento es ansiedad a
  // las tres de la mañana: quien la recibe tiene que saber qué mirar y qué hacer
  // sin ir a buscarlo, y lo primero de casi todas es reenviar el evento en Stripe.
  const cuerpo = [
    `<p><b>${escapar(asunto)}</b></p>`,
    `<pre style="background:#f6f6f6;padding:12px;border-radius:6px;overflow:auto">${escapar(
      JSON.stringify(detalle ?? {}, null, 2),
    )}</pre>`,
    `<p><b>Qué hacer:</b> <a href="${MANUAL}">manual de alertas</a>. ` +
      `Casi todas se reparan <b>reenviando el evento en Stripe</b> ` +
      `(Developers → Events → el id de arriba → Resend); los handlers son ` +
      `idempotentes, así que reenviar no duplica licencias ni cobra dos veces. ` +
      `<b>Ojo:</b> si el evento YA se procesó una vez, el webhook lo corta como ` +
      `duplicado y devuelve 200 sin hacer nada — hay que borrar antes su fila de ` +
      `<code>bvsala.stripe_events</code>. El manual lo explica.</p>`,
    `<p style="color:#666;font-size:12px">savings.bivelio.com · ${new Date().toISOString()}</p>`,
  ].join("");

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${clave}`, "content-type": "application/json" },
    body: JSON.stringify({
      from: REMITENTE,
      to: destino,
      subject: `🔴 BV-SALA: ${asunto}`,
      html: cuerpo,
    }),
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) console.error(`${MARCA} el correo no salió (${res.status})`);
}

/** El detalle lo componemos nosotros, pero puede traer texto de un error ajeno. */
function escapar(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Manda la alerta. NUNCA lanza y NUNCA bloquea más de unos segundos: esto se
 * llama desde caminos que ya están gestionando un fallo, y un avisador que rompe
 * lo que estaba intentando avisar es peor que no tener avisador.
 */
export async function alertar({ nivel, asunto, detalle }: Alerta): Promise<void> {
  // El registro va SIEMPRE, haya webhook o no: es la red de la red.
  const linea = `${MARCA}[${nivel}] ${asunto}`;
  if (nivel === "critico") console.error(linea, detalle ?? {});
  else console.warn(linea, detalle ?? {});

  // Los dos canales van EN PARALELO y ninguno puede tumbar al otro: si el webhook
  // está caído, el correo tiene que salir igual, y al revés. `allSettled` porque
  // aquí un fallo no se propaga nunca — se está gestionando otro fallo ya.
  await Promise.allSettled([
    porCorreo(nivel, asunto, detalle).catch((err) =>
      console.error(`${MARCA} no se pudo enviar el correo:`, err instanceof Error ? err.message : err),
    ),
    porWebhook(nivel, asunto, detalle),
  ]);
}

async function porWebhook(nivel: NivelDeAlerta, asunto: string, detalle?: Record<string, unknown>) {
  const url = process.env.BVSALA_ALERT_WEBHOOK;
  if (!url) return;

  try {
    // Formato de Slack (`text`), que es el que aceptan también Discord con
    // `/slack`, Mattermost y la mayoría de los recolectores. Se manda además el
    // objeto entero por si el receptor sabe leerlo.
    const cuerpo = {
      text: `${nivel === "critico" ? "🔴" : "🟠"} ${asunto}\n\`\`\`${JSON.stringify(detalle ?? {}, null, 1)}\`\`\``,
      nivel,
      asunto,
      detalle: detalle ?? {},
      producto: "bv-sala",
    };
    // Con timeout: un webhook que no responde no puede colgar un cron nocturno
    // ni, peor, una petición del cliente.
    const corte = AbortSignal.timeout(5_000);
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(cuerpo),
      signal: corte,
    });
    if (!res.ok) {
      // Se registra, pero no se relanza: el fallo del avisador no puede
      // convertirse en el fallo del que avisaba.
      console.error(`${MARCA} el webhook respondió ${res.status}`);
    }
  } catch (err) {
    console.error(`${MARCA} no se pudo entregar la alerta:`, err instanceof Error ? err.message : err);
  }
}
