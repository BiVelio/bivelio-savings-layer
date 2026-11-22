"""`wrap()` y los proxies del entorno: la copia es la de la 1.2.4, y avisa.

Historia. E2E 1.2.4 («major»): el cliente HTTP por defecto de los SDK lee
HTTP_PROXY / HTTPS_PROXY / ALL_PROXY, y la copia de `wrap()` lo hereda, así que
con un proxy en el entorno el tráfico al gateway local —clave del proveedor y
prompt incluidos— pasa por el proxy. El primer arreglo de la 1.2.5 le daba a
cada copia un cliente HTTP NUEVO sin proxies. La revisión del PR #617 lo tumbó
(«blocker»): en asíncrono ese pool propio no lo cierra nadie, ni cerrando el
original; el GC lo recoge con el bucle en marcha, los transportes se finalizan
sin cerrar («unclosed transport») y la siguiente conexión puede colgarse hasta
el timeout de conexión de 5 s. Les pasaba a usuarios SIN proxy.

Decisión del lanzamiento («nada peor que la versión publicada»): `wrap()` hace
EXACTAMENTE lo de la 1.2.4 —la copia comparte el cliente HTTP del original— y,
si el entorno mandaría el tráfico al gateway por un proxy, avisa una vez por
gateway y proceso y dice NO_PROXY. Aquí queda fijado:

(a) sin proxies, la copia comparte el MISMO objeto de cliente HTTP (el mismo
    pool) que el original, en OpenAI, AsyncOpenAI, Anthropic y AsyncAnthropic;
(b) con HTTP_PROXY y el gateway fuera de NO_PROXY, un único UserWarning por
    gateway, que nombra NO_PROXY y la variable, sin las credenciales del proxy,
    en la línea de quien llamó; la copia no cambia y la petición SÍ va por el
    proxy (un espía lo ve): el aviso dice la verdad;
(c) con NO_PROXY=127.0.0.1,localhost no hay aviso y la petición va directa;
(d) la regresión del bloqueante: 200 × `async with AsyncOpenAI() as c:
    await gw.wrap(c)…` contra un gateway falso con keep-alive y
    max_retries=0: cero fallos, ningún «unclosed transport» y cada copia
    cerrada al cerrar su original.

El espía solo apunta la línea de petición (nunca cabeceras ni cuerpo) y
contesta 502.
"""

from __future__ import annotations

import asyncio
import gc
import os
import socketserver
import threading
import warnings
from typing import Any, List

import pytest

from bvsala import Gateway, _gateway

KEY_OPENAI = "test-openai-key"
KEY_ANTHROPIC = "test-anthropic-key"

#: (módulo del SDK, clase del cliente, ¿asíncrono?)
CLIENTES = [
    ("openai", "OpenAI", False),
    ("openai", "AsyncOpenAI", True),
    ("anthropic", "Anthropic", False),
    ("anthropic", "AsyncAnthropic", True),
]
IDS = [c[1] for c in CLIENTES]


class _Servidor(socketserver.ThreadingTCPServer):
    daemon_threads = True


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

        self._server = _Servidor(("127.0.0.1", 0), H)
        self._hilo = threading.Thread(target=self._server.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True)
        self._hilo.start()

    @property
    def puerto(self) -> int:
        return int(self._server.server_address[1])

    def close(self) -> None:
        self._server.shutdown()
        self._server.server_close()


@pytest.fixture(autouse=True)
def entorno_sin_proxies(monkeypatch: pytest.MonkeyPatch) -> None:
    """Ningún *_PROXY de quien corre las pruebas, y el «ya avisé» del proceso a cero."""
    for var in list(os.environ):
        if var.lower().endswith("_proxy"):
            monkeypatch.delenv(var, raising=False)
    monkeypatch.setattr(_gateway, "_AVISADOS_POR_PROXY", set())


@pytest.fixture
def espia() -> Any:
    p = ProxyEspia()
    try:
        yield p
    finally:
        p.close()


def _clase(modulo: str, clase: str) -> Any:
    sdk = pytest.importorskip(modulo)
    return sdk, getattr(sdk, clase)


def _cliente(modulo: str, Cliente: Any, **kw: Any) -> Any:
    return Cliente(api_key=KEY_OPENAI if modulo == "openai" else KEY_ANTHROPIC, max_retries=0, **kw)


def _preparar(fake_gateway: Any, modulo: str) -> None:
    if modulo == "anthropic":
        fake_gateway.upstream = "https://api.anthropic.com"


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


def _avisos_de_bvsala(registro: List[warnings.WarningMessage]) -> List[warnings.WarningMessage]:
    return [w for w in registro if issubclass(w.category, UserWarning) and "bvsala gateway" in str(w.message)]


# ── (a) Sin proxies: la copia de la 1.2.4 ──────────────────────────────────


@pytest.mark.parametrize("modulo, clase, asincrono", CLIENTES, ids=IDS)
def test_sin_proxies_la_copia_comparte_el_cliente_http_del_original(fake_gateway, modulo, clase, asincrono):
    _sdk, Cliente = _clase(modulo, clase)
    _preparar(fake_gateway, modulo)
    original = _cliente(modulo, Cliente, timeout=12.5)
    with warnings.catch_warnings(record=True) as registro:
        warnings.simplefilter("always")
        copia = Gateway(fake_gateway.url).wrap(original)
    # El MISMO objeto: el mismo pool, que se cierra al cerrar el original.
    assert copia._client is original._client
    assert copia.timeout == original.timeout == 12.5
    assert _avisos_de_bvsala(registro) == []


# ── (b) Con un proxy que cubre el gateway: avisa una vez, y no cambia nada ──


@pytest.mark.parametrize("modulo, clase, asincrono", CLIENTES, ids=IDS)
def test_con_http_proxy_avisa_una_vez_por_gateway_y_no_cambia_nada(fake_gateway, espia, monkeypatch, modulo, clase, asincrono):
    sdk, Cliente = _clase(modulo, clase)
    _preparar(fake_gateway, modulo)
    # Con usuario y clave: el aviso no debe repetirlos.
    monkeypatch.setenv("HTTP_PROXY", f"http://usuario-espia:clave-espia@127.0.0.1:{espia.puerto}")
    gw = Gateway(fake_gateway.url)
    original = _cliente(modulo, Cliente)

    with warnings.catch_warnings(record=True) as registro:
        warnings.simplefilter("always")
        copia = gw.wrap(original)  # ← la línea a la que apunta el aviso
        gw.wrap(original)
        gw.wrap(_cliente(modulo, Cliente))
        Gateway(fake_gateway.url).wrap(_cliente(modulo, Cliente))  # mismo gateway, otro objeto
    avisos = _avisos_de_bvsala(registro)
    assert len(avisos) == 1, [str(a.message) for a in avisos]
    aviso = avisos[0]
    texto = str(aviso.message)
    assert aviso.category is UserWarning
    assert f"requests to the bvsala gateway at {fake_gateway.url} will go through the proxy in HTTP_PROXY" in texto
    assert f"127.0.0.1:{espia.puerto}" not in texto  # nada del valor de la variable
    assert "Set NO_PROXY=127.0.0.1,localhost before creating the client." in texto
    assert "usuario-espia" not in texto and "clave-espia" not in texto and "@" not in texto
    # Apunta a quien llamó a wrap(), no a bvsala.
    assert aviso.filename == __file__

    # Otro gateway (otra URL): su propio aviso, también una sola vez.
    otro = fake_gateway.url.replace("127.0.0.1", "localhost")
    with warnings.catch_warnings(record=True) as registro:
        warnings.simplefilter("always")
        Gateway(otro).wrap(_cliente(modulo, Cliente))
        Gateway(otro).wrap(_cliente(modulo, Cliente))
    avisos = _avisos_de_bvsala(registro)
    assert len(avisos) == 1 and f"gateway at {otro} " in str(avisos[0].message)

    # Nada más cambia: la copia de la 1.2.4, que SÍ pasa por el proxy (el aviso dice la verdad).
    assert copia._client is original._client
    with pytest.raises(sdk.APIStatusError):
        _llamar(modulo, copia, asincrono)
    ruta = "/v1/chat/completions" if modulo == "openai" else "/v1/messages"
    assert espia.vistas == [f"POST {fake_gateway.url}{ruta} HTTP/1.1"]
    assert fake_gateway.received == []


@pytest.mark.parametrize("variable", ["HTTP_PROXY", "http_proxy", "ALL_PROXY"])
def test_el_aviso_nombra_la_variable_que_se_usa(fake_gateway, espia, monkeypatch, variable):
    openai = pytest.importorskip("openai")
    monkeypatch.setenv(variable, f"http://127.0.0.1:{espia.puerto}")
    with pytest.warns(UserWarning, match="NO_PROXY=127.0.0.1,localhost") as registro:
        copia = Gateway(fake_gateway.url).wrap(openai.OpenAI(api_key=KEY_OPENAI, max_retries=0))
    (aviso,) = _avisos_de_bvsala(list(registro))
    assert f"through the proxy in {variable}:" in str(aviso.message)
    with pytest.raises(openai.APIStatusError):
        _llamar("openai", copia, False)
    assert len(espia.vistas) == 1


def test_un_https_proxy_no_toca_un_gateway_http(fake_gateway, espia, monkeypatch):
    openai = pytest.importorskip("openai")
    monkeypatch.setenv("HTTPS_PROXY", f"http://127.0.0.1:{espia.puerto}")
    gw = Gateway(fake_gateway.url)
    with warnings.catch_warnings(record=True) as registro:
        warnings.simplefilter("always")
        copia = gw.wrap(openai.OpenAI(api_key=KEY_OPENAI, max_retries=0))
    assert _avisos_de_bvsala(registro) == []
    assert gw.report(_llamar("openai", copia, False)).metered
    assert espia.vistas == []


def test_avisar_nunca_rompe_wrap(fake_gateway, monkeypatch):
    openai = pytest.importorskip("openai")
    # Un proxy mal escrito y los avisos convertidos en errores (-W error): wrap() hace lo de la 1.2.4.
    # (El cliente se crea antes: con ese proxy httpx ni lo construye; wrap() lee el entorno al llamarlo.)
    original = openai.OpenAI(api_key=KEY_OPENAI, max_retries=0)
    monkeypatch.setenv("HTTP_PROXY", "http://usuario:clave@proxy.invalid:no-es-un-puerto")
    with warnings.catch_warnings():
        warnings.simplefilter("error")
        copia = Gateway(fake_gateway.url).wrap(original)
    assert copia._client is original._client
    assert str(copia.base_url) == f"{fake_gateway.url}/v1/"
    # Con los avisos normales, el mal escrito también avisa, sin URL ni credenciales.
    monkeypatch.setattr(_gateway, "_AVISADOS_POR_PROXY", set())
    with pytest.warns(UserWarning) as registro:
        Gateway(fake_gateway.url).wrap(original)
    (aviso,) = _avisos_de_bvsala(list(registro))
    assert "through the proxy in HTTP_PROXY:" in str(aviso.message)
    assert "usuario" not in str(aviso.message) and "clave" not in str(aviso.message)


# ── (c) Con NO_PROXY, lo que dice el README: ni aviso ni proxy ────────────


@pytest.mark.parametrize("modulo, clase, asincrono", CLIENTES, ids=IDS)
def test_con_no_proxy_no_avisa_y_va_directo(fake_gateway, espia, monkeypatch, modulo, clase, asincrono):
    _sdk, Cliente = _clase(modulo, clase)
    _preparar(fake_gateway, modulo)
    monkeypatch.setenv("HTTP_PROXY", f"http://127.0.0.1:{espia.puerto}")
    monkeypatch.setenv("NO_PROXY", "127.0.0.1,localhost")
    gw = Gateway(fake_gateway.url)
    with warnings.catch_warnings(record=True) as registro:
        warnings.simplefilter("always")
        copia = gw.wrap(_cliente(modulo, Cliente))
    assert _avisos_de_bvsala(registro) == []
    resp = _llamar(modulo, copia, asincrono)
    assert espia.vistas == []
    assert len(fake_gateway.received) == 1
    assert fake_gateway.received[0]["headers"]["x-bvsala-report"] == "1"
    assert gw.report(resp).metered


# ── (d) Regresión del bloqueante: wrap() por petición en asíncrono ─────────


@pytest.mark.parametrize("modulo, clase", [("openai", "AsyncOpenAI"), ("anthropic", "AsyncAnthropic")])
@pytest.mark.parametrize("patron", ["async_with_por_peticion", "cliente_compartido"])
def test_wrap_por_peticion_en_asincrono_no_deja_pools_sin_cerrar(fake_gateway, modulo, clase, patron):
    _sdk, Cliente = _clase(modulo, clase)
    _preparar(fake_gateway, modulo)
    # Keep-alive, como el gateway de verdad: el pool se queda las conexiones.
    fake_gateway._server.RequestHandlerClass.protocol_version = "HTTP/1.1"
    gw = Gateway(fake_gateway.url)
    fallos: List[str] = []
    #: Copias cuyo cliente HTTP no es el del original (pools que nadie cierra).
    #: Se cuentan sin guardarlas: guardarlas impediría que el GC las recogiera.
    ajenas = 0

    async def crear(c: Any) -> Any:
        if modulo == "openai":
            return await c.chat.completions.create(model="gpt-4o-mini", messages=[{"role": "user", "content": "x"}])
        return await c.messages.create(model="claude-haiku-4-5", max_tokens=8, messages=[{"role": "user", "content": "x"}])

    async def bucle() -> None:
        nonlocal ajenas
        compartido = _cliente(modulo, Cliente, timeout=2.0) if patron == "cliente_compartido" else None
        for i in range(200):
            try:
                if compartido is not None:
                    w = gw.wrap(compartido)
                    ajenas += w._client is not compartido._client
                    await crear(w)
                else:
                    # Lo que hace un servicio bien escrito: crea y CIERRA su cliente en cada petición.
                    async with _cliente(modulo, Cliente, timeout=2.0) as c:
                        w = gw.wrap(c)
                        await crear(w)
                    ajenas += not w._client.is_closed
            except Exception as e:  # noqa: BLE001 — se cuentan, no se esconden
                fallos.append(f"{i}: {type(e).__name__}: {e}")
        if compartido is not None:
            await compartido.close()
        # El GC con el bucle en marcha: así salían los «unclosed transport».
        gc.collect()
        await asyncio.sleep(0)

    with warnings.catch_warnings(record=True) as registro:
        warnings.simplefilter("always")
        asyncio.run(bucle())
        gc.collect()
    sin_cerrar = [str(w.message) for w in registro if issubclass(w.category, ResourceWarning)]
    assert {"fallos": fallos[:3], "pools_sin_cerrar": ajenas, "resource_warnings": sin_cerrar[:2]} == {
        "fallos": [], "pools_sin_cerrar": 0, "resource_warnings": []
    }, f"{len(fallos)} fallos, {ajenas} pools sin cerrar, {len(sin_cerrar)} ResourceWarning"
    assert len(fake_gateway.received) == 200
