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
# Los dos de la web: `typecheck:all` no la cubre (no está en el workspace de la
# raíz), así que el código que cobra no lo miraba nadie hasta que Vercel
# construía EN PRODUCCIÓN. `--dir` va antes de `run`, o pnpm ejecuta el script
# de la raíz con argumentos basura.
paso "typecheck (apps/web)"      pnpm --dir apps/web run typecheck
paso "build (apps/web)"          pnpm --dir apps/web run build

printf '  %-42s' "etiqueta vs package.json"
node -p "require('./package.json').version"

echo "  comprobaciones del tarball:"
npm pack --silent >/dev/null
tar xzf bivelio-savings-layer-*.tgz
grep -q "BVSALA_DEV_OPEN" package/dist/index.js && { echo "     FALLA: paywall abierto"; exit 1; } || echo "     ok  paywall cerrado"
find package -name "*.map" | grep -q . && { echo "     FALLA: lleva sourcemaps"; exit 1; } || echo "     ok  sin sourcemaps"
grep -q "BEGIN PUBLIC KEY" package/dist/index.js || { echo "     FALLA: sin clave pública"; exit 1; }
echo "     ok  clave pública embebida"
grep -q "BEGIN PUBLIC KEY" package/dist/gateway/bin.js || { echo "     FALLA: el gateway sin clave pública"; exit 1; }
echo "     ok  clave pública también en el gateway"
# La privada no viaja, ni en PEM ni en base64 del PEM (la misma búsqueda que publish.yml).
grep -rqaE "PRIVATE KEY|UFJJVkFURSBLRV|BSSVZBVEUgS0VZ|QUklWQVRFIEtFW" package && { echo "     FALLA: lleva una clave privada"; exit 1; } || echo "     ok  sin clave privada"
# El SBOM que publish.yml adjunta a la Release: falla si el bundle reconstruido
# no es byte a byte el del tarball.
paso "sbom CycloneDX del tarball" pnpm exec tsx scripts/sbom.ts "$(ls bivelio-savings-layer-*.tgz)" sbom.cdx.json

echo
echo "Todo verde en clon limpio. La Release debería publicar."
