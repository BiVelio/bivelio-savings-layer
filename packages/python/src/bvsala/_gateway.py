"""El cliente del gateway local.

Qué hace y qué NO hace, a propósito:

- Habla SOLO con el gateway (`bvsala gateway`, del paquete de npm), que es quien
  tiene la licencia, mide con el contador del proveedor y registra el uso.
  Nunca llama al proveedor directamente ni cae a él si el gateway no está: sin
  gateway no hay licencia ni medición, así que se niega (fail-closed).
- No calcula precios ni ahorros: los números salen del gateway. Así no hay un
  segundo catálogo de precios que pueda divergir del de TypeScript.
- Solo usa la biblioteca estándar. Instalarlo no añade ninguna dependencia a la
  cadena de suministro del cliente.
- Sus propias llamadas (estado, informes) ignoran los proxies del entorno
  (HTTP_PROXY…): urllib sin ProxyHandler, porque el gateway es local y lo que
  va a él no debe pasar por nadie más.
- La copia de `wrap()` comparte el cliente HTTP del original, como en la 1.2.4
  (no abre un pool propio que nadie cierra). Ese cliente es del SDK y SÍ lee
  los proxies del entorno, así que `wrap()` no los cambia: si el entorno
  mandaría el tráfico al gateway por un proxy, avisa (una vez por gateway y
  proceso) y dice NO_PROXY.
"""

from __future__ import annotations

import asyncio
import json
import os
import threading
import urllib.error
import urllib.request
import warnings
from collections import OrderedDict
from typing import Any, Dict, List, Mapping, Optional, Set, Tuple
from urllib.parse import quote, urlsplit

from ._errors import BvsalaError, GatewayMismatch, GatewayUnavailable, LicenseInactive, ReportNotFound
from ._keys import is_request_id, request_id_of, response_id_of
from ._report import GatewayStatus, Report, Totals, parse_report, parse_status

#: El gateway de Anthropic, el de siempre. El de OpenAI se arranca aparte
#: (`npx @bivelio/savings-layer gateway --upstream openai --port 8403`).
DEFAULT_URL = "http://127.0.0.1:8402"
#: Cómo arranca el gateway quien instaló este paquete con pip: `bvsala` es el
#: binario del paquete de npm y no está en su PATH; `npx` sí lo encuentra (es
#: el único `bin` del paquete). La misma forma que el README del repositorio.
_ARRANCAR = "npx @bivelio/savings-layer gateway"
ENV_URL = "BVSALA_GATEWAY_URL"
#: La cabecera con la que una petición pide su informe al gateway (que no la reenvía).
REPORT_HEADER = "x-bvsala-report"
REPORT_HEADERS: Mapping[str, str] = {REPORT_HEADER: "1"}
#: Cuántos informes recuerda el proceso para `totals()`.
_MEMORIA = 10_000
_ESPERA_MAXIMA_S = 30.0
_SDKS = ("openai", "anthropic")


def _origen(url: str) -> Tuple[str, str]:
    """(esquema, host[:puerto]) normalizado: minúsculas, sin credenciales, sin el puerto por defecto."""
    p = urlsplit(url)
    esquema = (p.scheme or "").lower()
    host = (p.hostname or "").lower()
    if ":" in host:  # IPv6
        host = f"[{host}]"
    puerto = p.port
    if puerto is not None and not ((esquema == "https" and puerto == 443) or (esquema == "http" and puerto == 80)):
        host = f"{host}:{puerto}"
    return esquema, host


def _texto_origen(o: Tuple[str, str]) -> str:
    return f"{o[0]}://{o[1]}"


def _mismo_sitio(a: Tuple[str, str], b: Tuple[str, str]) -> bool:
    """Igualdad de origen en la que `localhost` y `127.0.0.1` son el mismo equipo."""

    def canon(o: Tuple[str, str]) -> Tuple[str, str]:
        esquema, host = o
        nombre, dos_puntos, puerto = host.rpartition(":") if not host.endswith("]") else (host, "", "")
        if not dos_puntos:
            nombre, puerto = host, ""
        if nombre == "localhost":
            nombre = "127.0.0.1"
        return esquema, f"{nombre}:{puerto}" if puerto else nombre

    return canon(a) == canon(b)


#: Los gateways (origen de la copia) de los que este proceso ya avisó por proxy.
_AVISADOS_POR_PROXY: Set[str] = set()
_CANDADO_AVISOS = threading.Lock()
_LOOPBACK = ("127.0.0.1", "localhost", "::1")


def _aviso_de_proxy(destino: str) -> Optional[str]:
    """El aviso, si el entorno mandaría por un proxy lo que va a ``destino``; si no, None.

    Lo que hace el cliente HTTP por defecto de los SDK (httpx): el proxy del
    esquema (``http``/``https``) o ``all``, salvo que NO_PROXY cubra el host.
    Solo mira el ENTORNO (getproxies_environment), sin la configuración del
    sistema. Del proxy dice solo la variable, nada de su valor.
    """
    p = urlsplit(destino)
    esquema, host = (p.scheme or "").lower(), (p.hostname or "").lower()
    proxies = urllib.request.getproxies_environment()
    clave = next((k for k in (esquema, "all") if proxies.get(k)), None)
    if clave is None:
        return None
    # urllib compara NO_PROXY con «host:puerto» y con el host solo; un IPv6,
    # sin corchetes ni puerto (con ellos no casaría con «::1»).
    donde = host if ":" in host or p.port is None else f"{host}:{p.port}"
    if urllib.request.proxy_bypass_environment(donde, proxies):
        return None
    # urllib da prioridad a la variable en minúsculas.
    nombres = [k for k, v in os.environ.items() if k.lower() == f"{clave}_proxy" and v]
    variable = f"{clave}_proxy" if f"{clave}_proxy" in nombres else (nombres[0] if nombres else f"{clave.upper()}_PROXY")
    # Solo el nombre de la variable: del valor (que puede llevar usuario y
    # clave) no se muestra nada.
    dice = variable
    no_proxy = "127.0.0.1,localhost" + ("" if host in _LOOPBACK else f",{host}")
    return (
        f"requests to the bvsala gateway at {_texto_origen(_origen(destino))} will go through the proxy in {dice}: "
        "the provider API key and the prompt would cross that proxy. "
        f"Set NO_PROXY={no_proxy} before creating the client."
    )


def _avisar_si_hay_proxy(destino: str) -> None:
    """Un ``UserWarning`` por gateway y proceso si el entorno manda su tráfico por un proxy.

    Solo avisa: no cambia nada ni lanza nunca (tampoco con ``-W error``), para
    que `wrap()` haga exactamente lo de la 1.2.4.
    """
    try:
        aviso = _aviso_de_proxy(destino)
        if aviso is None:
            return
        llave = _texto_origen(_origen(destino))
        with _CANDADO_AVISOS:
            if llave in _AVISADOS_POR_PROXY:
                return
            _AVISADOS_POR_PROXY.add(llave)
        # stacklevel=3: la línea de quien llamó a wrap().
        warnings.warn(aviso, UserWarning, stacklevel=3)
    except Exception:  # noqa: BLE001 — un aviso nunca rompe wrap()
        return


class Gateway:
    """A local ``bvsala gateway``, and the reports it recorded for this process.

    ``url`` defaults to ``$BVSALA_GATEWAY_URL`` or ``http://127.0.0.1:8402`` (the
    Anthropic gateway). For OpenAI, start ``npx @bivelio/savings-layer gateway
    --upstream openai --port 8403`` and use ``Gateway("http://127.0.0.1:8403")``.
    Only the origin of ``url`` matters: a path such as ``/v1`` is ignored.
    """

    def __init__(self, url: Optional[str] = None, *, timeout: float = 5.0) -> None:
        crudo = (url or os.environ.get(ENV_URL) or DEFAULT_URL).strip()
        esquema, host = _origen(crudo)
        if esquema not in ("http", "https") or not host:
            raise ValueError(f"not a gateway URL: {crudo!r} (expected something like {DEFAULT_URL})")
        self.url = _texto_origen((esquema, host))
        self.timeout = timeout
        self._informes: "OrderedDict[str, Report]" = OrderedDict()
        self._candado = threading.Lock()
        # Sin proxies: la petición va al gateway local y a nadie más.
        self._abridor = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def __repr__(self) -> str:
        return f"Gateway({self.url!r})"

    # ── HTTP ────────────────────────────────────────────────────────────────

    def _get(self, ruta: str, timeout: float) -> Tuple[int, Dict[str, Any], Mapping[str, str]]:
        req = urllib.request.Request(self.url + ruta, method="GET", headers={"accept": "application/json"})
        try:
            with self._abridor.open(req, timeout=timeout) as r:
                return r.status, self._json(r.read()), dict(r.headers.items())
        except urllib.error.HTTPError as e:
            try:
                cuerpo = self._json(e.read())
            finally:
                e.close()
            return e.code, cuerpo, dict(e.headers.items()) if e.headers else {}
        except (urllib.error.URLError, OSError) as e:
            raise GatewayUnavailable(
                f"no bvsala gateway answered at {self.url} ({getattr(e, 'reason', e)}). Start one with "
                f"`{_ARRANCAR}` (Anthropic, port 8402) or `{_ARRANCAR} --upstream openai --port 8403` "
                "(the gateway ships in the npm package @bivelio/savings-layer, runs on Node.js 20.19 or newer and "
                "needs no key: with none it runs free in COMMUNITY mode)."
            ) from e

    @staticmethod
    def _json(b: bytes) -> Dict[str, Any]:
        try:
            v = json.loads(b.decode("utf-8") or "{}")
        except (ValueError, UnicodeDecodeError):
            return {}
        return v if isinstance(v, dict) else {}

    @staticmethod
    def _mensaje(cuerpo: Mapping[str, Any]) -> str:
        err = cuerpo.get("error")
        if isinstance(err, Mapping) and isinstance(err.get("message"), str):
            return str(err["message"])
        return ""

    def _licencia(self, codigo: int, cuerpo: Mapping[str, Any], cabeceras: Mapping[str, str]) -> None:
        if codigo != 402:
            return
        estado = next((v for k, v in cabeceras.items() if k.lower() == "x-bvsala-license-status"), "") or "unknown"
        raise LicenseInactive(
            estado,
            self._mensaje(cuerpo) or f"the bvsala gateway at {self.url} refuses new requests: license {estado}",
        )

    # ── Estado y licencia ───────────────────────────────────────────────────

    def status(self) -> GatewayStatus:
        """The gateway's version, upstream and license. Raises if it is not a bvsala gateway."""
        codigo, cuerpo, cabeceras = self._get("/_bvsala/v1/status", self.timeout)
        self._licencia(codigo, cuerpo, cabeceras)
        if codigo != 200:
            raise GatewayUnavailable(
                f"{self.url} did not answer as a bvsala gateway with local reports (HTTP {codigo}). "
                "If it is an older gateway, update @bivelio/savings-layer: local reports need 0.4.26 or later."
            )
        try:
            return parse_status(cuerpo)
        except ValueError as e:
            raise GatewayUnavailable(f"{self.url}: {e}") from e

    def require_ready(self) -> GatewayStatus:
        """Fail closed: return the status only if the gateway serves new requests.

        A gateway with no BiVelio key (COMMUNITY mode) always does; with a key,
        only while its license is active or in its grace period.
        """
        st = self.status()
        if not st.serving:
            raise LicenseInactive(st.license_state, f"the bvsala gateway at {self.url} reports license {st.license_state}")
        return st

    # ── Envolver un cliente oficial ─────────────────────────────────────────

    def wrap(self, client: Any) -> Any:
        """Return a copy of an official OpenAI or Anthropic client that goes through this gateway.

        The copy points at the gateway (keeping the path of the client's base
        URL, e.g. ``/v1``) and asks for a report on every request. The original
        client is left untouched. Raises ``GatewayUnavailable`` or
        ``LicenseInactive`` if the gateway cannot serve, and ``GatewayMismatch``
        if the client is configured for a provider the gateway does not forward to.

        The copy shares the original's HTTP client (its connection pool and
        settings), as the SDK's own ``with_options()`` does: closing either one
        closes both. That client belongs to the SDK and reads proxy settings:
        with ``HTTP_PROXY`` or ``ALL_PROXY`` set (``HTTPS_PROXY`` for an
        ``https://`` gateway), requests to the gateway, provider API key and
        prompt included, go through that proxy unless ``NO_PROXY`` covers the
        gateway's host. Set ``NO_PROXY=127.0.0.1,localhost`` before creating
        the client. When the environment would send gateway traffic through a
        proxy, ``wrap()`` emits a ``UserWarning`` (once per gateway URL and
        process) and changes nothing else.
        """
        raiz = type(client).__module__.split(".")[0]
        if raiz not in _SDKS or not callable(getattr(client, "with_options", None)):
            raise TypeError(
                "wrap() takes a client from the official openai or anthropic SDK "
                f"(OpenAI, AsyncOpenAI, AzureOpenAI, Anthropic, AsyncAnthropic…), not {type(client).__name__}"
            )
        st = self.require_ready()
        base = str(client.base_url)
        suyo = _origen(base)
        nuestro = _origen(self.url)
        if _mismo_sitio(suyo, nuestro):
            # Ya apunta a este gateway: solo falta pedir el informe.
            nueva = base
        else:
            if not _mismo_sitio(suyo, _origen(st.upstream)):
                raise GatewayMismatch(
                    f"this {type(client).__name__} client sends to {_texto_origen(suyo)}, but the gateway at "
                    f"{self.url} forwards to {st.upstream}. Start a gateway for that provider, e.g. "
                    f"`{_ARRANCAR} --upstream {_texto_origen(suyo)} --port <free port>`, and pass its URL to Gateway()."
                )
            nueva = self.url + urlsplit(base).path
        # Solo avisa: la copia es la de la 1.2.4 y comparte el cliente HTTP.
        _avisar_si_hay_proxy(nueva)
        return client.with_options(base_url=nueva, default_headers=dict(REPORT_HEADERS))

    # ── Informes ────────────────────────────────────────────────────────────

    def report(self, obj: Any, *, wait: float = 5.0) -> Report:
        """The report of the request that produced ``obj``.

        ``obj`` can be a response object, a stream (after reading it), a stream
        event or chunk, a LiteLLM response, a raw response, or an id string.
        Waits up to ``wait`` seconds for a request still in flight; if it has
        not finished by then, the report comes back with status ``"pending"``.

        A raw response (``with_raw_response``), a stream or the
        ``x-bvsala-request-id`` string name the request exactly. A parsed
        response, a chunk or an event is looked up by the provider's response
        id instead. With the gateway's opt-in ``BVSALA_GATEWAY_COALESCE=1``,
        identical requests in flight at the same time share one provider call
        and one response id, so that lookup cannot tell them apart and returns
        the same report for all of them: pass the raw response, the stream or
        the header value to get each request's own report.
        """
        espera = max(0.0, min(float(wait), _ESPERA_MAXIMA_S))
        if isinstance(obj, str):
            rid, resp = (obj, None) if is_request_id(obj) else (None, obj)
        else:
            rid = request_id_of(obj)
            resp = None if rid else response_id_of(obj)
        if rid:
            ruta = f"/_bvsala/v1/reports/{quote(rid, safe='')}"
        elif resp:
            ruta = f"/_bvsala/v1/reports?response_id={quote(resp, safe='')}"
        else:
            raise ReportNotFound(
                "found no x-bvsala-request-id header and no response id on this object: pass the response, "
                "a stream you have read, one of its chunks or events, or the id itself"
            )
        codigo, cuerpo, cabeceras = self._pedir_informe(ruta, espera)
        if codigo == 404 and isinstance(obj, str) and rid:
            # Un proveedor puede usar un UUID como id de respuesta: si no era un
            # id de petición del gateway, se prueba como id de respuesta.
            codigo, cuerpo, cabeceras = self._pedir_informe(f"/_bvsala/v1/reports?response_id={quote(obj, safe='')}", espera)
        if codigo == 404:
            raise ReportNotFound(self._mensaje(cuerpo) or f"no report for {rid or resp}")
        if codigo != 200:
            raise BvsalaError(self._mensaje(cuerpo) or f"the gateway answered HTTP {codigo} for the report")
        try:
            informe = parse_report(cuerpo)
        except ValueError as e:
            raise BvsalaError(f"{self.url}: {e}") from e
        if informe.status != "pending":
            with self._candado:
                self._informes[informe.request_id] = informe
                self._informes.move_to_end(informe.request_id)
                while len(self._informes) > _MEMORIA:
                    self._informes.popitem(last=False)
        return informe

    def _pedir_informe(self, ruta: str, espera: float) -> Tuple[int, Dict[str, Any], Mapping[str, str]]:
        codigo, cuerpo, cabeceras = self._get(f"{ruta}{'&' if '?' in ruta else '?'}wait_ms={int(espera * 1000)}", espera + self.timeout)
        self._licencia(codigo, cuerpo, cabeceras)
        return codigo, cuerpo, cabeceras

    async def areport(self, obj: Any, *, wait: float = 5.0) -> Report:
        """``report()`` for async code: runs the blocking call in a worker thread."""
        return await asyncio.to_thread(self.report, obj, wait=wait)

    def reports(self) -> List[Report]:
        """Every finished report this ``Gateway`` has fetched, oldest first."""
        with self._candado:
            return list(self._informes.values())

    def totals(self) -> Totals:
        """Add up the fetched reports, keeping each basis apart."""
        informes = self.reports()
        por_base: Dict[str, float] = {}
        coste = 0.0
        medidos = 0
        for i in informes:
            if not i.metered or i.cost is None:
                continue
            medidos += 1
            coste += i.cost.actual
            base = i.cost.basis or "unknown"
            por_base[base] = por_base.get(base, 0.0) + i.cost.net_savings
        return Totals(
            requests=len(informes),
            metered=medidos,
            not_metered=len(informes) - medidos,
            actual_cost_usd=coste,
            net_savings_usd_by_basis=por_base,
        )
