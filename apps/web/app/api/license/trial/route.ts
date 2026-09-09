import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";

import { loadPrivateKey, signCompact } from "@/lib/license/sign";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolverOrgDelUsuario } from "@/lib/org/resolver";

/**
 * Internal / pilot license issuance. BV-SALA is PAID: there is NO free tier and NO
 * self-serve trial. This endpoint mints a signed license ONLY for an allow-listed
 * owner/pilot email (`LICENSE_ISSUER_EMAILS`, comma-separated) — fail-closed if the
 * env is unset, so nobody can self-issue by default. Everyone else gets a 402: paid
 * checkout is coming online via Stripe, which will replace this route.
 *
 * The Ed25519 PRIVATE signing key lives ONLY server-side (`LICENSE_PRIVATE_KEY_B64`
 * / `LICENSE_PRIVATE_KEY`); signing goes through the shared `lib/license/sign` helper.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LICENSE_HEADER = { alg: "EdDSA", typ: "BVL", v: 1 } as const;
const ISSUE_DAYS = 90; // internal/pilot window; revoke early via /api/license/revoke

/**
 * ¿Por qué esta cuenta no tiene licencia? Son dos casos con acciones OPUESTAS y
 * confundirlos cuesta dinero: a quien ya pagó no se le puede sugerir que vuelva a
 * pagar, y a quien no tiene suscripción no se le puede decir que espere.
 *
 * Fail-safe hacia el caso menos dañino: si la consulta falla, se responde «el pago
 * se está procesando», que como mucho hace esperar de más — nunca provoca un
 * segundo cobro.
 */
async function motivoSinLicencia(userId: string): Promise<"pago_en_curso" | "sin_suscripcion"> {
  try {
    const admin = createAdminClient();
    // Sin la siembra CP-0: las organizaciones son las que constan por PERTENENCIA.
    // (Aquí el impacto es solo el mensaje que se le enseña a quien no tiene
    // licencia, no una entrega de credencial — pero la regla debe ser la misma en
    // todo el producto, o vuelve a haber dos verdades.)
    const orgIds = new Set<string>();
    const { data: miembro } = await admin.from("org_members").select("org_id").eq("user_id", userId);
    for (const fila of (miembro as { org_id?: string }[] | null) ?? []) {
      if (fila.org_id) orgIds.add(fila.org_id);
    }
    // SIN PERTENENCIAS SE RESPONDE «pago en curso», Y ES DELIBERADO. Es justo el
    // hueco entre pagar y que el webhook escriba la organización: quien acaba de
    // comprar no tiene todavía ninguna, y decirle «no tienes suscripción» le
    // invita a comprar dos veces. La respuesta correcta es que espere.
    //
    // Antes esto salía bien POR ACCIDENTE: `.in("org_id", [])` genera `in.()`, que
    // PostgREST rechaza con un 400, y el `error` caía en la misma rama. Un accidente
    // no es una decisión — el día que PostgREST devolviese `[]` en vez de un error,
    // la respuesta se habría dado la vuelta hacia el lado caro, en silencio.
    if (orgIds.size === 0) return "pago_en_curso";
    const { data: sub, error } = await admin
      .from("subscriptions")
      .select("status")
      .in("org_id", [...orgIds])
      .in("status", ["incomplete", "active", "trialing", "past_due"])
      .limit(1)
      .maybeSingle();
    if (error) return "pago_en_curso";
    return sub ? "pago_en_curso" : "sin_suscripcion";
  } catch {
    return "pago_en_curso";
  }
}

/** Emails allowed to self-issue a license (owner + pilots). Fail-closed if unset. */
function issuerAllowList(): Set<string> {
  return new Set(
    (process.env.LICENSE_ISSUER_EMAILS ?? "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
}

export async function POST() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  // Paid product: esta ruta interna solo emite a la allow-list del dueño. El resto
  // llega aquí porque `/api/license/current` no encontró licencia, y hay DOS
  // motivos muy distintos que hay que saber distinguir.
  //
  // Antes se respondía con una frase fija en inglés — «Subscription checkout is
  // coming online — self-serve license keys aren't issued yet» — que era copia
  // fósil de cuando el checkout no existía. O sea que en el momento exacto en que
  // un cliente pagaba y venía a por su llave, el producto le decía que todavía no
  // podía vendérsela. Ahora se devuelve un CÓDIGO y el cliente lo traduce al
  // idioma del usuario con un mensaje que además dice qué hacer.
  const email = (user.email ?? "").toLowerCase();
  if (!issuerAllowList().has(email)) {
    return NextResponse.json(
      { code: await motivoSinLicencia(user.id) },
      { status: 402 },
    );
  }

  const privateKey = loadPrivateKey();
  if (!privateKey) {
    return NextResponse.json(
      { error: "License issuance isn't configured yet (LICENSE_PRIVATE_KEY missing)." },
      { status: 501 },
    );
  }

  // LA ORGANIZACIÓN, ANTES DE FIRMAR. El `org_id` viaja FIRMADO dentro del token y
  // el SDK descarta en silencio cualquier renovación cuyo org no case
  // (`src/license/refresher.ts:155`), así que no se puede decidir después: antes se
  // firmaba con `user.id` y solo luego se hacía `upsert({ id: user.id })` para que
  // la clave ajena cuadrase. Esa pareja solo funcionaba mientras las dos mitades
  // dijeran la misma mentira. Ahora se resuelve primero y se firma lo resuelto.
  const admin = createAdminClient();
  let orgId: string;
  try {
    orgId = (await resolverOrgDelUsuario(admin, user.id)).orgId;
  } catch (err) {
    console.error("[license/issue] org resolve failed:", err);
    return NextResponse.json({ error: "Could not issue the license." }, { status: 503 });
  }

  const now = Math.floor(Date.now() / 1000);
  // ANILLO-0. LOS DOS features de elisión viven AQUÍ —la ruta interna, cerrada a la
  // allow-list del dueño— y NO en `PRO_FEATURES` (lib/license/issue.ts), la lista que
  // firma Stripe. Son canales distintos para los dos caminos de elisión:
  //   · `tool_result_elision` → supersesión EN VIVO del SDK (`pipeline.ts` lo exige en
  //     el token, verificado offline). Sirve a las apps que consumen la API.
  //   · `context_elision` → dial S4a del gateway del terminal (`bvsala`), que lo lee de
  //     la fila `licenses` por el endpoint `/api/org/entitlements`.
  // Una sola re-emisión por esta ruta arma AMBOS: el token firma `tool_result_elision`
  // y la fila persistida (abajo) gana `context_elision`.
  //
  // ACTUALIZACIÓN (0023): la decisión deliberada que este comentario reclamaba YA SE
  // TOMÓ. `context_elision` y `cache_ttl_tuning` están ahora TAMBIÉN en PRO_FEATURES —
  // eran palancas de producto vendidas y estructuralmente inalcanzables, porque el
  // canal de entitlements es fail-closed y el cliente de pago no las llevaba en su
  // fila. `tool_result_elision` SIGUE siendo solo del anillo interno: vive en la
  // verificación offline del SDK, no en el gateway, y su superficie es otra.
  const features = [
    "semantic_cache",
    "dashboards",
    "long_context_compression",
    "tool_result_elision",
    "context_elision",
    "cache_ttl_tuning",
    // Palanca C · el anillo interno la lleva por la misma razón que las otras dos.
    "sibling_model_routing",
  ];
  // Bare-uuid jti so it doubles as the `bvsala.licenses.id` (the table's id == jti
  // invariant). `iss: "bivelio-internal"` — not a jti prefix — is what marks it
  // internal, and the SDK matches jti by exact string, so this verifies/revokes
  // identically on already-deployed SDKs.
  const licenseId = randomUUID();
  const payload = {
    jti: licenseId,
    org_id: orgId,
    plan: "pro",
    seats: 1,
    features,
    issued_at: now,
    expires_at: now + ISSUE_DAYS * 86400,
    grace_days: 3,
    iss: "bivelio-internal",
  };

  try {
    // Stamp a key-id only when configured (byte-identical default output), so a
    // future keyset deployment can rotate the signing key without a hard cutover.
    const kid = process.env.LICENSE_KEY_ID;
    const token = signCompact({ ...LICENSE_HEADER, ...(kid ? { kid } : {}) }, payload, privateKey);

    // PERSIST before returning, or the license is unrevocable-by-org (its jti would
    // live only inside the emitted token). Use the service-role client (the anon
    // client above is RLS-blocked from writing). La organización y la pertenencia ya
    // existen: las garantizó `resolverOrgDelUsuario` arriba, que es también lo que
    // satisface la clave ajena de `licenses.org_id`. FAIL CLOSED — never return an
    // unpersisted token, else a DB hiccup silently reproduces the original leak.
    const { error: licErr } = await admin.from("licenses").insert({
      id: licenseId,
      org_id: orgId,
      plan: "pro",
      seats: 1,
      features,
      issued_at: new Date(now * 1000).toISOString(),
      expires_at: new Date(payload.expires_at * 1000).toISOString(),
      grace_days: payload.grace_days,
      token,
    });
    if (licErr) throw licErr;

    return NextResponse.json({
      token,
      plan: "pro",
      features,
      expiresAt: new Date(payload.expires_at * 1000).toISOString(),
    });
  } catch (err) {
    console.error("[license/issue] issue failed:", err);
    return NextResponse.json({ error: "Could not issue the license." }, { status: 500 });
  }
}
