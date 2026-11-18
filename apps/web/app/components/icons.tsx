/* Iconos inline (trazo 1.9, caja 24, extremos redondos) — el mismo dibujo que
   los lucide-react de bivelio.com, sin arrastrar la dependencia a este paquete.
   Se pintan con `currentColor`, así que heredan el color de su contenedor. */
import type { SVGProps } from "react";

function Icon({ children, ...props }: SVGProps<SVGSVGElement> & { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...props}
    >
      {children}
    </svg>
  );
}

export const ArrowRightIcon = () => (
  <Icon>
    <path d="M5 12h14" />
    <path d="m12 5 7 7-7 7" />
  </Icon>
);

export const CloseIcon = () => (
  <Icon strokeWidth="2">
    <path d="M18 6 6 18" />
    <path d="m6 6 12 12" />
  </Icon>
);

/**
 * Triángulo de voto (el «upvote» genérico) para la franja de Product Hunt.
 * Dibujo propio y relleno: nada de logotipos ni de imágenes de producthunt.com,
 * que además pedirían abrir la CSP (img-src).
 */
export const VotoIcon = ({ className }: { className?: string }) => (
  <Icon className={className} fill="currentColor" strokeWidth="1.5">
    <path d="M12 5.5 19.5 17.5h-15Z" />
  </Icon>
);

/** Hamburguesa del menú móvil (lucide Menu), como el del <SiteNav> corporativo. */
export const MenuIcon = () => (
  <Icon strokeWidth="2">
    <path d="M4 6h16" />
    <path d="M4 12h16" />
    <path d="M4 18h16" />
  </Icon>
);

/** El sitio corporativo (lucide Globe). */
export const GlobeIcon = () => (
  <Icon>
    <circle cx="12" cy="12" r="10" />
    <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
    <path d="M2 12h20" />
  </Icon>
);

/** Overview — la rejilla de paneles (lucide LayoutDashboard). */
export const DashboardIcon = () => (
  <Icon>
    <rect width="7" height="9" x="3" y="3" rx="1" />
    <rect width="7" height="5" x="14" y="3" rx="1" />
    <rect width="7" height="9" x="14" y="12" rx="1" />
    <rect width="7" height="5" x="3" y="16" rx="1" />
  </Icon>
);

/** Proof — escudo con check (lucide ShieldCheck). */
export const ProofIcon = () => (
  <Icon>
    <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
    <path d="m9 12 2 2 4-4" />
  </Icon>
);

/** Verify — ejecutar la comprobación (lucide CirclePlay). */
export const VerifyIcon = () => (
  <Icon>
    <circle cx="12" cy="12" r="10" />
    <path d="M10 8.5 15.5 12 10 15.5z" />
  </Icon>
);

/** Primeros pasos — la descarga (lucide Download), el mismo que privacy. */
export const InstallIcon = () => (
  <Icon>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <path d="M7 10l5 5 5-5" />
    <path d="M12 15V3" />
  </Icon>
);

/** Account — el usuario (lucide CircleUser). */
export const AccountIcon = () => (
  <Icon>
    <circle cx="12" cy="12" r="10" />
    <circle cx="12" cy="10" r="3" />
    <path d="M7 20.66V19a4 4 0 0 1 4-4h2a4 4 0 0 1 4 4v1.66" />
  </Icon>
);

/* ── Marcas sociales: sólidas y con la caja de 24 del logotipo oficial, así que
      no pasan por el <Icon> de trazo. Mismos paths que el SocialDock de
      bivelio.com. ── */
function Glyph({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d={d} />
    </svg>
  );
}

export const LinkedInIcon = () => (
  <Glyph d="M20.45 20.45h-3.56v-5.57c0-1.33-.02-3.04-1.85-3.04-1.85 0-2.14 1.44-2.14 2.94v5.67H9.34V9h3.41v1.56h.05c.47-.89 1.63-1.83 3.36-1.83 3.6 0 4.27 2.37 4.27 5.46v6.26zM5.34 7.43a2.07 2.07 0 1 1 0-4.13 2.07 2.07 0 0 1 0 4.13zm-1.78 13.02h3.56V9H3.56v11.45zM22.22 0H1.77C.79 0 0 .77 0 1.72v20.56C0 23.23.79 24 1.77 24h20.45C23.2 24 24 23.23 24 22.28V1.72C24 .77 23.2 0 22.22 0z" />
);

export const GitHubIcon = () => (
  <Glyph d="M12 .3a12 12 0 0 0-3.8 23.38c.6.11.82-.26.82-.58 0-.29-.01-1.04-.02-2.04-3.34.72-4.04-1.61-4.04-1.61-.55-1.39-1.33-1.76-1.33-1.76-1.08-.74.08-.72.08-.72 1.2.08 1.83 1.23 1.83 1.23 1.07 1.83 2.8 1.3 3.49.99.1-.77.42-1.3.76-1.6-2.67-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.13-.3-.54-1.52.11-3.18 0 0 1-.32 3.3 1.23a11.5 11.5 0 0 1 6 0c2.28-1.55 3.29-1.23 3.29-1.23.65 1.66.24 2.88.12 3.18.77.84 1.23 1.91 1.23 3.22 0 4.61-2.81 5.63-5.49 5.92.42.36.81 1.1.81 2.22 0 1.6-.02 2.88-.02 3.28 0 .32.21.7.82.58A12 12 0 0 0 12 .3" />
);

/** How it works — la ruta entre dos puntos (lucide Route). */
export const HowIcon = () => (
  <Icon>
    <circle cx="6" cy="19" r="3" />
    <path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15" />
    <circle cx="18" cy="5" r="3" />
  </Icon>
);

/** Extracto — el recibo (lucide Receipt). */
export const ReceiptIcon = () => (
  <Icon>
    <path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1z" />
    <path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8" />
    <path d="M12 17.5v-11" />
  </Icon>
);

/** Equipo — las personas (lucide Users). */
export const TeamIcon = () => (
  <Icon>
    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
  </Icon>
);

/** Máquinas — el portátil (lucide Laptop). */
export const MachinesIcon = () => (
  <Icon>
    <path d="M20 16V7a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9m16 0H4m16 0 1.28 2.55a1 1 0 0 1-.9 1.45H3.62a1 1 0 0 1-.9-1.45L4 16" />
  </Icon>
);

/** Tour guiado — una brújula (lucide Compass). */
export const TourIcon = () => (
  <Icon>
    <circle cx="12" cy="12" r="10" />
    <path d="m16.24 7.76-1.8 5.4a2 2 0 0 1-1.28 1.28l-5.4 1.8 1.8-5.4a2 2 0 0 1 1.28-1.28z" />
  </Icon>
);

/** Cerrar sesión (lucide LogOut). */
export const SignOutIcon = () => (
  <Icon>
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
    <path d="m16 17 5-5-5-5" />
    <path d="M21 12H9" />
  </Icon>
);

/** Integrar una aplicación — llaves de código (lucide Braces). */
export const CodeIcon = () => (
  <Icon>
    <path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5a2 2 0 0 0 2 2h1" />
    <path d="M16 21h1a2 2 0 0 0 2-2v-5a2 2 0 0 1 2-2 2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1" />
  </Icon>
);

/** Conectar un agente — una terminal (lucide SquareTerminal). */
export const TerminalIcon = () => (
  <Icon>
    <path d="m7 11 2-2-2-2" />
    <path d="M11 13h4" />
    <rect width="18" height="18" x="3" y="3" rx="2" />
  </Icon>
);

/** Credenciales — una llave (lucide KeyRound). */
export const KeyIcon = () => (
  <Icon>
    <path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z" />
    <circle cx="16.5" cy="7.5" r=".5" fill="currentColor" />
  </Icon>
);

/** Modo local — un portátil (lucide Laptop). */
export const LaptopIcon = () => (
  <Icon>
    <path d="M18 5a2 2 0 0 1 2 2v8.526a2 2 0 0 0 .212.897l1.068 2.127a1 1 0 0 1-.9 1.45H3.62a1 1 0 0 1-.9-1.45l1.068-2.127A2 2 0 0 0 4 15.526V7a2 2 0 0 1 2-2z" />
    <path d="M20.054 15.987H3.946" />
  </Icon>
);

/** Conexión Cloud — una nube (lucide Cloud). */
export const CloudIcon = () => (
  <Icon>
    <path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z" />
  </Icon>
);

/** Lectura fallida o atención (lucide TriangleAlert). */
export const AlertIcon = () => (
  <Icon>
    <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
    <path d="M12 9v4" />
    <path d="M12 17h.01" />
  </Icon>
);

/** Acceso limitado (lucide EyeOff). */
export const EyeOffIcon = () => (
  <Icon>
    <path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49" />
    <path d="M14.084 14.158a3 3 0 0 1-4.242-4.242" />
    <path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143" />
    <path d="m2 2 20 20" />
  </Icon>
);

/** Ahorro medido — tendencia (lucide TrendingUp). */
export const TrendIcon = () => (
  <Icon>
    <path d="M16 7h6v6" />
    <path d="m22 7-8.5 8.5-5-5L2 17" />
  </Icon>
);

/** Hecho (lucide Check). */
export const CheckIcon = () => (
  <Icon strokeWidth="2.2">
    <path d="M20 6 9 17l-5-5" />
  </Icon>
);

export const ICONS: Record<string, () => React.ReactElement> = {
  overview: DashboardIcon,
  proof: ProofIcon,
  verify: VerifyIcon,
  install: InstallIcon,
  account: AccountIcon,
  how: HowIcon,
  extracto: ReceiptIcon,
  team: TeamIcon,
  machines: MachinesIcon,
};
