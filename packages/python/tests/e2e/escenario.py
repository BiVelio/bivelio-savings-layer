"""Escenario de extremo a extremo contra el gateway DE VERDAD.

No es una prueba de pytest (no empieza por test_): lo lanza
test/python-cliente.test.ts, que arranca el gateway de TypeScript con una
licencia de prueba, delante de upstreams e ingesta falsos en 127.0.0.1, y
compara lo que este script recibe con lo que recibe la ingesta (el panel).

Entrada: un JSON en argv[1] con las URL. Salida: un JSON por línea en stdout.
Solo biblioteca estándar, más los SDK oficiales si están instalados (si no, lo
dice en la salida y la prueba decide).
"""

from __future__ import annotations

import json
import os
import sys
import urllib.request

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "src"))

import bvsala  # noqa: E402


def salida(**kw: object) -> None:
    print(json.dumps(kw), flush=True)


def informe(r: bvsala.Report) -> dict:
    return {"requestId": r.request_id, "responseId": r.response_id, "status": r.status, "reason": r.reason,
            "report": r.raw_report}


def main() -> None:
    cfg = json.loads(sys.argv[1])
    sin_proxy = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    # 1 · Solo la biblioteca estándar: cualquier cliente HTTP vale.
    gw = bvsala.Gateway(cfg["openai"])
    st = gw.status()
    salida(paso="status", version=st.version, upstream=st.upstream, license=st.license_state, metering=st.metering)
    peticion = urllib.request.Request(
        cfg["openai"] + "/v1/chat/completions",
        data=json.dumps({"model": "gpt-4o-mini", "messages": [{"role": "user", "content": "Hi"}]}).encode(),
        headers={"content-type": "application/json", "authorization": "Bearer test-openai-key", **bvsala.REPORT_HEADERS},
        method="POST",
    )
    with sin_proxy.open(peticion, timeout=10) as r:
        cuerpo = json.loads(r.read())
        rid = r.headers.get(bvsala.REQUEST_ID_HEADER)
    por_id = gw.report(rid)
    por_respuesta = gw.report(cuerpo["id"])
    salida(paso="stdlib", cabecera=rid, mismo=por_id == por_respuesta, **informe(por_id))

    # 2 · El SDK oficial de OpenAI, envuelto.
    try:
        import openai
    except ImportError:
        salida(paso="openai", ausente=True)
    else:
        client = gw.wrap(openai.OpenAI(api_key="test-openai-key", base_url=cfg["openaiUpstream"] + "/v1", max_retries=0))
        resp = client.chat.completions.create(model="gpt-4o-mini", messages=[{"role": "user", "content": "Hi"}])
        salida(paso="openai", **informe(gw.report(resp)))
        stream = client.chat.completions.create(
            model="gpt-4o-mini", messages=[{"role": "user", "content": "Hi"}], stream=True,
            stream_options={"include_usage": True},
        )
        for _ in stream:
            pass
        salida(paso="openai-stream", **informe(gw.report(stream)))
        sin_uso = client.chat.completions.create(model="gpt-4o-mini", messages=[{"role": "user", "content": "Hi"}], stream=True)
        for _ in sin_uso:
            pass
        salida(paso="openai-stream-sin-uso", **informe(gw.report(sin_uso)))
        try:
            bvsala.Gateway(cfg["anthropic"]).wrap(openai.OpenAI(api_key="test-openai-key", base_url=cfg["openaiUpstream"] + "/v1"))
            salida(paso="mismatch", lanzo=False)
        except bvsala.GatewayMismatch as e:
            salida(paso="mismatch", lanzo=True, mensaje=str(e))

    # 3 · El SDK oficial de Anthropic, envuelto.
    try:
        import anthropic
    except ImportError:
        salida(paso="anthropic", ausente=True)
    else:
        ga = bvsala.Gateway(cfg["anthropic"])
        client = ga.wrap(anthropic.Anthropic(api_key="test-anthropic-key", base_url=cfg["anthropicUpstream"], max_retries=0))
        msg = client.messages.create(model="claude-haiku-4-5", max_tokens=16, messages=[{"role": "user", "content": "Hi"}])
        salida(paso="anthropic", **informe(ga.report(msg)))
        with client.messages.stream(model="claude-haiku-4-5", max_tokens=16, messages=[{"role": "user", "content": "Hi"}]) as s:
            s.get_final_message()
            salida(paso="anthropic-stream", **informe(ga.report(s)))
        t = ga.totals()
        salida(paso="totales", requests=t.requests, metered=t.metered, actual=t.actual_cost_usd,
               porBase=dict(t.net_savings_usd_by_basis))


if __name__ == "__main__":
    main()
