#!/usr/bin/env bash
# E6 · Instala el proxy de LiteLLM en un venv TEMPORAL, nunca global.
#
#   bash benchmarks/delante-de-litellm/instalar-litellm.sh <directorio-temporal>
#
# Versión fijada: 1.102.1 (la del informe de competencia del 2026-09-27). Es
# posterior al incidente de cadena de suministro de LiteLLM (1.82.7 y 1.82.8,
# publicadas con código malicioso el 24-mar-2026:
# https://docs.litellm.ai/blog/security-update-march-2026). La 1.103.0 salió el
# 2026-09-27 a las 17:47 UTC y no se usa: una versión de horas es justo la que un
# incidente así todavía no ha tenido tiempo de destapar.
#
# Tres cerrojos, en este orden:
#   1. La suma sha256 de la rueda está ESCRITA aquí (copiada de
#      https://pypi.org/pypi/litellm/1.102.1/json el 2026-09-27) y se compara con
#      la que PyPI publica HOY: si PyPI dice otra cosa, se para.
#   2. La rueda descargada se comprueba contra esa suma con `shasum -a 256`
#      antes de instalar nada, y se instala DESDE EL FICHERO comprobado.
#   3. Las dependencias se resuelven con `--exclude-newer 2026-09-24T00:00:00Z`:
#      ninguna versión subida a PyPI después del día siguiente a la de LiteLLM.
#      Así un paquete envenenado mañana no entra en la reproducción de hoy.
#
# Todo vive en <directorio-temporal>: el venv, la caché de uv y la lista de lo
# que se instaló (freeze.txt). No toca HOME ni el Python del sistema. Borrarlo
# es desinstalarlo.
set -euo pipefail

DESTINO="${1:?uso: instalar-litellm.sh <directorio-temporal>}"
VERSION="1.102.1"
LIMITE_DEPENDENCIAS="2026-09-24T00:00:00Z"

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64)
    RUEDA="litellm-${VERSION}-cp310-abi3-macosx_11_0_arm64.whl"
    SUMA="da73fe3f6a1bf70232d752f7e1fe49f5d4d9473c02972553e0d0f7b514b280c7" ;;
  Darwin-x86_64)
    RUEDA="litellm-${VERSION}-cp310-abi3-macosx_10_12_x86_64.whl"
    SUMA="01550e79e052249dc5df53631ed9bdff030ca7c2a22107c5ce482d53ecf5c8d8" ;;
  Linux-x86_64)
    RUEDA="litellm-${VERSION}-cp310-abi3-manylinux_2_28_x86_64.whl"
    SUMA="b36c46e89e2fc50f42848120ed03a31c7347103cbaa733421f8843915b6f3355" ;;
  Linux-aarch64)
    RUEDA="litellm-${VERSION}-cp310-abi3-manylinux_2_28_aarch64.whl"
    SUMA="296c49171d7b80e6298fdf1bb18c7b69a826b82ae2b917bc6f5a80f153ee8b29" ;;
  *)
    echo "instalar-litellm: plataforma sin rueda fijada aquí: $(uname -s)-$(uname -m)" >&2
    exit 2 ;;
esac

command -v uv >/dev/null || { echo "instalar-litellm: hace falta uv (https://docs.astral.sh/uv/)" >&2; exit 2; }
command -v python3 >/dev/null || { echo "instalar-litellm: hace falta python3 para leer el JSON de PyPI" >&2; exit 2; }

mkdir -p "$DESTINO"
DESTINO="$(cd "$DESTINO" && pwd)"
export UV_CACHE_DIR="$DESTINO/uv-cache"

# 1 · Lo que PyPI publica hoy para esa rueda: URL y suma.
read -r URL SUMA_PYPI < <(
  curl -fsS -m 30 "https://pypi.org/pypi/litellm/${VERSION}/json" | python3 -c '
import json, sys
nombre = sys.argv[1]
for f in json.load(sys.stdin)["urls"]:
    if f["filename"] == nombre:
        print(f["url"], f["digests"]["sha256"])
        break
' "$RUEDA"
)
if [[ -z "${URL:-}" ]]; then
  echo "instalar-litellm: PyPI no lista ${RUEDA}" >&2
  exit 1
fi
if [[ "$SUMA_PYPI" != "$SUMA" ]]; then
  echo "instalar-litellm: PyPI publica otra suma para ${RUEDA}: ${SUMA_PYPI} (fijada: ${SUMA}). Parado." >&2
  exit 1
fi

# 2 · La rueda, comprobada antes de instalar.
curl -fsS -m 120 -o "$DESTINO/$RUEDA" "$URL"
echo "${SUMA}  ${DESTINO}/${RUEDA}" | shasum -a 256 -c -

# 3 · El venv, desde el fichero comprobado; las dependencias, con fecha tope.
uv venv --quiet --python 3.13 "$DESTINO/venv"
uv pip install --quiet --python "$DESTINO/venv/bin/python" \
  --exclude-newer "$LIMITE_DEPENDENCIAS" \
  "litellm[proxy] @ file://${DESTINO}/${RUEDA}"
uv pip freeze --python "$DESTINO/venv/bin/python" > "$DESTINO/freeze.txt"

echo "LiteLLM ${VERSION} instalado en ${DESTINO}/venv ($(wc -l < "$DESTINO/freeze.txt" | tr -d ' ') paquetes, lista en freeze.txt)"
echo "Binario: ${DESTINO}/venv/bin/litellm"
