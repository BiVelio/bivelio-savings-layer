"use client";

import { useState } from "react";

/**
 * CTA de la landing: dejar el correo para una llamada de 15 minutos.
 *
 * Va en su propia franja justo antes de los precios (dueño, 2026-10-03): el
 * héroe es ahora la captura del panel, y quien ha bajado hasta los precios ya
 * ha leído la prueba medida — ahí es donde se ofrece hablar.
 *
 * El fallo se DICE. Un formulario que se traga un error y enseña «gracias»
 * pierde al cliente dos veces: no se le contacta y ademas cree que si.
 */
export function ReservarLlamada({
  t,
}: {
  t: { titulo: string; sub: string; placeholder: string; boton: string; enviando: string; ok: string; errorCorreo: string; errorEnvio: string; alterna: string };
}) {
  const [email, setEmail] = useState("");
  const [estado, setEstado] = useState<"listo" | "enviando" | "ok" | "error">("listo");
  const [motivo, setMotivo] = useState("");

  async function enviar(e: React.FormEvent) {
    e.preventDefault();
    if (estado === "enviando") return;
    setEstado("enviando");
    try {
      const r = await fetch("/api/contacto", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (r.ok) {
        setEstado("ok");
        return;
      }
      const d = (await r.json().catch(() => ({}))) as { error?: string };
      setMotivo(d.error === "bad_email" ? t.errorCorreo : t.errorEnvio);
      setEstado("error");
    } catch {
      setMotivo(t.errorEnvio);
      setEstado("error");
    }
  }

  if (estado === "ok") {
    return (
      <div className="cta15 cta15-ok" role="status">
        <span className="cta15-tic" aria-hidden="true">✓</span>
        <p>{t.ok}</p>
      </div>
    );
  }

  return (
    <form className="cta15" onSubmit={enviar}>
      <div className="cta15-txt">
        <strong>{t.titulo}</strong>
        <span>{t.sub}</span>
      </div>
      <div className="cta15-fila">
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder={t.placeholder}
          aria-label={t.placeholder}
          disabled={estado === "enviando"}
        />
        <button type="submit" disabled={estado === "enviando"}>
          {estado === "enviando" ? t.enviando : t.boton}
        </button>
      </div>
      {estado === "error" && (
        <p className="cta15-err" role="alert">
          {motivo} <a href="mailto:support@bivelio.com">{t.alterna}</a>
        </p>
      )}
    </form>
  );
}
