"""`python -m bvsala`: lo que imprime y sus códigos de salida."""

from __future__ import annotations

import json

from bvsala.__main__ import main

from conftest import informe_medido

RID = "11111111-2222-4333-8444-555555555555"


def test_status(fake_gateway, capsys):
    assert main(["--url", fake_gateway.url, "status"]) == 0
    out = capsys.readouterr().out
    assert "bvsala gateway 0.4.26-test" in out
    assert "upstream: https://api.openai.com" in out
    assert "license:  active (pro, expires 2026-10-27)" in out
    assert "metering: on" in out


def test_status_con_licencia_caducada_sale_con_2(fake_gateway, capsys):
    fake_gateway.license_state = "expired"
    assert main(["--url", fake_gateway.url, "status"]) == 2
    assert "license expired" in capsys.readouterr().err


def test_sin_gateway_sale_con_3(capsys):
    assert main(["--url", "http://127.0.0.1:9", "status"]) == 3
    assert "no bvsala gateway answered" in capsys.readouterr().err


def test_report_imprime_el_json(fake_gateway, capsys):
    fake_gateway.add_report(informe_medido(RID, "chatcmpl-abc"))
    assert main(["--url", fake_gateway.url, "report", "chatcmpl-abc"]) == 0
    d = json.loads(capsys.readouterr().out)
    assert d["requestId"] == RID
    assert d["status"] == "metered"
    assert d["report"]["cost"]["basis"] == "measured"


def test_report_desconocido_sale_con_4(fake_gateway, capsys):
    assert main(["--url", fake_gateway.url, "report", RID]) == 4
    assert "no report" in capsys.readouterr().err


# ── Auditoría de lo gratis (21-11-2026) ─────────────────────────────────────
# El gateway arranca sin ninguna clave (modo COMMUNITY): el cliente no puede decir
# que la necesita. Hasta la 1.2.4 decía «…and needs BIVELIO_SERVICE_KEY» al no
# encontrar el gateway, y `status` «metering: off (no BIVELIO_SERVICE_KEY)».

def test_sin_gateway_dice_que_no_hace_falta_clave(capsys):
    assert main(["--url", "http://127.0.0.1:9", "status"]) == 3
    err = capsys.readouterr().err
    assert "needs no key" in err
    assert "COMMUNITY mode" in err
    assert "needs BIVELIO_SERVICE_KEY" not in err


def test_status_sin_medicion_no_pide_una_clave(fake_gateway, capsys):
    fake_gateway.status_body = {
        "schema": "bvsala.gateway.status/1", "gateway": "bvsala", "version": "1.2.4-test",
        "upstream": fake_gateway.upstream,
        "license": {"state": "active", "plan": "community"},
        "metering": False,
        "reports": {"requestHeader": "x-bvsala-report", "responseHeader": "x-bvsala-request-id", "capacity": 1000},
    }
    assert main(["--url", fake_gateway.url, "status"]) == 0
    out = capsys.readouterr().out
    assert "metering: off" in out
    assert "BIVELIO_SERVICE_KEY" not in out


def test_ningun_mensaje_del_cliente_pide_una_clave_para_el_gateway():
    import pathlib

    import bvsala

    raiz = pathlib.Path(bvsala.__file__).parent
    for py in sorted(raiz.glob("*.py")):
        texto = py.read_text(encoding="utf-8")
        assert "needs BIVELIO_SERVICE_KEY" not in texto, py.name
        assert "no BIVELIO_SERVICE_KEY" not in texto, py.name
