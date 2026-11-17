"use client";

import { useCallback, useEffect, useRef } from "react";
import { useTranslations } from "next-intl";

import { TourIcon } from "@/app/components/icons";
import { usePathname, useRouter } from "@/i18n/navigation";

import { PASOS_DEL_TOUR, escaparHtml, marcarVisto, primerVisible, tourVisto, type PasoDelTour } from "./tour-pasos";

/**
 * EL TOUR GUIADO DEL PANEL — repetible desde la barra («Ver tour») y, la
 * primera vez, solo en el Resumen.
 *
 * Usa TourGuideJS (`@sjmc11/tourguidejs` 0.0.27), y lo usa con pinzas, porque
 * la librería trae cuatro cosas que aquí no se pueden dejar como vienen:
 *
 *  1. NO ES SEGURA EN SERVIDOR: su envoltorio UMD evalúa `self` al importarse.
 *     Se carga con `import()` dentro de un manejador o de un efecto, nunca
 *     arriba del fichero.
 *  2. NO TIENE ACCESIBILIDAD: ni `role`, ni foco, ni un botón de cerrar que
 *     sea un botón. `vestir()` le pone `role="dialog"`, `aria-modal`, sus
 *     etiquetas, mueve el foco al diálogo, lo retiene con Tab y lo devuelve a
 *     donde estaba al salir.
 *  3. COMPARTE LAS OPCIONES ENTRE INSTANCIAS Y NO SE PUEDE DESTRUIR: cada
 *     `new` deja otro diálogo en `<body>` con los mismos `id`. Hay UNA
 *     instancia por módulo; los pasos se le pasan frescos antes de cada inicio
 *     (los selectores que resuelve los sustituye por nodos, que tras un
 *     re-render ya no existen) y al desmontar se sale y se retiran sus nodos.
 *  4. PINTA CON `innerHTML`: todo texto pasa por `escaparHtml`.
 *
 * `keyboardControls` va apagado: sus flechas se escuchan en `window` y le
 * quitarían las flechas al selector de rango y a cualquier campo. Escape sí
 * cierra. `completeOnFinish` también: la librería escribe en `localStorage`
 * sin `try`, así que la marca de «ya visto» es nuestra (`bvsala.tour.v1`).
 *
 * LOS PASOS QUE NO TIENEN DÓNDE APUNTAR NO SALEN. Un `member` no ve Equipo; a
 * ≤860px no hay tarjeta de puesta en marcha; una tarjeta oculta no está. La
 * librería, ante un selector que no casa, apunta en silencio a `<body>`: aquí
 * se filtra antes (`primerVisible`).
 */

const GRUPO = "savings-dashboard";
/** El Resumen pide el tour desde otra ruta: se navega y se arranca al llegar. */
const PENDIENTE = "bvsala.tour.pendiente";

type ClienteDelTour = {
  dialog: HTMLElement;
  backdrop: HTMLElement;
  isVisible: boolean;
  activeStep: number;
  tourSteps: unknown[];
  start(group?: string): Promise<unknown>;
  exit(): Promise<unknown>;
  setOptions(options: Record<string, unknown>): Promise<unknown>;
  onAfterStepChange(cb: () => void): void;
  onAfterExit(cb: () => void): void;
};

/** UNA instancia por módulo (ver el punto 3 de arriba). */
let cliente: ClienteDelTour | null = null;
let cargando: Promise<ClienteDelTour> | null = null;

function obtenerCliente(): Promise<ClienteDelTour> {
  if (cliente) return Promise.resolve(cliente);
  cargando ??= import("@sjmc11/tourguidejs/dist/tour.js").then((mod) => {
    const Clase = (mod as unknown as { TourGuideClient: new (o: Record<string, unknown>) => ClienteDelTour }).TourGuideClient;
    cliente = new Clase({ debug: false, keyboardControls: false, completeOnFinish: false, steps: [] });
    return cliente;
  });
  return cargando;
}

function retirarCliente() {
  const c = cliente;
  cliente = null;
  cargando = null;
  if (!c) return;
  const quitar = () => {
    c.dialog?.remove();
    c.backdrop?.remove();
  };
  if (c.isVisible) c.exit().then(quitar, quitar);
  else quitar();
}

/** Con el almacenamiento bloqueado, LEER `window.localStorage` ya lanza. */
function almacenLocal(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

const reducido = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function TourGuide() {
  const t = useTranslations("app.tour");
  const pathname = usePathname();
  const router = useRouter();
  const lanzador = useRef<HTMLButtonElement>(null);
  const focoPrevio = useRef<HTMLElement | null>(null);
  const escuchas = useRef(false);

  /** Los textos de cada paso. Claves literales: `claves-usadas.test.ts` las lee. */
  const textoDe = useCallback(
    (id: PasoDelTour["id"]): { titulo: string; cuerpo: string } => {
      switch (id) {
        case "welcome":
          return { titulo: t("steps.welcome.title"), cuerpo: t("steps.welcome.body") };
        case "nav":
          return { titulo: t("steps.nav.title"), cuerpo: t("steps.nav.body") };
        case "setup":
          return { titulo: t("steps.setup.title"), cuerpo: t("steps.setup.body") };
        case "verdict":
          return { titulo: t("steps.verdict.title"), cuerpo: t("steps.verdict.body") };
        case "range":
          return { titulo: t("steps.range.title"), cuerpo: t("steps.range.body") };
        case "customize":
          return { titulo: t("steps.customize.title"), cuerpo: t("steps.customize.body") };
        case "explorer":
          return { titulo: t("steps.explorer.title"), cuerpo: t("steps.explorer.body") };
        case "proof":
          return { titulo: t("steps.proof.title"), cuerpo: t("steps.proof.body") };
        case "team":
          return { titulo: t("steps.team.title"), cuerpo: t("steps.team.body") };
        case "account":
          return { titulo: t("steps.account.title"), cuerpo: t("steps.account.body") };
        case "finish":
          return { titulo: t("steps.finish.title"), cuerpo: t("steps.finish.body") };
      }
    },
    [t],
  );

  /** Lo que la librería no trae: papel, etiquetas, cierre operable y foco. */
  const vestir = useCallback(
    (c: ClienteDelTour, moverFoco: boolean) => {
      const d = c.dialog;
      if (!d) return;
      d.setAttribute("role", "dialog");
      d.setAttribute("aria-modal", "true");
      d.setAttribute("aria-labelledby", "tg-dialog-title");
      d.setAttribute("aria-describedby", "tg-dialog-body");
      d.setAttribute("tabindex", "-1");

      const cerrar = d.querySelector<HTMLElement>("#tg-dialog-close-btn");
      if (cerrar) {
        cerrar.setAttribute("role", "button");
        cerrar.setAttribute("tabindex", "0");
        cerrar.setAttribute("aria-label", t("close"));
        cerrar.querySelector("svg")?.setAttribute("aria-hidden", "true");
      }
      // La librería escribe `disabled="false"`, que para el navegador ES
      // deshabilitado; y solo lo corrige en algunos caminos.
      const atras = d.querySelector<HTMLButtonElement>("#tg-dialog-prev-btn");
      if (atras) atras.disabled = c.activeStep === 0;
      d.querySelector("#tg-dialog-dots")?.setAttribute("aria-hidden", "true");
      d.querySelector("#tg-arrow")?.setAttribute("aria-hidden", "true");

      // «Paso 2 de 9», con palabras: el «2/9» de la librería no se traduce.
      const pie = d.querySelector(".tg-dialog-footer-sup");
      if (pie) {
        let cuenta = pie.querySelector<HTMLElement>(".tg-bv-count");
        if (!cuenta) {
          cuenta = document.createElement("span");
          cuenta.className = "tg-bv-count";
          pie.append(cuenta);
        }
        cuenta.textContent = t("step", { n: c.activeStep + 1, total: c.tourSteps.length });
      }
      if (moverFoco) d.focus({ preventScroll: true });
    },
    [t],
  );

  const iniciar = useCallback(async () => {
    const c = await obtenerCliente();
    if (c.isVisible) return;

    // Equipo y Cuenta comparten un paso: quien ve Equipo recibe el paso doble
    // (su texto cubre las dos cosas) y el de Cuenta a solas se omite.
    const veEquipo = primerVisible(['[data-tour="nav-team"]']) !== null;
    const pasos = PASOS_DEL_TOUR.flatMap((paso) => {
      if (paso.id === "account" && veEquipo) return [];
      const destino = paso.destinos.length === 0 ? null : primerVisible(paso.destinos);
      if (paso.destinos.length > 0 && !destino) return [];
      const { titulo, cuerpo } = textoDe(paso.id);
      const ancla = paso.ancla && primerVisible([paso.ancla]) ? paso.ancla : undefined;
      return [{ title: escaparHtml(titulo), content: escaparHtml(cuerpo), target: destino ?? undefined, dialogTarget: ancla, group: GRUPO }];
    });
    // Solo bienvenida y despedida no es un tour: no hay nada que enseñar.
    if (pasos.length < 3) return;

    if (!escuchas.current) {
      escuchas.current = true;
      c.onAfterStepChange(() => vestir(c, true));
      c.onAfterExit(() => {
        const previo = focoPrevio.current ?? lanzador.current;
        focoPrevio.current = null;
        if (previo && document.contains(previo)) previo.focus({ preventScroll: true });
      });
    }

    focoPrevio.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const quieto = reducido();
    await c.setOptions({
      steps: pasos,
      debug: false,
      keyboardControls: false,
      exitOnEscape: true,
      exitOnClickOutside: true,
      completeOnFinish: false,
      rememberStep: false,
      closeButton: true,
      showButtons: true,
      showStepDots: true,
      stepDotsPlacement: "footer",
      showStepProgress: false,
      progressBar: "",
      nextLabel: escaparHtml(t("next")),
      prevLabel: escaparHtml(t("prev")),
      finishLabel: escaparHtml(t("finish")),
      dialogClass: "tg-bv",
      backdropClass: "tg-bv-backdrop",
      backdropColor: "rgba(15,18,24,.55)",
      dialogZ: 999,
      dialogMaxWidth: 360,
      targetPadding: 12,
      dialogAnimate: !quieto,
      backdropAnimate: !quieto,
      autoScroll: true,
      autoScrollSmooth: !quieto,
      autoScrollOffset: 24,
      activeStepInteraction: false,
    });
    marcarVisto(almacenLocal());
    try {
      await c.start(GRUPO);
      vestir(c, true);
    } catch {
      /* ya estaba abierto, o no quedó ningún paso: no hay nada que deshacer */
    }
  }, [t, textoDe, vestir]);

  /** «Ver tour»: en el Resumen arranca; desde otra ruta, va al Resumen y arranca allí. */
  const pedir = useCallback(() => {
    // En el Resumen —o en cualquier pantalla que tenga el titular a la vista—
    // arranca aquí; desde las demás, primero se va al Resumen.
    if (pathname === "/dashboard" || document.querySelector('[data-tour="verdict"]') !== null) {
      void iniciar();
      return;
    }
    try {
      window.sessionStorage.setItem(PENDIENTE, "1");
    } catch {
      /* sin almacén: se navega igual y el tour se pide de nuevo desde el Resumen */
    }
    router.push("/dashboard");
  }, [iniciar, pathname, router]);

  // Al llegar al Resumen: el tour pedido desde otra ruta, o el de la primera
  // vez. Tras la hidratación y un respiro: `PanelEditable` aplica las
  // preferencias guardadas después de montar y una tarjeta puede desaparecer.
  useEffect(() => {
    if (pathname !== "/dashboard") return;
    let pendiente = false;
    try {
      pendiente = window.sessionStorage.getItem(PENDIENTE) === "1";
      if (pendiente) window.sessionStorage.removeItem(PENDIENTE);
    } catch {
      pendiente = false;
    }
    // La primera vez solo se ofrece sobre un Resumen de verdad: sin titular
    // (error de render, sesión sin configurar) no hay recorrido que hacer.
    const primeraVez = !tourVisto(almacenLocal()) && document.querySelector('[data-tour="verdict"]') !== null;
    if (!pendiente && !primeraVez) return;
    const id = window.setTimeout(() => void iniciar(), 700);
    return () => window.clearTimeout(id);
  }, [pathname, iniciar]);

  // Cambiar de ruta con el tour abierto lo cierra: sus destinos ya no están.
  useEffect(() => {
    return () => {
      if (cliente?.isVisible) void cliente.exit().catch(() => undefined);
    };
  }, [pathname]);

  // Tab no sale del diálogo mientras está abierto; Enter y Espacio accionan el
  // cierre, que en la librería es un `<div>`.
  useEffect(() => {
    const alTeclear = (e: KeyboardEvent) => {
      const c = cliente;
      if (!c?.isVisible || !c.dialog) return;
      const d = c.dialog;
      if ((e.key === "Enter" || e.key === " ") && e.target instanceof HTMLElement && e.target.id === "tg-dialog-close-btn") {
        e.preventDefault();
        void c.exit().catch(() => undefined);
        return;
      }
      if (e.key !== "Tab") return;
      const focos = [...d.querySelectorAll<HTMLElement>('button:not([disabled]), [tabindex="0"]')].filter((el) => el.getClientRects().length > 0);
      if (focos.length === 0) {
        e.preventDefault();
        d.focus({ preventScroll: true });
        return;
      }
      const primero = focos[0]!;
      const ultimo = focos[focos.length - 1]!;
      const activo = document.activeElement;
      if (!d.contains(activo) || activo === d) {
        e.preventDefault();
        (e.shiftKey ? ultimo : primero).focus({ preventScroll: true });
      } else if (!e.shiftKey && activo === ultimo) {
        e.preventDefault();
        primero.focus({ preventScroll: true });
      } else if (e.shiftKey && activo === primero) {
        e.preventDefault();
        ultimo.focus({ preventScroll: true });
      }
    };
    document.addEventListener("keydown", alTeclear, true);
    return () => {
      document.removeEventListener("keydown", alTeclear, true);
      retirarCliente();
    };
  }, []);

  return (
    <button ref={lanzador} type="button" className="app-tour" data-tour="tour-launch" onClick={pedir} title={t("openHint")}>
      <span className="app-tour-ic" aria-hidden>
        <TourIcon />
      </span>
      <span className="app-tour-label">{t("open")}</span>
    </button>
  );
}
