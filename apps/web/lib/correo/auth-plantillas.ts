import { escapar, type Idioma, type CorreoCompuesto } from "./invitacion";
import type { AccionAuth, Producto } from "./auth-hook";

/**
 * LAS PLANTILLAS DE LOS CORREOS DE AUTH — la mitad visible del hook.
 *
 * El reparto que separa productos SIN triplicar traducciones: la COPY es de la
 * plataforma («su cuenta de BiVelio») y se comparte en los doce idiomas con el
 * mismo tratamiento formal que los correos de invitación; lo que distingue a
 * cada producto es la CARCASA (savings y privacy, la clara de la casa; GPOS
 * conserva su carcasa oscura, portada de la plantilla que vivía en Supabase) y
 * el pie con su dominio.
 *
 * Tres juegos de copy y no uno por cada tipo de acción de GoTrue: `signup` y
 * `recovery` son los dos flujos que las apps ofrecen hoy; todo lo demás
 * (magiclink, invite, email_change, reauthentication…) cae en el genérico,
 * que enlaza si hay token_hash y muestra el código si lo que llega es un
 * código. Un tipo desconocido NUNCA deja al usuario sin correo.
 */

interface CopyAuth {
  asunto: string;
  saludo: string;
  cuerpo: string;
  boton: string;
  /** La letra pequeña de seguridad: caduca y es de un solo uso. */
  seguridad: string;
  ignorar: string;
}

type Juego = Record<Idioma, CopyAuth>;

const CONFIRMAR: Juego = {
  es: {
    asunto: "Confirme su correo en BiVelio",
    saludo: "Hola:",
    cuerpo: "Gracias por crear su cuenta de BiVelio. Confirme su dirección de correo para activarla.",
    boton: "Confirmar correo",
    seguridad: "Por seguridad, el enlace caduca y solo puede usarse una vez.",
    ignorar: "Si no ha creado ninguna cuenta, ignore este mensaje: no se hará nada.",
  },
  en: {
    asunto: "Confirm your email on BiVelio",
    saludo: "Hello,",
    cuerpo: "Thanks for creating your BiVelio account. Confirm your email address to activate it.",
    boton: "Confirm email",
    seguridad: "For security, this link expires and can only be used once.",
    ignorar: "If you didn't create an account, you can ignore this message — nothing will happen.",
  },
  ca: {
    asunto: "Confirmeu el vostre correu a BiVelio",
    saludo: "Hola,",
    cuerpo: "Gràcies per crear el vostre compte de BiVelio. Confirmeu la vostra adreça de correu per activar-lo.",
    boton: "Confirmar el correu",
    seguridad: "Per seguretat, l'enllaç caduca i només es pot fer servir una vegada.",
    ignorar: "Si no heu creat cap compte, ignoreu aquest missatge: no es farà res.",
  },
  de: {
    asunto: "Bestätigen Sie Ihre E-Mail-Adresse bei BiVelio",
    saludo: "Guten Tag,",
    cuerpo: "Vielen Dank für die Erstellung Ihres BiVelio-Kontos. Bestätigen Sie Ihre E-Mail-Adresse, um es zu aktivieren.",
    boton: "E-Mail bestätigen",
    seguridad: "Aus Sicherheitsgründen läuft der Link ab und kann nur einmal verwendet werden.",
    ignorar: "Wenn Sie kein Konto erstellt haben, ignorieren Sie diese Nachricht — es geschieht nichts.",
  },
  fr: {
    asunto: "Confirmez votre adresse e-mail sur BiVelio",
    saludo: "Bonjour,",
    cuerpo: "Merci d'avoir créé votre compte BiVelio. Confirmez votre adresse e-mail pour l'activer.",
    boton: "Confirmer l'e-mail",
    seguridad: "Pour des raisons de sécurité, ce lien expire et ne peut être utilisé qu'une seule fois.",
    ignorar: "Si vous n'avez créé aucun compte, ignorez ce message — rien ne se passera.",
  },
  id: {
    asunto: "Konfirmasi email Anda di BiVelio",
    saludo: "Halo,",
    cuerpo: "Terima kasih telah membuat akun BiVelio Anda. Konfirmasi alamat email Anda untuk mengaktifkannya.",
    boton: "Konfirmasi email",
    seguridad: "Demi keamanan, tautan ini kedaluwarsa dan hanya dapat digunakan satu kali.",
    ignorar: "Jika Anda tidak membuat akun, abaikan pesan ini — tidak akan terjadi apa-apa.",
  },
  it: {
    asunto: "Confermi la Sua email su BiVelio",
    saludo: "Buongiorno,",
    cuerpo: "Grazie per aver creato il Suo account BiVelio. Confermi il Suo indirizzo email per attivarlo.",
    boton: "Conferma email",
    seguridad: "Per sicurezza, il link scade e può essere usato una sola volta.",
    ignorar: "Se non ha creato alcun account, ignori questo messaggio: non accadrà nulla.",
  },
  nl: {
    asunto: "Bevestig uw e-mailadres op BiVelio",
    saludo: "Goedendag,",
    cuerpo: "Bedankt voor het aanmaken van uw BiVelio-account. Bevestig uw e-mailadres om het te activeren.",
    boton: "E-mail bevestigen",
    seguridad: "Om veiligheidsredenen verloopt deze link en kan hij maar één keer worden gebruikt.",
    ignorar: "Als u geen account hebt aangemaakt, kunt u dit bericht negeren — er gebeurt niets.",
  },
  pl: {
    asunto: "Potwierdzenie adresu e-mail w BiVelio",
    saludo: "Dzień dobry,",
    cuerpo: "Dziękujemy za utworzenie konta BiVelio. Prosimy potwierdzić adres e-mail, aby je aktywować.",
    boton: "Potwierdź e-mail",
    seguridad: "Ze względów bezpieczeństwa link wygasa i może zostać użyty tylko raz.",
    ignorar: "Jeśli konto nie zostało utworzone przez Pana/Panią, prosimy zignorować tę wiadomość — nic się nie stanie.",
  },
  pt: {
    asunto: "Confirme o seu e-mail no BiVelio",
    saludo: "Olá,",
    cuerpo: "Obrigado por criar a sua conta BiVelio. Confirme o seu endereço de e-mail para a ativar.",
    boton: "Confirmar e-mail",
    seguridad: "Por segurança, esta ligação expira e só pode ser usada uma vez.",
    ignorar: "Se não criou nenhuma conta, ignore esta mensagem — nada acontecerá.",
  },
  tr: {
    asunto: "BiVelio'da e-postanızı doğrulayın",
    saludo: "Merhaba,",
    cuerpo: "BiVelio hesabınızı oluşturduğunuz için teşekkür ederiz. Etkinleştirmek için e-posta adresinizi doğrulayın.",
    boton: "E-postayı doğrula",
    seguridad: "Güvenlik nedeniyle bu bağlantının süresi dolar ve yalnızca bir kez kullanılabilir.",
    ignorar: "Bir hesap oluşturmadıysanız bu mesajı yok sayabilirsiniz — hiçbir şey olmaz.",
  },
  vi: {
    asunto: "Xác nhận email của quý vị trên BiVelio",
    saludo: "Xin chào,",
    cuerpo: "Cảm ơn quý vị đã tạo tài khoản BiVelio. Vui lòng xác nhận địa chỉ email để kích hoạt tài khoản.",
    boton: "Xác nhận email",
    seguridad: "Vì lý do bảo mật, liên kết này sẽ hết hạn và chỉ dùng được một lần.",
    ignorar: "Nếu quý vị không tạo tài khoản nào, hãy bỏ qua thư này — sẽ không có gì xảy ra.",
  },
};

const RECUPERAR: Juego = {
  es: {
    asunto: "Restablecer la contraseña de BiVelio",
    saludo: "Hola:",
    cuerpo: "Hemos recibido una solicitud para restablecer la contraseña de su cuenta de BiVelio. Pulse el botón para elegir una nueva.",
    boton: "Restablecer contraseña",
    seguridad: "Por seguridad, el enlace caduca y solo puede usarse una vez.",
    ignorar: "Si no lo ha solicitado, ignore este mensaje: su contraseña no cambiará.",
  },
  en: {
    asunto: "Reset your BiVelio password",
    saludo: "Hello,",
    cuerpo: "We received a request to reset the password of your BiVelio account. Click the button to choose a new one.",
    boton: "Reset password",
    seguridad: "For security, this link expires and can only be used once.",
    ignorar: "If you didn't request this, you can ignore this message — your password won't change.",
  },
  ca: {
    asunto: "Restablir la contrasenya de BiVelio",
    saludo: "Hola,",
    cuerpo: "Hem rebut una sol·licitud per restablir la contrasenya del vostre compte de BiVelio. Premeu el botó per triar-ne una de nova.",
    boton: "Restablir la contrasenya",
    seguridad: "Per seguretat, l'enllaç caduca i només es pot fer servir una vegada.",
    ignorar: "Si no ho heu sol·licitat, ignoreu aquest missatge: la vostra contrasenya no canviarà.",
  },
  de: {
    asunto: "Ihr BiVelio-Passwort zurücksetzen",
    saludo: "Guten Tag,",
    cuerpo: "Wir haben eine Anfrage erhalten, das Passwort Ihres BiVelio-Kontos zurückzusetzen. Klicken Sie auf die Schaltfläche, um ein neues zu wählen.",
    boton: "Passwort zurücksetzen",
    seguridad: "Aus Sicherheitsgründen läuft der Link ab und kann nur einmal verwendet werden.",
    ignorar: "Wenn Sie dies nicht angefordert haben, ignorieren Sie diese Nachricht — Ihr Passwort ändert sich nicht.",
  },
  fr: {
    asunto: "Réinitialiser votre mot de passe BiVelio",
    saludo: "Bonjour,",
    cuerpo: "Nous avons reçu une demande de réinitialisation du mot de passe de votre compte BiVelio. Cliquez sur le bouton pour en choisir un nouveau.",
    boton: "Réinitialiser le mot de passe",
    seguridad: "Pour des raisons de sécurité, ce lien expire et ne peut être utilisé qu'une seule fois.",
    ignorar: "Si vous n'êtes pas à l'origine de cette demande, ignorez ce message — votre mot de passe ne changera pas.",
  },
  id: {
    asunto: "Atur ulang kata sandi BiVelio Anda",
    saludo: "Halo,",
    cuerpo: "Kami menerima permintaan untuk mengatur ulang kata sandi akun BiVelio Anda. Klik tombol untuk memilih yang baru.",
    boton: "Atur ulang kata sandi",
    seguridad: "Demi keamanan, tautan ini kedaluwarsa dan hanya dapat digunakan satu kali.",
    ignorar: "Jika Anda tidak memintanya, abaikan pesan ini — kata sandi Anda tidak akan berubah.",
  },
  it: {
    asunto: "Reimpostare la password di BiVelio",
    saludo: "Buongiorno,",
    cuerpo: "Abbiamo ricevuto una richiesta di reimpostazione della password del Suo account BiVelio. Prema il pulsante per sceglierne una nuova.",
    boton: "Reimposta password",
    seguridad: "Per sicurezza, il link scade e può essere usato una sola volta.",
    ignorar: "Se non l'ha richiesto, ignori questo messaggio: la Sua password non cambierà.",
  },
  nl: {
    asunto: "Uw BiVelio-wachtwoord opnieuw instellen",
    saludo: "Goedendag,",
    cuerpo: "We hebben een verzoek ontvangen om het wachtwoord van uw BiVelio-account opnieuw in te stellen. Klik op de knop om een nieuw wachtwoord te kiezen.",
    boton: "Wachtwoord opnieuw instellen",
    seguridad: "Om veiligheidsredenen verloopt deze link en kan hij maar één keer worden gebruikt.",
    ignorar: "Als u dit niet hebt aangevraagd, kunt u dit bericht negeren — uw wachtwoord verandert niet.",
  },
  pl: {
    asunto: "Zresetowanie hasła w BiVelio",
    saludo: "Dzień dobry,",
    cuerpo: "Otrzymaliśmy prośbę o zresetowanie hasła do konta BiVelio. Prosimy nacisnąć przycisk, aby wybrać nowe hasło.",
    boton: "Zresetuj hasło",
    seguridad: "Ze względów bezpieczeństwa link wygasa i może zostać użyty tylko raz.",
    ignorar: "Jeśli prośba nie pochodziła od Pana/Pani, prosimy zignorować tę wiadomość — hasło nie zostanie zmienione.",
  },
  pt: {
    asunto: "Repor a palavra-passe do BiVelio",
    saludo: "Olá,",
    cuerpo: "Recebemos um pedido para repor a palavra-passe da sua conta BiVelio. Clique no botão para escolher uma nova.",
    boton: "Repor palavra-passe",
    seguridad: "Por segurança, esta ligação expira e só pode ser usada uma vez.",
    ignorar: "Se não fez este pedido, ignore esta mensagem — a sua palavra-passe não será alterada.",
  },
  tr: {
    asunto: "BiVelio parolanızı sıfırlayın",
    saludo: "Merhaba,",
    cuerpo: "BiVelio hesabınızın parolasını sıfırlamak için bir istek aldık. Yeni bir parola seçmek için düğmeye tıklayın.",
    boton: "Parolayı sıfırla",
    seguridad: "Güvenlik nedeniyle bu bağlantının süresi dolar ve yalnızca bir kez kullanılabilir.",
    ignorar: "Bu isteği siz yapmadıysanız bu mesajı yok sayın — parolanız değişmez.",
  },
  vi: {
    asunto: "Đặt lại mật khẩu BiVelio của quý vị",
    saludo: "Xin chào,",
    cuerpo: "Chúng tôi đã nhận được yêu cầu đặt lại mật khẩu cho tài khoản BiVelio của quý vị. Nhấn nút để chọn mật khẩu mới.",
    boton: "Đặt lại mật khẩu",
    seguridad: "Vì lý do bảo mật, liên kết này sẽ hết hạn và chỉ dùng được một lần.",
    ignorar: "Nếu quý vị không yêu cầu, hãy bỏ qua thư này — mật khẩu của quý vị sẽ không thay đổi.",
  },
};

const GENERICA: Juego = {
  es: {
    asunto: "Acción pendiente en su cuenta de BiVelio",
    saludo: "Hola:",
    cuerpo: "Hemos recibido una solicitud relacionada con su cuenta de BiVelio. Pulse el botón para continuar.",
    boton: "Continuar",
    seguridad: "Por seguridad, el enlace caduca y solo puede usarse una vez.",
    ignorar: "Si no ha solicitado nada, ignore este mensaje: no se hará nada.",
  },
  en: {
    asunto: "Action pending on your BiVelio account",
    saludo: "Hello,",
    cuerpo: "We received a request related to your BiVelio account. Click the button to continue.",
    boton: "Continue",
    seguridad: "For security, this link expires and can only be used once.",
    ignorar: "If you didn't request anything, you can ignore this message — nothing will happen.",
  },
  ca: {
    asunto: "Acció pendent al vostre compte de BiVelio",
    saludo: "Hola,",
    cuerpo: "Hem rebut una sol·licitud relacionada amb el vostre compte de BiVelio. Premeu el botó per continuar.",
    boton: "Continuar",
    seguridad: "Per seguretat, l'enllaç caduca i només es pot fer servir una vegada.",
    ignorar: "Si no heu sol·licitat res, ignoreu aquest missatge: no es farà res.",
  },
  de: {
    asunto: "Ausstehende Aktion für Ihr BiVelio-Konto",
    saludo: "Guten Tag,",
    cuerpo: "Wir haben eine Anfrage zu Ihrem BiVelio-Konto erhalten. Klicken Sie auf die Schaltfläche, um fortzufahren.",
    boton: "Fortfahren",
    seguridad: "Aus Sicherheitsgründen läuft der Link ab und kann nur einmal verwendet werden.",
    ignorar: "Wenn Sie nichts angefordert haben, ignorieren Sie diese Nachricht — es geschieht nichts.",
  },
  fr: {
    asunto: "Action en attente sur votre compte BiVelio",
    saludo: "Bonjour,",
    cuerpo: "Nous avons reçu une demande concernant votre compte BiVelio. Cliquez sur le bouton pour continuer.",
    boton: "Continuer",
    seguridad: "Pour des raisons de sécurité, ce lien expire et ne peut être utilisé qu'une seule fois.",
    ignorar: "Si vous n'avez rien demandé, ignorez ce message — rien ne se passera.",
  },
  id: {
    asunto: "Tindakan tertunda pada akun BiVelio Anda",
    saludo: "Halo,",
    cuerpo: "Kami menerima permintaan terkait akun BiVelio Anda. Klik tombol untuk melanjutkan.",
    boton: "Lanjutkan",
    seguridad: "Demi keamanan, tautan ini kedaluwarsa dan hanya dapat digunakan satu kali.",
    ignorar: "Jika Anda tidak meminta apa pun, abaikan pesan ini — tidak akan terjadi apa-apa.",
  },
  it: {
    asunto: "Azione in sospeso sul Suo account BiVelio",
    saludo: "Buongiorno,",
    cuerpo: "Abbiamo ricevuto una richiesta relativa al Suo account BiVelio. Prema il pulsante per continuare.",
    boton: "Continua",
    seguridad: "Per sicurezza, il link scade e può essere usato una sola volta.",
    ignorar: "Se non ha richiesto nulla, ignori questo messaggio: non accadrà nulla.",
  },
  nl: {
    asunto: "Actie vereist voor uw BiVelio-account",
    saludo: "Goedendag,",
    cuerpo: "We hebben een verzoek ontvangen met betrekking tot uw BiVelio-account. Klik op de knop om door te gaan.",
    boton: "Doorgaan",
    seguridad: "Om veiligheidsredenen verloopt deze link en kan hij maar één keer worden gebruikt.",
    ignorar: "Als u niets hebt aangevraagd, kunt u dit bericht negeren — er gebeurt niets.",
  },
  pl: {
    asunto: "Oczekująca akcja na koncie BiVelio",
    saludo: "Dzień dobry,",
    cuerpo: "Otrzymaliśmy prośbę dotyczącą konta BiVelio. Prosimy nacisnąć przycisk, aby kontynuować.",
    boton: "Kontynuuj",
    seguridad: "Ze względów bezpieczeństwa link wygasa i może zostać użyty tylko raz.",
    ignorar: "Jeśli prośba nie pochodziła od Pana/Pani, prosimy zignorować tę wiadomość — nic się nie stanie.",
  },
  pt: {
    asunto: "Ação pendente na sua conta BiVelio",
    saludo: "Olá,",
    cuerpo: "Recebemos um pedido relacionado com a sua conta BiVelio. Clique no botão para continuar.",
    boton: "Continuar",
    seguridad: "Por segurança, esta ligação expira e só pode ser usada uma vez.",
    ignorar: "Se não pediu nada, ignore esta mensagem — nada acontecerá.",
  },
  tr: {
    asunto: "BiVelio hesabınızda bekleyen işlem",
    saludo: "Merhaba,",
    cuerpo: "BiVelio hesabınızla ilgili bir istek aldık. Devam etmek için düğmeye tıklayın.",
    boton: "Devam et",
    seguridad: "Güvenlik nedeniyle bu bağlantının süresi dolar ve yalnızca bir kez kullanılabilir.",
    ignorar: "Hiçbir istekte bulunmadıysanız bu mesajı yok sayın — hiçbir şey olmaz.",
  },
  vi: {
    asunto: "Hành động đang chờ trên tài khoản BiVelio của quý vị",
    saludo: "Xin chào,",
    cuerpo: "Chúng tôi đã nhận được một yêu cầu liên quan đến tài khoản BiVelio của quý vị. Nhấn nút để tiếp tục.",
    boton: "Tiếp tục",
    seguridad: "Vì lý do bảo mật, liên kết này sẽ hết hạn và chỉ dùng được một lần.",
    ignorar: "Nếu quý vị không yêu cầu gì, hãy bỏ qua thư này — sẽ không có gì xảy ra.",
  },
};

export function juegoPara(accion: AccionAuth): Juego {
  if (accion === "signup") return CONFIRMAR;
  if (accion === "recovery") return RECUPERAR;
  return GENERICA;
}

/** El pie de cada producto: marca + dominio. La copy es de la plataforma; esto es lo suyo. */
const PIE: Record<Producto, string> = {
  savings: "BiVelio · savings.bivelio.com",
  privacy: "BiVelio · privacy.bivelio.com",
  gpos: "BiVelio · Governed Process Operating System",
};

export interface DatosCorreoAuth {
  producto: Producto;
  accion: AccionAuth;
  idioma: Idioma;
  /** El enlace ya construido; vacío si la acción solo trae código. */
  enlace: string;
  /** Código de un solo uso (reauthentication); se muestra en grande si no hay enlace. */
  codigo?: string;
  destinatario: string;
}

/** Carcasa clara de la casa (savings y privacy): la misma familia visual que
 *  los correos de invitación. */
function carcasaClara(t: CopyAuth, d: DatosCorreoAuth): string {
  // El enlace SOLO en el botón (pedido del dueño, 2026-08-27): la URL desnuda
  // afeaba el correo. El respaldo para clientes sin HTML es la versión en
  // texto plano, que la lleva entera.
  const accionHtml = d.enlace
    ? `<p><a href="${escapar(d.enlace)}" style="display:inline-block;background:#111;color:#fff;` +
      `padding:10px 18px;border-radius:6px;text-decoration:none">${escapar(t.boton)}</a></p>`
    : `<p style="font-size:22px;letter-spacing:0.2em;font-weight:700">${escapar(d.codigo ?? "")}</p>`;
  return [
    `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:520px;color:#111">`,
    `<p>${escapar(t.saludo)}</p>`,
    `<p>${escapar(t.cuerpo)}</p>`,
    accionHtml,
    `<p style="font-size:13px;color:#555">${escapar(t.seguridad)}</p>`,
    `<p style="font-size:13px;color:#555">${escapar(t.ignorar)}</p>`,
    `<p style="font-size:12px;color:#999">${escapar(PIE[d.producto])}</p>`,
    `</div>`,
  ].join("");
}

/** Carcasa oscura de GPOS, portada de la plantilla que vivía en Supabase para
 *  que sus usuarios no noten el cambio de remitente técnico. */
function carcasaOscura(t: CopyAuth, d: DatosCorreoAuth): string {
  // Solo botón, como en la carcasa clara: el respaldo es el texto plano.
  const accionHtml = d.enlace
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:16px auto"><tr>` +
      `<td align="center" style="border-radius:10px;background:linear-gradient(135deg,#6B85EB 0%,#8E7BF0 100%)">` +
      `<a href="${escapar(d.enlace)}" target="_blank" style="display:inline-block;padding:14px 32px;` +
      `font-size:15px;font-weight:600;color:#FFFFFF;text-decoration:none;border-radius:10px">${escapar(t.boton)}</a>` +
      `</td></tr></table>`
    : `<p style="color:#F4F6FB;font-size:26px;letter-spacing:0.25em;font-weight:700;text-align:center">${escapar(d.codigo ?? "")}</p>`;
  return [
    `<div style="margin:0;padding:32px 16px;background-color:#070B14;font-family:'Segoe UI',Helvetica,Arial,sans-serif">`,
    `<div style="max-width:600px;margin:0 auto;background-color:#0F1524;border:1px solid #1E2740;border-radius:16px;padding:36px 40px">`,
    `<img src="https://app.bivelio.com/logo-bivelio.png" width="140" alt="BiVelio" style="display:block;width:140px;height:auto;border:0" />`,
    `<h1 style="margin:24px 0 12px 0;color:#F4F6FB;font-size:24px;line-height:1.25;font-weight:700">${escapar(t.asunto)}</h1>`,
    `<p style="margin:0 0 16px 0;color:#9AA6C2;font-size:15px;line-height:1.6">${escapar(t.cuerpo)}</p>`,
    accionHtml,
    `<p style="margin:16px 0 0 0;color:#6B7592;font-size:12px;line-height:1.6">${escapar(t.seguridad)} ${escapar(t.ignorar)}</p>`,
    `<p style="margin:24px 0 0 0;color:#4E566E;font-size:12px">${escapar(PIE.gpos)} · ` +
      `<a href="https://bivelio.com" style="color:#6B7592">bivelio.com</a></p>`,
    `</div></div>`,
  ].join("");
}

/**
 * Compone el correo de auth. Función PURA, como componerInvitacion: el
 * contenido —incluido que el enlace va escapado y que ningún idioma se queda
 * sin campo— se prueba sin red.
 */
export function componerCorreoAuth(d: DatosCorreoAuth): CorreoCompuesto {
  const t = juegoPara(d.accion)[d.idioma];
  const html = d.producto === "gpos" ? carcasaOscura(t, d) : carcasaClara(t, d);
  const texto = [
    t.saludo,
    "",
    t.cuerpo,
    "",
    d.enlace || (d.codigo ?? ""),
    "",
    t.seguridad,
    t.ignorar,
    "",
    PIE[d.producto],
  ].join("\n");
  return { asunto: t.asunto, html, texto };
}
