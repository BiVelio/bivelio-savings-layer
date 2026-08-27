/**
 * LIMITADOR EN MEMORIA, ventana deslizante. Existe para que un endpoint público
 * que manda correo (/api/contacto) no pueda AGOTAR la cuota de Resend que
 * comparte con el hook de auth (confirmaciones, recuperación) — que es
 * fail-closed: sin cuota, nadie confirma su cuenta ni recupera su contraseña.
 *
 * HONESTO SOBRE SUS LÍMITES: la memoria es POR INSTANCIA (Vercel reutiliza
 * instancias con Fluid Compute, pero puede haber varias). Frena en seco al
 * abusador trivial que martillea una instancia, y el TOPE GLOBAL acota cuánto
 * puede consumir este endpoint pase lo que pase, dejando el resto de la cuota
 * para los correos esenciales. Para un flood distribuido de verdad, la capa
 * correcta es el Vercel Firewall (rate-limit rule) — esto es el cinturón, no
 * el airbag. No usa Redis a propósito: cero dependencias nuevas.
 */

interface Ventana {
  sellos: number[]; // timestamps (ms) dentro de la ventana
}

/** Un limitador de ventana deslizante con claves (p. ej. IP) y un tope global. */
export class RateLimiter {
  private readonly porClave = new Map<string, Ventana>();
  private readonly global: Ventana = { sellos: [] };

  constructor(
    private readonly ventanaMs: number,
    private readonly porClaveMax: number,
    private readonly globalMax: number,
    private readonly ahora: () => number = () => Date.now(),
  ) {}

  private podar(v: Ventana, t: number): void {
    const limite = t - this.ventanaMs;
    // Los sellos están en orden ascendente: se quitan los del principio.
    let i = 0;
    while (i < v.sellos.length && v.sellos[i]! <= limite) i++;
    if (i > 0) v.sellos.splice(0, i);
  }

  /**
   * ¿Se permite una petición de `clave` ahora? Si sí, la CONTABILIZA y devuelve
   * `{ ok: true }`. Si no, `{ ok: false, motivo }` sin contabilizar.
   */
  permitir(clave: string): { ok: true } | { ok: false; motivo: "clave" | "global" } {
    const t = this.ahora();
    this.podar(this.global, t);
    if (this.global.sellos.length >= this.globalMax) return { ok: false, motivo: "global" };

    let v = this.porClave.get(clave);
    if (!v) {
      v = { sellos: [] };
      this.porClave.set(clave, v);
    }
    this.podar(v, t);
    if (v.sellos.length >= this.porClaveMax) return { ok: false, motivo: "clave" };

    v.sellos.push(t);
    this.global.sellos.push(t);
    // Higiene de memoria: sin esto el mapa crece con cada IP única y no vuelve a
    // bajar (una clave que no se vuelve a ver nunca se poda). Cuando el mapa pasa
    // de un umbral, se barren de una vez las claves cuya ventana ya está vacía.
    if (this.porClave.size > 10_000) this.barrer(t);
    return { ok: true };
  }

  private barrer(t: number): void {
    for (const [clave, v] of this.porClave) {
      this.podar(v, t);
      if (v.sellos.length === 0) this.porClave.delete(clave);
    }
  }
}

/**
 * La IP del cliente detrás del proxy de Vercel. `x-forwarded-for` es una lista
 * `cliente, proxy1, …`; la primera es la del cliente. Sin cabecera (imposible en
 * Vercel, posible en tests) se agrupa todo bajo "desconocida" — que el tope
 * global sigue acotando.
 */
export function ipDe(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  return req.headers.get("x-real-ip")?.trim() || "desconocida";
}
