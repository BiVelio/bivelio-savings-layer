"""Envolver los SDK oficiales: la copia va por el gateway, pide su informe y
jamás cae al proveedor directo.

Las pruebas con los SDK de verdad se saltan si no están instalados; la CI los
instala con versiones fijadas y hashes (requirements-ci.txt).
"""

from __future__ import annotations

from typing import Any, Dict, List

import pytest

import bvsala
from bvsala import Gateway, GatewayMismatch, GatewayUnavailable, LicenseInactive


class _Base:
    """Un cliente con la forma de los SDK (base_url + with_options), sin red."""

    def __init__(self, base_url: str) -> None:
        self.base_url = base_url
        self.llamadas: List[Dict[str, Any]] = []

    def with_options(self, **kw: Any) -> "_Base":
        self.llamadas.append(kw)
        copia = type(self)(kw.get("base_url", self.base_url))
        copia.cabeceras = kw.get("default_headers")
        return copia


class OpenAI(_Base):
    pass


OpenAI.__module__ = "openai._client"


class Anthropic(_Base):
    pass


Anthropic.__module__ = "anthropic"


def test_solo_clientes_de_los_sdk_oficiales(fake_gateway):
    class Otro:
        base_url = "https://api.openai.com/v1/"

        def with_options(self, **kw: Any) -> Any:
            return self

    with pytest.raises(TypeError):
        Gateway(fake_gateway.url).wrap(Otro())
    # Se rechaza antes de hablar con nadie.
    assert fake_gateway.received == []


def test_openai_conserva_la_ruta_y_pide_informe(fake_gateway):
    original = OpenAI("https://api.openai.com/v1/")
    copia = Gateway(fake_gateway.url).wrap(original)
    assert copia.base_url == f"{fake_gateway.url}/v1/"
    assert copia.cabeceras == {"x-bvsala-report": "1"}
    assert original.base_url == "https://api.openai.com/v1/"


def test_anthropic_sin_ruta(fake_gateway):
    fake_gateway.upstream = "https://api.anthropic.com"
    copia = Gateway(fake_gateway.url).wrap(Anthropic("https://api.anthropic.com"))
    assert copia.base_url == fake_gateway.url


def test_puertos_por_defecto_y_mayusculas_no_cuentan(fake_gateway):
    fake_gateway.upstream = "https://api.openai.com"
    copia = Gateway(fake_gateway.url).wrap(OpenAI("HTTPS://API.OPENAI.COM:443/v1/"))
    assert copia.base_url == f"{fake_gateway.url}/v1/"


def test_otro_proveedor_que_el_del_gateway_se_niega(fake_gateway):
    fake_gateway.upstream = "https://api.anthropic.com"
    original = OpenAI("https://api.openai.com/v1/")
    with pytest.raises(GatewayMismatch) as e:
        Gateway(fake_gateway.url).wrap(original)
    assert "https://api.openai.com" in str(e.value)
    assert "--upstream" in str(e.value)
    assert original.llamadas == []


def test_un_cliente_que_ya_apunta_al_gateway_solo_pide_informe(fake_gateway):
    fake_gateway.upstream = "https://otra-cosa.example"
    copia = Gateway(fake_gateway.url).wrap(OpenAI(f"{fake_gateway.url}/v1/"))
    assert copia.base_url == f"{fake_gateway.url}/v1/"
    assert copia.cabeceras == {"x-bvsala-report": "1"}


def test_localhost_y_127_0_0_1_son_el_mismo_gateway(fake_gateway):
    fake_gateway.upstream = "https://otra-cosa.example"
    puerto = fake_gateway.url.rsplit(":", 1)[1]
    copia = Gateway(fake_gateway.url).wrap(OpenAI(f"http://localhost:{puerto}/v1/"))
    assert copia.base_url == f"http://localhost:{puerto}/v1/"
    assert copia.cabeceras == {"x-bvsala-report": "1"}


def test_falla_cerrado_sin_licencia(fake_gateway):
    fake_gateway.license_state = "expired"
    original = OpenAI("https://api.openai.com/v1/")
    with pytest.raises(LicenseInactive):
        Gateway(fake_gateway.url).wrap(original)
    assert original.llamadas == []


def test_falla_cerrado_sin_gateway():
    original = OpenAI("https://api.openai.com/v1/")
    with pytest.raises(GatewayUnavailable):
        Gateway("http://127.0.0.1:9").wrap(original)
    assert original.llamadas == []


# ── Con los SDK de verdad ────────────────────────────────────────────────────


def test_sdk_openai_de_verdad(fake_gateway):
    openai = pytest.importorskip("openai")
    original = openai.OpenAI(api_key="test-openai-key", max_retries=0)
    gw = Gateway(fake_gateway.url)
    client = gw.wrap(original)
    assert str(original.base_url) == "https://api.openai.com/v1/"

    resp = client.chat.completions.create(model="gpt-4o-mini", messages=[{"role": "user", "content": "Hi"}])
    r = fake_gateway.received[-1]
    assert r["path"] == "/v1/chat/completions"
    assert r["headers"]["x-bvsala-report"] == "1"
    # La credencial del cliente viaja al gateway, que la reenvía; el paquete no la toca.
    assert r["headers"]["authorization"] == "Bearer test-openai-key"
    informe = gw.report(resp)
    assert informe.metered and informe.response_id == resp.id

    stream = client.chat.completions.create(
        model="gpt-4o-mini", messages=[{"role": "user", "content": "Hi"}], stream=True,
        stream_options={"include_usage": True},
    )
    trozos = list(stream)
    assert trozos[-1].usage is not None
    por_stream = gw.report(stream)  # por la cabecera, en stream.response
    assert por_stream.request_id == stream.response.headers["x-bvsala-request-id"]
    assert gw.report(trozos[0]).request_id == por_stream.request_id  # y por el id de cualquier chunk


def test_sdk_openai_async(fake_gateway):
    openai = pytest.importorskip("openai")
    import asyncio

    gw = Gateway(fake_gateway.url)
    client = gw.wrap(openai.AsyncOpenAI(api_key="test-openai-key", max_retries=0))

    async def una() -> Any:
        resp = await client.chat.completions.create(model="gpt-4o-mini", messages=[{"role": "user", "content": "Hi"}])
        return await gw.areport(resp)

    assert asyncio.run(una()).metered


def test_sdk_anthropic_de_verdad(fake_gateway):
    anthropic = pytest.importorskip("anthropic")
    fake_gateway.upstream = "https://api.anthropic.com"
    gw = Gateway(fake_gateway.url)
    client = gw.wrap(anthropic.Anthropic(api_key="test-anthropic-key", max_retries=0))

    msg = client.messages.create(model="claude-haiku-4-5", max_tokens=16, messages=[{"role": "user", "content": "Hi"}])
    r = fake_gateway.received[-1]
    assert r["path"] == "/v1/messages"
    assert r["headers"]["x-bvsala-report"] == "1"
    assert r["headers"]["x-api-key"] == "test-anthropic-key"
    assert gw.report(msg).response_id == msg.id

    with client.messages.stream(model="claude-haiku-4-5", max_tokens=16, messages=[{"role": "user", "content": "Hi"}]) as s:
        final = s.get_final_message()
        por_stream = gw.report(s)
    assert por_stream.response_id == final.id


def test_exporta_lo_que_documenta():
    for nombre in ("Gateway", "Report", "LicenseInactive", "GatewayUnavailable", "GatewayMismatch", "ReportNotFound", "REPORT_HEADERS"):
        assert hasattr(bvsala, nombre)
    assert bvsala.REPORT_HEADERS == {"x-bvsala-report": "1"}
