"""El informe por petición, tal como lo devuelve el gateway.

Aquí NO se calcula nada: cada número viene del `SavingsReport` que el gateway
encoló para el panel (los mismos números), medido con el contador del
proveedor y tarifado al precio de lista del catálogo del paquete de npm. Este
módulo solo traduce el JSON a objetos de Python, con nombres en snake_case.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Mapping, Optional

#: Los esquemas que este cliente entiende. Un gateway con otro esquema es de
#: otra versión: se dice en vez de leer campos a ciegas.
REPORT_SCHEMA = "bvsala.gateway.report/1"
STATUS_SCHEMA = "bvsala.gateway.status/1"


def _num(d: Mapping[str, Any], clave: str, defecto: float = 0) -> float:
    v = d.get(clave, defecto)
    # bool es subclase de int: un `true` no es una cifra.
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else float(defecto)


def _int(d: Mapping[str, Any], clave: str) -> int:
    return int(_num(d, clave, 0))


def _dict(d: Mapping[str, Any], clave: str) -> Mapping[str, Any]:
    v = d.get(clave)
    return v if isinstance(v, dict) else {}


@dataclass(frozen=True)
class Tokens:
    """Token counts. ``actual_*`` are the provider's own usage counter for this request."""

    baseline_input: int
    actual_input: int
    eliminated_input: int
    compressed_input: int
    baseline_output: int
    actual_output: int
    eliminated_output: int
    #: Input tokens the provider served from its prompt cache (cheaper, not removed).
    provider_cached_input: int


@dataclass(frozen=True)
class Cost:
    """Money in USD, at the model's list price in the catalog of the gateway's version.

    ``basis`` says where the baseline comes from, and it is what separates
    measured money from estimated money: ``"measured"`` (this request's
    provider counter), ``"reference"`` (an avoided repeat valued with the
    counter of the identical request that ran), ``"estimated"`` or
    ``"unmeasured"``. Never add different bases into one "saved" figure.
    """

    baseline_estimate: float
    actual: float
    net_savings: float
    basis: Optional[str]
    #: Provider-side context clearing valued at the cached-input price; a separate lane, never in ``net_savings``.
    eliminated_input_floor_cost: Optional[float]


@dataclass(frozen=True)
class Calls:
    baseline_llm: int
    actual_llm: int
    #: 1 when the call was avoided (for example, a coalesced duplicate served from its twin).
    avoided_llm: int


@dataclass(frozen=True)
class Report:
    """What the gateway recorded for one request.

    ``status`` is ``"metered"`` (``cost``, ``tokens`` and ``calls`` are set),
    ``"not_metered"`` (``reason`` says why, in the words of the gateway log) or
    ``"pending"`` (the request had not finished when the wait ran out).
    """

    request_id: str
    response_id: Optional[str]
    path: str
    status: str
    reason: Optional[str]
    model: Optional[str]
    cost: Optional[Cost]
    tokens: Optional[Tokens]
    calls: Optional[Calls]
    #: The full ``SavingsReport`` as the gateway queued it for your dashboard (camelCase keys).
    raw_report: Optional[Mapping[str, Any]] = field(default=None, repr=False)

    @property
    def metered(self) -> bool:
        return self.status == "metered"

    def summary(self) -> str:
        """One line for a log: model, basis, cost and the provider's counts."""
        if not self.metered or self.cost is None or self.tokens is None:
            return f"{self.path} · {self.status}" + (f": {self.reason}" if self.reason else "")
        t = self.tokens
        linea = (
            f"{self.model} · {self.cost.basis or 'unknown'} · ${self.cost.actual:.6f} "
            f"(in {t.actual_input}, cached {t.provider_cached_input}, out {t.actual_output})"
        )
        if self.calls is not None and self.calls.avoided_llm > 0:
            linea += " · call avoided"
        if self.cost.net_savings:
            linea += f" · saved ${self.cost.net_savings:.6f} ({self.cost.basis})"
        return linea


def parse_report(cuerpo: Mapping[str, Any]) -> Report:
    """El JSON de ``GET /_bvsala/v1/reports/…`` → ``Report``. Lanza ``ValueError`` si no es uno."""
    if cuerpo.get("schema") != REPORT_SCHEMA:
        raise ValueError(f"unexpected report schema {cuerpo.get('schema')!r} (this client reads {REPORT_SCHEMA})")
    status = str(cuerpo.get("status"))
    reason = cuerpo.get("reason")
    rep = cuerpo.get("report")
    base = dict(
        request_id=str(cuerpo.get("requestId", "")),
        response_id=cuerpo.get("responseId") if isinstance(cuerpo.get("responseId"), str) else None,
        path=str(cuerpo.get("path", "")),
        status=status,
        reason=reason if isinstance(reason, str) else None,
    )
    if status != "metered" or not isinstance(rep, dict):
        return Report(**base, model=None, cost=None, tokens=None, calls=None, raw_report=None)
    c, t, k = _dict(rep, "cost"), _dict(rep, "tokens"), _dict(rep, "calls")
    suelo = c.get("eliminatedInputFloorCost")
    return Report(
        **base,
        model=rep.get("model") if isinstance(rep.get("model"), str) else None,
        cost=Cost(
            baseline_estimate=_num(c, "baselineEstimate"),
            actual=_num(c, "actual"),
            # El informe del SDK la llama `netSavingsRatio` desde la 0.5 (antes
            # `netSavings`); se aceptan las dos para leer pasarelas de ambas versiones.
            net_savings=_num(c, "netSavingsRatio") if "netSavingsRatio" in c else _num(c, "netSavings"),
            basis=c.get("basis") if isinstance(c.get("basis"), str) else None,
            eliminated_input_floor_cost=_num(c, "eliminatedInputFloorCost") if suelo is not None else None,
        ),
        tokens=Tokens(
            baseline_input=_int(t, "baselineInput"),
            actual_input=_int(t, "actualInput"),
            eliminated_input=_int(t, "eliminatedInput"),
            compressed_input=_int(t, "compressedInput"),
            baseline_output=_int(t, "baselineOutput"),
            actual_output=_int(t, "actualOutput"),
            eliminated_output=_int(t, "eliminatedOutput"),
            provider_cached_input=_int(t, "providerCachedInput"),
        ),
        calls=Calls(
            baseline_llm=_int(k, "baselineLlm"),
            actual_llm=_int(k, "actualLlm"),
            avoided_llm=_int(k, "avoidedLlm"),
        ),
        raw_report=rep,
    )


@dataclass(frozen=True)
class GatewayStatus:
    version: str
    #: The origin the gateway forwards to: the provider API it was started with.
    upstream: str
    license_state: str
    license_plan: Optional[str]
    license_expires_at: Optional[str]
    #: False when the gateway has no service key: then nothing is measured or recorded.
    metering: bool
    raw: Mapping[str, Any] = field(default_factory=dict, repr=False)

    @property
    def serving(self) -> bool:
        """Whether the license serves new requests (active, or in its grace period)."""
        return self.license_state in ("active", "grace")


def parse_status(cuerpo: Mapping[str, Any]) -> GatewayStatus:
    if cuerpo.get("schema") != STATUS_SCHEMA:
        raise ValueError(f"unexpected status schema {cuerpo.get('schema')!r} (this client reads {STATUS_SCHEMA})")
    lic = _dict(cuerpo, "license")
    return GatewayStatus(
        version=str(cuerpo.get("version", "")),
        upstream=str(cuerpo.get("upstream", "")),
        license_state=str(lic.get("state", "")),
        license_plan=lic.get("plan") if isinstance(lic.get("plan"), str) else None,
        license_expires_at=lic.get("expiresAt") if isinstance(lic.get("expiresAt"), str) else None,
        metering=cuerpo.get("metering") is True,
        raw=cuerpo,
    )


@dataclass(frozen=True)
class Totals:
    """What this process fetched, added up per basis and never across bases."""

    requests: int
    metered: int
    not_metered: int
    #: Sum of ``cost.actual`` over metered requests: the provider's counters at list price.
    actual_cost_usd: float
    #: Sum of ``cost.net_savings`` per basis. Measured and estimated money stay apart on purpose.
    net_savings_usd_by_basis: Mapping[str, float]
