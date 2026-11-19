/**
 * EL CORREO DE INVITACIÓN. El único correo que este producto manda a alguien que
 * no es el equipo de BiVelio, y por eso el único que se escribe con este cuidado.
 *
 * Va por la cuenta de Resend que la plataforma YA tiene, con el dominio
 * `bivelio.com` verificado — la misma que usa `lib/observabilidad/alerta.ts`. No
 * hay infraestructura nueva: era la condición para que las invitaciones fuesen
 * automáticas en vez de un enlace que alguien copia a mano.
 *
 * TRATAMIENTO FORMAL EN LOS DOCE IDIOMAS. Es correo B2B a alguien que no nos
 * conoce: usted / vous / Sie / siz / Lei / u / Pan-Pani / você / vostè / Anda /
 * quý vị. Ya se coló una vez un bloque en turco informal y hubo que rehacerlo.
 *
 * NO se le mete al destinatario ningún dato de la organización que no sea su
 * nombre: ni el gasto, ni los asientos, ni quién más está dentro. Un correo se
 * reenvía, y el destinatario todavía no ha aceptado nada.
 */

import { botonTinta, escapar, tarjetaClara } from "./carcasa";

export type Idioma =
  | "es" | "en" | "ca" | "de" | "fr" | "id" | "it" | "nl" | "pl" | "pt" | "tr" | "vi";

export const IDIOMAS: Idioma[] = ["es", "en", "ca", "de", "fr", "id", "it", "nl", "pl", "pt", "tr", "vi"];

interface Plantilla {
  /**
   * FIJO: sin sustituciones. El asunto es lo primero que lee un desconocido, con
   * nuestro remitente al lado, y llevaba el nombre de la organización — que lo
   * escribe el usuario. «URGENT: your invoice is overdue, pay at …» como nombre
   * salía tal cual de asunto. Quien invita ya no elige ni una palabra de él.
   */
  asunto: string;
  saludo: string;
  /** `{quien}` = quien invita, `{org}` = la organización, `{rol}` = el rol. */
  cuerpo: string;
  boton: string;
  /** `{dias}` */
  caduca: string;
  /** Para quien no esperaba nada: qué hacer. */
  ignorar: string;
  roles: Record<string, string>;
}

const T: Record<Idioma, Plantilla> = {
  es: {
    asunto: "Invitación a un equipo en BiVelio",
    saludo: "Hola:",
    cuerpo: "{quien} le ha invitado a unirse a <b>{org}</b> en BiVelio, con el perfil de <b>{rol}</b>.",
    boton: "Aceptar la invitación",
    caduca: "El enlace caduca en {dias} días.",
    ignorar: "Si no esperaba esta invitación, puede ignorar este mensaje: no se hará nada.",
    roles: { admin: "administrador", member: "miembro", billing: "facturación" },
  },
  en: {
    asunto: "Invitation to join a team on BiVelio",
    saludo: "Hello,",
    cuerpo: "{quien} has invited you to join <b>{org}</b> on BiVelio as <b>{rol}</b>.",
    boton: "Accept the invitation",
    caduca: "This link expires in {dias} days.",
    ignorar: "If you weren't expecting this invitation, you can ignore this message — nothing will happen.",
    roles: { admin: "an administrator", member: "a member", billing: "billing" },
  },
  ca: {
    asunto: "Invitació a un equip a BiVelio",
    saludo: "Hola,",
    cuerpo: "{quien} us ha convidat a unir-vos a <b>{org}</b> a BiVelio, amb el perfil d'<b>{rol}</b>.",
    boton: "Acceptar la invitació",
    caduca: "L'enllaç caduca d'aquí a {dias} dies.",
    ignorar: "Si no esperàveu aquesta invitació, podeu ignorar aquest missatge: no es farà res.",
    roles: { admin: "administrador", member: "membre", billing: "facturació" },
  },
  de: {
    asunto: "Einladung zu einem Team bei BiVelio",
    saludo: "Guten Tag,",
    cuerpo: "{quien} hat Sie eingeladen, <b>{org}</b> bei BiVelio als <b>{rol}</b> beizutreten.",
    boton: "Einladung annehmen",
    caduca: "Der Link läuft in {dias} Tagen ab.",
    ignorar: "Wenn Sie diese Einladung nicht erwartet haben, können Sie diese Nachricht ignorieren — es geschieht nichts.",
    roles: { admin: "Administrator", member: "Mitglied", billing: "Buchhaltung" },
  },
  fr: {
    asunto: "Invitation à rejoindre une équipe sur BiVelio",
    saludo: "Bonjour,",
    cuerpo: "{quien} vous invite à rejoindre <b>{org}</b> sur BiVelio en tant que <b>{rol}</b>.",
    boton: "Accepter l'invitation",
    caduca: "Ce lien expire dans {dias} jours.",
    ignorar: "Si vous n'attendiez pas cette invitation, vous pouvez ignorer ce message : rien ne se passera.",
    roles: { admin: "administrateur", member: "membre", billing: "facturation" },
  },
  id: {
    asunto: "Undangan untuk bergabung dengan tim di BiVelio",
    saludo: "Halo,",
    cuerpo: "{quien} mengundang Anda untuk bergabung dengan <b>{org}</b> di BiVelio sebagai <b>{rol}</b>.",
    boton: "Terima undangan",
    caduca: "Tautan ini kedaluwarsa dalam {dias} hari.",
    ignorar: "Jika Anda tidak mengharapkan undangan ini, Anda dapat mengabaikan pesan ini — tidak ada yang akan terjadi.",
    roles: { admin: "administrator", member: "anggota", billing: "penagihan" },
  },
  it: {
    asunto: "Invito a unirsi a un team su BiVelio",
    saludo: "Buongiorno,",
    cuerpo: "{quien} La invita a unirsi a <b>{org}</b> su BiVelio come <b>{rol}</b>.",
    boton: "Accetta l'invito",
    caduca: "Il link scade tra {dias} giorni.",
    ignorar: "Se non attendeva questo invito, può ignorare questo messaggio: non accadrà nulla.",
    roles: { admin: "amministratore", member: "membro", billing: "fatturazione" },
  },
  nl: {
    asunto: "Uitnodiging voor een team op BiVelio",
    saludo: "Goedendag,",
    cuerpo: "{quien} nodigt u uit om lid te worden van <b>{org}</b> op BiVelio als <b>{rol}</b>.",
    boton: "Uitnodiging accepteren",
    caduca: "Deze link verloopt over {dias} dagen.",
    ignorar: "Als u deze uitnodiging niet verwachtte, kunt u dit bericht negeren — er gebeurt niets.",
    roles: { admin: "beheerder", member: "lid", billing: "facturatie" },
  },
  pl: {
    asunto: "Zaproszenie do zespołu w BiVelio",
    saludo: "Dzień dobry,",
    cuerpo: "{quien} zaprasza Państwa do dołączenia do <b>{org}</b> w BiVelio w roli: <b>{rol}</b>.",
    boton: "Przyjmij zaproszenie",
    caduca: "Link wygasa za {dias} dni.",
    ignorar: "Jeśli nie spodziewali się Państwo tego zaproszenia, można zignorować tę wiadomość — nic się nie stanie.",
    roles: { admin: "administrator", member: "członek", billing: "rozliczenia" },
  },
  pt: {
    asunto: "Convite para uma equipa na BiVelio",
    saludo: "Olá,",
    cuerpo: "{quien} convidou-o para se juntar a <b>{org}</b> na BiVelio como <b>{rol}</b>.",
    boton: "Aceitar o convite",
    caduca: "A ligação expira dentro de {dias} dias.",
    ignorar: "Se não estava à espera deste convite, pode ignorar esta mensagem — não acontecerá nada.",
    roles: { admin: "administrador", member: "membro", billing: "faturação" },
  },
  tr: {
    asunto: "BiVelio'da bir ekibe davet",
    saludo: "Merhaba,",
    cuerpo: "{quien}, sizi BiVelio'da <b>{org}</b> kuruluşuna <b>{rol}</b> olarak katılmaya davet etti.",
    boton: "Daveti kabul edin",
    caduca: "Bu bağlantının süresi {dias} gün içinde dolar.",
    ignorar: "Bu daveti beklemiyorsanız bu mesajı yok sayabilirsiniz — hiçbir şey olmayacaktır.",
    roles: { admin: "yönetici", member: "üye", billing: "faturalandırma" },
  },
  vi: {
    asunto: "Lời mời tham gia một nhóm trên BiVelio",
    saludo: "Xin chào,",
    cuerpo: "{quien} đã mời quý vị tham gia <b>{org}</b> trên BiVelio với vai trò <b>{rol}</b>.",
    boton: "Chấp nhận lời mời",
    caduca: "Liên kết này sẽ hết hạn sau {dias} ngày.",
    ignorar: "Nếu quý vị không mong đợi lời mời này, có thể bỏ qua tin nhắn này — sẽ không có gì xảy ra.",
    roles: { admin: "quản trị viên", member: "thành viên", billing: "thanh toán" },
  },
};

export function idiomaValido(x: string | null | undefined): Idioma {
  return (IDIOMAS as string[]).includes(x ?? "") ? (x as Idioma) : "es";
}

/** El escape vive ahora en la carcasa compartida (carcasa.ts); se re-exporta
 *  desde aquí para no mover a los importadores existentes. */
export { escapar };

/** Lo más largo que puede salir el nombre de la organización en el correo. */
export const MAX_NOMBRE_EN_CORREO = 60;

/**
 * EL NOMBRE DE LA ORGANIZACIÓN, TAL COMO PUEDE IR EN UN CORREO A UN TERCERO.
 *
 * Lo escribe el usuario y sale con nuestro remitente, así que no puede llevar
 * nada que un cliente de correo convierta en ENLACE (los clientes enlazan solos
 * cualquier cosa con forma de URL, de dominio o de dirección), ni ser tan largo
 * que quepa un mensaje entero. Se le quitan los esquemas (`https://`), las
 * arrobas y el punto de lo que parezca un dominio («evil.example» → «evil
 * example»), y se recorta. Un nombre normal —«Acme S.L.», «Talleres Ruiz»— pasa
 * intacto.
 */
export function nombreParaCorreo(crudo: string): string {
  const limpio = crudo
    .normalize("NFKC")
    // Controles e invisibles (incluidos los de dirección de texto).
    .replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202f\u2060-\u2069\ufeff]/g, " ")
    .replace(/[a-z][a-z0-9+.-]*:\/\//gi, " ")
    .replace(/[@/\\]/g, " ")
    // Punto seguido de dos o más letras o cifras = forma de dominio. «S.L.» y
    // «S.A.» no lo son (una sola letra entre puntos).
    .replace(/(?<=[\p{L}\p{N}])[.。．｡](?=[\p{L}\p{N}-]{2,})/gu, " ")
    .replace(/(?<=\p{N})[.:](?=\p{N})/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const corto = Array.from(limpio).slice(0, MAX_NOMBRE_EN_CORREO).join("").trim();
  return corto || "BiVelio";
}

export interface DatosInvitacion {
  org: string;
  quienInvita: string;
  rol: string;
  enlace: string;
  dias: number;
  idioma: Idioma;
}

export interface CorreoCompuesto {
  asunto: string;
  html: string;
  texto: string;
}

/**
 * Compone el correo. Función PURA: no manda nada, así que se puede probar el
 * contenido —incluido que el nombre de la organización va escapado— sin red.
 */
export function componerInvitacion(d: DatosInvitacion): CorreoCompuesto {
  const t = T[d.idioma];
  const org = escapar(nombreParaCorreo(d.org));
  const quien = escapar(d.quienInvita);
  const rol = escapar(t.roles[d.rol] ?? d.rol);

  const asunto = t.asunto; // fijo de plantilla: nada del usuario (ver `Plantilla.asunto`)
  const cuerpo = t.cuerpo.replace("{quien}", quien).replace("{org}", org).replace("{rol}", rol);
  const caduca = t.caduca.replace("{dias}", String(d.dias));

  // La tarjeta de marca compartida (carcasa.ts): el dueño cazó esta plantilla
  // desnuda el mismo día que la de auth (02-09). El enlace solo en el botón
  // (pedido del 2026-08-27): el respaldo para clientes sin HTML es el texto
  // plano, que lleva la URL entera.
  const html = tarjetaClara({
    nombreMarca: "Savings",
    logoUrl: "https://savings.bivelio.com/correo/logo-savings.png",
    dominio: "savings.bivelio.com",
    titulo: asunto,
    saludo: t.saludo,
    cuerpoHtml: cuerpo,
    accionHtml: botonTinta(d.enlace, t.boton),
    letraPequena: [caduca, t.ignorar],
    pie: "BiVelio",
  });

  const texto = [
    t.saludo,
    "",
    cuerpo.replace(/<\/?b>/g, ""),
    "",
    d.enlace,
    "",
    caduca,
    t.ignorar,
    "",
    "BiVelio · savings.bivelio.com",
  ].join("\n");

  return { asunto, html, texto };
}

/** El remitente. `no-reply@` porque nadie lee las respuestas a este buzón, y
 *  `reply_to` apunta al soporte real para que quien conteste llegue a alguien. */
const REMITENTE = "BiVelio <no-reply@bivelio.com>";
const RESPUESTAS = "support@bivelio.com";

export type ResultadoEnvio = { ok: true } | { ok: false; motivo: string };

/**
 * Manda el correo. NUNCA lanza: quien llama ya ha creado la invitación en la base,
 * y que el correo no salga no puede deshacer eso ni devolver un 500 — se le dice
 * a quien invita que lo reenvíe, que es una operación que existe.
 */
export async function enviarInvitacion(
  d: DatosInvitacion,
  destinatario: string,
): Promise<ResultadoEnvio> {
  const clave = process.env.RESEND_API_KEY;
  if (!clave) return { ok: false, motivo: "sin_configurar" };

  const { asunto, html, texto } = componerInvitacion(d);
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${clave}`, "content-type": "application/json" },
      body: JSON.stringify({
        from: REMITENTE,
        reply_to: RESPUESTAS,
        to: [destinatario],
        subject: asunto,
        html,
        text: texto,
      }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return { ok: false, motivo: `resend_${res.status}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, motivo: err instanceof Error ? err.name : "desconocido" };
  }
}
