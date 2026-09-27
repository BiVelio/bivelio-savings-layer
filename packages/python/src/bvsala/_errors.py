"""Errores del cliente. Los mensajes van en inglés: los lee el desarrollador."""

from __future__ import annotations


class BvsalaError(Exception):
    """Base class for every error raised by this package."""


class GatewayUnavailable(BvsalaError):
    """No bvsala gateway with local reports answered at the configured URL.

    The client never falls back to calling the provider directly: without the
    gateway there is no license check and no measurement, so it refuses instead.
    """


class LicenseInactive(BvsalaError):
    """The gateway is running but its BiVelio license does not serve new requests."""

    def __init__(self, state: str, message: str) -> None:
        super().__init__(message)
        #: The gateway's license state: "expired", "revoked", "no-license", "blocked" or "invalid".
        self.state = state


class GatewayMismatch(BvsalaError):
    """The client is configured for a different provider than the gateway forwards to."""


class ReportNotFound(BvsalaError):
    """The gateway holds no report for this request, or the object carries no id to look it up."""
