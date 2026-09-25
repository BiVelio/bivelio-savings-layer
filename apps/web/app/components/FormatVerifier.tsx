"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { useLocale, useTranslations } from "next-intl";

import {
  DEFAULT_SAMPLE,
  MAX_PAYLOAD_CHARS,
  SAMPLE_ORDER,
  VERIFIER_MODEL,
  VERIFIER_SAMPLES,
  VERIFIER_TOKENIZER,
  verdictFor,
  type FormatVerdict,
  type SampleKey,
  type SelectorLike,
} from "@/lib/verifier/format-check";

/*
 * EL VERIFICADOR DE FORMATO, SIN CUENTA — una palanca del SDK (cómo se
 * escriben los datos estructurados en el prompt) sobre los datos del
 * visitante, en su navegador.
 *
 * Por qué vuelve a la portada: lo quitó 9feb377 (#85, 17-08) junto con el
 * PROYECTOR, y el motivo era el proyector (deslizadores con porcentajes
 * inventados por el visitante: estimación pura). Ese motivo sigue en pie, así
 * que el proyector NO vuelve: se queda en el panel. El verificador sí, con
 * tres condiciones del lado seguro (lib/verifier/format-check.ts):
 *
 *   · Tokenizador EXACTO o200k_base, cargado en diferido en su propio trozo
 *     (≈1 MB con gzip, solo lo baja quien llega a la sección). Si no carga,
 *     ni porcentaje ni barras: con el heurístico esta pantalla enseñaría
 *     45–51 % donde lo real es 17–27 %.
 *   · Abre con la muestra de MENOR efecto, redondea hacia abajo y la base es
 *     el JSON compacto, nunca el indentado.
 *   · El alcance se dice en la propia pantalla: no es la factura.
 *
 * Qué NO hace: ni instancia proveedor ni pipeline — solo el FormatSelector del
 * bundle web (el de la demo, `__BV_SALA_DEMO_ONLY__`) y dos tokenizadores. No
 * toca el paquete de pago. Y NUNCA pinta el texto codificado (`encoded`), solo
 * recuentos: enseñar el resultado sería regalar el uso de la palanca.
 */

type Encoder = { encode(text: string): number[] };
type EstimatorLike = { readonly id: string; readonly exact: boolean; count(text: string): number };
type RegistryLike = {
  register(e: EstimatorLike): unknown;
  mapModel(model: string, tokenizerId: string): unknown;
  resolve(o: { model?: string }): EstimatorLike;
};
type SdkModule = {
  TokenizerRegistry: new () => RegistryLike;
  ExactTokenizer: new (id: string, encoder: Encoder) => EstimatorLike;
  FormatSelector: new (o: { tokenizer: RegistryLike }) => SelectorLike;
};

type Motor = { selector: SelectorLike; exact: boolean };
type Resultado =
  | { tipo: "pendiente" }
  | { tipo: "grande" }
  | { tipo: "invalido"; message: string }
  | { tipo: "ok"; verdict: FormatVerdict };

const MODELO_CORTO = VERIFIER_MODEL.split("/").pop() ?? VERIFIER_MODEL;
const texto = (k: SampleKey) => JSON.stringify(VERIFIER_SAMPLES[k], null, 2);

export function FormatVerifier({ eager = false }: { eager?: boolean }) {
  const t = useTranslations("landing.verify");
  const locale = useLocale();
  const raiz = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(eager);
  const [motor, setMotor] = useState<Motor | null>(null);
  const [falloBundle, setFalloBundle] = useState(false);
  const [sample, setSample] = useState<SampleKey | null>(DEFAULT_SAMPLE);
  const [payload, setPayload] = useState(() => texto(DEFAULT_SAMPLE));
  const [resultado, setResultado] = useState<Resultado>({ tipo: "pendiente" });

  // Diferido: nada se descarga hasta que la sección está a 300 px de verse.
  useEffect(() => {
    if (visible) return;
    const el = raiz.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const io = new IntersectionObserver(
      (entradas) => {
        if (entradas.some((e) => e.isIntersecting)) {
          setVisible(true);
          io.disconnect();
        }
      },
      { rootMargin: "300px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    // `alive`: el doble efecto de StrictMode no puede dejar un setState colgado.
    let alive = true;
    // El bundle web vendorizado (public/vendor/bv-sala.js), como import de URL
    // nativo del navegador: webpackIgnore lo deja fuera del empaquetado y la CSP
    // lo permite por 'self'.
    // @ts-expect-error — especificador de URL, se resuelve en el navegador, no en el build.
    const sdk: Promise<SdkModule> = import(/* webpackIgnore: true */ "/vendor/bv-sala.js");
    // El tokenizador SÍ pasa por el empaquetador (sin webpackIgnore): Next lo
    // trocea aparte y solo lo pide quien llega hasta aquí. Si falla, no hay
    // recuento exacto — y sin exacto no se enseña cifra.
    const codificacion: Promise<Encoder | null> = import("gpt-tokenizer/encoding/o200k_base").then(
      (m) => ({ encode: (s: string) => m.encode(s) }),
      () => null,
    );
    Promise.all([sdk, codificacion])
      .then(([m, enc]) => {
        if (!alive) return;
        const reg = new m.TokenizerRegistry();
        if (enc && typeof enc.encode === "function") {
          reg.register(new m.ExactTokenizer(VERIFIER_TOKENIZER, enc));
          reg.mapModel(VERIFIER_MODEL, VERIFIER_TOKENIZER);
        }
        // «Exacto» lo dice el registro, no el import: es el estimador que el
        // selector va a usar de verdad para este modelo.
        const exact = reg.resolve({ model: VERIFIER_MODEL }).exact === true;
        setMotor({ selector: new m.FormatSelector({ tokenizer: reg }), exact });
      })
      .catch(() => {
        if (alive) setFalloBundle(true);
      });
    return () => {
      alive = false;
    };
  }, [visible]);

  // Recalcula 250 ms después de la última tecla.
  useEffect(() => {
    if (!motor) return;
    const h = setTimeout(() => {
      if (payload.length > MAX_PAYLOAD_CHARS) {
        setResultado({ tipo: "grande" });
        return;
      }
      let datos: unknown;
      try {
        datos = JSON.parse(payload);
      } catch (e) {
        setResultado({ tipo: "invalido", message: (e as Error).message });
        return;
      }
      try {
        const eleccion = motor.selector.choose(datos, { model: VERIFIER_MODEL });
        setResultado({ tipo: "ok", verdict: verdictFor(eleccion, motor.exact) });
      } catch (e) {
        // gpt-tokenizer lanza con tokens especiales (`<|endoftext|>`): para el
        // visitante es lo mismo que un dato que no se puede contar.
        setResultado({ tipo: "invalido", message: (e as Error).message });
      }
    }, 250);
    return () => clearTimeout(h);
  }, [motor, payload]);

  const numero = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const porcentaje = useMemo(
    () => new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 }),
    [locale],
  );

  const elegir = (k: SampleKey) => {
    setSample(k);
    setPayload(texto(k));
  };

  const salida = () => {
    if (falloBundle) return <p className="ck-note" style={{ color: "var(--danger)" }}>{t("errBundle")}</p>;
    if (!motor) return <p className="ck-note">{t("loading")}</p>;
    const etiqueta = <span className="est-tag">{motor.exact ? t("tagExact") : t("tagApprox")}</span>;
    if (resultado.tipo === "pendiente") return etiqueta;
    if (resultado.tipo === "grande") {
      return (
        <>
          {etiqueta}
          <p className="ck-note" style={{ color: "var(--danger)" }}>{t("tooBig", { max: numero.format(MAX_PAYLOAD_CHARS) })}</p>
        </>
      );
    }
    if (resultado.tipo === "invalido") {
      return (
        <>
          {etiqueta}
          <p className="ck-note" style={{ color: "var(--danger)" }}>{t("errInvalidData", { message: resultado.message })}</p>
        </>
      );
    }
    const v = resultado.verdict;
    switch (v.kind) {
      case "fewer": {
        const max = Math.max(v.baselineTokens, v.chosenTokens, 1);
        const filas = [
          { nombre: t("yourData"), tokens: v.baselineTokens, gana: false },
          { nombre: t("optimized"), tokens: v.chosenTokens, gana: true },
        ];
        return (
          <>
            {etiqueta}
            <div className="pv-verdict">
              <span className="pv-pct">{t("fewer", { pct: porcentaje.format(v.percentFloor / 100) })}</span>
            </div>
            {filas.map((f) => (
              <div key={f.nombre} className="fv-row">
                <span className={`fmt-name2 ${f.gana ? "win" : ""}`}>{f.nombre}</span>
                <span className="track2">
                  <span className={`fill2 ${f.gana ? "win" : ""}`} style={{ width: `${(100 * f.tokens) / max}%` }} />
                </span>
                <span className="fmt-tok2">{numero.format(f.tokens)}</span>
              </div>
            ))}
            <p className="ck-note">
              {t("trims", { before: numero.format(v.baselineTokens), after: numero.format(v.chosenTokens) })}
            </p>
            <p className="ck-note">{t("exactNote", { tokenizer: VERIFIER_TOKENIZER, model: MODELO_CORTO })}</p>
          </>
        );
      }
      case "optimal":
        return (
          <>
            {etiqueta}
            <div className="pv-verdict">
              <span className="pv-pct zero">{porcentaje.format(0)}</span>
            </div>
            <p className="ck-note">{t("alreadyOptimal")}</p>
          </>
        );
      case "approximate":
        return (
          <>
            {etiqueta}
            <p className="ck-note">{t("approxNote")}</p>
          </>
        );
      case "not-comparable":
        return etiqueta;
    }
  };

  return (
    <div className="fv" ref={raiz}>
      <div className="fv-in">
        <p className="pv-label">{t("tryExample")}</p>
        <div className="pv-chips">
          {SAMPLE_ORDER.map((k) => (
            <button
              key={k}
              type="button"
              className={`pv-chip ${sample === k ? "on" : ""}`}
              aria-pressed={sample === k}
              onClick={() => elegir(k)}
            >
              {t(`sample_${k}`)}
            </button>
          ))}
        </div>
        <textarea
          className="proj-ta"
          value={payload}
          spellCheck={false}
          aria-label={t("pasteHint")}
          onChange={(e) => {
            setPayload(e.target.value);
            setSample(null);
          }}
        />
        <p className="ck-note">{t("pasteHint")}</p>
      </div>
      <div className="fv-out" aria-live="polite">
        {salida()}
        <p className="fv-scope">{t("scope")}</p>
      </div>
    </div>
  );
}
