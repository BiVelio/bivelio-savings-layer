import { NextResponse } from "next/server";
import { createHash, createPublicKey, verify } from "node:crypto";
import { loadPrivateKey, signCompact } from "@/lib/license/sign";
import { CLAVE_PUBLICA_DEL_SDK, cuerpoDelPem } from "@/lib/license/clave-esperada";

/**
 * SONDA DE LA PAREJA DE CLAVES. Responde 200 si las licencias que este despliegue
 * firma las va a poder verificar el SDK que tienen instalado los clientes, y 503 si
 * no.
 *
 * EL FALLO QUE VIGILA es el más silencioso del producto. El SDK verifica con una
 * clave pública incrustada en tiempo de build (`tsup` la lee de `keys/license.pub.pem`);
 * el plano de control firma con la privada de `LICENSE_PRIVATE_KEY_B64`. Son dos
 * mitades del mismo par que llegan por caminos distintos —una en el paquete de npm,
 * otra en la configuración de Vercel— y si dejan de ser pareja no salta ningún error
 * aquí: la emisión de licencias sigue funcionando perfectamente y son los SDK de
 * TODOS los clientes los que las rechazan a la vez, cada uno en su infraestructura.
 * Como el SDK es fail-closed, es una caída total del producto que desde dentro no se
 * ve. Sin esta sonda, el primer aviso sería un cliente enfadado.
 *
 * NO comprueba la clave "de mentira": hace la ida y vuelta REAL — firma con la
 * privada que este despliegue usa de verdad y verifica esa firma con la pública que
 * el SDK lleva dentro. Comparar huellas no bastaría: un PEM mal copiado puede tener
 * la misma huella textual y no firmar igual.
 *
 * QUÉ DEVUELVE Y QUÉ NO. Nunca material de clave privada. La huella que expone es de
 * la mitad PÚBLICA, que va publicada dentro de cada copia del SDK, y sirve para saber
 * de un vistazo QUÉ par está cargado cuando algo no cuadra. Sin autenticar, a
 * propósito: el sentido de una sonda es que un vigilante externo pueda llamarla.
 */
export const dynamic = "force-dynamic";

const huella = (pem: string) =>
  createHash("sha256").update(cuerpoDelPem(pem)).digest("hex").slice(0, 12);

function respuesta(estado: number, cuerpo: Record<string, unknown>) {
  return NextResponse.json(cuerpo, {
    status: estado,
    // Una sonda cacheada no es una sonda: mediría el pasado.
    headers: { "cache-control": "no-store" },
  });
}

export async function GET() {
  const privada = loadPrivateKey();
  if (!privada) {
    return respuesta(503, {
      ok: false,
      motivo: "sin_clave_privada",
      detalle: "LICENSE_PRIVATE_KEY_B64 no está puesta en este despliegue: no se puede firmar ninguna licencia.",
    });
  }

  // 1. ¿La privada cargada produce la MISMA pública que embebe el SDK?
  let publicaDerivada: string;
  try {
    publicaDerivada = createPublicKey(privada).export({ type: "spki", format: "pem" }).toString();
  } catch {
    return respuesta(503, {
      ok: false,
      motivo: "clave_privada_ilegible",
      detalle: "LICENSE_PRIVATE_KEY_B64 no es una clave PEM válida (¿saltos de línea perdidos al copiarla?).",
    });
  }

  const esperada = huella(CLAVE_PUBLICA_DEL_SDK);
  const cargada = huella(publicaDerivada);
  if (cargada !== esperada) {
    return respuesta(503, {
      ok: false,
      motivo: "par_de_claves_distinto",
      detalle:
        "La privada de este despliegue NO es pareja de la pública que llevan los SDK instalados. Toda licencia emitida ahora será rechazada por todos los clientes.",
      huellaEsperada: esperada,
      huellaCargada: cargada,
    });
  }

  // 2. Ida y vuelta de verdad: firmar y verificar con la pública del SDK. Coincidir
  //    en la huella no garantiza que la firma valga; esto sí.
  try {
    const token = signCompact(
      { alg: "EdDSA", typ: "BVSALA-HEALTH", v: 1 },
      { v: 1, probe: true },
      privada,
    );
    const [cabecera, cuerpo, firma] = token.split(".");
    const valida = verify(
      null,
      Buffer.from(`${cabecera}.${cuerpo}`),
      createPublicKey(CLAVE_PUBLICA_DEL_SDK),
      Buffer.from(firma, "base64url"),
    );
    if (!valida) {
      return respuesta(503, {
        ok: false,
        motivo: "firma_no_verifica",
        detalle: "La huella coincide pero la firma no verifica contra la pública del SDK.",
        huella: cargada,
      });
    }
  } catch {
    return respuesta(503, {
      ok: false,
      motivo: "fallo_al_firmar",
      detalle: "La clave está cargada pero firmar o verificar ha lanzado.",
      huella: cargada,
    });
  }

  return respuesta(200, { ok: true, huella: cargada });
}
