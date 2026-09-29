#!/usr/bin/env bash
# LUZ VERDE — ¿se puede promocionar el producto hoy?
#
# `pnpm luz-verde` corre todas las comprobaciones y da un veredicto por ÁREA, no
# una sola bola verde. La distinción importa: la batería que ya existía
# (scripts/simular-ci.sh) contesta «¿se puede PUBLICAR este código?», que no es
# la misma pregunta que «¿se puede PROMETER esto a un cliente?». Un repositorio
# entero en verde puede seguir anunciando una cifra que su propio banco no
# sostiene — pasó, y por eso existe este fichero.
#
#   pnpm luz-verde              todo menos lo que gasta dinero
#   pnpm luz-verde --con-gasto  además, la sonda del SDK contra el proveedor real
#
# Sale con 0 solo si TODAS las áreas están en verde.
set -uo pipefail
cd "$(dirname "$0")/.."

CON_GASTO=0
[[ "${1:-}" == "--con-gasto" ]] && CON_GASTO=1

V="\033[32m"; R="\033[31m"; A="\033[33m"; G="\033[90m"; N="\033[0m"; B="\033[1m"
fallos=0; avisos=0
declare -a RESUMEN

area() { printf "\n${B}%s${N}\n" "$1"; }
ok()   { printf "  ${V}✓${N} %s\n" "$1"; }
mal()  { printf "  ${R}✗${N} %s\n" "$1"; fallos=$((fallos+1)); }
avis() { printf "  ${A}!${N} %s\n" "$1"; avisos=$((avisos+1)); }
nota() { printf "    ${G}%s${N}\n" "$1"; }

printf "${B}LUZ VERDE${N} · ¿se puede promocionar el producto hoy?\n"
printf "${G}commit %s${N}\n" "$(git rev-parse --short HEAD)"

# ── 1 · El código se puede publicar ──────────────────────────────────────────
area "1 · El código se puede publicar"
# El commit que dice la cabecera, no la rama `main` LOCAL: en un árbol de
# trabajo cortado de origin/main esa rama puede ir semanas por detrás, y el
# veredicto hablaba de un código que no era el que se estaba evaluando. En main,
# HEAD es main. Lo que no esté commiteado no entra en el clon limpio.
if bash scripts/simular-ci.sh "$(git rev-parse HEAD)" >/tmp/lv-ci.log 2>&1; then
  ok "clon limpio: instala, construye, tipa, pasa las pruebas y compila la web en los 12 idiomas"
  ok "el tarball de npm: paywall cerrado, sin sourcemaps, clave pública embebida"
else
  mal "la simulación de CI falla en clon limpio"
  nota "mira /tmp/lv-ci.log"
fi

# ── 2 · Un cliente puede integrar el SDK ─────────────────────────────────────
area "2 · Un cliente puede integrar el SDK"
if pnpm -s sonda:sdk --seco >/tmp/lv-sonda.log 2>&1; then
  ok "la sonda construye la capa y sabe emitir marcada como sdk/$(node -p "require('./package.json').version")"
else
  mal "la sonda del SDK no arranca ni en seco"
fi
if [[ $CON_GASTO -eq 1 ]]; then
  if pnpm -s sonda:sdk >/tmp/lv-sonda-viva.log 2>&1 && grep -q "0 fallidas" /tmp/lv-sonda-viva.log; then
    ok "$(grep -oE '[0-9]+ peticiones servidas' /tmp/lv-sonda-viva.log) contra el proveedor real, 0 fallidas"
  else
    mal "la sonda falla contra el proveedor real"
    nota "mira /tmp/lv-sonda-viva.log"
  fi
else
  nota "(--con-gasto la lanza de verdad; cuesta céntimos)"
fi

# ── 3 · Las cifras de la web resisten a un escéptico ─────────────────────────
area "3 · Las cifras de la web resisten a un escéptico"
node --input-type=module -e '
import { readFileSync, readdirSync, existsSync } from "node:fs";
const art = JSON.parse(readFileSync("apps/web/public/data/ab-live.json","utf8"));
// Los suelos del artefacto (frente a B0, B1 y, si lo trae, B2 «nativo bien
// configurado»): lo prometido tiene que caber en el menor.
const sueloB0 = (art.aggregate?.savings?.lower ?? 0) * 100;
const sueloB1 = art.aggregateB1?.savings?.lower != null ? art.aggregateB1.savings.lower * 100 : sueloB0;
const sueloB2 = art.aggregateB2?.savings?.lower != null ? art.aggregateB2.savings.lower * 100 : sueloB1;
const suelo = Math.min(sueloB0, sueloB1, sueloB2);
const sellado = !!(art.generatedAt && art.commit && art.trials);
const dir = "apps/web/messages/";
const idiomas = readdirSync(dir).filter(f=>f.endsWith(".json"));
const cifras = new Set();
for (const f of idiomas) {
  const d = JSON.parse(readFileSync(dir+f,"utf8"));
  const p = d.landing?.hero?.proofs ?? [];
  for (const fila of p) { const m=/(\d+)[.,](\d+)/.exec(fila.cifra??""); if(m) cifras.add(Number(`${m[1]}.${m[2]}`)); }
}
const prometido = Math.max(...cifras, 0);
const csv = existsSync("apps/web/public/data/ab-live-trials.csv");
const salida = {
  suelo: (Math.floor(suelo * 10) / 10).toFixed(1), prometido: prometido.toFixed(1), sellado, csv,
  unaSola: cifras.size === 1, idiomas: idiomas.length, pares: art.trials ?? null,
  modo: art.mode, calidad: art.aggregate?.qualityPassRate ?? null,
};
console.log(JSON.stringify(salida));
' > /tmp/lv-cifras.json 2>/dev/null
if [[ -s /tmp/lv-cifras.json ]]; then
  read -r SUELO PROM SELL CSV UNA IDI PARES MODO CAL <<<"$(node -p "const d=require('/tmp/lv-cifras.json');[d.suelo,d.prometido,d.sellado,d.csv,d.unaSola,d.idiomas,d.pares,d.modo,d.calidad].join(' ')")"
  if [[ "$MODO" == "LIVE" ]]; then ok "el artefacto es una medición real contra proveedor ($PARES parejas, calidad $CAL)"; else mal "el artefacto publicado NO es LIVE (es $MODO)"; fi
  if [[ "$SELL" == "true" ]]; then ok "el artefacto lleva sello de procedencia (fecha, commit y nº de parejas)"; else mal "el artefacto no lleva sello: no se sabe de qué tirada salió"; fi
  # Desde el 2026-09-29 la portada NO publica cifras de este artefacto (era
  # sintético y con el compresor del banco): publica las del banco en vivo
  # (lib/portada/banco-en-vivo.ts), con verja contra sus informes, y prohíbe
  # volver al «al menos un 10 %» en los 12 idiomas.
  if pnpm -s exec vitest run apps/web/lib/portada >/tmp/lv-portada.log 2>&1; then
    ok "la portada publica solo cifras del banco en vivo, con su informe, en los $IDI idiomas"
  else
    mal "la portada publica una cifra que no cuadra con su informe, o vuelve a prometer lo que no se midió"
    nota "mira /tmp/lv-portada.log"
  fi
  # Lo prometido tiene que caber también en lo que ENTREGA el paquete de npm. Si
  # el artefacto se midió con una pieza que npm no trae (el compresor del banco),
  # se reconstruye el suelo sin ella — sin red, con los ensayos publicados.
  if TCS=$(pnpm -s exec tsx benchmarks/titular-como-se-instala.ts --json 2>/dev/null) && [[ -n "$TCS" ]]; then
    read -r TAL SINREC MENOR <<<"$(node -p 'const d=JSON.parse(process.argv[1]);[d.medidoTalCual,d.sinReconstruir,(Math.floor(d.menor*1000)/10).toFixed(1)].join(" ")' "$TCS")"
    MOTIVO=$(node -p 'JSON.parse(process.argv[1]).motivo' "$TCS")
    if [[ "$TAL" == "true" ]]; then
      ok "el artefacto midió el SDK tal como se instala desde npm (sdk.asShipped: true)"
    else
      if [[ "$SINREC" == "true" ]]; then
        avis "$MOTIVO: re-medir con \`pnpm ab\` (asShipped es el modo por defecto) para sellarlo"
      else
        avis "el artefacto se midió con el compresor del banco, que npm no trae: re-medir con \`pnpm ab\` (asShipped es el modo por defecto)"
      fi
      # Y NINGUNA OTRA SUPERFICIE lo contradice: mientras el artefacto no mida lo
      # instalado, el recibo del héroe, la frase del paso 2, la banda, las
      # tarjetas por libro y la factura de ejemplo no pueden presentar su suelo
      # como lo que obtiene el cliente. Rojo si alguna lo hace.
      if pnpm -s exec vitest run apps/web/lib/bench/sdk-instalado.test.ts >/tmp/lv-sdk-instalado.log 2>&1; then
        ok "ninguna superficie de la web presenta el suelo de esa tirada como lo que obtiene el cliente: enseñan el titular"
      else
        mal "alguna superficie de la web presenta el suelo de una tirada que no midió lo instalado"
        nota "mira /tmp/lv-sdk-instalado.log"
      fi
    fi
  else
    mal "no se pudo calcular el suelo de lo que entrega npm (benchmarks/titular-como-se-instala.ts)"
  fi
  if [[ "$CSV" == "true" ]]; then ok "los ensayos crudos están publicados y enlazados"; else mal "no se publican los ensayos: la promesa de verificable es falsa"; fi
  # Y CUALQUIERA PUEDE RECALCULARLOS: el script público del kit de medición
  # independiente (docs/MEDICION-INDEPENDIENTE.md) rehace el bootstrap con el
  # CSV publicado y compara con lo que el JSON afirma, bit a bit.
  if node apps/web/public/measure/reproduce.mjs --json --artifact apps/web/public/data/ab-live.json \
      --trials apps/web/public/data/ab-live-trials.csv >/tmp/lv-reproduce.json 2>&1; then
    ok "reproduce.mjs recalcula lo publicado desde los ensayos crudos, bit a bit"
  else
    mal "reproduce.mjs NO recalcula lo publicado: el JSON no se sigue de su propio CSV"
    nota "mira /tmp/lv-reproduce.json"
  fi
else
  mal "no se pudieron leer las cifras de la web"
fi

# ── 4 · Lo que se factura es lo que se midió ─────────────────────────────────
area "4 · Lo que se factura es lo que se midió"
if pnpm -s vitest run apps/web/lib/billing >/tmp/lv-billing.log 2>&1; then
  ok "la batería de facturación pasa entera ($(grep -oE 'Tests +[0-9]+ passed' /tmp/lv-billing.log | grep -oE '[0-9]+' | head -1) pruebas)"
else
  mal "la facturación no pasa sus pruebas"
fi
if grep -q "measured_baseline_cost" apps/web/lib/billing/extracto.ts && ! grep -qE "^\s*base(line)?Usd \+= f\.baseline_cost" apps/web/lib/billing/extracto.ts; then
  ok "el extracto suma SOLO las columnas medidas"
else
  avis "revisar a mano de qué columnas suma el extracto"
fi

# ── 5 · El panel dice la verdad ──────────────────────────────────────────────
area "5 · El panel dice la verdad"
VH="apps/web/app/[locale]/dashboard/components/VerdictHero.tsx"
if grep -q "deriveVerdict" "$VH" 2>/dev/null; then
  ok "el titular usa la función que separa medido de estimado"
else
  mal "el titular reimplementa la aritmética y suma el TOTAL bajo un rótulo que dice «medido»"
  nota "arreglo planificado; hoy la cifra coincide porque todo el tráfico es del gateway"
fi

# ── Veredicto ────────────────────────────────────────────────────────────────
printf "\n${B}VEREDICTO${N}\n"
if [[ $fallos -eq 0 ]]; then
  printf "  ${V}LUZ VERDE${N} — %d avisos, ninguna comprobación en rojo.\n\n" "$avisos"
  exit 0
fi
printf "  ${R}NO${N} — %d comprobaciones en rojo, %d avisos.\n" "$fallos" "$avisos"
printf "  ${G}Promocionar con algo en rojo es prometer lo que no se puede defender.${N}\n\n"
exit 1
