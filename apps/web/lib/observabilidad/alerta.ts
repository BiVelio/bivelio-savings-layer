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
