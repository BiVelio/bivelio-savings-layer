/**
 * EL RESALTADO POR ANCLA DEL MENÚ SE MUEVE CON CADA NAVEGACIÓN, NO SÓLO CON
 * `hashchange` — y cuando dos entradas comparten página (Resumen `/dashboard`
 * y Máquinas `/dashboard#maquinas`) se enciende UNA, en las dos direcciones.
 *
 * Es el test que privacy fijó el 20-09-2026 (`nav-hash.test.ts` de ese repo)
 * tras medir en Chromium dos entradas con `.on` y `aria-current="page"` a la
 * vez en `/dashboard/billing#devices`. Sin banco de DOM, se ejercita el
 * almacén con un `window` mínimo —un `EventTarget` con `location`— y la
 * decisión de iluminar con la función pura.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/i18n/navigation", () => ({
  Link: () => null,
  usePathname: () => "/dashboard",
}));

const { announceHash, getHashSnapshot, getServerHashSnapshot, readDocumentHash, subscribeHash } =
  await import("./nav-hash");
const { isNavLinkActive } = await import("./NavLink");

type FakeWindow = EventTarget & { location: { hash: string } };

function installWindow(hash = ""): FakeWindow {
  const w = Object.assign(new EventTarget(), { location: { hash } }) as FakeWindow;
  (globalThis as { window?: unknown }).window = w;
  return w;
}

const OVERVIEW = "/dashboard";
const MACHINES = `${OVERVIEW}#maquinas`;

/** Las dos entradas tal y como el raíl las declara: Resumen sin ancla y
 *  Máquinas con la suya; `siblingHashes` las calcula `AppSidebar`. */
function lit(pathname: string, hash: string) {
  return {
    overview: isNavLinkActive({ pathname, hash, href: OVERVIEW, siblingHashes: ["maquinas"] }),
    machines: isNavLinkActive({ pathname, hash, href: MACHINES, siblingHashes: [] }),
  };
}

describe("el almacén del ancla", () => {
  beforeEach(() => {
    installWindow("");
    announceHash("");
  });
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it("antes de hidratar no afirma ningún ancla", () => {
    expect(getServerHashSnapshot()).toBe("");
  });

  it("dos clics seguidos mueven la luz — el caso que se congelaba", () => {
    let notified = 0;
    const unsubscribe = subscribeHash(() => notified++);

    announceHash("#maquinas");
    expect(getHashSnapshot()).toBe("#maquinas");
    expect(lit(OVERVIEW, getHashSnapshot())).toEqual({ overview: false, machines: true });

    announceHash("");
    expect(lit(OVERVIEW, getHashSnapshot())).toEqual({ overview: true, machines: false });
    expect(notified).toBe(2);
    unsubscribe();
  });

  it("anunciar el mismo ancla dos veces no notifica dos veces", () => {
    let notified = 0;
    const unsubscribe = subscribeHash(() => notified++);
    announceHash("#maquinas");
    announceHash("maquinas");
    expect(notified).toBe(1);
    unsubscribe();
  });

  it("atrás/adelante (popstate) y hashchange vuelven a leer el documento", () => {
    const w = installWindow("");
    let notified = 0;
    const unsubscribe = subscribeHash(() => notified++);
    w.location.hash = "#maquinas";
    w.dispatchEvent(new Event("popstate"));
    expect(getHashSnapshot()).toBe("#maquinas");
    w.location.hash = "";
    w.dispatchEvent(new Event("hashchange"));
    expect(getHashSnapshot()).toBe("");
    expect(notified).toBe(2);
    unsubscribe();
  });

  it("quitar una suscripción no deja sordas a las que siguen", () => {
    const w = installWindow("");
    let a = 0;
    let b = 0;
    const offA = subscribeHash(() => a++);
    const offB = subscribeHash(() => b++);
    offA();
    w.location.hash = "#maquinas";
    w.dispatchEvent(new Event("hashchange"));
    expect(a).toBe(0);
    expect(b).toBe(1);
    offB();
  });

  it("readDocumentHash lee lo que hay en la URL", () => {
    const w = installWindow("#maquinas");
    readDocumentHash();
    expect(getHashSnapshot()).toBe("#maquinas");
    w.location.hash = "";
  });
});

describe("isNavLinkActive", () => {
  it("Resumen casa exacto: /dashboard/proof no lo enciende", () => {
    expect(lit("/dashboard/proof", "")).toEqual({ overview: false, machines: false });
  });

  it("un ancla que no es de nadie deja encendida la entrada sin ancla", () => {
    expect(lit(OVERVIEW, "#otra")).toEqual({ overview: true, machines: false });
  });

  it("una entrada casa sus rutas anidadas", () => {
    expect(isNavLinkActive({ pathname: "/dashboard/install/x", hash: "", href: "/dashboard/install" })).toBe(true);
  });

  it("Prueba sigue encendida en Verificar (pestaña de la misma entrada)", () => {
    expect(isNavLinkActive({ pathname: "/dashboard/verify", hash: "", href: "/dashboard/proof" })).toBe(true);
    expect(isNavLinkActive({ pathname: "/dashboard/verify", hash: "", href: "/dashboard/account" })).toBe(false);
  });

  it("una entrada con ancla y `primary` se enciende también sin ancla", () => {
    expect(isNavLinkActive({ pathname: OVERVIEW, hash: "", href: MACHINES, primary: true })).toBe(true);
  });
});
