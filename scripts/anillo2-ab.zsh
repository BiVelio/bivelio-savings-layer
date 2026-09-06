# ANILLO 2 · el A/B de días alternos, AUTOMÁTICO — para la org propia, no
# para clientes (un cliente solo instala y usa; esto es el contrafactual del
# experimento). Se carga desde ~/.zshrc, DESPUÉS del alias `claude`:
#
#     source ~/bivelio-savings-layer/scripts/anillo2-ab.zsh
#
# Qué hace `claude` a partir de ahí (docs/PLAN-S4-PALANCA.md § 2.5, runbook):
#   1. deriva el BRAZO del día natural UTC: par = palanca (=1), impar = control (=0)
#      — la bandera va SIEMPRE explícita, su sentido cambió en 0.4.14;
#   2. exige la clave de servicio en el entorno (sin ella la palanca ni se
#      arma: la pestaña de agosto que corrió un «brazo par» entero en silencio);
#   3. levanta el espía (scripts/espia-anthropic.mjs 8402) si no escucha, y
#      encadena el gateway a él con BVSALA_GATEWAY_UPSTREAM;
#   4. si faltan los informes de AYER (pnpm anillo2 + pnpm anillo2:conciliar),
#      los lanza en segundo plano y, cuando existen, imprime su resumen —
#      veredicto, paridad de ayer y fisuras — en dos líneas al abrir sesión;
#   5. lanza `bvsala claude` con todo puesto.
#
# Todo es zsh puro + node/pnpm del repo; nada se instala. `BVSALA_AB_REPO`
# apunta al clon (por defecto ~/bivelio-savings-layer). Con
# `BVSALA_AB_SECO=1` hace todo menos lanzar claude (para probarlo).

BVSALA_AB_REPO="${BVSALA_AB_REPO:-$HOME/bivelio-savings-layer}"
BVSALA_AB_PUERTO_ESPIA="${BVSALA_AB_PUERTO_ESPIA:-8402}"

# Brazo del protocolo para un día YYYY-MM-DD (por defecto hoy UTC).
bvsala-ab-brazo() {
  local dia="${1:-$(date -u +%F)}"
  local dd="${dia:8:2}"
  if (( 10#$dd % 2 == 0 )); then echo palanca; else echo control; fi
}

# Bandera explícita para ese brazo.
bvsala-ab-bandera() {
  [[ "$(bvsala-ab-brazo "$1")" == palanca ]] && echo 1 || echo 0
}

# El espía escuchando en su puerto; si no, se levanta desde el repo.
bvsala-ab-espia() {
  if lsof -nP -iTCP:"$BVSALA_AB_PUERTO_ESPIA" -sTCP:LISTEN >/dev/null 2>&1; then return 0; fi
  if [[ ! -f "$BVSALA_AB_REPO/scripts/espia-anthropic.mjs" ]]; then
    print -u2 "[anillo2] no encuentro $BVSALA_AB_REPO/scripts/espia-anthropic.mjs (BVSALA_AB_REPO)"
    return 1
  fi
  mkdir -p "$HOME/.bvsala-f0"
  ( cd "$BVSALA_AB_REPO" && nohup node scripts/espia-anthropic.mjs "$BVSALA_AB_PUERTO_ESPIA" >> "$HOME/.bvsala-f0/espia.log" 2>&1 & ) >/dev/null 2>&1
  local i
  for i in 1 2 3 4 5 6 7 8 9 10; do
    lsof -nP -iTCP:"$BVSALA_AB_PUERTO_ESPIA" -sTCP:LISTEN >/dev/null 2>&1 && { print "[anillo2] espía levantado en :$BVSALA_AB_PUERTO_ESPIA"; return 0; }
    sleep 0.3
  done
  print -u2 "[anillo2] el espía no ha arrancado (mira ~/.bvsala-f0/espia.log)"
  return 1
}

# Los informes de un día (por defecto AYER UTC): pnpm anillo2 (corpus entero,
# minutos) + pnpm anillo2:conciliar --dia (segundos). En segundo plano si
# faltan; el resumen se guarda en benchmarks/out/anillo2-noche-<día>.txt.
bvsala-ab-informes() {
  local dia="${1:-$(date -u -v-1d +%F 2>/dev/null || date -u -d 'yesterday' +%F)}"
  local out="$BVSALA_AB_REPO/benchmarks/out"
  local resumen="$out/anillo2-noche-$dia.txt"
  local candado="$out/anillo2-noche-$dia.enmarcha"
  if [[ -f "$resumen" ]]; then
    print "[anillo2] informes de $dia:"
    sed 's/^/   /' "$resumen"
    return 0
  fi
  if [[ -f "$candado" ]]; then
    # Un candado de más de 2 h es de un trabajo que murió (cierre de la máquina
    # a medias): se relanza en vez de callar para siempre.
    if [[ -n "$(find "$candado" -mmin +120 2>/dev/null)" ]]; then
      print "[anillo2] informes de $dia: candado viejo (>2 h), relanzo"
      rm -f "$candado" "$resumen.tmp"
    else
      print "[anillo2] informes de $dia en marcha"
      return 0
    fi
  fi
  mkdir -p "$out" && : > "$candado"
  print "[anillo2] informes de $dia lanzados en segundo plano; se enseñan en la próxima sesión"
  (
    cd "$BVSALA_AB_REPO" || exit 1
    {
      NODE_OPTIONS=--max-old-space-size=8192 pnpm -s anillo2 2>/dev/null | node -e '
        const d = JSON.parse(require("fs").readFileSync(0, "utf8"));
        const dia = process.argv[1];
        const v = d.veredicto, m = d.veredictoPorModelo;
        console.log(`veredicto global: ${v.estado}` + (v.estado === "ok" ? ` ${v.ahorroPctFactura} % [${v.ci95Pct.inferior}, ${v.ci95Pct.superior}]` : ""));
        console.log(`veredicto por modelo: ${m.estado}` + (m.estado === "ok" ? ` ${m.ahorroPctFactura} % [${m.ci95Pct.inferior}, ${m.ci95Pct.superior}]` : ""));
        const p = (d.paridad?.dias ?? []).find((x) => x.dia === dia);
        if (p) console.log(`paridad ${dia}: esperado ${p.esperado}, observado control ${p.observado.control} / palanca ${p.observado.palanca}, ${p.limpio ? "LIMPIO" : "FISURA: " + p.fisuras.join(" | ")}`);
        else console.log(`paridad ${dia}: sin turnos en el corpus`);
      ' "$dia"
      pnpm -s anillo2:conciliar --dia "$dia" 2>&1 | grep -E 'GLOBAL|FISURA|COMPLETO' | sed 's/^\[conciliar\] //'
    } > "$resumen.tmp" 2>&1
    mv "$resumen.tmp" "$resumen"
    rm -f "$candado"
  ) >/dev/null 2>&1 &!
}

# `claude` = el A/B entero, solo. `command bvsala` evita cualquier alias.
unalias claude 2>/dev/null
function claude {
  local dia brazo bandera
  dia="$(date -u +%F)"
  brazo="$(bvsala-ab-brazo "$dia")"
  bandera="$(bvsala-ab-bandera "$dia")"
  if [[ -z "${BIVELIO_SERVICE_KEY:-}" ]]; then
    print -u2 "[anillo2] falta BIVELIO_SERVICE_KEY en esta shell: sin clave la palanca NO se arma (brazo control en silencio). Abre una ventana NUEVA de Terminal."
    return 1
  fi
  bvsala-ab-espia || return 1
  bvsala-ab-informes
  print "[anillo2] $dia UTC → brazo ${(U)brazo} (BVSALA_GATEWAY_ELISION=$bandera), gateway encadenado a :$BVSALA_AB_PUERTO_ESPIA"
  if [[ -n "${BVSALA_AB_SECO:-}" ]]; then
    print "[anillo2] (seco) no lanzo claude"
    return 0
  fi
  BVSALA_GATEWAY_ELISION="$bandera" BVSALA_GATEWAY_UPSTREAM="http://127.0.0.1:$BVSALA_AB_PUERTO_ESPIA" command bvsala claude "$@"
}
