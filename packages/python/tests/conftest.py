"""Un gateway FALSO en 127.0.0.1 y una verja que prohíbe la red.

Las pruebas no salen del equipo: `sin_red` (autouse) hace fallar cualquier
conexión a algo que no sea loopback. Si un envoltorio estuviera mal y el SDK
intentara ir al proveedor de verdad, la prueba revienta en vez de mandar nada.

El gateway falso imita las rutas que usa el cliente (`/_bvsala/v1/status`,
`/_bvsala/v1/reports…`) y dos rutas de proveedor (`/v1/chat/completions`,
`/v1/messages`) con la cabecera `x-bvsala-request-id` cuando se pide informe.
El gateway de verdad se prueba contra este mismo cliente en
test/python-cliente.test.ts (lado TypeScript).
"""

from __future__ import annotations

import json
import socket
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, List, Optional
from urllib.parse import parse_qs, urlsplit

import pytest

_LOOPBACK = {"127.0.0.1", "::1", "localhost"}


@pytest.fixture(autouse=True)
def sin_red(monkeypatch: pytest.MonkeyPatch) -> None:
    original_connect = socket.socket.connect
    original_getaddrinfo = socket.getaddrinfo

    def connect(self: socket.socket, address: Any) -> Any:
        host = address[0] if isinstance(address, tuple) else address
        if isinstance(host, str) and host not in _LOOPBACK and not host.startswith("/"):
            raise AssertionError(f"network access attempted in a test: {address!r}")
        return original_connect(self, address)

    def getaddrinfo(host: Any, *args: Any, **kwargs: Any) -> Any:
        if isinstance(host, bytes):
            host = host.decode()
        if host is not None and host not in _LOOPBACK:
            raise AssertionError(f"DNS lookup attempted in a test: {host!r}")
        return original_getaddrinfo(host, *args, **kwargs)

    monkeypatch.setattr(socket.socket, "connect", connect)
    monkeypatch.setattr(socket, "getaddrinfo", getaddrinfo)


def informe_medido(request_id: str, response_id: Optional[str], *, basis: str = "measured", actual: float = 0.000024,
                   net: float = 0.0, avoided: int = 0, path: str = "/v1/chat/completions") -> Dict[str, Any]:
    return {
        "schema": "bvsala.gateway.report/1",
        "requestId": request_id,
        "responseId": response_id,
        "path": path,
        "status": "metered",
        "reason": None,
        "report": {
            "requestId": request_id,
            "model": "gpt-4o-mini",
            "calls": {"baselineLlm": 1, "actualLlm": 1 - avoided, "avoidedLlm": avoided},
            "tokens": {
                "baselineInput": 100, "actualInput": 100, "eliminatedInput": 0, "compressedInput": 0,
                "baselineOutput": 20, "actualOutput": 20, "eliminatedOutput": 0, "providerCachedInput": 40,
            },
            "cost": {"baselineEstimate": actual + net, "actual": actual, "netSavings": net, "basis": basis},
        },
    }


class FakeGateway:
    def __init__(self) -> None:
        self.upstream = "https://api.openai.com"
        self.license_state = "active"
        self.status_code = 200
        #: None = el estado de verdad; un dict = ese cuerpo tal cual (para gateways viejos o raros).
        self.status_body: Optional[Dict[str, Any]] = None
        self.reports: Dict[str, Dict[str, Any]] = {}
        self.by_response: Dict[str, str] = {}
        self.received: List[Dict[str, Any]] = []
        self.report_queries: List[str] = []
        self._server = ThreadingHTTPServer(("127.0.0.1", 0), self._handler())
        self._thread = threading.Thread(target=self._server.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True)
        self._thread.start()

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self._server.server_address[1]}"

    def close(self) -> None:
        self._server.shutdown()
        self._server.server_close()

    def add_report(self, body: Dict[str, Any]) -> None:
        self.reports[body["requestId"]] = body
        if body.get("responseId"):
            self.by_response[body["responseId"]] = body["requestId"]

    def _handler(self) -> type:
        fake = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *args: Any) -> None:  # silencio
                pass

            def _send(self, code: int, body: Any, headers: Optional[Dict[str, str]] = None, ctype: str = "application/json") -> None:
                data = body if isinstance(body, bytes) else json.dumps(body).encode()
                self.send_response(code)
                self.send_header("content-type", ctype)
                self.send_header("content-length", str(len(data)))
                for k, v in (headers or {}).items():
                    self.send_header(k, v)
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self) -> None:
                u = urlsplit(self.path)
                if fake.license_state not in ("active", "grace") and u.path.startswith("/_bvsala/"):
                    self._send(402, {"type": "error", "error": {"type": "license_error", "status": fake.license_state,
                                                               "message": f"license {fake.license_state} (fake)"}},
                               {"x-bvsala-license-status": fake.license_state})
                    return
                if u.path == "/_bvsala/v1/status":
                    body = fake.status_body if fake.status_body is not None else {
                        "schema": "bvsala.gateway.status/1", "gateway": "bvsala", "version": "0.4.26-test",
                        "upstream": fake.upstream,
                        "license": {"state": fake.license_state, "plan": "pro", "expiresAt": "2026-10-27"},
                        "metering": True,
                        "reports": {"requestHeader": "x-bvsala-report", "responseHeader": "x-bvsala-request-id", "capacity": 1000},
                    }
                    self._send(fake.status_code, body)
                    return
                if u.path.startswith("/_bvsala/v1/reports"):
                    fake.report_queries.append(self.path)
                    q = parse_qs(u.query)
                    if u.path == "/_bvsala/v1/reports":
                        rid = fake.by_response.get(q.get("response_id", [""])[0])
                    else:
                        rid = u.path.rsplit("/", 1)[1]
                    body = fake.reports.get(rid or "")
                    if body is None:
                        self._send(404, {"type": "error", "error": {"type": "not_found", "message": "no report (fake)"}})
                    else:
                        self._send(200, body)
                    return
                self._send(404, {"error": "not found"})

            def do_POST(self) -> None:
                largo = int(self.headers.get("content-length") or 0)
                cuerpo = json.loads(self.rfile.read(largo) or b"{}")
                cabeceras = {k.lower(): v for k, v in self.headers.items()}
                fake.received.append({"path": self.path, "headers": cabeceras, "body": cuerpo})
                pide = cabeceras.get("x-bvsala-report") == "1"
                rid = str(uuid.uuid4())
                extra = {"x-bvsala-request-id": rid} if pide else {}
                if self.path == "/v1/chat/completions":
                    resp_id = f"chatcmpl-{rid[:8]}"
                    if pide:
                        fake.add_report(informe_medido(rid, resp_id))
                    if cuerpo.get("stream"):
                        trozos = [
                            {"id": resp_id, "object": "chat.completion.chunk", "created": 0, "model": "gpt-4o-mini",
                             "choices": [{"index": 0, "delta": {"content": "Hi"}, "finish_reason": None}]},
                            {"id": resp_id, "object": "chat.completion.chunk", "created": 0, "model": "gpt-4o-mini",
                             "choices": [], "usage": {"prompt_tokens": 100, "completion_tokens": 20, "total_tokens": 120}},
                        ]
                        sse = "".join(f"data: {json.dumps(t)}\n\n" for t in trozos) + "data: [DONE]\n\n"
                        self._send(200, sse.encode(), extra, "text/event-stream")
                        return
                    self._send(200, {
                        "id": resp_id, "object": "chat.completion", "created": 0, "model": "gpt-4o-mini",
                        "choices": [{"index": 0, "message": {"role": "assistant", "content": "Hi"}, "finish_reason": "stop"}],
                        "usage": {"prompt_tokens": 100, "completion_tokens": 20, "total_tokens": 120},
                    }, extra)
                    return
                if self.path == "/v1/messages":
                    resp_id = f"msg_{rid[:8]}"
                    if pide:
                        fake.add_report(informe_medido(rid, resp_id, path="/v1/messages"))
                    mensaje = {"id": resp_id, "type": "message", "role": "assistant", "model": "claude-haiku-4-5",
                               "content": [{"type": "text", "text": "Hi"}], "stop_reason": "end_turn", "stop_sequence": None,
                               "usage": {"input_tokens": 100, "output_tokens": 20}}
                    if cuerpo.get("stream"):
                        inicio = dict(mensaje, content=[], stop_reason=None, usage={"input_tokens": 100, "output_tokens": 1})
                        eventos = [
                            ("message_start", {"type": "message_start", "message": inicio}),
                            ("content_block_start", {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}),
                            ("content_block_delta", {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "Hi"}}),
                            ("content_block_stop", {"type": "content_block_stop", "index": 0}),
                            ("message_delta", {"type": "message_delta", "delta": {"stop_reason": "end_turn", "stop_sequence": None},
                                               "usage": {"output_tokens": 20}}),
                            ("message_stop", {"type": "message_stop"}),
                        ]
                        sse = "".join(f"event: {e}\ndata: {json.dumps(d)}\n\n" for e, d in eventos)
                        self._send(200, sse.encode(), extra, "text/event-stream")
                        return
                    self._send(200, mensaje, extra)
                    return
                self._send(404, {"error": "not found"})

        return H


@pytest.fixture
def fake_gateway() -> Any:
    g = FakeGateway()
    try:
        yield g
    finally:
        g.close()
