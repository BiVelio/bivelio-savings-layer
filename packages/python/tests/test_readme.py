"""El README (la página de PyPI) se lee bien y sus bloques de Python funcionan.

E2E 1.2.4, dos «minor»:

- El bloque «Anthropic:» no corría solo (`NameError: name 'bvsala' is not
  defined`): daba por hecho el `import bvsala` de un bloque anterior. Quien
  copia un bloque copia ESE bloque. Aquí cada bloque ```python corre solo, en
  un espacio de nombres vacío, contra el gateway falso, tal cual está escrito
  (solo cambia el puerto 8403 por el del gateway falso).
- En pypi.org un párrafo salía pegado al anterior («…never changed. In the
  TypeScript SDK: Every lever is included…» en un solo <p>, y el siguiente
  juntaba cuatro afirmaciones): faltaban líneas en blanco. `twine check` no lo
  ve (no renderiza Markdown). Aquí cada frase compartida vive en su propio
  bloque de Markdown.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import List

import pytest

README = (Path(__file__).resolve().parent.parent / "README.md").read_text(encoding="utf-8")
BLOQUES: List[str] = re.findall(r"^```python\n(.*?)^```", README, re.S | re.M)


def test_hay_bloques_de_python():
    assert len(BLOQUES) >= 3


@pytest.mark.parametrize("i", range(len(BLOQUES)))
def test_cada_bloque_de_python_corre_solo(i, fake_gateway, monkeypatch, tmp_path, capsys):
    codigo = BLOQUES[i]
    anthropic = "anthropic" in codigo
    pytest.importorskip("anthropic" if anthropic else "openai")
    # Un entorno limpio: claves falsas, sin proxies, sin la configuración de nadie.
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("OPENAI_API_KEY", "test-openai-key")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-anthropic-key")
    for var in ("OPENAI_BASE_URL", "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "HTTP_PROXY", "HTTPS_PROXY",
                "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setenv("BVSALA_GATEWAY_URL", fake_gateway.url)
    fake_gateway.upstream = "https://api.anthropic.com" if anthropic else "https://api.openai.com"

    exec(compile(codigo.replace("http://127.0.0.1:8403", fake_gateway.url), f"README.md python block {i + 1}", "exec"), {})

    assert len(fake_gateway.received) == 1
    assert " · measured · " in capsys.readouterr().out


def _bloques_markdown(md: str) -> List[str]:
    """Párrafos y elementos de lista, fuera de los bloques de código, con el espacio normalizado."""
    sin_codigo = re.sub(r"^```.*?^```", "", md, flags=re.S | re.M)
    bloques: List[str] = []
    for parrafo in re.split(r"\n\s*\n", sin_codigo):
        for item in re.split(r"\n(?=- )", parrafo):
            bloques.append(re.sub(r"\s+", " ", item).strip())
    return bloques


def test_cada_afirmacion_en_su_propio_bloque():
    frases = [
        "This package measures.",
        "Every lever is included and free, with no key.",
        "In the SDK, a BiVelio key only adds the cloud",
        "In the `bvsala` gateway the free Measure license",
        "One dependency comes with a key",
        "What the paid cloud adds is",
    ]
    bloques = _bloques_markdown(README)
    for frase in frases:
        con = [b for b in bloques if frase in b]
        assert len(con) == 1, frase
        otras = [f for f in frases if f != frase and f in con[0]]
        assert otras == [], f"{frase!r} comparte bloque con {otras}"
    medida = next(b for b in bloques if b.startswith("This package measures."))
    assert medida.endswith("by default it is never changed.")
