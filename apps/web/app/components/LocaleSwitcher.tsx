"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLocale, useTranslations } from "next-intl";

import { useRouter, usePathname } from "@/i18n/navigation";
import { locales } from "@/i18n/config";
import { metaFor } from "@/i18n/locale-meta";

// A search box only earns its place once the list is long; below this many
// locales it is pure noise (you can see them all at a glance).
const SEARCH_THRESHOLD = 8;

/**
 * Language selector — an iLovePDF-style modal grid, matching bivelio.com. The
 * trigger stays compact in the nav (globe + the current language's native name);
 * the dialog exposes every LIVE locale as a card with its native + English name
 * and a check on the active one, so a visitor jumps straight to their language.
 *
 * Rebuilt on the app's own CSS tokens (no Tailwind / base-ui / lucide): the
 * corporate switcher's look, native to this surface and theme-aware.
 */
export function LocaleSwitcher() {
  const active = useLocale();
  const t = useTranslations("nav");
  const router = useRouter();
  const pathname = usePathname();

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const showSearch = locales.length > SEARCH_THRESHOLD;
  const q = query.trim().toLowerCase();
  const items = locales
    .map((code) => ({ code, ...metaFor(code) }))
    .filter((l) => (q ? `${l.native} ${l.english} ${l.code}`.toLowerCase().includes(q) : true));
  const activeMeta = metaFor(active);

  // Al abrir: bloquear el scroll de fondo y enfocar la búsqueda. Al cerrar:
  // limpiar la consulta, restaurar la posición y devolver el foco al disparador.
  //
  // El bloqueo NO puede hacerse con `body.style.overflow = "hidden"`: html y body
  // ya declaran `overflow-x` (clip) para contener las bandas a sangre, y con eso
  // el truco deja de detener el scroll — comprobado en Chrome. Se fija el body y
  // se compensa con un desplazamiento negativo, que funciona pase lo que pase con
  // la semántica de overflow y además evita el salto al restaurar.
  useEffect(() => {
    if (!open) {
      setQuery("");
      return;
    }
    const y = window.scrollY;
    const body = document.body;
    const prev = { position: body.style.position, top: body.style.top, width: body.style.width };
    body.style.position = "fixed";
    body.style.top = `-${y}px`;
    body.style.width = "100%";

    const id = window.setTimeout(() => searchRef.current?.focus(), 20);
    return () => {
      window.clearTimeout(id);
      body.style.position = prev.position;
      body.style.top = prev.top;
      body.style.width = prev.width;
      window.scrollTo({ top: y, behavior: "instant" });
      triggerRef.current?.focus();
    };
  }, [open]);

  // Escape closes.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  function selectLocale(code: string) {
    setOpen(false);
    if (code === active) return;
    // Keep the current path + query + hash; next-intl swaps only the locale
    // segment and sets the NEXT_LOCALE cookie via its middleware on navigation.
    const search = typeof window !== "undefined" ? window.location.search : "";
    const hash = typeof window !== "undefined" ? window.location.hash : "";
    router.replace(`${pathname}${search}${hash}`, { locale: code });
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="toggle lang-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <GlobeIcon />
        {/* El nombre accesible es «Cambiar idioma» + lo que se ve («English EN»).
            Con `aria-label` el texto visible quedaba fuera del nombre, y quien
            maneja la web por voz («pulsa English») no daba con el botón
            (axe `label-content-name-mismatch`). */}
        <span className="sr-only">{t("langAria")}</span>
        {/* El disparador nunca se queda mudo: por debajo de 640px el nombre
            nativo cede el sitio al código, como el `sm:hidden` del origen. */}
        <span className="lang-trigger-name">{activeMeta.native}</span>
        <span className="lang-trigger-code">{active.toUpperCase()}</span>
      </button>

      {/* El overlay se monta en <body> mediante un portal, NO aquí dentro. La
          barra de navegación lleva `backdrop-filter`, y un ancestro con filtro
          de fondo se convierte en el bloque contenedor de sus descendientes
          `position: fixed`: sin el portal, `inset: 0` se resolvía contra los
          64px del nav y el modal aparecía encajado dentro de la barra. Es lo
          mismo que hace bivelio.com con <Dialog.Portal>. */}
      {open && createPortal(
        <div
          className="lang-overlay"
          onClick={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <div
            className="lang-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="lang-modal-title"
            aria-describedby="lang-modal-sub"
          >
            <div className="lang-modal-head">
              <div>
                <h2 id="lang-modal-title" className="lang-modal-title">
                  {t("langTitle")}
                </h2>
                <p id="lang-modal-sub" className="lang-modal-sub">
                  {t("langSubtitle")}
                </p>
              </div>
              <button
                type="button"
                className="lang-close"
                aria-label={t("langClose")}
                onClick={() => setOpen(false)}
              >
                <CloseIcon />
              </button>
            </div>

            {showSearch && (
              <div className="lang-search-wrap">
                <input
                  ref={searchRef}
                  type="text"
                  className="lang-search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t("langSearch")}
                  aria-label={t("langSearch")}
                />
              </div>
            )}

            <div className="lang-grid">
              {items.map((l) => {
                const isActive = l.code === active;
                return (
                  <button
                    key={l.code}
                    type="button"
                    dir={l.dir}
                    onClick={() => selectLocale(l.code)}
                    aria-current={isActive ? "true" : undefined}
                    className={`lang-card${isActive ? " on" : ""}`}
                  >
                    <span className="lang-card-names">
                      <span className="lang-card-native">{l.native}</span>
                      <span className="lang-card-english">{l.english}</span>
                    </span>
                    {isActive && <CheckIcon />}
                  </button>
                );
              })}
              {items.length === 0 && <p className="lang-empty">—</p>}
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

function GlobeIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3c2.5 2.5 3.8 5.6 3.8 9s-1.3 6.5-3.8 9c-2.5-2.5-3.8-5.6-3.8-9s1.3-6.5 3.8-9Z" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}
