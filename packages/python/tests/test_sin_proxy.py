"""Lo que va al gateway no pasa por HTTP_PROXY (E2E 1.2.4, «major»).

El cliente HTTP por defecto de los SDK de OpenAI y Anthropic lee HTTP_PROXY /
HTTPS_PROXY / ALL_PROXY del entorno. Hasta la 1.2.4, la copia de `wrap()`
heredaba ese cliente: el tráfico al gateway local (127.0.0.1) —con la clave del
proveedor y el prompt— viajaba EN CLARO por el proxy, y detrás de un proxy
corporativo la llamada daba 502. El README decía que el cliente ignora los
proxies; solo era verdad para las llamadas propias de bvsala (urllib).

Aquí un proxy ESPÍA en 127.0.0.1 apunta cada petición que le llega (solo la
línea de petición, nunca cabeceras ni cuerpo) y contesta 502. Cada prueba
comprueba primero que el espía SÍ ve el tráfico de un cliente sin envolver (si
no, un «cero peticiones» no probaría nada) y después que la copia de `wrap()`
no le manda ninguna, en OpenAI y Anthropic, síncronos y asíncronos.

Si el usuario trae su propio `http_client=`, `wrap()` lo respeta tal cual; la
guía le dice NO_PROXY=127.0.0.1,localhost, y eso también se comprueba.
"""

from __future__ import annotations

import asyncio
import socketserver
import threading
from typing import Any, List

import pytest

from bvsala import Gateway

KEY_OPENAI = "test-openai-key"
KEY_ANTHROPIC = "test-anthropic-key"

#: (módulo del SDK, clase del cliente, ¿asíncrono?, su cliente HTTP por defecto público)
CLIENTES = [
    ("openai", "OpenAI", False, "DefaultHttpxClient"),
    ("openai", "AsyncOpenAI", True, "DefaultAsyncHttpxClient"),
    ("anthropic", "Anthropic", False, "DefaultHttpxClient"),
    ("anthropic", "AsyncAnthropic", True, "DefaultAsyncHttpxClient"),
]
IDS = [c[1] for c in CLIENTES]


class ProxyEspia:
    """Un «proxy HTTP» que apunta la línea de cada petición y contesta 502."""

    def __init__(self) -> None:
        self.vistas: List[str] = []
        espia = self

        class H(socketserver.StreamRequestHandler):
            def handle(self) -> None:
                linea = self.rfile.readline().decode("latin-1").strip()
                largo = 0
                while True:
                    l = self.rfile.readline().decode("latin-1")
                    if l in ("\r\n", "\n", ""):
                        break
                    nombre, _, valor = l.partition(":")
                    if nombre.strip().lower() == "content-length":
                        largo = int(valor.strip() or 0)
                if largo:
                    self.rfile.read(largo)
                espia.vistas.append(linea)
                self.wfile.write(b"HTTP/1.1 502 Bad Gateway\r\ncontent-length: 0\r\nconnection: close\r\n\r\n")

        socketserver.ThreadingTCPServer.daemon_threads = True
        self._server = socketserver.ThreadingTCPServer(("127.0.0.1", 0), H)
        self._hilo = threading.Thread(target=self._server.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True)
        self._hilo.start()

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self._server.server_address[1]}"

    def close(self) -> None:
        self._server.shutdown()
        self._server.server_close()


@pytest.fixture
def proxy_espia(monkeypatch: pytest.MonkeyPatch) -> Any:
    """El espía, y el entorno de quien está detrás de un proxy corporativo."""
    p = ProxyEspia()
    for var in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"):
        monkeypatch.setenv(var, p.url)
        monkeypatch.setenv(var.lower(), p.url)
    monkeypatch.delenv("NO_PROXY", raising=False)
    monkeypatch.delenv("no_proxy", raising=False)
    try:
        yield p
    finally:
        p.close()


def _clase(modulo: str, clase: str) -> Any:
    sdk = pytest.importorskip(modulo)
    return sdk, getattr(sdk, clase)


def _clave(modulo: str) -> str:
    return KEY_OPENAI if modulo == "openai" else KEY_ANTHROPIC


def _llamar(modulo: str, client: Any, asincrono: bool) -> Any:
    """Una llamada de verdad con el SDK; al acabar cierra el cliente."""

    def crear() -> Any:
        if modulo == "openai":
            return client.chat.completions.create(model="gpt-4o-mini", messages=[{"role": "user", "content": "Hi"}])
        return client.messages.create(model="claude-haiku-4-5", max_tokens=16, messages=[{"role": "user", "content": "Hi"}])

    if not asincrono:
        try:
            return crear()
        finally:
            client.close()

    async def una() -> Any:
        try:
            return await crear()
        finally:
            await client.close()

    return asyncio.run(una())


def _preparar(fake_gateway: Any, modulo: str) -> None:
    if modulo == "anthropic":
        fake_gateway.upstream = "https://api.anthropic.com"


@pytest.mark.parametrize("modulo, clase, asincrono, _http", CLIENTES, ids=IDS)
def test_lo_envuelto_no_pasa_por_el_proxy(fake_gateway, proxy_espia, modulo, clase, asincrono, _http):
    sdk, Cliente = _clase(modulo, clase)
    _preparar(fake_gateway, modulo)
    ruta = "/v1/chat/completions" if modulo == "openai" else "/v1/messages"

    # Control: el mismo SDK, sin envolver y apuntando al gateway, SÍ va por el
    # proxy. Sin esto, el «cero» de abajo podría ser un espía que no espía.
    base = f"{fake_gateway.url}/v1" if modulo == "openai" else fake_gateway.url
    sin_envolver = Cliente(api_key=_clave(modulo), base_url=base, max_retries=0)
    with pytest.raises(sdk.APIStatusError):
        _llamar(modulo, sin_envolver, asincrono)
    assert proxy_espia.vistas == [f"POST {fake_gateway.url}{ruta} HTTP/1.1"]
    assert fake_gateway.received == []
    proxy_espia.vistas.clear()

    # La copia de wrap(): directa al gateway, el proxy no ve nada.
    gw = Gateway(fake_gateway.url)
    resp = _llamar(modulo, gw.wrap(Cliente(api_key=_clave(modulo), max_retries=0)), asincrono)
    assert proxy_espia.vistas == []
    assert [r["path"] for r in fake_gateway.received] == [ruta]
    assert fake_gateway.received[0]["headers"]["x-bvsala-report"] == "1"
    assert gw.report(resp).metered


@pytest.mark.parametrize("modulo, clase, asincrono, _http", CLIENTES, ids=IDS)
def test_la_copia_lleva_el_cliente_por_defecto_del_sdk_sin_proxy(fake_gateway, modulo, clase, asincrono, _http):
    _sdk, Cliente = _clase(modulo, clase)
    _preparar(fake_gateway, modulo)
    original = Cliente(api_key=_clave(modulo), max_retries=0, timeout=12.5)
    copia = Gateway(fake_gateway.url).wrap(original)
    nuevo, suyo = copia._client, original._client
    # Un cliente NUEVO del mismo tipo que el que el SDK crea por defecto: los
    # mismos límites, redirecciones y keepalive, y el timeout del cliente.
    assert nuevo is not suyo
    assert type(nuevo) is type(suyo)
    assert nuevo.timeout == suyo.timeout
    assert nuevo.follow_redirects == suyo.follow_redirects
    assert copia.timeout == original.timeout == 12.5
    # Sin proxies del entorno; el original, intacto.
    assert nuevo.trust_env is False
    assert suyo.trust_env is True
    # Cerrar la copia no cierra el original (antes compartían el cliente HTTP).
    if asincrono:
        asyncio.run(copia.close())
    else:
        copia.close()
    assert nuevo.is_closed and not suyo.is_closed


@pytest.mark.parametrize("modulo, clase, asincrono, http", CLIENTES, ids=IDS)
def test_un_http_client_propio_se_respeta(fake_gateway, proxy_espia, modulo, clase, asincrono, http):
    sdk, Cliente = _clase(modulo, clase)
    _preparar(fake_gateway, modulo)
    propio = getattr(sdk, http)()
    copia = Gateway(fake_gateway.url).wrap(Cliente(api_key=_clave(modulo), max_retries=0, http_client=propio))
    assert copia._client is propio
    # Lee HTTP_PROXY como cualquier cliente httpx: por eso la guía pide NO_PROXY.
    with pytest.raises(sdk.APIStatusError):
        _llamar(modulo, copia, asincrono)
    assert len(proxy_espia.vistas) == 1
    assert fake_gateway.received == []


@pytest.mark.parametrize("modulo, clase, asincrono, http", CLIENTES, ids=IDS)
def test_con_no_proxy_un_http_client_propio_va_directo(fake_gateway, proxy_espia, monkeypatch, modulo, clase, asincrono, http):
    sdk, Cliente = _clase(modulo, clase)
    _preparar(fake_gateway, modulo)
    # Lo que dice el README para quien trae su propio http_client.
    monkeypatch.setenv("NO_PROXY", "127.0.0.1,localhost")
    propio = getattr(sdk, http)()
    gw = Gateway(fake_gateway.url)
    resp = _llamar(modulo, gw.wrap(Cliente(api_key=_clave(modulo), max_retries=0, http_client=propio)), asincrono)
    assert proxy_espia.vistas == []
    assert len(fake_gateway.received) == 1
    assert gw.report(resp).metered
