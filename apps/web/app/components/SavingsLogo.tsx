/* Logo oficial de Savings (by BiVelio) — los PNG recortados de public/brand/.
   Dos variantes: el logotipo horizontal completo (isotipo + «Savings.» + «by
   BiVelio») y el isotipo «S» solo, para huecos estrechos. Las proporciones van
   fijadas en el <img> para que no haya salto de maquetación al cargar. */

// Proporción ancho/alto del logotipo recortado (574×160).
const FULL_RATIO = 574 / 160;

type Props = {
  variant?: "full" | "mark";
  /** Alto en px; el ancho sale de la proporción real del recurso. */
  height?: number;
  className?: string;
};

export function SavingsLogo({ variant = "full", height = 36, className }: Props) {
  const full = variant === "full";
  const width = full ? Math.round(height * FULL_RATIO) : height;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      className={["savings-logo", className].filter(Boolean).join(" ")}
      src={full ? "/brand/savings-logo.png" : "/brand/savings-mark.png"}
      alt="Savings by BiVelio"
      width={width}
      height={height}
      style={{ width, height }}
      decoding="async"
    />
  );
}
