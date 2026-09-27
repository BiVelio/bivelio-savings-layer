"""Estado y licencia: sin gateway vivo y con licencia, el cliente no opera."""

from __future__ import annotations

import socket

import pytest

import bvsala
from bvsala import Gateway, GatewayUnavailable, LicenseInactive


def test_status_lee_version_upstream_y_licencia(fake_gateway):
    st = Gateway(fake_gateway.url).status()
    assert st.version == "0.4.26-test"
    assert st.upstream == "https://api.openai.com"
    assert st.license_state == "active"
    assert st.license_plan == "pro"
    assert st.license_expires_at == "2026-10-27"
    assert st.metering is True
    assert st.serving is True


def test_402_es_licencia_inactiva_con_su_estado(fake_gateway):
    fake_gateway.license_state = "expired"
    with pytest.raises(LicenseInactive) as e:
        Gateway(fake_gateway.url).status()
    assert e.value.state == "expired"
    assert "license expired" in str(e.value)


def test_require_ready_falla_cerrado_si_la_licencia_no_sirve(fake_gateway):
    fake_gateway.status_body = {
        "schema": "bvsala.gateway.status/1", "version": "x", "upstream": "https://api.openai.com",
        "license": {"state": "revoked"}, "metering": True,
    }
    gw = Gateway(fake_gateway.url)
    assert gw.status().serving is False
    with pytest.raises(LicenseInactive) as e:
        gw.require_ready()
    assert e.value.state == "revoked"


def test_sin_gateway_no_hay_camino_alternativo():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    puerto = s.getsockname()[1]
    s.close()  # un puerto libre: nadie escucha
    with pytest.raises(GatewayUnavailable) as e:
        Gateway(f"http://127.0.0.1:{puerto}").status()
    assert "bvsala gateway" in str(e.value)
    assert "--upstream openai" in str(e.value)


@pytest.mark.parametrize("cuerpo, codigo", [({"error": "not found"}, 404), ({"hola": 1}, 200), ({"schema": "otro/9"}, 200)])
def test_un_gateway_viejo_o_ajeno_se_dice(fake_gateway, cuerpo, codigo):
    fake_gateway.status_body = cuerpo
    fake_gateway.status_code = codigo
    with pytest.raises(GatewayUnavailable) as e:
        Gateway(fake_gateway.url).status()
    assert fake_gateway.url in str(e.value)


def test_los_proxies_del_entorno_no_se_usan(fake_gateway, monkeypatch):
    # Un proxy que no existe: si el cliente lo usara, fallaría.
    monkeypatch.setenv("HTTP_PROXY", "http://127.0.0.1:9")
    monkeypatch.setenv("http_proxy", "http://127.0.0.1:9")
    monkeypatch.delenv("NO_PROXY", raising=False)
    monkeypatch.delenv("no_proxy", raising=False)
    assert Gateway(fake_gateway.url).status().serving


def test_url_se_queda_en_el_origen_y_admite_el_entorno(monkeypatch):
    assert Gateway("http://127.0.0.1:8403/v1/").url == "http://127.0.0.1:8403"
    assert Gateway("HTTP://LocalHost:80").url == "http://localhost"
    monkeypatch.setenv(bvsala.ENV_URL, "http://127.0.0.1:9999")
    assert Gateway().url == "http://127.0.0.1:9999"
    monkeypatch.delenv(bvsala.ENV_URL)
    assert Gateway().url == bvsala.DEFAULT_URL
    with pytest.raises(ValueError):
        Gateway("ftp://127.0.0.1")
