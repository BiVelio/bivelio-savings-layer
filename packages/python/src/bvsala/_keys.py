"""De qué objeto sale la clave para pedir el informe.

Dos claves, por orden de preferencia:

1. ``x-bvsala-request-id``, la cabecera que el gateway pone en la respuesta de
   una petición que pidió informe. Exacta. Está al alcance en los streams de
   los SDK oficiales (``stream.response.headers``), en ``with_raw_response`` y
   en LiteLLM (``_hidden_params["additional_headers"]``, con prefijo
   ``llm_provider-``).
2. El ``id`` de la respuesta del proveedor (``chatcmpl-…``, ``msg_…``,
   ``resp_…``), que los SDK exponen como campo público en todo objeto de
   respuesta y en los eventos de stream. El gateway lo indexa al verlo pasar.

Solo duck typing: este módulo no importa ningún SDK.
"""

from __future__ import annotations

import re
from typing import Any, Mapping, Optional

REQUEST_ID_HEADER = "x-bvsala-request-id"
_LITELLM_HEADER = "llm_provider-" + REQUEST_ID_HEADER
_ID_SEGURO = re.compile(r"^[A-Za-z0-9._:-]{1,200}$")
_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


def is_request_id(s: str) -> bool:
    """Los ids de petición del gateway son UUID; los de respuesta del proveedor, no."""
    return bool(_UUID.match(s))


def _seguro(v: Any) -> Optional[str]:
    return v if isinstance(v, str) and _ID_SEGURO.match(v) else None


def _de_cabeceras(cabeceras: Any, nombre: str) -> Optional[str]:
    if cabeceras is None:
        return None
    # httpx/httpx2 Headers: get() ya ignora mayúsculas.
    get = getattr(cabeceras, "get", None)
    if callable(get) and not isinstance(cabeceras, Mapping):
        return _seguro(get(nombre))
    if isinstance(cabeceras, Mapping):
        for k, v in cabeceras.items():
            if isinstance(k, str) and k.lower() == nombre:
                return _seguro(v)
    return None


def request_id_of(obj: Any) -> Optional[str]:
    """La cabecera ``x-bvsala-request-id`` que acompaña a ``obj``, si se puede leer."""
    # with_raw_response (LegacyAPIResponse) y respuestas httpx: .headers
    rid = _de_cabeceras(getattr(obj, "headers", None), REQUEST_ID_HEADER)
    if rid:
        return rid
    # Stream y MessageStream de los SDK: .response es la respuesta HTTP
    respuesta = getattr(obj, "response", None)
    if respuesta is not None:
        rid = _de_cabeceras(getattr(respuesta, "headers", None), REQUEST_ID_HEADER)
        if rid:
            return rid
    # LiteLLM guarda las cabeceras del proveedor con prefijo llm_provider-
    ocultos = getattr(obj, "_hidden_params", None)
    if isinstance(ocultos, Mapping):
        return _de_cabeceras(ocultos.get("additional_headers"), _LITELLM_HEADER)
    return None


def response_id_of(obj: Any) -> Optional[str]:
    """El ``id`` de la respuesta del proveedor dentro de ``obj``, si lo lleva."""
    if isinstance(obj, Mapping):
        for anidado in ("message", "response"):
            sub = obj.get(anidado)
            if isinstance(sub, Mapping) and _seguro(sub.get("id")):
                return _seguro(sub.get("id"))
        return _seguro(obj.get("id"))
    # message_start de Anthropic: event.message.id; eventos de Responses: event.response.id
    for anidado in ("message", "response"):
        sub = getattr(obj, anidado, None)
        if sub is not None and not callable(sub):
            rid = _seguro(getattr(sub, "id", None))
            if rid:
                return rid
    return _seguro(getattr(obj, "id", None))
