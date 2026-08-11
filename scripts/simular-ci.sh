#!/usr/bin/env bash
# Ejecuta la verja de publicación en un CLON LIMPIO, igual que GitHub Actions.
#
# POR QUÉ EXISTE: la verja se estrenó el 2026-08-11 y falló dos veces seguidas, las
# dos por diferencias entre "mi portátil" y un entorno limpio, no por el código:
#
#   1. `apps/web` es un proyecto aparte con su propio lockfile, y el workspace de la
#      raíz no lo incluye. En local su node_modules lleva ahí desde el primer
#      `pnpm dev`; en CI no existía y 26 tests reventaron con "Failed to load url
#      next/server".
#   2. `services/*` typechequea contra los tipos CONSTRUIDOS de packages/*, así que
#      `typecheck` antes de `build` falla con "Cannot find module @bivelio/protocol".
#      En local packages/*/dist ya estaba de builds anteriores.
#
# Las dos se descubrieron cortando una Release y viéndola fallar — un ciclo de varios
# minutos por intento. Este script las habría cazado en uno solo. Úsalo antes de
# tocar el workflow o de cortar una Release.
set -euo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLON="$(mktemp -d)/ciclean"
trap 'rm -rf "$(dirname "$CLON")"' EXIT

echo "Clonando $RAIZ en un directorio limpio (sin node_modules ni dist)…"
git clone -q "$RAIZ" "$CLON"
cd "$CLON"
git checkout -q "${1:-main}"
echo "  commit: $(git log --oneline -1)"
echo

paso() { printf '  %-42s' "$1"; shift; if "$@" >/dev/null 2>&1; then echo "ok"; else echo "FALLA"; exit 1; fi; }

paso "install (raíz)"            pnpm install --frozen-lockfile
paso "install (apps/web)"        pnpm install --frozen-lockfile --dir apps/web
paso "build:all"                 pnpm run build:all
paso "typecheck:all"             pnpm run typecheck:all
paso "tests"                     pnpm test

printf '  %-42s' "etiqueta vs package.json"
node -p "require('./package.json').version"

echo "  comprobaciones del tarball:"
npm pack --silent >/dev/null
tar xzf bivelio-savings-layer-*.tgz
grep -q "BVSALA_DEV_OPEN" package/dist/index.js && { echo "     FALLA: paywall abierto"; exit 1; } || echo "     ok  paywall cerrado"
find package -name "*.map" | grep -q . && { echo "     FALLA: lleva sourcemaps"; exit 1; } || echo "     ok  sin sourcemaps"
grep -q "BEGIN PUBLIC KEY" package/dist/index.js || { echo "     FALLA: sin clave pública"; exit 1; }
echo "     ok  clave pública embebida"

echo
echo "Todo verde en clon limpio. La Release debería publicar."
