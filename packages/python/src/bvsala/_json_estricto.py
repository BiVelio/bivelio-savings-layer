"""La compactación sin pérdida de un JSON (perfil ``lossless-data``), en Python.

Es la MISMA regla que ``src/util/json-estricto.ts`` + ``src/compression/cola.ts``
(perfil ``lossless-data``, transformación ``json-lossless`` v1) del paquete de
npm, reescrita con la biblioteca estándar y comprobada contra los vectores
compartidos de ``test/fixtures/paridad/json-estricto.json``, que genera la
implementación de TypeScript (``pnpm paridad:vectores``).

Interno y experimental (D10, plan Caveman 2026-10-14): ``bvsala`` no lo exporta.
El paquete de Python es un cliente del gateway, y la compactación de verdad la
hace el gateway o el SDK; esto existe para que un llamante de Python pueda
DECIDIR igual que TypeScript, con la misma explicación, sin adivinar.

Qué hace: si el texto ENTERO es JSON estricto (RFC 8259) sin claves duplicadas a
ninguna profundidad, quita el espacio entre lexemas y nada más; las cadenas, sus
escapes y los números salen tal como estaban escritos. Si no, devuelve el texto
intacto con un código de motivo estable.

Dos detalles para hablar el mismo idioma que JavaScript:

* Las longitudes y posiciones se cuentan en unidades UTF-16 (``text.length`` de
  JS), no en puntos de código de Python: un emoji son 2.
* El estimador heurístico usa la clase ``\\s`` de JavaScript, que NO es la de
  Python (JS incluye ``U+FEFF``; Python incluye ``U+0085`` y ``U+001C..1F``).

Lo que no está soportado sale como ``passthrough`` EXPLÍCITO con su motivo,
nunca en silencio: otra versión de la transformación
(``unsupported_version``) u otro estimador de tokens que el heurístico
(``unsupported_estimator``; Python no lleva o200k ni el tokenizador de nadie).
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

TRANSFORM_ID = "json-lossless"
TRANSFORM_VERSION = "1"
ESTIMADOR_HEURISTICO = "heuristic"
DEFAULT_MIN_SAVED_CHARS = 256

# ── UTF-16 ──────────────────────────────────────────────────────────────────


def a_utf16(texto: str) -> List[int]:
    """Las unidades UTF-16 de ``texto``, como las ve JavaScript.

    Un sustituto suelto (lo que ``json.loads`` deja de un ``"\\ud800"``) queda
    como esa misma unidad; un astral se parte en su par.
    """
    unidades: List[int] = []
    for ch in texto:
        o = ord(ch)
        if o > 0xFFFF:
            o -= 0x10000
            unidades.append(0xD800 + (o >> 10))
            unidades.append(0xDC00 + (o & 0x3FF))
        else:
            unidades.append(o)
    return unidades


def de_utf16(unidades: List[int]) -> str:
    """Lo contrario de :func:`a_utf16`: los pares se juntan, los sueltos quedan."""
    salida: List[str] = []
    i = 0
    n = len(unidades)
    while i < n:
        u = unidades[i]
        if 0xD800 <= u <= 0xDBFF and i + 1 < n and 0xDC00 <= unidades[i + 1] <= 0xDFFF:
            salida.append(chr(0x10000 + ((u - 0xD800) << 10) + (unidades[i + 1] - 0xDC00)))
            i += 2
            continue
        salida.append(chr(u))
        i += 1
    return "".join(salida)


def longitud_js(texto: str) -> int:
    """``texto.length`` de JavaScript."""
    return sum(2 if ord(ch) > 0xFFFF else 1 for ch in texto)


# ── El recorrido estricto ────────────────────────────────────────────────────

_BLANCO_JSON = (0x20, 0x0A, 0x0D, 0x09)
_ESCAPES = (0x22, 0x5C, 0x2F, 0x62, 0x66, 0x6E, 0x72, 0x74, 0x75)
_ESCAPE_SIMPLE = {0x22: 0x22, 0x5C: 0x5C, 0x2F: 0x2F, 0x62: 0x08, 0x66: 0x0C, 0x6E: 0x0A, 0x72: 0x0D, 0x74: 0x09}


def _es_digito(c: int) -> bool:
    return 0x30 <= c <= 0x39


def _es_hex(c: int) -> bool:
    return _es_digito(c) or 0x41 <= c <= 0x46 or 0x61 <= c <= 0x66


def _en(u: List[int], i: int) -> int:
    """La unidad en ``i``, o -1 fuera del texto (el ``NaN`` de ``charCodeAt``)."""
    return u[i] if 0 <= i < len(u) else -1


def _fin_de_cadena(u: List[int], i: int) -> Tuple[Optional[int], bool, Optional[str]]:
    """(fin exclusivo, llevaba escapes, fallo) de la cadena que empieza en ``i``."""
    n = len(u)
    escapes = False
    j = i + 1
    while j < n:
        c = u[j]
        if c == 0x22:
            return j + 1, escapes, None
        if c == 0x5C:
            e = _en(u, j + 1)
            if e not in _ESCAPES:
                return None, escapes, "invalid_json"
            escapes = True
            if e == 0x75:
                for k in range(j + 2, j + 6):
                    if not _es_hex(_en(u, k)):
                        return None, escapes, "invalid_json"
                j += 6
            else:
                j += 2
            continue
        if c < 0x20:
            return None, escapes, "invalid_json"
        if 0xD800 <= c <= 0xDBFF:
            d = _en(u, j + 1)
            if not (0xDC00 <= d <= 0xDFFF):
                return None, escapes, "invalid_unicode"
            j += 2
            continue
        if 0xDC00 <= c <= 0xDFFF:
            return None, escapes, "invalid_unicode"
        j += 1
    return None, escapes, "invalid_json"


def _decodificar_clave(u: List[int], inicio: int, fin: int) -> Tuple[int, ...]:
    """Una clave con escapes, decodificada a unidades (lo que da ``JSON.parse``)."""
    salida: List[int] = []
    j = inicio + 1
    while j < fin - 1:
        c = u[j]
        if c == 0x5C:
            e = u[j + 1]
            if e == 0x75:
                salida.append(int("".join(chr(x) for x in u[j + 2 : j + 6]), 16))
                j += 6
            else:
                salida.append(_ESCAPE_SIMPLE[e])
                j += 2
            continue
        salida.append(c)
        j += 1
    return tuple(salida)


def _fin_de_numero(u: List[int], i: int) -> Optional[int]:
    """Fin del literal ``-?(0|[1-9]\\d*)(\\.\\d+)?([eE][+-]?\\d+)?`` en ``i``, o None."""
    j = i
    if _en(u, j) == 0x2D:
        j += 1
    c = _en(u, j)
    if c == 0x30:
        j += 1
    elif 0x31 <= c <= 0x39:
        while _es_digito(_en(u, j)):
            j += 1
    else:
        return None
    if _en(u, j) == 0x2E and _es_digito(_en(u, j + 1)):
        j += 1
        while _es_digito(_en(u, j)):
            j += 1
    if _en(u, j) in (0x45, 0x65):
        k = j + 1
        if _en(u, k) in (0x2B, 0x2D):
            k += 1
        if _es_digito(_en(u, k)):
            while _es_digito(_en(u, k)):
                k += 1
            j = k
    return j


def lexemas_json_estricto(u: List[int]) -> Tuple[Optional[List[Tuple[int, int]]], Optional[str]]:
    """Los lexemas de un JSON estricto como (inicio, fin) en unidades; o el fallo.

    Recorre ``u`` como UN valor JSON estricto rodeado, como mucho, de espacio
    JSON. Rechaza claves duplicadas en un mismo objeto a cualquier profundidad.
    Lineal y sin recursión: un JSON de 100 000 niveles no revienta la pila.
    """
    n = len(u)
    pila: List[Optional[set]] = []
    estado = "valor"
    i = 0
    lex: List[Tuple[int, int]] = []

    def tras_valor() -> str:
        return "fin" if not pila else "comaOFin"

    while True:
        while i < n and u[i] in _BLANCO_JSON:
            i += 1
        if estado == "fin":
            return (lex, None) if i == n else (None, "invalid_json")
        if i >= n:
            return None, "invalid_json"
        c = u[i]

        if estado == "valorOFin":
            if c == 0x5D:
                pila.pop()
                lex.append((i, i + 1))
                i += 1
                estado = tras_valor()
                continue
            estado = "valor"
        if estado == "claveOFin":
            if c == 0x7D:
                pila.pop()
                lex.append((i, i + 1))
                i += 1
                estado = tras_valor()
                continue
            estado = "clave"

        if estado == "valor":
            if c in (0x7B, 0x5B):
                pila.append(set() if c == 0x7B else None)
                lex.append((i, i + 1))
                i += 1
                estado = "claveOFin" if c == 0x7B else "valorOFin"
                continue
            if c == 0x22:
                fin, _, fallo = _fin_de_cadena(u, i)
                if fallo is not None or fin is None:
                    return None, fallo
                lex.append((i, fin))
                i = fin
                estado = tras_valor()
                continue
            if c == 0x2D or _es_digito(c):
                fin = _fin_de_numero(u, i)
                if fin is None:
                    return None, "invalid_json"
                lex.append((i, fin))
                i = fin
                estado = tras_valor()
                continue
            literal = "true" if c == 0x74 else "false" if c == 0x66 else "null" if c == 0x6E else None
            if literal is not None and u[i : i + len(literal)] == [ord(x) for x in literal]:
                lex.append((i, i + len(literal)))
                i += len(literal)
                estado = tras_valor()
                continue
            return None, "invalid_json"

        if estado == "clave":
            if c != 0x22:
                return None, "invalid_json"
            fin, escapes, fallo = _fin_de_cadena(u, i)
            if fallo is not None or fin is None:
                return None, fallo
            clave = _decodificar_clave(u, i, fin) if escapes else tuple(u[i + 1 : fin - 1])
            vistas = pila[-1]
            assert vistas is not None
            if clave in vistas:
                return None, "duplicate_keys"
            vistas.add(clave)
            lex.append((i, fin))
            i = fin
            estado = "dosPuntos"
            continue

        if estado == "dosPuntos":
            if c != 0x3A:
                return None, "invalid_json"
            lex.append((i, i + 1))
            i += 1
            estado = "valor"
            continue

        if estado == "comaOFin":
            tope = pila[-1]
            if c == 0x2C:
                lex.append((i, i + 1))
                i += 1
                estado = "clave" if tope is not None else "valor"
                continue
            if (c == 0x7D and tope is not None) or (c == 0x5D and tope is None):
                pila.pop()
                lex.append((i, i + 1))
                i += 1
                estado = tras_valor()
                continue
            return None, "invalid_json"


# ── El estimador heurístico (src/tokenizer/estimator.ts) ─────────────────────

# `\s` de JavaScript (sin la bandera `u`), unidad a unidad.
_ESPACIO_JS = frozenset(
    [0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20, 0xA0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF]
    + list(range(0x2000, 0x200B))
)


def _es_letra(c: int) -> bool:
    return 0x41 <= c <= 0x5A or 0x61 <= c <= 0x7A


def estimar_tokens(texto: str) -> int:
    """El ``heuristicEstimator.count`` de TypeScript, unidad UTF-16 a unidad."""
    u = a_utf16(texto)
    n = len(u)
    if n == 0:
        return 0
    tokens = 0
    i = 0
    while i < n:
        c = u[i]
        j = i + 1
        if _es_letra(c):
            while j < n and _es_letra(u[j]):
                j += 1
            tokens += max(1, -(-(j - i) // 4))
        elif _es_digito(c):
            while j < n and _es_digito(u[j]):
                j += 1
            tokens += max(1, -(-(j - i) // 2))
        elif c in _ESPACIO_JS:
            while j < n and u[j] in _ESPACIO_JS:
                j += 1
            saltos = sum(1 for k in range(i, j) if u[k] == 0x0A)
            tokens += saltos + max(0, j - i - 1) // 2
        else:
            tokens += 1
        i = j
    return max(tokens, -(-n // 4))


# ── La decisión ──────────────────────────────────────────────────────────────


def _desvio(texto: str, n: int, motivo: str, antes: int, candidato: Optional[int] = None) -> Dict[str, Any]:
    decision: Dict[str, Any] = {
        "status": "bypassed",
        "reason": motivo,
        "transformId": TRANSFORM_ID,
        "version": TRANSFORM_VERSION,
        "tokensBefore": antes,
        "tokensAfter": antes,
    }
    if candidato is not None:
        decision["candidateTokens"] = candidato
    return {"text": texto, "changed": False, "originalChars": n, "compactChars": n, "decision": decision}


def _passthrough(texto: str, motivo: str, detalle: str) -> Dict[str, Any]:
    n = longitud_js(texto)
    return {
        "text": texto,
        "changed": False,
        "originalChars": n,
        "compactChars": n,
        "decision": {"status": "passthrough", "reason": motivo, "detail": detalle},
    }


def compactar_sin_perdida(
    texto: str,
    min_saved_chars: int = DEFAULT_MIN_SAVED_CHARS,
    *,
    version: str = TRANSFORM_VERSION,
    estimador: str = ESTIMADOR_HEURISTICO,
) -> Dict[str, Any]:
    """La decisión del perfil ``lossless-data`` para la salida de UNA herramienta.

    Devuelve ``text`` (compacto si ``changed``, si no el original tal cual),
    ``originalChars``/``compactChars`` en unidades UTF-16 y ``decision`` con
    ``status`` ``applied``/``bypassed`` y un ``reason`` estable: ``applied``,
    ``not_json``, ``invalid_json``, ``duplicate_keys``, ``invalid_unicode``,
    ``not_smaller`` o ``below_threshold``. Los tokens son ESTIMACIONES del
    heurístico, nunca un ahorro verificado.

    ``status: "passthrough"`` (con ``unsupported_version`` o
    ``unsupported_estimator``): Python no sabe hacer lo pedido y no lo finge.
    """
    if version != TRANSFORM_VERSION:
        return _passthrough(texto, "unsupported_version", f"{TRANSFORM_ID} v{version} is not implemented in Python (only v{TRANSFORM_VERSION})")
    if estimador != ESTIMADOR_HEURISTICO:
        return _passthrough(texto, "unsupported_estimator", f"token estimator {estimador!r} is not available in Python (only {ESTIMADOR_HEURISTICO!r})")
    if isinstance(min_saved_chars, bool) or not isinstance(min_saved_chars, (int, float)):
        raise TypeError("min_saved_chars must be a number")
    minimo = max(1, min_saved_chars)

    u = a_utf16(texto)
    n = len(u)
    antes = estimar_tokens(texto)

    i = 0
    while i < n and u[i] in _BLANCO_JSON:
        i += 1
    if _en(u, i) not in (0x7B, 0x5B):
        return _desvio(texto, n, "not_json", antes)
    lex, fallo = lexemas_json_estricto(u)
    if lex is None:
        return _desvio(texto, n, fallo or "invalid_json", antes)
    compacto_u: List[int] = []
    trozos = []
    for a, b in lex:
        trozo = u[a:b]
        trozos.append(trozo)
        compacto_u.extend(trozo)
    # LA COMPROBACIÓN, no la promesa: el compacto tiene los mismos lexemas, uno a uno.
    vuelta, _ = lexemas_json_estricto(compacto_u)
    if vuelta is None or len(vuelta) != len(trozos) or any(compacto_u[a:b] != trozos[k] for k, (a, b) in enumerate(vuelta)):
        return _desvio(texto, n, "invalid_json", antes)
    compacto = de_utf16(compacto_u)

    candidato = estimar_tokens(compacto)
    if candidato >= antes:
        return _desvio(texto, n, "not_smaller", antes, candidato)
    if n - len(compacto_u) < minimo:
        return _desvio(texto, n, "below_threshold", antes, candidato)
    return {
        "text": compacto,
        "changed": True,
        "originalChars": n,
        "compactChars": len(compacto_u),
        "decision": {
            "status": "applied",
            "reason": "applied",
            "transformId": TRANSFORM_ID,
            "version": TRANSFORM_VERSION,
            "tokensBefore": antes,
            "tokensAfter": candidato,
            "candidateTokens": candidato,
        },
    }
