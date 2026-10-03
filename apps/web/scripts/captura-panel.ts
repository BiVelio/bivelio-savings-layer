/**
 * LA CAPTURA DEL PANEL QUE ENSEÑA LA PORTADA.
 *
 *   pnpm dev                                # en apps/web, otra terminal
 *   node scripts/captura-panel.ts           # Node ≥ 22.6 (tipos borrados)
 *
 * Abre la ruta de desarrollo `/es/captura-panel` —el Resumen del panel con sus
 * componentes de verdad, alimentados SOLO con `lib/portada/panel-del-banco.ts`
 * (el flujo GSM8K del banco público del 2026-09-28)— en un Chromium a 2×,
 * y escribe `assets/portada/panel-del-banco.png`, que la portada importa con
 * `next/image` (Vercel la sirve en AVIF o WebP según el navegador; el PNG es la
 * reserva). Escribe también los .webp y .avif al lado de la carpeta temporal
 * para poder comprobar el peso de lo que se sirve.
 *
 * Nada de la captura se retoca a mano. Lo único que se toca de la página es
 * lo que no es el panel: se esconde la barra pública del sitio (la ruta no
 * está bajo /dashboard, así que la pinta) y el indicador de `next dev`, se
 * quita el desenfoque de la barra superior (sin contenido debajo deja una
 * franja gris en la captura), y se marca «Resumen» como la entrada activa del raíl, que es la pantalla que es.
 *
 * Variables: CAPTURA_URL (por defecto http://localhost:3000), CHROMIUM_PATH
 * (por defecto el Chrome instalado).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright-core";
import sharp from "sharp";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.env.CAPTURA_URL ?? "http://localhost:3000";
const SALIDA = join(WEB, "assets", "portada", "panel-del-banco.png");

/** El tamaño de la ventana en píxeles CSS, y la densidad: 2× para pantallas retina. */
const ANCHO = 1360;
const ALTO = 1040;
const DENSIDAD = 2;

/** El reloj de la página: el día siguiente a la tirada, para que el periodo de 30 días la contenga. */
const AHORA = new Date("2026-09-29T09:00:00Z");

const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : { channel: "chrome" },
);
try {
  const page = await browser.newPage({
    viewport: { width: ANCHO, height: ALTO },
    deviceScaleFactor: DENSIDAD,
    colorScheme: "light",
    reducedMotion: "reduce",
    locale: "es-ES",
  });
  await page.clock.setFixedTime(AHORA);
  // El explorador recuerda vista y métrica en el navegador: por modelo y ahorro neto.
  await page.addInitScript(() => {
    window.localStorage.setItem("bvsala.explorer.v1", JSON.stringify({ vista: "modelo", metrica: "neto" }));
  });
  // Nada sale de localhost (la etiqueta de Google Ads, por ejemplo).
  await page.route(/^https?:\/\/(?!localhost|127\.0\.0\.1)/, (r) => r.abort());

  const res = await page.goto(`${BASE}/es/captura-panel`, { waitUntil: "networkidle", timeout: 120_000 });
  if (!res || res.status() !== 200) throw new Error(`/es/captura-panel respondió ${res?.status()} — ¿está corriendo \`next dev\`?`);

  await page.addStyleTag({
    content: `
      .announce, .site-nav, nextjs-portal { display: none !important; }
      /* El desenfoque de la barra pegajosa, sin nada debajo, deja en la captura una franja gris. */
      .app-topbar { -webkit-backdrop-filter: none !important; backdrop-filter: none !important; background: #fff !important; }
      html { scrollbar-width: none; }
      *, *::before, *::after { caret-color: transparent !important; }
    `,
  });
  await page.evaluate(() => {
    const resumen = document.querySelector<HTMLAnchorElement>('.app-nav a[href$="/dashboard"]');
    resumen?.setAttribute("aria-current", "page");
    resumen?.classList.add("on");
  });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(600);

  const huella = await page.getAttribute("[data-huella]", "data-huella");
  if (!huella) throw new Error("la ruta de la captura no dejó su huella");

  const png = await page.screenshot({ type: "png", fullPage: false });

  mkdirSync(dirname(SALIDA), { recursive: true });
  const maestro = await sharp(png).png({ compressionLevel: 9, adaptiveFiltering: true, effort: 10 }).toBuffer();
  writeFileSync(SALIDA, maestro);
  // Qué cifras pinta esta imagen: la verja compara la huella con la de
  // lib/portada/panel-del-banco.ts y exige volver a capturar si cambian.
  const meta = { huella, ruta: "/es/captura-panel", ancho: ANCHO * DENSIDAD, alto: ALTO * DENSIDAD, densidad: DENSIDAD, reloj: AHORA.toISOString() };
  writeFileSync(SALIDA.replace(/\.png$/, ".json"), JSON.stringify(meta, null, 2) + "\n");

  const tmp = join(tmpdir(), "captura-panel");
  mkdirSync(tmp, { recursive: true });
  const kb = (b: Buffer) => `${(b.length / 1024).toFixed(0)} KB`;
  console.log(`PNG  ${SALIDA} · ${kb(maestro)} · ${ANCHO * DENSIDAD}×${ALTO * DENSIDAD}`);
  for (const ancho of [1200, 2048, ANCHO * DENSIDAD]) {
    const r = sharp(png).resize({ width: ancho });
    const avif = await r.clone().avif({ quality: 70, effort: 6 }).toBuffer();
    const webp = await r.clone().webp({ quality: 80, effort: 6 }).toBuffer();
    writeFileSync(join(tmp, `panel-${ancho}.avif`), avif);
    writeFileSync(join(tmp, `panel-${ancho}.webp`), webp);
    console.log(`${ancho}px · AVIF ${kb(avif)} · WebP ${kb(webp)}  (${tmp})`);
  }
} finally {
  await browser.close();
}
