// Los tipos de las imágenes importadas (`import x from "….png"`), que Next
// declara en `next-env.d.ts`. Ese fichero no se versiona (.gitignore) y en CI
// el typecheck corre sin `next build` previo: sin esta línea, la captura del
// panel que importa la portada no tiene tipo y `tsc` falla.
/// <reference types="next/image-types/global" />
