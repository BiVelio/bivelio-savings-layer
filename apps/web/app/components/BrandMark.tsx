/* The BiVelio brand mark: the logo + the "BiVelio." wordmark with the exact
   brand-coloured dots (#00B3FC / #0073FF / #00CBF2), matching bivelio.com. */
export function BrandMark({ size = 26 }: { size?: number }) {
  return (
    <span className="brand">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        className="brand-logo"
        src="/logo-bivelio.png"
        alt="BiVelio"
        width={size}
        height={size}
        style={{ width: size, height: size }}
      />
      <span className="bv-word" aria-label="BiVelio">
        B<span className="bv-i">ı<span className="tit bv-c1" /></span>Vel
        <span className="bv-i">ı<span className="tit bv-c2" /></span>o
        <span className="bv-period bv-c3" />
      </span>
    </span>
  );
}
