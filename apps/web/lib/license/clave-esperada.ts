/**
 * La clave PÚBLICA que el SDK publicado lleva incrustada.
 *
 * POR QUÉ ESTÁ AQUÍ DUPLICADA. El SDK la embebe en tiempo de build: `tsup.config.ts`
 * lee `keys/license.pub.pem` y la inyecta como `__BV_SALA_PUBLIC_KEY__`, que acaba
 * dentro del bundle que se instala el cliente. El plano de control, en cambio, firma
 * con la PRIVADA que vive en la variable `LICENSE_PRIVATE_KEY_B64` de Vercel.
 *
 * Son dos mitades del mismo par que viajan por caminos COMPLETAMENTE distintos —
 * una por el paquete de npm, la otra por la configuración de un despliegue— y hasta
 * ahora nada comprobaba que siguieran siendo pareja. Si dejan de serlo (una rotación
 * a medias, un despliegue con la variable de otro entorno, un copiado con un salto de
 * línea de menos), el sistema NO da ningún error visible: el plano de control sigue
 * emitiendo licencias con toda normalidad, y son los SDK de TODOS los clientes los
 * que las rechazan a la vez, cada uno en su infraestructura. Como el SDK es
 * fail-closed, eso es una caída total del producto que aquí no se ve.
 *
 * Esta constante es el lado "SDK" de la comparación, y `clave-esperada.test.ts` la
 * ata a `keys/license.pub.pem` para que no pueda derivar del fichero de verdad.
 * `apps/web` es un proyecto aparte y no puede leer ese fichero en ejecución (su
 * trazado de ficheros tiene la raíz en apps/web), de ahí la copia.
 *
 * No es un secreto: es la mitad pública, y va publicada dentro de cada copia del SDK.
 */
export const CLAVE_PUBLICA_DEL_SDK = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAWBiklf0kmDIVmM7nMiCxwiEAkwQIiqWGuRiRDJonsFY=
-----END PUBLIC KEY-----
`;

/** Normaliza un PEM para comparar: sin cabeceras, sin espacios ni saltos. */
export function cuerpoDelPem(pem: string): string {
  return pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
}
