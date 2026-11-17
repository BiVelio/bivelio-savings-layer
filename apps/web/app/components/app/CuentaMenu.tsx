"use client";

import type { ReactNode } from "react";

import { Link } from "@/i18n/navigation";
import { ProfileMenu, type ProfileMenuItem, type ProfileMenuSetup } from "@/vendor/affectui/profile-menu";

import { announceHash } from "./nav-hash";

/**
 * LA CUENTA EN LA BARRA: el Profile Menu de affectUI, con lo que el panel ya
 * sabe de quien mira. Este fichero solo existe para una cosa: darle a la pieza
 * el `Link` con idioma (un componente no cruza de servidor a cliente como
 * prop; los datos sí). Todo lo que se pinta lo resolvió `AppTopbar` en
 * servidor: aquí no se lee ni se decide nada.
 *
 * Lo único que hace al elegir una fila es lo mismo que hace `NavLink`: decirle
 * al almacén de anclas a dónde va (`announceHash`), para que «Máquinas» del
 * raíl se encienda al llegar por aquí a `#maquinas`.
 */
export function CuentaMenu(props: {
  triggerLabel: string;
  menuLabel: string;
  name: string;
  email: string;
  tags: { id: string; label: string; tone?: "brand" }[];
  items: ProfileMenuItem[];
  setup?: ProfileMenuSetup;
  signOut: { label: string; icon: ReactNode };
}) {
  return (
    <ProfileMenu
      {...props}
      linkAs={Link}
      onNavigate={(href) => announceHash(href.includes("#") ? `#${href.split("#")[1]}` : "")}
      signOut={{ action: "/auth/signout", label: props.signOut.label, icon: props.signOut.icon, className: "app-signout-item" }}
    />
  );
}
