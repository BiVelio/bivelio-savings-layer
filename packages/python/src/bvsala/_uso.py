"""El uso por intento (D02) en Python: normalizar por dialecto y tarifar en enteros.

Es la MISMA regla que ``src/metering/intento.ts`` del paquete de npm
(``normalizarUso`` y ``tarifarIntento``), con la biblioteca estándar, comprobada
contra los vectores compartidos de ``test/fixtures/paridad/uso-por-intento.json``
que genera TypeScript (``pnpm paridad:vectores``).

Interno y experimental (D10, plan Caveman 2026-10-14): ``bvsala`` no lo exporta.

Lo que Python NO lleva es el catálogo de precios: emparejar un id de modelo con
su fila (alias, instantáneas con fecha, vetos, tramos por día) es del gateway y
del SDK. :func:`tarifar_intento` recibe la FILA ya resuelta (``None`` si el
catálogo no tiene precio) y hace con ella lo mismo que TypeScript: aritmética
entera exacta y la misma máquina de estados (``priced`` / ``unpriced`` /
``uncertain``). Un uso ausente, a medias o cortado nunca sale tarifado a 0.

Un dialecto que Python no conoce sale ``passthrough`` EXPLÍCITO con su motivo
(``unsupported_dialect``), nunca como un uso vacío que parezca medido.
"""

from __future__ import annotations

import math
from typing import Any, Dict, List, Mapping, Optional

MAX_SAFE_INTEGER = 2**53 - 1
UMBRAL_CONTEXTO_LARGO = 200_000
_ATTO_POR_MICRO = 1_000_000_000_000
_CONTADORES = ("inputUncached", "cacheRead", "cacheWrite5m", "cacheWrite1h", "output")
DIALECTOS = ("anthropic", "openai-chat", "openai-responses", "provider-usage")


class DialectoNoSoportado(ValueError):
    """El uso viene en un dialecto que esta versión de Python no sabe leer."""


def _es_numero(n: Any) -> bool:
    # En Python `True` es un int; en JavaScript un booleano no es un número.
    return isinstance(n, (int, float)) and not isinstance(n, bool)


def _entero(n: Any) -> bool:
    """``Number.isSafeInteger(n) && n >= 0`` de JavaScript."""
    if not _es_numero(n):
        return False
    if isinstance(n, float) and (not math.isfinite(n) or not n.is_integer()):
        return False
    return 0 <= n <= MAX_SAFE_INTEGER


def _opcional(n: Any) -> Any:
    return n if _entero(n) else 0


def _contador(v: Any) -> Any:
    """El contador de una iteración: cualquier número finito > 0 (sí, fraccionario)."""
    return v if _es_numero(v) and math.isfinite(v) and v > 0 else 0


def _dict(v: Any) -> Mapping[str, Any]:
    return v if isinstance(v, Mapping) else {}


def _falso_js(v: Any) -> bool:
    """``!v`` de JavaScript para lo que puede traer un JSON: un ``{}`` NO es falso."""
    return v is None or v is False or v == "" or (_es_numero(v) and (v == 0 or v != v))


def _extra_de_compactacion(iterations: Any) -> Optional[Dict[str, Any]]:
    """``extraDeCompactacion`` (src/providers/iteraciones-de-compactacion.ts)."""
    if not isinstance(iterations, list):
        return None
    extra: Dict[str, Any] = {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "cacheWrite1h": 0, "iteraciones": 0}
    for it in iterations:
        if not isinstance(it, Mapping) or it.get("type") != "compaction":
            continue
        extra["iteraciones"] += 1
        extra["input"] += _contador(it.get("input_tokens"))
        extra["output"] += _contador(it.get("output_tokens"))
        extra["cacheRead"] += _contador(it.get("cache_read_input_tokens"))
        desglose = _dict(it.get("cache_creation"))
        d5m = _contador(desglose.get("ephemeral_5m_input_tokens"))
        d1h = _contador(desglose.get("ephemeral_1h_input_tokens"))
        total = it.get("cache_creation_input_tokens")
        escrita = _contador(total) if _es_numero(total) else d5m + d1h
        extra["cacheWrite"] += escrita
        extra["cacheWrite1h"] += min(d1h, escrita)
    return extra if extra["iteraciones"] > 0 else None


def _salida_oculta(u: Mapping[str, Any]) -> int:
    """``salidaOculta`` (src/providers/salida-oculta.ts): total − prompt − completion, si es > 0."""
    p, c, t = u.get("prompt_tokens"), u.get("completion_tokens"), u.get("total_tokens")

    def ent(x: Any) -> bool:
        return _es_numero(x) and (isinstance(x, int) or (math.isfinite(x) and x.is_integer())) and x >= 0

    if not (ent(p) and ent(c) and ent(t)):
        return 0
    return max(0, t - p - c)


def _repartir_total(total: Any, leidos: Any, escritos: Any) -> Dict[str, Any]:
    cache_read = min(leidos, total)
    cache_write = min(escritos, total - cache_read)
    return {"inputUncached": total - cache_read - cache_write, "cacheRead": cache_read, "cacheWrite5m": cache_write, "cacheWrite1h": 0}


def _cerrar(base: Dict[str, Any], faltan: List[str], basis: str) -> Dict[str, Any]:
    completeness = "absent" if len(faltan) == 2 else "partial" if faltan else "complete"
    salida = dict(base)
    salida["reasoningIncludedInOutput"] = True
    salida["basis"] = basis
    salida["completeness"] = completeness
    if completeness != "complete":
        salida["missing"] = list(faltan)
    return salida


def _cero() -> Dict[str, Any]:
    return {"inputUncached": 0, "cacheRead": 0, "cacheWrite5m": 0, "cacheWrite1h": 0, "output": 0}


def _de_anthropic(u: Any, final: bool, basis: str) -> Dict[str, Any]:
    if _falso_js(u):
        return _cerrar(_cero(), ["input", "output"], basis)
    u = _dict(u)
    faltan: List[str] = []
    if not _entero(u.get("input_tokens")):
        faltan.append("input")
    if not final or not _entero(u.get("output_tokens")):
        faltan.append("output")
    extra = _extra_de_compactacion(u.get("iterations")) or {}
    d = _dict(u.get("cache_creation"))
    total = u.get("cache_creation_input_tokens")
    escrita_primer_nivel = total if _entero(total) else _opcional(d.get("ephemeral_5m_input_tokens")) + _opcional(d.get("ephemeral_1h_input_tokens"))
    escrita = escrita_primer_nivel + extra.get("cacheWrite", 0)
    una_hora = min(min(_opcional(d.get("ephemeral_1h_input_tokens")), escrita_primer_nivel) + extra.get("cacheWrite1h", 0), escrita)
    return _cerrar(
        {
            "inputUncached": _opcional(u.get("input_tokens")) + extra.get("input", 0),
            "cacheRead": _opcional(u.get("cache_read_input_tokens")) + extra.get("cacheRead", 0),
            "cacheWrite5m": escrita - una_hora,
            "cacheWrite1h": una_hora,
            "output": (_opcional(u.get("output_tokens")) if final else 0) + extra.get("output", 0),
        },
        faltan,
        basis,
    )


def _de_chat(u: Any, final: bool, basis: str) -> Dict[str, Any]:
    if _falso_js(u) or not final:
        return _cerrar(_cero(), ["input", "output"], basis)
    u = _dict(u)
    faltan: List[str] = []
    if not _entero(u.get("prompt_tokens")):
        faltan.append("input")
    if not _entero(u.get("completion_tokens")):
        faltan.append("output")
    oculta = _salida_oculta(u)
    declarado = _dict(u.get("completion_tokens_details")).get("reasoning_tokens")
    if oculta > 0:
        reasoning: Any = max(oculta, _opcional(declarado))
    else:
        reasoning = declarado if _entero(declarado) else None
    detalles = _dict(u.get("prompt_tokens_details"))
    base = _repartir_total(_opcional(u.get("prompt_tokens")), _opcional(detalles.get("cached_tokens")), _opcional(detalles.get("cache_write_tokens")))
    base["output"] = _opcional(u.get("completion_tokens")) + oculta
    if reasoning is not None:
        base["reasoning"] = reasoning
    return _cerrar(base, faltan, basis)


def _de_responses(u: Any, final: bool, basis: str) -> Dict[str, Any]:
    if _falso_js(u) or not final:
        return _cerrar(_cero(), ["input", "output"], basis)
    u = _dict(u)
    faltan: List[str] = []
    if not _entero(u.get("input_tokens")):
        faltan.append("input")
    if not _entero(u.get("output_tokens")):
        faltan.append("output")
    declarado = _dict(u.get("output_tokens_details")).get("reasoning_tokens")
    detalles = _dict(u.get("input_tokens_details"))
    base = _repartir_total(_opcional(u.get("input_tokens")), _opcional(detalles.get("cached_tokens")), _opcional(detalles.get("cache_write_tokens")))
    base["output"] = _opcional(u.get("output_tokens"))
    if _entero(declarado):
        base["reasoning"] = declarado
    return _cerrar(base, faltan, basis)


def _de_provider_usage(u: Any, basis: str) -> Dict[str, Any]:
    if _falso_js(u):
        return _cerrar(_cero(), ["input", "output"], basis)
    u = _dict(u)
    leidos = _opcional(u.get("cachedInputTokens"))
    escritos = _opcional(u.get("cacheWriteInputTokens"))
    total = _opcional(u.get("inputTokens"))
    cache_read = min(leidos, total)
    escrita = min(escritos, total - cache_read)
    una_hora = min(_opcional(u.get("cacheWrite1hInputTokens")), escrita)
    base: Dict[str, Any] = {
        "inputUncached": total - cache_read - escrita,
        "cacheRead": cache_read,
        "cacheWrite5m": escrita - una_hora,
        "cacheWrite1h": una_hora,
        "output": _opcional(u.get("outputTokens")),
    }
    if _entero(u.get("reasoningTokens")):
        base["reasoning"] = u.get("reasoningTokens")
    incompleto = u.get("complete") is False
    faltan: List[str] = []
    if incompleto:
        if total == 0:
            faltan.append("input")
        if base["output"] == 0:
            faltan.append("output")
    if not _entero(u.get("inputTokens")) and "input" not in faltan:
        faltan.append("input")
    if not _entero(u.get("outputTokens")) and "output" not in faltan:
        faltan.append("output")
    if incompleto and not faltan:
        salida = _cerrar(base, [], basis)
        salida["completeness"] = "partial"
        salida["missing"] = []
        return salida
    return _cerrar(base, faltan, basis)


def normalizar_uso(crudo: Mapping[str, Any], basis: str = "provider_reported") -> Dict[str, Any]:
    """El uso de un intento en la forma común (``AttemptUsage``), como ``normalizarUso``.

    ``crudo`` es ``{"dialecto": ..., "uso": {...} | None, "final": bool?}``. No
    lanza por un uso ilegible: lo declara ``partial``/``absent``. Lanza
    :class:`DialectoNoSoportado` con un dialecto que no conoce; usa
    :func:`normalizar_o_passthrough` para recibirlo como resultado.
    """
    dialecto = crudo.get("dialecto")
    uso = crudo.get("uso")
    final = crudo.get("final") is not False
    if dialecto == "anthropic":
        return _de_anthropic(uso, final, basis)
    if dialecto == "openai-chat":
        return _de_chat(uso, final, basis)
    if dialecto == "openai-responses":
        return _de_responses(uso, final, basis)
    if dialecto == "provider-usage":
        return _de_provider_usage(uso, basis)
    raise DialectoNoSoportado(f"usage dialect {dialecto!r} is not supported in Python (supported: {', '.join(DIALECTOS)})")


def normalizar_o_passthrough(crudo: Mapping[str, Any], basis: str = "provider_reported") -> Dict[str, Any]:
    """Como :func:`normalizar_uso`, pero un dialecto desconocido es un resultado, no una excepción."""
    try:
        return {"status": "normalized", "usage": normalizar_uso(crudo, basis)}
    except DialectoNoSoportado as e:
        return {"status": "passthrough", "reason": "unsupported_dialect", "detail": str(e)}


# ── La tarifa, en enteros ────────────────────────────────────────────────────


def _a_entero_exacto(x: Any, escala: int) -> Optional[int]:
    """``aEnteroExacto``: el precio en la unidad entera, o None si no cabe exacto."""
    if not _es_numero(x):
        return None
    v = x * escala
    if not math.isfinite(v):
        return None
    r = math.floor(v + 0.5)  # Math.round de JS: mitades hacia +∞
    if r < 0 or abs(v - r) > 1e-6:
        return None
    return int(r)


def tarifar_intento(modelo: str, uso: Mapping[str, Any], fila: Optional[Mapping[str, Any]], dia: str, price_version: str) -> Dict[str, Any]:
    """El precio de un intento (``AttemptPrice``), como ``tarifarIntento``.

    ``fila`` es lo que el catálogo de TypeScript resolvió para ``modelo`` el día
    ``dia`` (``catalogKey``, ``inputPer1k``, ``cachedInputPer1k`` o None,
    ``outputPer1k``, ``prima5m``, ``prima1h``, ``propio``), o ``None`` si no hay
    precio. ``price_version`` es la versión del catálogo (``PRECIOS_AL_DIA``).
    """
    if uso.get("completeness") == "absent":
        return {"state": "unpriced", "reason": "usage-absent", "detail": "the provider reported no usage for this attempt"}
    invalido = next((k for k in _CONTADORES if not _entero(uso.get(k))), None)
    if invalido is not None or ("reasoning" in uso and not _entero(uso.get("reasoning"))):
        return {"state": "unpriced", "reason": "usage-invalid", "detail": f"counter {invalido or 'reasoning'} is not a safe non-negative integer"}
    if fila is None:
        return {"state": "unpriced", "reason": "no-catalog-price", "detail": f"no list price for {modelo} on {dia}"}
    clave = fila["catalogKey"]
    cacheada = fila.get("cachedInputPer1k")
    p_in = _a_entero_exacto(fila["inputPer1k"], 10**9)
    p_cache = _a_entero_exacto(fila["inputPer1k"] if cacheada is None else cacheada, 10**9)
    p_out = _a_entero_exacto(fila["outputPer1k"], 10**9)
    prima5m = _a_entero_exacto(fila["prima5m"], 100)
    prima1h = _a_entero_exacto(fila["prima1h"], 100)
    if p_in is None or p_cache is None or p_out is None or prima5m is None or prima1h is None:
        return {
            "state": "uncertain",
            "reason": "price-not-representable",
            "detail": f"the catalog price of {clave} has more precision than this ledger keeps",
            "priceVersion": price_version,
        }
    t = {k: int(uso[k]) for k in _CONTADORES}
    centi_pico = (
        t["inputUncached"] * p_in * 100
        + t["cacheRead"] * p_cache * 100
        + t["cacheWrite5m"] * p_in * prima5m
        + t["cacheWrite1h"] * p_in * prima1h
        # `reasoning` NO aparece: ya está dentro de `output`.
        + t["output"] * p_out * 100
    )
    atto = centi_pico * 10_000
    suelo = atto // _ATTO_POR_MICRO

    basis = uso.get("basis")
    if basis == "estimated":
        return {"state": "uncertain", "reason": "usage-estimated", "detail": "a token estimate is not a provider counter", "priceVersion": price_version}
    if basis == "client_observed":
        return {
            "state": "uncertain",
            "reason": "usage-client-observed",
            "detail": "counted by the client, not reported by the provider (hidden reasoning is not visible)",
            "priceVersion": price_version,
        }
    if not fila.get("propio"):
        return {
            "state": "uncertain",
            "reason": "inherited-price",
            "detail": f"{modelo} has no catalog row of its own; {clave}'s price is an approximation",
            "priceVersion": price_version,
        }
    if uso.get("completeness") == "partial":
        faltan = ", ".join(uso.get("missing") or []) or "unknown"
        return {
            "state": "uncertain",
            "reason": "usage-partial",
            "detail": f"missing counter(s): {faltan}; priced counters are a floor",
            "lowerBoundMicroUsd": suelo,
            "priceVersion": price_version,
        }
    entrada = t["inputUncached"] + t["cacheRead"] + t["cacheWrite5m"] + t["cacheWrite1h"]
    if entrada == 0:
        return {
            "state": "uncertain",
            "reason": "implausible-zero-input",
            "detail": "a billed attempt always carries its prompt; zero input tokens looks like a zero-filled counter",
            "lowerBoundMicroUsd": suelo,
            "priceVersion": price_version,
        }
    if entrada > UMBRAL_CONTEXTO_LARGO:
        return {
            "state": "uncertain",
            "reason": "long-context-tier",
            "detail": f"{entrada} input tokens exceed {UMBRAL_CONTEXTO_LARGO}; the long-context rate is not in the catalog, the short rate is a floor",
            "lowerBoundMicroUsd": suelo,
            "priceVersion": price_version,
        }
    importe = (atto + _ATTO_POR_MICRO // 2) // _ATTO_POR_MICRO
    if importe > MAX_SAFE_INTEGER:
        return {"state": "uncertain", "reason": "price-not-representable", "detail": "the amount does not fit a safe integer of micro-USD", "priceVersion": price_version}
    return {
        "state": "priced",
        "amountMicroUsd": importe,
        "exactAttoUsd": str(atto),
        "currency": "USD",
        "priceVersion": price_version,
        "priceDay": dia,
        "catalogKey": clave,
    }
