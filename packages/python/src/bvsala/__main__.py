"""``python -m bvsala``: comprobar el gateway y leer un informe desde la terminal.

Códigos de salida: 0 bien, 2 licencia sin servir, 3 gateway ausente o de otra
versión, 4 informe no encontrado, 1 cualquier otro error.
"""

from __future__ import annotations

import argparse
import json
import sys
from typing import List, Optional

from ._errors import BvsalaError, GatewayUnavailable, LicenseInactive, ReportNotFound
from ._gateway import Gateway


def main(argv: Optional[List[str]] = None) -> int:
    p = argparse.ArgumentParser(prog="python -m bvsala", description="Check a local bvsala gateway and read its per-request reports.")
    p.add_argument("--url", help="gateway URL (default: $BVSALA_GATEWAY_URL or http://127.0.0.1:8402)")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("status", help="print the gateway's version, upstream and license")
    r = sub.add_parser("report", help="print the report of one request as JSON")
    r.add_argument("id", help="the x-bvsala-request-id header, or the provider's response id")
    r.add_argument("--wait", type=float, default=0.0, help="seconds to wait for a request still in flight")
    a = p.parse_args(argv)

    try:
        gw = Gateway(a.url)
        if a.cmd == "status":
            st = gw.status()
            print(f"bvsala gateway {st.version} at {gw.url}")
            print(f"  upstream: {st.upstream}")
            vence = f", expires {st.license_expires_at}" if st.license_expires_at else ""
            print(f"  license:  {st.license_state} ({st.license_plan or 'unknown plan'}{vence})")
            print(f"  metering: {'on' if st.metering else 'off (no BIVELIO_SERVICE_KEY)'}")
            return 0 if st.serving else 2
        informe = gw.report(a.id, wait=a.wait)
        print(json.dumps(
            {
                "requestId": informe.request_id,
                "responseId": informe.response_id,
                "path": informe.path,
                "status": informe.status,
                "reason": informe.reason,
                "report": informe.raw_report,
            },
            indent=2,
        ))
        return 0
    except LicenseInactive as e:
        print(f"license {e.state}: {e}", file=sys.stderr)
        return 2
    except GatewayUnavailable as e:
        print(str(e), file=sys.stderr)
        return 3
    except ReportNotFound as e:
        print(str(e), file=sys.stderr)
        return 4
    except (BvsalaError, ValueError) as e:
        print(str(e), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
