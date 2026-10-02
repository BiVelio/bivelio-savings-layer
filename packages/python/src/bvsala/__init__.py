"""BiVelio Savings Layer for Python — a thin client for the local ``bvsala`` gateway.

The gateway (``bvsala gateway``, in the npm package ``@bivelio/savings-layer``)
holds the BiVelio license, forwards your requests to the provider and measures
each one with the provider's own usage counter. This package routes the
official OpenAI and Anthropic SDKs through it and hands you, per request, the
report the gateway recorded for your dashboard::

    import bvsala
    from openai import OpenAI

    gw = bvsala.Gateway("http://127.0.0.1:8403")  # bvsala gateway --upstream openai --port 8403
    client = gw.wrap(OpenAI())
    resp = client.chat.completions.create(model="gpt-4o-mini", messages=[{"role": "user", "content": "Hi"}])
    print(gw.report(resp).summary())

Commercial software, © 2026 BiVelio Inc. See LICENSE.
"""

from ._errors import BvsalaError, GatewayMismatch, GatewayUnavailable, LicenseInactive, ReportNotFound
from ._gateway import DEFAULT_URL, ENV_URL, REPORT_HEADER, REPORT_HEADERS, Gateway
from ._keys import REQUEST_ID_HEADER
from ._report import Calls, Cost, GatewayStatus, Report, Tokens, Totals

__version__ = "0.1.1"

__all__ = [
    "BvsalaError",
    "Calls",
    "Cost",
    "DEFAULT_URL",
    "ENV_URL",
    "Gateway",
    "GatewayMismatch",
    "GatewayStatus",
    "GatewayUnavailable",
    "LicenseInactive",
    "REPORT_HEADER",
    "REPORT_HEADERS",
    "REQUEST_ID_HEADER",
    "Report",
    "ReportNotFound",
    "Tokens",
    "Totals",
    "__version__",
]
