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
