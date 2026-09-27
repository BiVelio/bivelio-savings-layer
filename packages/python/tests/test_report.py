"""Leer el informe: cualquier objeto que lleve una de las dos claves sirve."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from bvsala import BvsalaError, Gateway, ReportNotFound
from bvsala._keys import request_id_of, response_id_of
from bvsala._report import parse_report

from conftest import informe_medido

RID = "11111111-2222-4333-8444-555555555555"


@pytest.fixture
def gw(fake_gateway):
    fake_gateway.add_report(informe_medido(RID, "chatcmpl-abc"))
    return Gateway(fake_gateway.url)


def test_por_id_de_peticion_y_por_id_de_respuesta(gw, fake_gateway):
    a = gw.report(RID)
    b = gw.report("chatcmpl-abc")
    assert a == b
    assert a.metered
    assert a.request_id == RID
    assert a.response_id == "chatcmpl-abc"
    assert a.cost.basis == "measured"
    assert a.cost.actual == pytest.approx(0.000024)
    assert a.tokens.actual_input == 100
    assert a.tokens.provider_cached_input == 40
    assert a.calls.avoided_llm == 0
    assert a.raw_report["requestId"] == RID
    assert fake_gateway.report_queries[0] == f"/_bvsala/v1/reports/{RID}?wait_ms=5000"
    assert fake_gateway.report_queries[1] == "/_bvsala/v1/reports?response_id=chatcmpl-abc&wait_ms=5000"


@pytest.mark.parametrize(
    "obj",
    [
        SimpleNamespace(id="chatcmpl-abc"),  # ChatCompletion, Message, Response
        {"id": "chatcmpl-abc"},
        SimpleNamespace(type="message_start", message=SimpleNamespace(id="chatcmpl-abc")),  # evento de Anthropic
        SimpleNamespace(type="response.completed", response=SimpleNamespace(id="chatcmpl-abc")),  # evento de Responses
        {"type": "message_start", "message": {"id": "chatcmpl-abc"}},
        SimpleNamespace(response=SimpleNamespace(headers={"X-Bvsala-Request-Id": RID})),  # Stream de un SDK
        SimpleNamespace(headers={"x-bvsala-request-id": RID}),  # with_raw_response
        SimpleNamespace(id="chatcmpl-otro", _hidden_params={"additional_headers": {"llm_provider-x-bvsala-request-id": RID}}),  # LiteLLM
    ],
)
def test_cualquier_objeto_con_una_clave(gw, obj):
    assert gw.report(obj).request_id == RID


def test_la_cabecera_manda_sobre_el_id_de_respuesta():
    obj = SimpleNamespace(id="chatcmpl-x", response=SimpleNamespace(headers={"x-bvsala-request-id": RID}))
    assert request_id_of(obj) == RID
    assert response_id_of(SimpleNamespace(id="con espacios")) is None
    assert response_id_of(SimpleNamespace(response=SimpleNamespace(headers={}))) is None


def test_sin_clave_no_se_pregunta_nada(gw, fake_gateway):
    with pytest.raises(ReportNotFound):
        gw.report(SimpleNamespace(texto="sin id"))
    assert fake_gateway.report_queries == []


def test_un_uuid_que_no_es_de_peticion_se_prueba_como_id_de_respuesta(fake_gateway):
    gw = Gateway(fake_gateway.url)
    uuid_de_proveedor = "abcdefab-2222-4333-8444-555555555555"
    fake_gateway.add_report(informe_medido(RID, uuid_de_proveedor))
    assert gw.report(uuid_de_proveedor, wait=0).request_id == RID
    assert fake_gateway.report_queries[-1] == f"/_bvsala/v1/reports?response_id={uuid_de_proveedor}&wait_ms=0"


def test_desconocido_es_report_not_found(gw):
    with pytest.raises(ReportNotFound) as e:
        gw.report("99999999-2222-4333-8444-555555555555", wait=0)
    assert "no report" in str(e.value)


def test_la_espera_se_pasa_y_se_acota(gw, fake_gateway):
    gw.report(RID, wait=0.25)
    gw.report(RID, wait=500)
    assert fake_gateway.report_queries[-2].endswith("wait_ms=250")
    assert fake_gateway.report_queries[-1].endswith("wait_ms=30000")


def test_no_medido_y_pendiente(fake_gateway):
    gw = Gateway(fake_gateway.url)
    fake_gateway.add_report({
        "schema": "bvsala.gateway.report/1", "requestId": "aaaaaaaa-2222-4333-8444-555555555555", "responseId": None,
        "path": "/v1/chat/completions", "status": "not_metered",
        "reason": "the request did not ask for usage (stream_options.include_usage)", "report": None,
    })
    fake_gateway.add_report({
        "schema": "bvsala.gateway.report/1", "requestId": "bbbbbbbb-2222-4333-8444-555555555555", "responseId": None,
        "path": "/v1/messages", "status": "pending", "reason": None, "report": None,
    })
    nm = gw.report("aaaaaaaa-2222-4333-8444-555555555555")
    assert not nm.metered
    assert nm.cost is None
    assert "include_usage" in nm.summary()
    pe = gw.report("bbbbbbbb-2222-4333-8444-555555555555", wait=0)
    assert pe.status == "pending"
    # Lo pendiente no entra en los totales; lo no medido sí cuenta como petición.
    t = gw.totals()
    assert (t.requests, t.metered, t.not_metered) == (1, 0, 1)


def test_totales_por_base_sin_mezclar(fake_gateway):
    gw = Gateway(fake_gateway.url)
    ids = [f"{i}{i}{i}{i}{i}{i}{i}{i}-2222-4333-8444-555555555555" for i in range(1, 5)]
    fake_gateway.add_report(informe_medido(ids[0], None, actual=0.01, net=0.0))
    fake_gateway.add_report(informe_medido(ids[1], None, actual=0.02, net=0.005, basis="measured"))
    fake_gateway.add_report(informe_medido(ids[2], None, actual=0.0, net=0.01, basis="reference", avoided=1))
    fake_gateway.add_report(informe_medido(ids[3], None, actual=0.0, net=0.02, basis="estimated", avoided=1))
    for i in ids + ids:  # repetir no duplica
        gw.report(i)
    t = gw.totals()
    assert t.requests == 4
    assert t.metered == 4
    assert t.actual_cost_usd == pytest.approx(0.03)
    assert dict(t.net_savings_usd_by_basis) == pytest.approx({"measured": 0.005, "reference": 0.01, "estimated": 0.02})
    assert "call avoided" in gw.report(ids[2]).summary()


def test_areport(gw):
    assert asyncio.run(gw.areport(RID)).request_id == RID


def test_402_al_pedir_el_informe(gw, fake_gateway):
    fake_gateway.license_state = "revoked"
    with pytest.raises(BvsalaError) as e:
        gw.report(RID)
    assert type(e.value).__name__ == "LicenseInactive"


def test_parse_report_rechaza_otro_esquema():
    with pytest.raises(ValueError):
        parse_report({"schema": "bvsala.gateway.report/2"})
    # Cifras con tipos raros no se cuelan como números.
    r = parse_report({
        "schema": "bvsala.gateway.report/1", "requestId": RID, "responseId": 7, "path": "/v1/messages", "status": "metered",
        "reason": None, "report": {"model": "m", "cost": {"actual": True, "netSavings": "3"}, "tokens": {}, "calls": {}},
    })
    assert r.response_id is None
    assert r.cost.actual == 0.0
    assert r.cost.net_savings == 0.0
    assert r.cost.eliminated_input_floor_cost is None
