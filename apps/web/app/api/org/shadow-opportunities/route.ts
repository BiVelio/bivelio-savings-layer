import { NextResponse } from "next/server";

import { getShadowByModel, getUsageRollups } from "@/app/[locale]/dashboard/data";
import { cortarPorPeriodo } from "@/app/[locale]/dashboard/explorer-datos";
import {
  deriveOpportunities,
  opportunityExportCsv,
  opportunityExportJson,
} from "@/app/[locale]/dashboard/opportunities";
import { RANGOS, type Rango } from "@/app/[locale]/dashboard/rango";
import { contextoDeLaOrg } from "@/lib/org/guardia";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const params = new URL(req.url).searchParams;
  const format = params.get("format") ?? "csv";
  const rangeParam = params.get("range") ?? "120";
  if (format !== "csv" && format !== "json") {
    return NextResponse.json({ error: "format must be csv or json" }, { status: 400 });
  }
  if (!/^\d{1,3}$/.test(rangeParam) || !(RANGOS as readonly number[]).includes(Number(rangeParam))) {
    return NextResponse.json({ error: "range must be 30, 90 or 120" }, { status: 400 });
  }
  const range = Number(rangeParam) as Rango;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  const admin = createAdminClient();
  const guard = await contextoDeLaOrg(admin, user.id, "ver_panel");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const [usage, shadow] = await Promise.all([
    getUsageRollups(supabase, guard.orgId),
    getShadowByModel(supabase, guard.orgId, admin),
  ]);
  if (usage.failed || shadow.failed || shadow.status === "hidden") {
    return NextResponse.json({ error: "Could not read the shadow opportunities." }, { status: 503 });
  }
  if (shadow.status === "unavailable") {
    return NextResponse.json(
      { error: "Shadow opportunities by model are not available on this server yet.", code: "shadow_by_model_unavailable" },
      { status: 503 },
    );
  }

  const summary = deriveOpportunities(
    cortarPorPeriodo(shadow.rows, range),
    cortarPorPeriodo(usage.rows, range),
  );
  const generatedAt = new Date().toISOString();
  const common = { "cache-control": "private, no-store" };
  if (format === "json") {
    return new Response(`${JSON.stringify(opportunityExportJson(summary, range, generatedAt), null, 2)}\n`, {
      status: 200,
      headers: {
        ...common,
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="shadow-opportunities-${range}d.json"`,
      },
    });
  }
  return new Response(opportunityExportCsv(summary, range, generatedAt), {
    status: 200,
    headers: {
      ...common,
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="shadow-opportunities-${range}d.csv"`,
    },
  });
}
