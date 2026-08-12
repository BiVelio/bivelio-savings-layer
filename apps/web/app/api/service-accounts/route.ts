import { createHash, randomBytes } from "node:crypto";
import { NextResponse } from "next/server";

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolverOrgSiExiste, resolverOrgDelUsuario } from "@/lib/org/resolver";

/**
 * Mint a service-account key (bvk_…) for the signed-in user's org. This is the
 * machine credential the SDK uses to report usage (and, later, pull a rotated
 * license). Only the sha256 HASH + prefix are stored; the plaintext is returned
 * ONCE. La organización se RESUELVE por pertenencia (`lib/org/resolver`) y se crea
 * con identidad propia si el usuario no tiene ninguna: ya no se asume que el id de
 * la organización sea el del usuario.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<NextResponse> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Sign in to create a key." }, { status: 401 });

  let body: { label?: string } = {};
  try {
    body = (await req.json()) as { label?: string };
  } catch {
    // no body is fine
  }
  const label = typeof body.label === "string" && body.label.trim() ? body.label.trim().slice(0, 64) : "default";

  const token = `bvk_${randomBytes(24).toString("base64url")}`;
  const keyHash = createHash("sha256").update(token).digest("hex");
  const keyPrefix = token.slice(0, 12); // "bvk_" + 8 chars, for display

  const admin = createAdminClient();

  // LA ORGANIZACIÓN SE RESUELVE, NO SE ASUME.
  //
  // Antes esto era `upsert({ id: user.id })`, y la trampa estaba en el `upsert`:
  // funcionaba solo mientras el id de la organización FUESE el del usuario. En
  // cuanto una organización nace con un uuid propio —que es lo que hace ya el
  // checkout de Stripe— deja de haber conflicto que absorber, así que el upsert
  // no encuentra nada: CREA UNA SEGUNDA organización, vacía, y le cuelga la clave
  // `bvk_`. La flota del cliente se autentica entonces contra una organización sin
  // suscripción y sin licencia, y se apaga fail-closed semanas después sin un solo
  // error visible. Es el fallo más caro que puede tener este producto.
  //
  // Falla CERRADA: si no se puede resolver ni crear, 503 y que el cliente
  // reintente. Nunca se acuña una clave contra una organización adivinada.
  let orgId: string;
  try {
    orgId = (await resolverOrgDelUsuario(admin, user.id)).orgId;
  } catch (err) {
    console.error("[service-accounts] org resolve failed:", err);
    return NextResponse.json({ error: "could not set up your workspace" }, { status: 503 });
  }

  const { error } = await admin
    .from("service_accounts")
    .insert({ org_id: orgId, label, key_hash: keyHash, key_prefix: keyPrefix });
  if (error) {
    console.error("[service-accounts] insert failed:", error);
    return NextResponse.json({ error: "could not create key" }, { status: 500 });
  }

  return NextResponse.json({ key: token, keyPrefix, label }, { status: 201 });
}

/**
 * Las claves de servicio VIVAS de la org (nunca el secreto: solo prefijo y uso).
 * El panel las necesita para poder ofrecer revocarlas.
 */
export async function GET(): Promise<NextResponse> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  const admin = createAdminClient();
  const org = await resolverOrgSiExiste(admin, user.id);
  if (!org) return NextResponse.json({ keys: [] });
  const { data, error } = await admin
    .from("service_accounts")
    .select("id, label, key_prefix, last_used_at, created_at")
    .eq("org_id", org.orgId)
    .order("created_at", { ascending: false });
  if (error) {
    console.error("[service-accounts] list failed:", error);
    return NextResponse.json({ error: "could not list keys" }, { status: 503 });
  }
  return NextResponse.json({ keys: data ?? [] });
}

/**
 * REVOCAR una clave de servicio. No existía, y su ausencia era un no rotundo en
 * cualquier revisión de seguridad B2B: la `bvk_` es la credencial que descarga la
 * licencia COMPLETA de la organización (ver `/api/license/current`), y si un
 * empleado se iba con ella en el portátil el cliente no tenía forma de
 * desactivarla. Podía acuñar otra, pero la vieja seguía viva y seguía sirviendo
 * la licencia.
 *
 * Se BORRA la fila en vez de marcarla. Se puede: nada en el esquema referencia
 * `service_accounts` (el historial de facturación cuelga de `seat_activity`, que
 * referencia la ORGANIZACIÓN), así que revocar no destruye ni un dato de uso. Y
 * borrar hace imposible el fallo clásico de un borrado lógico: que a alguien se
 * le olvide filtrar por `revoked` en una de las dos rutas que autentican con esta
 * clave y la credencial siga sirviendo. El rastro queda en `billing_audit`.
 */
export async function DELETE(req: Request): Promise<NextResponse> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  let body: { id?: string } = {};
  try {
    body = (await req.json()) as { id?: string };
  } catch {
    /* sin cuerpo */
  }
  const id = typeof body.id === "string" ? body.id.trim() : "";
  if (!id) return NextResponse.json({ error: "Which key?" }, { status: 400 });

  const admin = createAdminClient();
  const org = await resolverOrgSiExiste(admin, user.id);
  // Sin organización no hay nada que revocar — y sobre todo, NO se borra por id a
  // secas: ese `.eq("org_id", …)` es el ÚNICO control que impide borrar la clave
  // de otro cliente, y ahora lleva la organización RESUELTA, no el user id.
  if (!org) return NextResponse.json({ error: "No such key in your account." }, { status: 404 });
  const { data, error } = await admin
    .from("service_accounts")
    .delete()
    .eq("id", id)
    .eq("org_id", org.orgId)
    .select("id, key_prefix");
  if (error) {
    console.error("[service-accounts] revoke failed:", error);
    return NextResponse.json({ error: "could not revoke the key" }, { status: 503 });
  }
  const borrada = (data ?? [])[0] as { id?: string; key_prefix?: string } | undefined;
  // 404 y no 200: si el id no era de esta org, el cliente tiene que saber que NO
  // ha revocado nada. Un 200 vacío le haría creer que la clave está muerta.
  if (!borrada) return NextResponse.json({ error: "No such key in your account." }, { status: 404 });

  try {
    await admin.from("billing_audit").insert({
      org_id: org.orgId,
      event_id: `sa_revoke_${Date.now()}`,
      kind: "service_account_revoked",
      detail: { keyPrefix: borrada.key_prefix },
    });
  } catch (err) {
    // El rastro es deseable, no imprescindible: la clave YA está revocada y eso
    // es lo que importa. No se deshace por no poder anotarlo.
    console.error("[service-accounts] audit insert failed:", err);
  }

  return NextResponse.json({ revoked: borrada.key_prefix ?? id });
}
