import { getTranslations } from "next-intl/server";

import { getSidebarState } from "@/lib/dashboard/sidebar-state";
import { puede, type Accion } from "@/lib/org/permisos";

import { NavLink } from "./NavLink";
import { SetupProgress } from "./SetupProgress";

/**
 * EL RAÍL DEL PANEL: POR RECORRIDO, COMO EL DE PRIVACY.
 *
 * Tres grupos que son VERBOS, no áreas de producto — Empezar (dónde estoy y
 * qué hago primero), Ahorrar (el producto haciendo su trabajo) y Tu
 * organización (la gente, las máquinas y lo que se paga). Es el mismo
 * recorrido que aprobó el propietario para privacy el 19-09 (bloque 1 de
 * `docs/artefactos/maqueta-panel-recorrido.html` en ese repo), para que las
 * dos consolas se lean como un mismo software: mismo raíl de 288px, mismas
 * cabeceras de grupo, mismas cifras a la derecha y el mismo bloque de puesta
 * en marcha arriba.
 *
 * LAS CIFRAS DE LA DERECHA son lecturas, no adornos: «2/5» pasos, «3 de 5»
 * asientos, «2 miembros». Salen de `lib/dashboard/sidebar-state.ts` (una sola
 * resolución por petición) y cuando una lectura no contesta la entrada se
 * pinta SIN cifra. Nunca un cero por un fallo. Y son CIFRAS, no frases: la
 * frase entera va al `title` de la fila (`badgeTitle`), donde no le roba el
 * ancho a la etiqueta.
 *
 * ENTRADAS FILTRADAS POR ROL, Y NUNCA POR PLAN. Equipo es de quien puede
 * gestionar miembros (la puerta de `GET /api/org/members`: a un `member` la
 * ruta le contesta 403 y el panel se callaba entero). El Extracto NO se
 * filtra por plan a propósito: una organización en impago sigue leyendo `pro`
 * y esconderle el extracto es castigarla justo cuando más lo necesita.
 *
 * Y CUANDO NO HAY ROL QUE LEER, EL MENÚ LO DICE. `loadDashboard` devuelve el
 * contexto vacío tanto para «no estás en ninguna organización» como para «la
 * lectura falló», y `puede(null, …)` cierra todo. Se sigue sin ofrecer lo que
 * no se puede respaldar, pero se dice que está incompleto.
 *
 * VERIFICAR no tiene entrada (decisión del dueño, 02-09: «lía más que otra
 * cosa»): desde hoy es pestaña de Prueba, y `NavLink.ALSO_MATCHES` mantiene
 * Prueba encendida mientras se está en ella.
 */
export async function AppSidebar({
  role,
  unknownOrg,
}: {
  role?: string | null;
  /** La organización no se pudo leer para un usuario con sesión. El menú que
   *  se ve entonces no es el de este rol: es el de NINGÚN rol. */
  unknownOrg?: boolean;
}) {
  const t = await getTranslations("app.sidebar");
  const s = await getTranslations("app.setup");
  const state = await getSidebarState();

  const progress = state.progress;
  const progressBadge =
    progress && progress.readable
      ? {
          badge: s("badge.progress", { done: progress.done, total: progress.total }),
          title: `${s("title")} · ${s("count", { done: progress.done, total: progress.total })}`,
        }
      : { badge: null, title: null };

  const GROUPS: {
    label: string;
    items: {
      href: string;
      label: string;
      icon: string;
      needs?: Accion;
      primary?: boolean;
      badge?: string | null;
      badgeTitle?: string | null;
    }[];
  }[] = [
    {
      label: "groupStart",
      items: [
        { href: "/dashboard", label: "overview", icon: "overview" },
        // La cifra de la derecha es la misma puesta en marcha del bloque de
        // arriba, en pequeño, para que siga visible cuando el bloque se haya
        // ido scrolleando — y para el rol que no ve el bloque, nada.
        {
          href: "/dashboard/install",
          label: "install",
          icon: "install",
          badge: progressBadge.badge,
          badgeTitle: progressBadge.title,
        },
        { href: "/dashboard/how-it-works", label: "howItWorks", icon: "how" },
      ],
    },
    {
      label: "groupSave",
      items: [
        { href: "/dashboard/proof", label: "proof", icon: "proof" },
        { href: "/dashboard/extracto", label: "extracto", icon: "extracto" },
      ],
    },
    {
      label: "groupOrg",
      items: [
        {
          href: "/dashboard/team",
          label: "team",
          icon: "team",
          needs: "gestionar_miembros",
          badge: typeof state.members === "number" ? s("badge.members", { n: state.members }) : null,
          badgeTitle:
            typeof state.members === "number" ? s("badge.members", { n: state.members }) : null,
        },
        // Las máquinas viven en el Resumen (MaquinasCard, ancla `#maquinas`):
        // la entrada lleva la lectura que responde de verdad a «¿cuántos
        // asientos estoy usando de los que pago?».
        {
          href: "/dashboard#maquinas",
          label: "maquinas",
          icon: "machines",
          badge: state.seats
            ? s("badge.seats", { used: state.seats.used, seats: state.seats.seats })
            : null,
          badgeTitle: state.seats
            ? s("badge.seatsTitle", { used: state.seats.used, seats: state.seats.seats })
            : null,
        },
        { href: "/dashboard/account", label: "account", icon: "account" },
      ],
    },
  ];

  const visible = GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => !item.needs || puede(role, item.needs)),
  })).filter((group) => group.items.length > 0);

  /**
   * Qué anclas declaran las OTRAS entradas de cada ruta — la tabla que impide
   * el doble marcado (Resumen y Máquinas comparten `/dashboard`), resuelta
   * aquí porque este catálogo es quien la sabe, y sobre las entradas VISIBLES.
   */
  const anchorsByBase = new Map<string, string[]>();
  for (const group of visible) {
    for (const item of group.items) {
      const [base, ownHash] = item.href.split("#");
      if (!ownHash || !base) continue;
      anchorsByBase.set(base, [...(anchorsByBase.get(base) ?? []), ownHash]);
    }
  }
  const siblingsOf = (href: string): string[] => {
    const [base, ownHash] = href.split("#");
    return (anchorsByBase.get(base ?? "") ?? []).filter((anchor) => anchor !== ownHash);
  };

  return (
    <aside className="app-sidebar">
      {/* Fuera de `.app-nav` a propósito: en ≤860px ese contenedor es una tira
          horizontal con scroll y una frase dentro sería un ítem más. */}
      {unknownOrg && (
        <p className="app-nav-note" role="status">
          {t("incomplete")}
        </p>
      )}
      <nav className="app-nav" aria-label={t("sections")}>
        {/* DENTRO del raíl, y no encima: el raíl es lo único con altura acotada
            y scroll propio; un bloque por fuera empuja el menú hacia abajo sin
            entrar en esa cuenta. En ≤860px el bloque se oculta por CSS — la
            cifra sigue en «Instalar». */}
        {progress && <SetupProgress progress={progress} />}
        {visible.map((group, gi) => (
          <div key={group.label} style={{ display: "contents" }}>
            {/* `data-first` en la cabecera del PRIMER grupo: a ≤860px las
                cabeceras se convierten en una raya vertical entre grupos, y
                una raya delante de la primera entrada es una raya suelta. */}
            <div className="app-nav-sep" data-first={gi === 0 ? "" : undefined}>
              {t(group.label)}
            </div>
            {group.items.map((item) => (
              <NavLink
                key={item.href}
                href={item.href}
                icon={item.icon}
                primary={item.primary}
                siblingHashes={siblingsOf(item.href)}
                badge={item.badge}
                badgeTitle={item.badgeTitle}
              >
                {t(item.label)}
              </NavLink>
            ))}
          </div>
        ))}
      </nav>
    </aside>
  );
}
