/**
 * El gateway de BV-SALA como PROCESO PROPIO para el banco de latencia, arrancado
 * desde el FUENTE con una licencia de prueba (el par Ed25519 efímero de
 * test/helpers/test-license.ts, el mismo que usan los tests del gateway).
 *
 * Por qué así y no con `bvsala gateway`: el binario publicado exige una licencia
 * real y, en el build de npm, solo acepta la clave pública embebida
 * (`effectivePublicKey`); una licencia firmada con otra clave no arranca nada
 * allí. Desde el fuente la clave inyectada vale, que es exactamente lo que hace
 * la batería del gateway. El camino de cada petición es el mismo código.
 *
 *   --upstream <origen>   el upstream falso (http://127.0.0.1:9911)
 *   --puerto <n>          0 = efímero
 *   --modo paso|medido    paso: sin clave de servicio (solo reenvía, como un
 *                         gateway en proceso sin BIVELIO_SERVICE_KEY). medido:
 *                         con una clave FALSA y la ingesta y el canal de
 *                         entitlements apuntando al upstream falso, que es lo
 *                         que hace el CLI en producción: medir cada petición.
 *
 * Avisa del puerto por IPC (`{ listo: puerto }`) o, sin IPC, con `LISTO <n>`.
 */
import { arrancarGateway } from "../../gateway/servidor.js";
import { testLicense } from "../../test/helpers/test-license.js";
import { esElPrincipal } from "./nucleo.js";

export type ModoBvsala = "paso" | "medido";

/** Una clave con la forma de ninguna real: solo viaja a la ingesta FALSA local. */
export const CLAVE_FALSA_DE_BANCO = "banco-local-no-es-una-clave";

function arg(nombre: string): string | undefined {
  const i = process.argv.indexOf(nombre);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (esElPrincipal(import.meta.url)) {
  const upstream = arg("--upstream");
  if (!upstream) {
    console.error("lanzar-bvsala: falta --upstream <origen>");
    process.exit(2);
  }
  const modo: ModoBvsala = arg("--modo") === "medido" ? "medido" : "paso";
  const g = await arrancarGateway({
    puerto: Number(arg("--puerto") ?? 0),
    upstream,
    license: testLicense(),
    ...(modo === "medido"
      ? {
          serviceAccountKey: CLAVE_FALSA_DE_BANCO,
          meteringUrl: new URL("/api/metering/usage", upstream).toString(),
          seatId: "asiento-de-banco",
        }
      : {}),
  });
  if (process.send) process.send({ listo: g.puerto });
  else console.log(`LISTO ${g.puerto}`);
  const salir = () => void g.cerrar().then(() => process.exit(0));
  process.on("SIGTERM", salir);
  process.on("SIGINT", salir);
  process.on("disconnect", salir);
}
