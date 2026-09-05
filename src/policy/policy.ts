import type { CanonicalRequest } from "../canonicalization/canonicalize.js";

/**
 * Policy engine: risk and freshness.
 *
 * This is the gate that decides which savings are *safe* for a given request.
 * The most dangerous failure of a savings layer is not a cache miss — it is
 * confidently returning a wrong answer (a stale price, another tenant's data, a
 * reused answer for a side-effecting action). The policy engine exists to make
 * those outcomes structurally impossible, not merely unlikely.
 */
export interface Policy {
  /** May the exact cache be read/written for this request? */
  allowExactCache: boolean;
  /** May the semantic cache even be *considered*? (still verified later) */
  allowSemanticCache: boolean;
  /** May concurrent equivalent requests be coalesced? */
  allowSingleflight: boolean;
  /** May we run natural-language compression on the context? */
  allowCompression: boolean;
  /**
   * ¿Puede el SDK elidir tool_results viejos y gordos antes de reenviar?
   * COMPUTADO (no cableado como `allowCompression`): la elisión borra salidas de
   * herramienta enteras, así que honra los mismos vetos que la caché semántica —
   * escritura, frescura, personalización, muestreo estocástico y `day`.
   */
  allowElision: boolean;
  /** Does the request demand current/live data? */
  requiresFreshData: boolean;
  /** Does the request have (or request) side effects? */
  hasSideEffects: boolean;
  /** Is the response personalized to a user/account? */
  isPersonalized: boolean;
  /**
   * Techo de antigüedad para una entrada de caché exacta, derivado del
   * `freshnessBucket`. `null` = sin techo propio (manda el TTL por defecto).
   * Existe porque el bucket NO particiona la clave —va crudo al hash y no rota—,
   * así que sin esto "hour" y "day" no significaban nada operativamente.
   */
  maxCacheAgeMs: number | null;
  reasons: string[];
}

/**
 * Marcadores léxicos, en los 12 idiomas que el producto sirve.
 *
 * Estaban SOLO en inglés y español. Como de `PERSONAL_MARKERS` sale lo único que
 * apaga la caché exacta, el singleflight y la caché semántica cuando no hay
 * `principal`, en los otros 10 idiomas el guardarraíl no casaba nunca: dos
 * usuarios del mismo tenant preguntando «Wie hoch ist mein Kontostand?»
 * compartían entrada de caché y el segundo recibía el saldo del primero — y el
 * informe lo apuntaba como acierto de caché, o sea como AHORRO.
 *
 * Sigue siendo una heurística léxica, con sus falsos negativos («how much do I
 * owe» no lleva ninguna de estas palabras). Es una red de seguridad para quien no
 * pasa `context.sessionId`; el aislamiento de verdad lo da el `principal`, que
 * mete al usuario en la clave. Por eso conviene leer esto como "reduce el daño
 * por defecto", no como "garantiza el aislamiento".
 */
const FRESHNESS_MARKERS = new RegExp(
  "\\b(" +
    [
      // en
      "now|today|current|currently|latest|live|price|prices|stock|availability|weather|score|breaking",
      // es
      "ahora|hoy|actual|actualmente|ultimo|último|precio|precios|disponibilidad|cotizacion|cotización",
      // ca
      "ara|avui|preu|preus|disponibilitat|darrer",
      // fr
      "maintenant|aujourd'hui|actuel|actuelle|dernier|prix|disponibilite|disponibilité|meteo|météo",
      // de
      "jetzt|heute|aktuell|aktuelle|neueste|preis|preise|verfugbarkeit|verfügbarkeit|wetter|kurs",
      // it
      "adesso|oggi|attuale|ultimo|prezzo|prezzi|disponibilita|disponibilità|meteo",
      // pt
      "agora|hoje|atual|ultimo|último|preco|preço|precos|preços|disponibilidade|cotacao|cotação",
      // nl
      "nu|vandaag|huidige|laatste|prijs|prijzen|beschikbaarheid|weer|koers",
      // pl
      "teraz|dzisiaj|dzis|dziś|aktualny|aktualna|najnowszy|cena|ceny|dostepnosc|dostępność|pogoda",
      // tr
      "simdi|şimdi|bugun|bugün|guncel|güncel|son|fiyat|fiyatlar|stok|hava",
      // id
      "sekarang|hari ini|terkini|terbaru|harga|ketersediaan|cuaca",
      // vi
      "bay gio|bây giờ|hom nay|hôm nay|hien tai|hiện tại|moi nhat|mới nhất|gia|giá|thoi tiet|thời tiết",
    ].join("|") +
    ")\\b",
  "i",
);

const PERSONAL_MARKERS = new RegExp(
  "\\b(" +
    [
      // en
      "my|mine|our|ours|account|balance|subscription|invoice|order|profile",
      // es
      "mi|mis|mio|mío|nuestro|nuestra|cuenta|factura|pedido|saldo|suscripcion|suscripción|perfil",
      // ca
      "meu|meva|nostre|compte|factura|comanda|saldo|subscripcio|subscripció|perfil",
      // fr
      "mon|ma|mes|notre|nos|compte|solde|facture|commande|abonnement|profil",
      // de
      "mein|meine|meinem|unser|unsere|konto|kontostand|saldo|rechnung|bestellung|abo|abonnement|profil",
      // it
      "mio|mia|miei|nostro|nostra|conto|saldo|fattura|ordine|abbonamento|profilo",
      // pt
      "meu|minha|meus|nosso|nossa|conta|saldo|fatura|pedido|assinatura|perfil",
      // nl
      "mijn|onze|ons|rekening|saldo|factuur|bestelling|abonnement|profiel",
      // pl
      "moj|mój|moja|moje|nasz|nasza|konto|saldo|faktura|zamowienie|zamówienie|subskrypcja|profil",
      // tr
      "benim|bizim|hesap|hesabim|hesabım|bakiye|fatura|siparis|sipariş|abonelik|profil",
      // id
      "saya|kami|akun|saldo|tagihan|pesanan|langganan|profil",
      // vi
      "cua toi|của tôi|tai khoan|tài khoản|so du|số dư|hoa don|hóa đơn|don hang|đơn hàng|thue bao|thuê bao",
    ].join("|") +
    ")\\b",
  "i",
);

export function evaluatePolicy(c: CanonicalRequest): Policy {
  const reasons: string[] = [];
  const text = c.normalizedText;

  const hasWriteTools = (c.original.tools ?? []).some(
    (t) => t.risk === "write" || t.risk === "destructive",
  );
  const requiresFreshData =
    c.freshnessBucket === "live" ||
    c.freshnessBucket === "hour" ||
    FRESHNESS_MARKERS.test(text);
  // La personalización la delata el TEXTO, no el tenant. La condición
  // `tenantId !== "anonymous"` dejaba el guardarraíl muerto justo en la
  // configuración por defecto —que es la que más protección necesita, no la que
  // menos— porque canonicalize() rellena tenantId con "anonymous" cuando no se
  // pasa contexto.
  const isPersonalized = PERSONAL_MARKERS.test(text);
  const stochastic = (c.temperature ?? 0) > 0.3 && c.seed == null;

  if (hasWriteTools) reasons.push("write/destructive tools present");
  if (requiresFreshData) reasons.push("freshness-sensitive request");
  if (isPersonalized) reasons.push("personalized/account-scoped request");
  if (stochastic) reasons.push("stochastic sampling (temp>0.3, no seed)");

  // Exact cache is safe when the key isolates tenant/scope AND the answer can't
  // go stale under us. Also disabled for deliberately stochastic outputs, where an
  // identical replay isn't what the caller wants.
  //
  // AQUÍ HABÍA UNA INVERSIÓN. La regla era `requiresFreshData && (bucket == null ||
  // bucket === "any")`, justificada con que un bucket explícito "particiona la
  // clave por tiempo, así que rota sola". Eso es FALSO: `freshnessBucket` es un
  // enum de cuatro literales fijos que `buildExactKey` mete crudo en el material
  // del hash — el literal "live" es constante, así que la clave es idéntica dentro
  // de un segundo o dentro de un día. Consecuencia: declarar `freshnessBucket:
  // "live"`, que es lo MÁS estricto que puede decir un integrador, era justo lo
  // que ENCENDÍA la caché exacta con un TTL de 24 h. Quien no declaraba nada
  // quedaba protegido y quien hacía bien su trabajo recibía respuestas de hace
  // medio día. Reproducido: "what is the current price of BTC?" servida a las 12 h
  // con `ageMs = 43.200.000` y 100 % de ahorro acreditado.
  //
  // Ahora el bucket manda de verdad y en la dirección correcta:
  //   live  -> nunca se cachea (la respuesta debe ser de AHORA)
  //   hour  -> se cachea, con un techo de 1 h
  //   day   -> se cachea, con un techo de 24 h
  //   any/ausente + el texto huele a frescura -> no se cachea
  // El techo lo aplica el pipeline al escribir y al leer (`maxCacheAgeMs`), que es
  // lo único que de verdad hace caducar una entrada.
  const freshWithoutBucket =
    requiresFreshData && (c.freshnessBucket == null || c.freshnessBucket === "any");
  const liveNoCache = c.freshnessBucket === "live";

  // Una respuesta personalizada solo se puede cachear si la clave AÍSLA a quien
  // pregunta. La clave exacta lleva tenant y scope, pero los dos son compartidos
  // por defecto ("anonymous" / "default"), así que dos usuarios de la misma
  // organización preguntando "cuál es el saldo de mi cuenta" caían en la misma
  // entrada: el segundo recibía la respuesta del primero. `allowExactCache`
  // calculaba isPersonalized y no lo miraba.
  //
  // Con principal (sessionId) la clave sí separa y el cacheo es seguro y útil;
  // sin él, se apaga. El tráfico no personalizado no pierde ni un acierto.
  const personalizedWithoutPrincipal = isPersonalized && c.principal == null;
  // `hasWriteTools` TAMBIÉN apaga la caché exacta. El contrato lo promete
  // literalmente ("Write/destructive tools are never cached", ToolRisk en
  // contracts/types.ts) y la semántica y el singleflight ya lo cumplían — solo
  // esta condición lo omitía. Reproducido: dos generate() idénticos con un tool
  // risk:"write" y texto imperativo neutro («send the weekly report»): el
  // segundo salía de caché con netSavings=1, la acción no se ejecutaba y el
  // informe vendía como ahorro un trabajo que nunca se hizo.
  const allowExactCache =
    !stochastic &&
    !freshWithoutBucket &&
    !liveNoCache &&
    !personalizedWithoutPrincipal &&
    !hasWriteTools;
  if (hasWriteTools) reasons.push("write/destructive tools → exact cache off (side effects must execute)");
  if (liveNoCache) reasons.push("freshnessBucket=live → exact cache off (answer must be current)");
  if (freshWithoutBucket) reasons.push("freshness-sensitive without a freshness bucket → exact cache off");
  if (personalizedWithoutPrincipal) {
    reasons.push("personalized request with no principal (context.sessionId) → exact cache off");
  }

  // Semantic cache is far more restricted: read-only, non-personalized,
  // non-fresh, deterministic-enough. Even then, a downstream verifier must
  // still confirm the hit.
  const allowSemanticCache =
    !hasWriteTools &&
    !requiresFreshData &&
    !isPersonalized &&
    !stochastic &&
    c.freshnessBucket !== "day";

  // Elisión de tool_results: se calcula IGUAL que la caché semántica, y por la
  // misma razón. Borrar la salida de una herramienta vieja de una conversación
  // con escritura/estado puede esconderle al modelo el resultado de una acción;
  // en una petición fresca o personalizada, el contexto viejo puede ser justo lo
  // que hace falta. NO se copia el `allowCompression: true` cableado de abajo: la
  // elisión quita información entera, no la reescribe más corta, así que debe
  // honrar los vetos por turno, no ignorarlos.
  const allowElision =
    !hasWriteTools &&
    !requiresFreshData &&
    !isPersonalized &&
    !stochastic &&
    c.freshnessBucket !== "day";

  return {
    allowExactCache,
    allowSemanticCache,
    allowElision,
    // Singleflight fusiona dos peticiones idénticas concurrentes y le da a las
    // DOS la misma respuesta. Con una petición personalizada sin principal, eso
    // es la misma fuga que la caché exacta: el segundo usuario recibe la
    // respuesta calculada para el primero. Se calculaba `personalizedWithoutPrincipal`
    // arriba, se aplicaba a la caché exacta, y aquí se ignoraba — dejando abierta
    // la misma puerta por otra vía.
    allowSingleflight: !hasWriteTools && !personalizedWithoutPrincipal,
    allowCompression: true,
    requiresFreshData,
    hasSideEffects: hasWriteTools,
    isPersonalized,
    maxCacheAgeMs:
      c.freshnessBucket === "hour" ? 3_600_000 : c.freshnessBucket === "day" ? 86_400_000 : null,
    reasons,
  };
}
