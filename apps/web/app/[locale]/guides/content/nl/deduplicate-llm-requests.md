Elke LLM-API factureert per aanroep. Als je app hetzelfde verzoek twee keer stuurt, betaal je twee keer, ook al voegt het tweede antwoord niets toe. Deze gids laat twee technieken zien die dat voorkomen: een **responscache op exacte overeenkomst** voor herhalingen die later binnenkomen, en het **samenvoegen van verzoeken die al onderweg zijn** voor identieke verzoeken die op hetzelfde moment binnenkomen. Beide werken in elke taal en met elke provider. Aan het eind zie je hoe de open-source SDK BV-SALA standaard allebei doet, en hoe je de besparing controleert met de gebruikscijfers van je provider zelf.

## Waar dubbele verzoeken vandaan komen

Duplicaten komen vaker voor dan je denkt, omdat ze zelden uit één voor de hand liggende hoek komen:

- **Retries en dubbelklikken.** Een gebruiker drukt twee keer op “Genereren”, of een clientbibliotheek probeert het opnieuw na een time-out terwijl de provider in feite al had geantwoord.
- **Batchjobs en crons.** Een nachtelijke job classificeert dezelfde productbeschrijvingen, FAQ-items of supportmacro's die hij gisteren ook al classificeerde.
- **Fan-out.** Twee workers, twee browsertabbladen of een React-effect dat in development twee keer draait, sturen binnen milliseconden dezelfde prompt.
- **Agents en pipelines.** Een pipeline met meerdere stappen stelt dezelfde deelvraag in verschillende takken.
- **Tests en evals.** De CI draait bij elke push dezelfde fixtures tegen de live API.

De eerste en de laatste groep zijn herhalingen in de tijd; fan-out is gelijktijdigheid. Ze vragen om verschillende oplossingen, en daarom behandelt deze gids ze allebei.

## Meet eerst je percentage duplicaten

Zoek, voordat je iets bouwt, uit hoeveel van je verkeer zich herhaalt. Hash een dag lang elke request-body en tel. De sleutel moet **canoniek** zijn: hetzelfde verzoek moet dezelfde bytes opleveren, ongeacht de volgorde van de JSON-sleutels.

```ts
import { createHash } from "node:crypto";

// Canonical JSON: the same object gives the same text, whatever the key order.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function requestKey(body: object, scope = "global"): string {
  return createHash("sha256").update(`${scope}\n${canonical(body)}`).digest("hex");
}

// Feed it one day of request bodies, then read the share that repeated.
const seen = new Map<string, number>();
export function record(body: object): void {
  const key = requestKey(body);
  seen.set(key, (seen.get(key) ?? 0) + 1);
}
export function duplicateRate(): number {
  let total = 0;
  for (const n of seen.values()) total += n;
  return total === 0 ? 0 : (total - seen.size) / total;
}
```

Ligt het percentage dicht bij nul, dan levert een responscache je weinig op en kun je beter kijken naar [prompt caching](/nl/guides/claude-prompt-caching-not-working) of [de modelkeuze](/nl/guides/reduce-openai-api-costs). Herhaalt een merkbaar deel van je verzoeken zich, lees dan verder.

## Bouw een cachesleutel die echt veilig is

Een exacte cache is maar zo goed als zijn sleutel. De regel is eenvoudig: **alles wat het antwoord kan veranderen, gaat in de sleutel, en niets wordt weggenormaliseerd.**

- De model-id, de volledige berichtenlijst, de systeemprompt, de tooldefinities, het responsformaat of JSON-schema, en elke samplingparameter (`temperature`, `top_p`, `max_tokens`, `seed`, redeneerinspanning).
- Een **scope** als de prompt gebruikersgegevens bevat. Twee gebruikers die vragen “wat is mijn saldo?” sturen dezelfde tekst en hebben verschillende antwoorden nodig. Zet de id van de gebruiker of tenant in de sleutel, of cache die verzoeken helemaal niet.
- Geen “slimme” normalisatie. Kleine letters maken, witruimte inkorten of leestekens weglaten om meer hits te krijgen, maakt van een exacte cache een vage cache, en een vage cache kan het antwoord op een andere vraag teruggeven.

## Wat nooit uit een cache mag komen

Sommige verzoeken herhalen zich maar moeten toch elke keer het model bereiken:

- **Antwoorden die moeten veranderen**: “kies een willekeurige naam”, “genereer een wachtwoord”, “hoe laat is het”, “de prijs van vandaag”. Een gecachet antwoord is hier een bug, geen besparing.
- **Tools met neveneffecten.** Als het antwoord vraagt om `send_email` of `create_order` aan te roepen, slaat afspelen uit de cache de actie over. Cache alleen verzoeken waarvan de tools alleen-lezen zijn, of die er geen hebben.
- **Gesamplede output waarvan gebruikers verwachten dat hij varieert.** Met een hoge `temperature` is een gecachet antwoord maar één sample, dat voor altijd wordt geserveerd.
- **Fouten, lege antwoorden, weigeringen en afgekapte antwoorden.** Schrijf ze nooit naar de cache; laat het volgende verzoek het opnieuw proberen.
- **Gevoelige onderwerpen.** Een supportbot die antwoorden over zelfbeschadiging of een medisch noodgeval cachet, zou dat niet moeten doen; stuur die elke keer naar het model.

## Voeg identieke verzoeken die al onderweg zijn samen

Een cache helpt pas als het eerste antwoord binnen is. Als tien identieke verzoeken binnen dezelfde 300 ms vertrekken, missen ze alle tien. De oplossing is een klein patroon dat vaak *singleflight* heet: de eerste aanroeper doet de aanroep, de anderen wachten op dezelfde promise.

```ts
const inFlight = new Map<string, Promise<unknown>>();

export function singleflight<T>(key: string, call: () => Promise<T>): Promise<T> {
  const running = inFlight.get(key) as Promise<T> | undefined;
  if (running) return running; // join the call that is already on its way
  const p = call().finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p; // an error reaches every caller that joined, so nobody waits forever
}
```

In productie tellen drie details. Fouten moeten elke wachtende aanroeper bereiken (het patroon hierboven doet dat). Als één aanroeper annuleert, mag de gedeelde aanroep voor de anderen niet worden geannuleerd. En streaming is lastiger: een stream die al is begonnen, kun je niet zomaar aan een tweede aanroeper doorgeven, dus de meeste implementaties laten een gewoon verzoek aanhaken bij een aanroep die onderweg is, maar laten niets aanhaken bij een stream.

## Hoe BV-SALA het doet

[BV-SALA](https://github.com/BiVelio/bivelio-savings-layer) is een besparingslaag onder Apache-2.0 voor TypeScript. De SDK omhult je provider en zet, **zonder sleutel en zonder aanmelding**, standaard beide technieken aan: een exacte cache en deduplicatie van verzoeken die al onderweg zijn. Hij past ook de “nooit cachen”-regels van hierboven toe: verzoeken met formuleringen die om actualiteit of willekeur vragen, persoonlijke formuleringen zonder sessie, gevoelige onderwerpen, weigeringen en fouten blijven buiten de cache.

```ts
// npm i @bivelio/savings-layer   (ESM: a "type": "module" project or a .mts file)
import { createSavingsLayer, OpenAICompatibleProvider } from "@bivelio/savings-layer";

const layer = createSavingsLayer({
  provider: new OpenAICompatibleProvider({
    baseUrl: "https://api.openai.com/v1",
    apiKey: process.env.OPENAI_API_KEY,
  }),
  // Nothing else is required: the exact cache and deduplication are on by default.
});

const request = {
  model: "openai/gpt-4o-mini",
  messages: [{ role: "user" as const, content: "Classify the sentiment as positive or negative: The battery lasts two days." }],
  temperature: 0,
};

const first = await layer.generate(request);
const again = await layer.generate(request);
console.log(first.report.cache.result, again.report.cache.result); // "miss" "exact"
console.log(again.report.calls.avoidedLlm); // 1: the repeat never reached the provider

// Two identical requests at the same moment: one call, shared by both.
const other = { ...request, messages: [{ role: "user" as const, content: "Classify the sentiment as positive or negative: Shipping took a month." }] };
const [a, b] = await Promise.all([layer.generate(other), layer.generate(other)]);
console.log(a.report.cache.result, b.report.cache.result); // "miss" "singleflight"
```

Een verzoek dat persoonlijk klinkt (“mijn bestelling”, “onze factuur”), wordt niet gecachet tenzij je zegt van wie het is. Geef een scope mee en de cache werkt weer, apart voor elke sessie:

```ts
import { createSavingsLayer, OpenAICompatibleProvider } from "@bivelio/savings-layer";

const layer = createSavingsLayer({
  provider: new OpenAICompatibleProvider({ baseUrl: "https://api.openai.com/v1", apiKey: process.env.OPENAI_API_KEY }),
});

const answer = await layer.generate({
  model: "openai/gpt-4o-mini",
  messages: [{ role: "user", content: "Translate to French: the invoice for my order is attached." }],
  context: { sessionId: "user-42" }, // cached for this session only
});
console.log(answer.report.cache.result);
```

De standaardcache leeft in het geheugen van één proces. Om hem te delen tussen meerdere servers of serverless-instanties, geef je via de optie `exactCache` een store mee die je zelf draait. Er zijn drie methoden nodig, dus elke key-value-store werkt:

```ts
import { createSavingsLayer, OpenAICompatibleProvider, type ExactCache } from "@bivelio/savings-layer";

// The three calls a Redis client offers; adapt the names to yours.
interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: "PX", ttlMs: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

export function sharedLayer(redis: RedisLike) {
  const exactCache: ExactCache = {
    async get(key) {
      const raw = await redis.get(`bvsala:${key}`);
      return raw ? JSON.parse(raw) : null;
    },
    async set(key, value, ttlMs) {
      await redis.set(`bvsala:${key}`, JSON.stringify(value), "PX", ttlMs ?? 3_600_000);
    },
    async delete(key) {
      await redis.del(`bvsala:${key}`);
    },
  };
  return createSavingsLayer({
    provider: new OpenAICompatibleProvider({ baseUrl: "https://api.openai.com/v1", apiKey: process.env.OPENAI_API_KEY }),
    exactCache,
  });
}
```

De gecachete antwoorden blijven in je eigen infrastructuur. Als je zonder sleutel draait, gaat er niets naar BiVelio.

## Controleer de besparing met de cijfers van je provider

Een cachebesparing is makkelijk te controleren, want het is een telling van aanroepen die niet hebben plaatsgevonden.

1. **Tel aanroepen aan beide kanten.** Tel een dag lang de `generate()`-aanroepen die je app deed en vergelijk ze met het aantal verzoeken dat je provider toont voor dezelfde API-sleutel en hetzelfde model (de gebruikspagina van de OpenAI- of Anthropic-console, of hun usage-API's). Het verschil moet gelijk zijn aan de som van `report.calls.avoidedLlm`.
2. **Lees hoe elke herhaling is gewaardeerd.** `report.cost.basis` zegt waar het getal vandaan komt. Een herhaling is `reference` als de identieke aanroep die wél draaide rechtstreeks naar de API van OpenAI, Anthropic of Google Gemini ging (`api.openai.com`, `api.anthropic.com` of `generativelanguage.googleapis.com`): de baseline is dan de eigen gebruiksteller van die aanroep, voorzichtig beprijsd tegen het tarief voor gecachete input. Hij blijft `estimated` als de aanroep die draaide ergens anders heen ging, ook naar de eigen API van een andere provider zoals die van DeepSeek, een proxy, Azure of een gateway, omdat alleen van die drie API's bekend is dat de lijstprijzen van de laag met de factuur overeenkomen. Geschat geld wordt altijd apart gerapporteerd.
3. **Vergelijk uitgaven, niet alleen aanroepen.** Tel `report.cost.netSavingsUsd` per basis op. Tel nooit gemeten en geschatte bedragen bij elkaar op, en neem nooit het gemiddelde van `netSavingsRatio` over verzoeken.

Wil je een zuiverdere test, draai dan dezelfde workload twee keer, één keer met de hefbomen uit voor die run (`savings: { exactCache: false, singleflight: false }` op elk verzoek) en één keer met de standaardinstellingen, en vergelijk de twee facturen.

## Wat de openbare cijfers zeggen

De repository publiceert zijn benchmarkruns. Op een openbare workload van GSM8K-vragen waarin 30% van de verzoeken exacte herhalingen waren, was de gemeten gepoolde verlaging **31,50%** voor `gpt-4o-mini`, met een 95%-interval van 25,7% tot 36,7% (artefacten van SDK 0.4.31 uit september 2026; bron: de [benchmarkpagina](/nl/benchmarks#savings) en de README). Op verkeer dat zich nooit herhaalt, is de besparing ongeveer 0%, en de [benchmarkpagina](/nl/benchmarks#no-savings) toont die vlakke resultaten ook. De pagina telt ook de fout die voor een cache het zwaarst weegt: **0 van de 198** vraagvarianten kregen het antwoord op een andere vraag ([garanties](/nl/benchmarks#guarantees)).

Je besparing hangt af van je percentage duplicaten, dus meet dat eerst met het fragment bovenaan deze pagina. De code, de paper en de ruwe rapporten staan op [GitHub](https://github.com/BiVelio/bivelio-savings-layer).
