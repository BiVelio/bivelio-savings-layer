"""PARIDAD TS ↔ Python: las mismas entradas dan las mismas salidas, campo a campo.

Los vectores los genera la implementación de TypeScript (``pnpm
paridad:vectores``, casos en test/helpers/paridad.ts) y viven en
test/fixtures/paridad/ en la raíz del repositorio. Aquí no se calcula nada
esperado: se compara lo que dice Python con lo que dijo TypeScript. Que el
fichero esté al día con TypeScript lo exige test/paridad-python.test.ts.

Fuera del repositorio (p. ej. desde el sdist) los vectores no están: se salta
con el motivo dicho, nunca en verde sin haber comparado.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict

import pytest

from bvsala._json_estricto import (
    TRANSFORM_ID,
    TRANSFORM_VERSION,
    a_utf16,
    compactar_sin_perdida,
    de_utf16,
    estimar_tokens,
    longitud_js,
)
from bvsala._uso import DialectoNoSoportado, normalizar_o_passthrough, normalizar_uso, tarifar_intento

_VECTORES = Path(__file__).resolve().parents[3] / "test" / "fixtures" / "paridad"


def _cargar(nombre: str) -> Dict[str, Any]:
    ruta = _VECTORES / nombre
    if not ruta.is_file():
        pytest.skip(f"parity vectors not found at {ruta} (outside the repository checkout)")
    return json.loads(ruta.read_text(encoding="utf-8"))


JSON_V = _cargar("json-estricto.json") if (_VECTORES / "json-estricto.json").is_file() else {"casos": [], "estimadorHeuristico": []}
USO_V = _cargar("uso-por-intento.json") if (_VECTORES / "uso-por-intento.json").is_file() else {"casos": []}


def test_los_vectores_existen_y_son_del_formato_que_se_entiende() -> None:
    j = _cargar("json-estricto.json")
    u = _cargar("uso-por-intento.json")
    assert j["formato"] == 1 and u["formato"] == 1
    # Si TypeScript sube la versión de la transformación, Python NO la finge:
    # este test cae hasta que alguien porte la nueva regla.
    assert j["transform"] == {"id": TRANSFORM_ID, "version": TRANSFORM_VERSION}
    assert j["estimador"] == "heuristic"
    assert len(j["casos"]) >= 30 and len(u["casos"]) >= 30


# ── json-estricto ────────────────────────────────────────────────────────────


@pytest.mark.parametrize("caso", JSON_V["casos"], ids=lambda c: c["nombre"])
def test_compactacion_sin_perdida_igual_que_typescript(caso: Dict[str, Any]) -> None:
    e = caso["esperado"]
    r = compactar_sin_perdida(caso["entrada"]["texto"], caso["entrada"]["minSavedChars"])
    d = r["decision"]
    obtenido = {
        "changed": r["changed"],
        "text": r["text"],
        "status": d["status"],
        "reason": d["reason"],
        "tokensBefore": d["tokensBefore"],
        "tokensAfter": d["tokensAfter"],
        "candidateTokens": d.get("candidateTokens"),
        "originalChars": r["originalChars"],
        "compactChars": r["compactChars"],
    }
    assert obtenido == e


@pytest.mark.parametrize("caso", JSON_V["estimadorHeuristico"], ids=lambda c: repr(c["texto"][:24]))
def test_estimador_heuristico_igual_que_typescript(caso: Dict[str, Any]) -> None:
    assert estimar_tokens(caso["texto"]) == caso["tokens"]


def test_lo_aplicado_conserva_cada_lexema_y_solo_quita_espacio() -> None:
    # Oráculo independiente de las dos implementaciones: lo compacto, vuelto a
    # leer con el json de la biblioteca estándar, dice lo mismo que el original,
    # y no tiene ni un carácter que no estuviera en él.
    aplicados = [c for c in JSON_V["casos"] if c["esperado"]["changed"]]
    assert len(aplicados) >= 8
    for c in aplicados:
        original, compacto = c["entrada"]["texto"], c["esperado"]["text"]
        try:
            assert json.loads(compacto) == json.loads(original), c["nombre"]
        except RecursionError:
            pass  # el json de la biblioteca estándar es recursivo; el anidado se mira por el espacio

        quitado = len(original) - len(compacto)
        espacio = sum(original.count(ch) for ch in " \t\n\r") - sum(compacto.count(ch) for ch in " \t\n\r")
        assert quitado == espacio > 0, c["nombre"]


def test_los_numeros_y_escapes_salen_escritos_igual() -> None:
    caso = next(c for c in JSON_V["casos"] if c["nombre"].startswith("números"))
    t = caso["esperado"]["text"]
    for literal in ("9223372036854775809", "1.10", "1e400", "-0", "1E-7"):
        assert f":{literal}," in t
    caso = next(c for c in JSON_V["casos"] if c["nombre"].startswith("escapes"))
    assert '"a  b\\n\\t \\"c\\" \\\\ \\/ \\u00e9 \\ud83d\\ude00"' in caso["esperado"]["text"]


def test_version_desconocida_es_passthrough_explicito_no_silencio() -> None:
    texto = json.dumps({"filas": list(range(200))}, indent=2)
    r = compactar_sin_perdida(texto, 1, version="2")
    assert r["changed"] is False and r["text"] == texto
    assert r["decision"]["status"] == "passthrough"
    assert r["decision"]["reason"] == "unsupported_version"
    assert "v2" in r["decision"]["detail"]


def test_otro_estimador_es_passthrough_explicito() -> None:
    texto = json.dumps({"filas": list(range(200))}, indent=2)
    r = compactar_sin_perdida(texto, 1, estimador="o200k_base")
    assert r["changed"] is False and r["text"] == texto
    assert r["decision"] == {
        "status": "passthrough",
        "reason": "unsupported_estimator",
        "detail": "token estimator 'o200k_base' is not available in Python (only 'heuristic')",
    }


def test_utf16_ida_y_vuelta_y_longitud_de_javascript() -> None:
    for s in ["", "abc", "😀", "x\ud800y", "a\udc00", "中文😀ñ"]:
        assert de_utf16(a_utf16(s)) == s
    assert longitud_js("😀") == 2 and longitud_js("ñ") == 1


def test_anidamiento_profundo_no_revienta_la_pila() -> None:
    texto = "[" * 200_000 + "]" * 200_000
    r = compactar_sin_perdida(texto, 1)
    assert r["decision"]["reason"] == "not_smaller"


# ── uso-por-intento ──────────────────────────────────────────────────────────


@pytest.mark.parametrize("caso", USO_V["casos"], ids=lambda c: c["nombre"])
def test_normalizar_y_tarifar_igual_que_typescript(caso: Dict[str, Any]) -> None:
    entrada = caso["entrada"]
    uso = normalizar_uso(entrada["crudo"], entrada["basis"] or "provider_reported")
    assert uso == caso["esperado"]["uso"]
    precio = tarifar_intento(entrada["modelo"], uso, caso["fila"], USO_V["priceDay"], USO_V["priceVersion"])
    assert precio == caso["esperado"]["precio"]


def test_ningun_uso_incompleto_sale_tarifado() -> None:
    # La propiedad, no el caso: sobre TODOS los vectores, lo que no es completo
    # del proveedor nunca es `priced`, y un `priced` nunca es 0 sin entrada.
    for c in USO_V["casos"]:
        uso, precio = c["esperado"]["uso"], c["esperado"]["precio"]
        if uso["completeness"] != "complete" or uso["basis"] != "provider_reported":
            assert precio["state"] != "priced", c["nombre"]
        if precio["state"] == "priced":
            assert isinstance(precio["amountMicroUsd"], int)
            assert int(precio["exactAttoUsd"]) >= 0


def test_dialecto_desconocido_es_passthrough_explicito() -> None:
    with pytest.raises(DialectoNoSoportado):
        normalizar_uso({"dialecto": "gemini-native", "uso": {"promptTokenCount": 10}})
    r = normalizar_o_passthrough({"dialecto": "gemini-native", "uso": {"promptTokenCount": 10}})
    assert r["status"] == "passthrough" and r["reason"] == "unsupported_dialect"
    assert "gemini-native" in r["detail"]


def test_un_objeto_vacio_no_es_un_uso_ausente_sino_sin_contadores() -> None:
    # En JavaScript `{}` es verdadero: llega el objeto pero sin contadores. Los
    # dos faltan, así que sale `absent` igual, pero por el camino de los contadores.
    u = normalizar_uso({"dialecto": "anthropic", "uso": {}})
    assert u["completeness"] == "absent" and u["missing"] == ["input", "output"]
