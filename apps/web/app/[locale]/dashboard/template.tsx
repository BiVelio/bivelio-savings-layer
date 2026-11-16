/**
 * LA ENTRADA DEL CONTENIDO AL CAMBIAR DE SECCIÓN. Un `template` se vuelve a
 * montar en cada navegación (un `layout` no), así que la clase repite su
 * transición: el contenido sube unos píxeles y aparece, en un cuarto de
 * segundo. La cáscara —barra y raíl— no se mueve: vive en el layout.
 *
 * Solo corre sin `prefers-reduced-motion` (lo decide el CSS, `.app-enter`);
 * sin animación la página es la misma. Sin estado ni efectos: es de servidor.
 */
export default function DashboardTemplate({ children }: { children: React.ReactNode }) {
  return <div className="app-enter">{children}</div>;
}
