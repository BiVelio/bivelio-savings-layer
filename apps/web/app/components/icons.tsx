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

/** Install — la terminal (lucide Terminal). */
export const InstallIcon = () => (
  <Icon>
    <path d="m4 17 6-6-6-6" />
    <path d="M12 19h8" />
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

export const ICONS: Record<string, () => React.ReactElement> = {
  overview: DashboardIcon,
  proof: ProofIcon,
  verify: VerifyIcon,
  install: InstallIcon,
  account: AccountIcon,
  how: HowIcon,
  extracto: ReceiptIcon,
};
