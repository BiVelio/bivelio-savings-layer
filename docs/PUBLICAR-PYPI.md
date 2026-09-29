# Publicar el cliente de Python en PyPI

**Decisión del dueño (2026-09-29):** el cliente de Python (`packages/python`) se
publica en **PyPI** como `bivelio-savings-layer` (`import bvsala`), con
**publicador de confianza** (Trusted Publishing, OIDC): sin token de PyPI guardado
en ningún sitio. Lo publica `.github/workflows/publish-pypi.yml` al publicar una
GitHub Release con etiqueta `py-v<versión>`.

El nombre `bivelio-savings-layer` seguía libre el 2026-09-29 (`curl -s -o /dev/null
-w "%{http_code}" https://pypi.org/pypi/bivelio-savings-layer/json` → `404`; el
27-09 también). **Un pending publisher NO reserva el nombre**: si alguien sube un
proyecto con ese nombre antes que nosotros, el pending publisher queda invalidado
(<https://docs.pypi.org/trusted-publishers/creating-a-project-through-oidc/>).
Conviene hacer la primera publicación poco después de crearlo.

## Política de versión: propia, `py-v*`

El cliente de Python lleva **su propia versión semántica**, empezando en `0.1.0`,
no la del paquete de npm (`0.4.32` hoy). Por qué:

- **Son dos artefactos con dos ritmos.** El de npm publica una versión por cada
  cambio del SDK de TypeScript o del gateway; el de Python es un cliente HTTP fino
  que no cambia con ellos. Alinear las versiones obligaría a publicar en PyPI
  versiones idénticas solo para seguir el número, o a dejar huecos que parecen
  versiones perdidas.
- **La compatibilidad ya está dicha donde importa.** El cliente exige un gateway
  0.4.26 o posterior y lo comprueba en tiempo de ejecución (`GatewayUnavailable`
  con el motivo); el README y la web lo dicen. Un número compartido no añadiría
  ninguna garantía.
- **Las etiquetas no chocan.** `v*` es de npm (`publish.yml`), `py-v*` de PyPI
  (`publish-pypi.yml`). `publish.yml` salta las `py-v*` y `publish-pypi.yml` solo
  corre con ellas.

La versión vive en **un solo sitio**, `packages/python/src/bvsala/__init__.py`
(`__version__`); `pyproject.toml` la lee de ahí (`dynamic = ["version"]`). El
workflow falla si la etiqueta no es `py-v` + esa versión.

## Qué hace el workflow

Tres trabajos, cada uno con el mínimo permiso (`permissions: {}` por defecto):

1. **`pruebas`** (`contents: read`): pytest en Python 3.10 y 3.14, con las mismas
   dependencias fijadas por hash que `ci.yml`.
2. **`construir`** (`contents: read`): etiqueta == versión; el README dice
   `pip install bivelio-savings-layer` (es la página de PyPI, que se congela al
   subir); sdist + wheel **una vez** con `build`, `twine` y `hatchling` fijados por
   hash (`requirements-publicar.txt`, construido `--no-isolation` para que el
   backend también llegue por hash); `twine check --strict`; exactamente dos
   archivos, la LICENSE del repositorio dentro, `License-Expression:
   LicenseRef-BiVelio-Commercial`, ningún `Requires-Dist` y ninguna clave privada
   (la misma búsqueda que `publish.yml`); instala el wheel en un entorno limpio y
   comprueba `bvsala.__version__`. Su salida es el sha256 del conjunto.
3. **`publicar`** (`id-token: write`, environment `pypi`): no hace checkout ni
   instala nada. Comprueba que los archivos tienen el sha256 que `construir` dejó
   en su salida y los sube con `pypa/gh-action-pypi-publish@release/v1`.
   **Atestaciones PEP 740 solo si el repositorio es público**: se firman con
   Sigstore, cuyo registro de transparencia es público y lleva la identidad del
   workflow; con el repositorio privado eso expondría su nombre y su estructura.
   Es la misma decisión que `--provenance` en npm, y el día que el repositorio sea
   público entran solas.

`test/publicar-pypi.test.ts` falla en el PR si el workflow pierde `id-token:
write`, gana un token, instala algo en el trabajo que publica, deja de comprobar
la versión, el README, el contenido o el hash, o si `publish.yml` deja de saltar
las `py-v*`.

## Pasos del dueño (una vez)

### 1. Crear el «pending publisher» en pypi.org

Con la cuenta de PyPI de BiVelio (con 2FA activada):

1. <https://pypi.org/manage/account/publishing/> (menú de la cuenta →
   **Publishing**).
2. Sección **Add a new pending publisher** → pestaña **GitHub**.
3. Rellenar, **exactamente** (distingue mayúsculas):

   | Campo | Valor |
   |---|---|
   | PyPI Project Name | `bivelio-savings-layer` |
   | Owner | `BiVelio` |
   | Repository name | `bivelio-savings-layer` |
   | Workflow name | `publish-pypi.yml` |
   | Environment name | `pypi` |

4. **Add**. El proyecto no existe todavía: lo crea la primera subida.

### 2. (Recomendado) Proteger el environment `pypi` en GitHub

El environment se crea solo en la primera ejecución, pero conviene crearlo antes:
repositorio → **Settings** → **Environments** → **New environment** → `pypi`.

- **Deployment branches and tags** → *Selected branches and tags* → añadir la regla
  de etiqueta `py-v*`. Así ni otra rama ni otra etiqueta pueden pedir el token
  OIDC que PyPI acepta.
- *Required reviewers*: con plan Team y repositorio privado GitHub no lo ofrece
  (lo mismo que con `npm`, ver `docs/PUBLISHING.md`). Si el repositorio pasa a ser
  público, añadir al dueño como revisor.

### 3. Primera publicación

Con el PR del workflow fusionado en `main`:

```bash
git switch main && git pull
python -c "import re;print(re.search(r'__version__ = \"(.+)\"', open('packages/python/src/bvsala/__init__.py').read())[1])"
# → 0.1.0
gh release create py-v0.1.0 --target main --latest=false \
  --title "Python 0.1.0" \
  --notes "Primera versión del cliente de Python en PyPI: pip install bivelio-savings-layer"
```

`--latest=false` para que la Release de Python no desplace a la última de npm
como «Latest» en GitHub.

Luego:

1. Seguir la ejecución: `gh run list --workflow publish-pypi.yml` y `gh run watch`.
   La de `publish` también arranca con esa Release y debe salir **saltada**
   (`verificar` con `if` falso), no fallida.
2. Comprobar que PyPI la sirve, sin autenticarse:
   `curl -s https://pypi.org/pypi/bivelio-savings-layer/json | python -c "import json,sys;print(json.load(sys.stdin)['info']['version'])"`
   → `0.1.0`.
3. Probarla en limpio: `python -m venv /tmp/v && /tmp/v/bin/pip install
   bivelio-savings-layer && /tmp/v/bin/python -c "import bvsala;print(bvsala.__version__)"`.
4. **Solo entonces** fusionar el PR que cambia la web (nota de Python del panel de
   instalación, 12 idiomas) de «se instala desde el repositorio / escríbenos» a
   `pip install bivelio-savings-layer`.

Si falla en «Publicar en PyPI» con `invalid-publisher`, revisar los cinco valores
del paso 1: son lo único que PyPI compara. Una versión que ya subió no se puede
volver a subir con el mismo número (PyPI no permite reutilizar nombres de
archivo, ni borrando la versión): se corrige con la siguiente, `0.1.1`.

**Por qué el README de `packages/python` ya dice `pip install
bivelio-savings-layer` y la web todavía no:** el README es la descripción que PyPI
muestra, y la congela al subir cada versión; si la 0.1.0 saliera con «aún no está
en PyPI», la página de PyPI lo diría hasta la 0.1.1. El README vive en un
repositorio privado, así que antes de publicar no lo lee ningún cliente. La web sí
es pública: esa nota cambia en su propio PR, que se fusiona solo con el paquete ya
servido por PyPI.

## Versiones siguientes

1. Subir `__version__` en `packages/python/src/bvsala/__init__.py` y fusionar.
2. `gh release create py-vX.Y.Z --target main --latest=false --title "Python X.Y.Z" --notes "…"`.

## Probarlo en local sin publicar

```bash
cd packages/python
python -m venv /tmp/pub && /tmp/pub/bin/pip install --require-hashes --only-binary :all: -r requirements-publicar.txt
/tmp/pub/bin/python -m build --no-isolation . --outdir /tmp/dist
/tmp/pub/bin/python -m twine check --strict /tmp/dist/*
```

`requirements-publicar.txt` se regenera con el comando de la cabecera de
`requirements-publicar.in` (`uv pip compile --universal --generate-hashes …`).
