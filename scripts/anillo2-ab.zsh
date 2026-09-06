# ANILLO 2 · el A/B de días alternos, AUTOMÁTICO — para la org propia, no
# para clientes (un cliente solo instala y usa; esto es el contrafactual del
# experimento). Se carga desde ~/.zshrc como ÚLTIMA línea, después del alias
# `claude` (ningún instalador puede añadir otro alias detrás; un vigía avisa
# si pasa):
#
#     source ~/bivelio-savings-layer/scripts/anillo2-ab.zsh
#
# Qué hace `claude` a partir de ahí (docs/PLAN-S4-PALANCA.md § 2.5, runbook):
#   1. deriva el BRAZO del día natural UTC: par = palanca (=1), impar = control (=0)
#      — la bandera va SIEMPRE explícita, su sentido cambió en 0.4.14;
#   2. exige la clave de servicio en el entorno (sin ella la palanca ni se
#      arma: la pestaña de agosto que corrió un «brazo par» entero en silencio)
#      y el clon del repo con el arnés;
#   3. levanta el espía (scripts/espia-anthropic.mjs) si nadie escucha en su
#      puerto, y encadena el gateway a él con BVSALA_GATEWAY_UPSTREAM;
#   4. si faltan los informes de AYER (pnpm anillo2 + pnpm anillo2:conciliar),
#      los lanza en segundo plano y, cuando existen, imprime su resumen al abrir
#      sesión; un informe que FALLA no se guarda como bueno: queda un .fallo con
#      la causa y se reintenta en la siguiente sesión;
#   5. lanza `bvsala claude` con todo puesto (`--version`, `--help`, `mcp`,
#      `update` pasan de largo sin preflight).
#
# Todo es zsh puro + node/pnpm del repo; nada se instala. `BVSALA_AB_REPO`
# apunta al clon (por defecto ~/bivelio-savings-layer); `BVSALA_AB_SECO=1`
# hace todo el preflight menos lanzar claude (para probarlo). Los mensajes
# van a la terminal solo si stdout ES la terminal; en una tubería
# (`claude -p x | …`) van a stderr, jamás dentro del resultado.

BVSALA_AB_REPO="${BVSALA_AB_REPO:-$HOME/bivelio-savings-layer}"
BVSALA_AB_PUERTO_ESPIA="${BVSALA_AB_PUERTO_ESPIA:-8402}"

bvsala-ab-di() { if [[ -t 1 ]]; then print -- "$@"; else print -u2 -- "$@"; fi }
bvsala-ab-error() { print -u2 -- "$@" }

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

# El clon con el arnés. Sin él nada de lo demás tiene sentido — y el árbol de
# trabajo es compartido: en una rama sin benchmarks/anillo2 no se lanza nada.
bvsala-ab-clon() {
  [[ -f "$BVSALA_AB_REPO/package.json" && -f "$BVSALA_AB_REPO/benchmarks/anillo2/arnes.ts" ]] && return 0
  bvsala-ab-error "[anillo2] BVSALA_AB_REPO=$BVSALA_AB_REPO no es el clon con el arnés (falta benchmarks/anillo2/arnes.ts): ¿ruta movida o rama sin el anillo 2?"
  return 1
}

# ¿Escucha alguien en 127.0.0.1:$1? zsh puro (zsh/net/tcp); lsof solo de
# respaldo. 0 = sí, 1 = no, 2 = no lo puedo saber.
bvsala-ab-puerto-abierto() {
  local puerto="$1"
  if zmodload zsh/net/tcp 2>/dev/null; then
    if ztcp 127.0.0.1 "$puerto" 2>/dev/null; then ztcp -c "$REPLY" 2>/dev/null; return 0; fi
    return 1
  fi
  if (( $+commands[lsof] )); then
    lsof -nP -iTCP:"$puerto" -sTCP:LISTEN >/dev/null 2>&1 && return 0 || return 1
  fi
  return 2
}

# El espía escuchando; si no, se levanta desde el clon, desapegado de la
# terminal (</dev/null + nohup: sobrevive al cierre de la ventana).
bvsala-ab-espia() {
  local p="$BVSALA_AB_PUERTO_ESPIA" rc i
  bvsala-ab-puerto-abierto "$p"; rc=$?
  (( rc == 0 )) && return 0
  if (( rc == 2 )); then
    bvsala-ab-error "[anillo2] no puedo comprobar si el espía escucha en :$p (ni zsh/net/tcp ni lsof): no lanzo a ciegas"
    return 1
  fi
  mkdir -p "$HOME/.bvsala-f0"
  ( cd "$BVSALA_AB_REPO" && exec nohup node scripts/espia-anthropic.mjs "$p" </dev/null >>"$HOME/.bvsala-f0/espia.log" 2>&1 & ) >/dev/null 2>&1
  for i in {1..10}; do
    bvsala-ab-puerto-abierto "$p" && { bvsala-ab-di "[anillo2] espía levantado en :$p"; return 0; }
    sleep 0.3
  done
  bvsala-ab-error "[anillo2] el espía no ha arrancado en :$p (mira ~/.bvsala-f0/espia.log)"
  return 1
}

# Los informes de un día (por defecto AYER UTC): pnpm anillo2 (corpus entero)
# + pnpm anillo2:conciliar --dia. En segundo plano si faltan. Candado = un
# DIRECTORIO (mkdir es atómico: dos ventanas a la vez no lanzan dos arneses)
# con el pid del trabajo (un pid muerto = relanzar). Resumen en
# benchmarks/out/anillo2-noche-<día>.txt; si falla, .fallo con la causa y se
# reintenta en la siguiente sesión — jamás se guarda un fallo como informe.
bvsala-ab-informes() {
  local dia="${1:-$(date -u -v-1d +%F 2>/dev/null || date -u -d 'yesterday' +%F)}"
  bvsala-ab-clon || return 1
  local out="$BVSALA_AB_REPO/benchmarks/out"
  local resumen="$out/anillo2-noche-$dia.txt"
  local fallo="$out/anillo2-noche-$dia.fallo"
  local candado="$out/anillo2-noche-$dia.enmarcha"
  mkdir -p "$out"
  if [[ -f "$resumen" ]]; then
    bvsala-ab-di "[anillo2] informes de $dia:"
    if [[ -t 1 ]]; then sed 's/^/   /' "$resumen"; else sed 's/^/   /' "$resumen" >&2; fi
    return 0
  fi
  if [[ -d "$candado" ]]; then
    local pid; pid="$(cat "$candado/pid" 2>/dev/null)"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      bvsala-ab-di "[anillo2] informes de $dia en marcha (pid $pid)"
      return 0
    fi
    bvsala-ab-di "[anillo2] informes de $dia: el trabajo anterior murió, relanzo"
    rm -rf "$candado"
  fi
  if [[ -f "$fallo" ]]; then
    bvsala-ab-error "[anillo2] informes de $dia FALLARON la última vez: $(head -n 1 "$fallo"); reintento"
    rm -f "$fallo"
  fi
  mkdir "$candado" 2>/dev/null || { bvsala-ab-di "[anillo2] informes de $dia en marcha"; return 0; }
  bvsala-ab-di "[anillo2] informes de $dia lanzados en segundo plano; se enseñan en la próxima sesión"
  (
    setopt pipefail
    zmodload zsh/system 2>/dev/null
    print -- "${sysparams[pid]:-$$}" > "$candado/pid"
    cd "$BVSALA_AB_REPO" || exit 1
    # (sin `local`: esto es una subshell, no una función — zsh lo rechazaría)
    tmp="$candado/resumen.tmp"; err="$candado/err.log"; rc=0
    {
      NODE_OPTIONS=--max-old-space-size=8192 pnpm -s anillo2 2>"$err" | node -e '
        const d = JSON.parse(require("fs").readFileSync(0, "utf8"));
        const dia = process.argv[1];
        const v = d.veredicto, m = d.veredictoPorModelo;
        console.log(`veredicto global: ${v.estado}` + (v.estado === "ok" ? ` ${v.ahorroPctFactura} % [${v.ci95Pct.inferior}, ${v.ci95Pct.superior}]` : ""));
        console.log(`veredicto por modelo: ${m.estado}` + (m.estado === "ok" ? ` ${m.ahorroPctFactura} % [${m.ci95Pct.inferior}, ${m.ci95Pct.superior}]` : ""));
        const p = (d.paridad?.dias ?? []).find((x) => x.dia === dia);
        if (p) console.log(`paridad ${dia}: esperado ${p.esperado}, observado control ${p.observado.control} / palanca ${p.observado.palanca}, ${p.limpio ? "LIMPIO" : "FISURA: " + p.fisuras.join(" | ")}`);
        else console.log(`paridad ${dia}: sin turnos en el corpus`);
      ' "$dia" &&
      pnpm -s anillo2:conciliar --dia "$dia" 2>>"$err" | grep -E 'GLOBAL|FISURA|COMPLETO' | sed 's/^\[conciliar\] //'
    } > "$tmp" 2>>"$err"
    rc=$?
    if (( rc == 0 )) && [[ -s "$tmp" ]]; then
      mv "$tmp" "$resumen"
    else
      # Escrito entero y luego movido: quien lo lea nunca ve un .fallo a medias.
      {
        print -- "rc=$rc en rama $(git branch --show-current 2>/dev/null || echo '?') a las $(date -u +%FT%TZ)"
        # La causa está al PRINCIPIO (el stderr del arnés); la traza de node, al final.
        head -n 4 "$err" 2>/dev/null
        print -- "…"
        tail -n 4 "$err" 2>/dev/null
      } > "$fallo.tmp"
      mv "$fallo.tmp" "$fallo"
    fi
    rm -rf "$candado"
  ) >/dev/null 2>&1 &!
}

# `claude` = el A/B entero, solo. `command bvsala` evita cualquier alias.
unalias claude 2>/dev/null
function claude {
  case "${1:-}" in
    --version|-v|--help|-h|mcp|update) command bvsala claude "$@"; return $? ;;
  esac
  local dia brazo bandera p="$BVSALA_AB_PUERTO_ESPIA" sombra="${BVSALA_AB_SHADOW:-1}"
  dia="$(date -u +%F)"
  brazo="$(bvsala-ab-brazo "$dia")"
  bandera="$(bvsala-ab-bandera "$dia")"
  if [[ -z "${BIVELIO_SERVICE_KEY:-}" ]]; then
    bvsala-ab-error "[anillo2] falta BIVELIO_SERVICE_KEY en esta shell: sin clave la palanca NO se arma (brazo control en silencio). Abre una ventana NUEVA de Terminal."
    return 1
  fi
  bvsala-ab-clon || return 1
  bvsala-ab-espia || return 1
  bvsala-ab-informes
  # El brazo se fija al lanzar: una sesión que cruce las 00:00 UTC sale como
  # «día mezclado» en la auditoría. Avisar antes, no después.
  local restante=$(( 24 * 60 - (10#$(date -u +%H) * 60 + 10#$(date -u +%M)) ))
  (( restante <= 90 )) && bvsala-ab-di "[anillo2] AVISO: faltan $restante min para las 00:00 UTC — esta sesión cruzará el cambio de brazo (día mezclado); mejor relanzarla después"
  bvsala-ab-di "[anillo2] $dia UTC → brazo ${(U)brazo} (BVSALA_GATEWAY_ELISION=$bandera), gateway encadenado a :$p, sombra=$sombra"
  if [[ -n "${BVSALA_AB_SECO:-}" ]]; then
    bvsala-ab-di "[anillo2] (seco) no lanzo claude"
    return 0
  fi
  BVSALA_GATEWAY_ELISION="$bandera" BVSALA_GATEWAY_UPSTREAM="http://127.0.0.1:$p" BVSALA_GATEWAY_SHADOW="$sombra" command bvsala claude "$@"
}

# Vigía: al primer prompt (cuando ~/.zshrc ya se ha leído entero) comprueba que
# `claude` sigue siendo la función; si algo definió un alias detrás del source
# (instaladores que añaden `alias claude=…` al final), lo dice en voz alta.
if autoload -Uz add-zsh-hook 2>/dev/null; then
  _bvsala_ab_vigia() {
    add-zsh-hook -d precmd _bvsala_ab_vigia
    [[ "$(whence -w claude 2>/dev/null)" == "claude: function" ]] ||
      print -u2 "[anillo2] ⛔ claude YA NO es la función del A/B: algo definió un alias claude DESPUÉS del source en ~/.zshrc. En esta shell el A/B no se aplica."
  }
  add-zsh-hook precmd _bvsala_ab_vigia
fi
