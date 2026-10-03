/**
 * LAS CAPTURAS DEL PANEL QUE ENSEÑA LA PORTADA.
 *
 *   pnpm dev                                # en apps/web, otra terminal
 *   node scripts/captura-panel.ts           # Node ≥ 22.6 (tipos borrados)
 *
 * Abre la ruta de desarrollo `/es/captura-panel` —el Resumen del panel con sus
 * componentes de verdad, alimentados SOLO con `lib/portada/panel-del-banco.ts`
 * (el flujo GSM8K del banco público del 2026-09-28)— en Chromium y escribe dos
 * imágenes, que la portada sirve con `next/image` en un <picture> (Vercel las
 * entrega en AVIF o WebP según el navegador; el PNG es la reserva):
 *
 *   · `assets/portada/panel-del-banco.png`: escritorio, 1360 px CSS a 2×, con
 *     la cáscara entera (barra, raíl, titular y tabla por modelo).
 *   · `assets/portada/panel-del-banco-movil.png`: móvil, el panel a 430 px CSS
 *     a 3× y recortado al titular y la tabla — menos cosas y más grandes, para
 *     que se lean en un teléfono.
 *
 * y `assets/portada/panel-del-banco.json` con la huella de las cifras pintadas.
 *
 * Nada de la captura se retoca a mano. Lo único que se toca de la página es
 * lo que no es el panel: se esconde la barra pública del sitio (la ruta no
 * está bajo /dashboard, así que la pinta) y el indicador de `next dev`, se
 * quita el desenfoque de la barra superior (sin contenido debajo deja una
 * franja gris en la captura), y se marca «Resumen» como la entrada activa del
 * raíl, que es la pantalla que es.
 *
 * Variables: CAPTURA_URL (por defecto http://localhost:3000), CHROMIUM_PATH
 * (por defecto el Chrome instalado).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium, type Browser } from "playwright-core";
import sharp from "sharp";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.env.CAPTURA_URL ?? "http://localhost:3000";
const CARPETA = join(WEB, "assets", "portada");
const RUTA = "/es/captura-panel";

/** El reloj de la página: el día siguiente a la tirada, para que el periodo del explorador la contenga. */
const AHORA = new Date("2026-09-29T09:00:00Z");

interface Toma {
  fichero: string;
  ancho: number;
  alto: number;
  densidad: number;
  /** Recortar al titular y la tabla (móvil) en vez de la ventana entera (escritorio). */
  soloElPanel: boolean;
}
const TOMAS: Toma[] = [
  { fichero: "panel-del-banco.png", ancho: 1360, alto: 900, densidad: 2, soloElPanel: false },
  { fichero: "panel-del-banco-movil.png", ancho: 430, alto: 1200, densidad: 3, soloElPanel: true },
];

async function capturar(browser: Browser, toma: Toma): Promise<{ png: Buffer; huella: string; ancho: number; alto: number }> {
  const page = await browser.newPage({
    viewport: { width: toma.ancho, height: toma.alto },
    deviceScaleFactor: toma.densidad,
    colorScheme: "light",
    reducedMotion: "reduce",
    locale: "es-ES",
  });
  await page.clock.setFixedTime(AHORA);
  // Nada sale de localhost (la etiqueta de Google Ads, por ejemplo).
  await page.route(/^https?:\/\/(?!localhost|127\.0\.0\.1)/, (r) => r.abort());

  const res = await page.goto(`${BASE}${RUTA}`, { waitUntil: "networkidle", timeout: 120_000 });
  if (!res || res.status() !== 200) throw new Error(`${RUTA} respondió ${res?.status()} — ¿está corriendo \`next dev\`?`);

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

  // Escritorio: la ventana entera, hasta un poco por debajo de la tabla.
  // Móvil: del titular a la tabla, con un margen igual por los cuatro lados.
  const caja = await page.evaluate((solo) => {
    const pila = document.querySelector(".panel-stack")!.getBoundingClientRect();
    if (!solo) return { x: 0, y: 0, width: window.innerWidth, height: Math.min(window.innerHeight, Math.ceil(pila.bottom + 56)) };
    const m = 14;
    return { x: Math.max(0, pila.left - m), y: pila.top - m, width: pila.width + 2 * m, height: pila.height + 2 * m };
  }, toma.soloElPanel);
  const png = await page.screenshot({ type: "png", clip: caja });
  await page.close();
  // Las dimensiones, las del PNG que salió (el recorte puede caer en medio píxel).
  const { width, height } = await sharp(png).metadata();
  return { png, huella, ancho: width!, alto: height! };
}

const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : { channel: "chrome" },
);
try {
  mkdirSync(CARPETA, { recursive: true });
  const tmp = join(tmpdir(), "captura-panel");
  mkdirSync(tmp, { recursive: true });
  const kb = (b: Buffer) => `${(b.length / 1024).toFixed(0)} KB`;
  const meta: Record<string, unknown> = { ruta: RUTA, reloj: AHORA.toISOString() };
  const huellas = new Set<string>();

  for (const toma of TOMAS) {
    const { png, huella, ancho, alto } = await capturar(browser, toma);
    huellas.add(huella);
    const salida = join(CARPETA, toma.fichero);
    const maestro = await sharp(png).png({ compressionLevel: 9, adaptiveFiltering: true, effort: 10 }).toBuffer();
    writeFileSync(salida, maestro);
    meta[toma.fichero] = { ancho, alto, densidad: toma.densidad };
    console.log(`PNG  ${salida} · ${kb(maestro)} · ${ancho}×${alto}`);
    const avif = await sharp(png).avif({ quality: 70, effort: 6 }).toBuffer();
    const webp = await sharp(png).webp({ quality: 80, effort: 6 }).toBuffer();
    writeFileSync(join(tmp, toma.fichero.replace(/\.png$/, ".avif")), avif);
    writeFileSync(join(tmp, toma.fichero.replace(/\.png$/, ".webp")), webp);
    console.log(`     a ${ancho}px · AVIF ${kb(avif)} · WebP ${kb(webp)}  (${tmp})`);
  }
  if (huellas.size !== 1) throw new Error("las dos tomas no pintan las mismas cifras");
  // Qué cifras pintan estas imágenes: la verja compara la huella con la de
  // lib/portada/panel-del-banco.ts y exige volver a capturar si cambian.
  meta.huella = [...huellas][0];
  writeFileSync(join(CARPETA, "panel-del-banco.json"), JSON.stringify(meta, null, 2) + "\n");
} finally {
  await browser.close();
}
