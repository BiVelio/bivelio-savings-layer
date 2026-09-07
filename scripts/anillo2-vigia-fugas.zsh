#!/bin/zsh
# ANILLO 2 · VIGÍA DE FUGAS — desde FUERA de la shell, por SOCKETS.
#
# El arnés (anillo2-ab.zsh) solo puede avisar dentro de una zsh que ya lo cargó.
# Toda pestaña abierta ANTES de que ~/.zshrc lo cargara lanza `claude` a pelo,
# directo a Anthropic, sin que nada lo diga: el 06-09 se fugó el 99 % del
# tráfico (8812 de 8904 turnos, $1439,92 de $1494,89) exactamente así — una
# pestaña de Terminal con un zsh del 27 de agosto.
#
# CÓMO DETECTA. NO por variables de entorno: en macOS el listado de procesos no expone el entorno
# de otros procesos (verificado el 07-09: 0 coincidencias incluso en un hijo
# propio con la variable puesta). Mira los SOCKETS TCP de cada `claude` vivo
# con lsof: si conecta a 127.0.0.1:<puerto> va por un gateway; si conecta a
# :443 de fuera, va DIRECTO. Un claude sin sockets aún (recién abierto) es
# «sin tráfico todavía», no fuga.
#
# Solo lectura. Nunca imprime cuerpos, cabeceras ni valores de variables.
#
#   pnpm anillo2:fugas          · una pasada; rc = nº de fugas
#   pnpm anillo2:fugas --watch  · cada 30 s

set -u
watch=0; [[ "${1:-}" == "--watch" ]] && watch=1

# Sockets TCP salientes de un pid: "local->remoto" por línea.
sockets_de() { lsof -nP -a -p "$1" -iTCP -sTCP:ESTABLISHED 2>/dev/null | awk 'NR>1{print $9}' }

pasada() {
  local ahora fugas ok mudos p ini cwd via socks locales externas
  fugas=0; ok=0; mudos=0
  ahora="$(date -u +%H:%M:%S)"
  print -- "[anillo2·fugas] $ahora UTC · brazo hoy: $([[ $((10#$(date -u +%d) % 2)) -eq 0 ]] && echo PALANCA || echo control)"
  for p in $(pgrep -x claude 2>/dev/null); do
    ini="$(ps -o lstart= -p "$p" 2>/dev/null | awk '{print $2" "$3" "$4}')"
    cwd="$(lsof -a -p "$p" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)"
    socks="$(sockets_de "$p")"
    locales=$(print -- "$socks" | grep -c -- '->127\.0\.0\.1:' )
    externas=$(print -- "$socks" | grep -c -- '->[0-9.]*:443$' )
    if (( externas > 0 && locales == 0 )); then
      via="⛔ FUGA · $externas conexión(es) directas a :443, ninguna al gateway"
      fugas=$((fugas+1))
    elif (( locales > 0 )); then
      via="✓ gateway · $locales conexión(es) a 127.0.0.1"
      ok=$((ok+1))
    else
      via="… sin tráfico todavía"
      mudos=$((mudos+1))
    fi
    printf '  pid %-6s %-16s %-30s %s\n' "$p" "$ini" "${cwd:t}" "$via"
  done
  (( fugas + ok + mudos == 0 )) && print -- "  (ningún claude vivo)"
  (( fugas > 0 )) && print -u2 -- "  → $fugas sesión(es) FUERA del A/B. Ciérralas y relanza con \`claude\` en una pestaña NUEVA (⌘N: la shell tiene que ser posterior a la carga del arnés), o con \`bvsala claude\`."
  return $fugas
}

if (( watch )); then
  while true; do pasada; print; sleep 30; done
else
  pasada
fi
