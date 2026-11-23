Todas as API de LLM cobram por chamada. Se a tua aplicação envia o mesmo pedido duas vezes, pagas duas vezes, mesmo que a segunda resposta não acrescente nada. Este guia mostra duas técnicas que evitam isso: uma **cache de respostas por correspondência exata** para as repetições que chegam mais tarde, e o **agrupamento de pedidos em curso** para os pedidos idênticos que chegam no mesmo momento. As duas funcionam em qualquer linguagem e com qualquer fornecedor. No fim vais ver como o SDK open source BV-SALA faz ambas por predefinição, e como confrontar a poupança com os números de uso do teu próprio fornecedor.

## De onde vêm os pedidos duplicados

Os duplicados são mais comuns do que parecem, porque raramente vêm de um único sítio óbvio:

- **Retries e cliques duplos.** Um utilizador carrega duas vezes em «Gerar», ou uma biblioteca cliente repete o pedido depois de um timeout a que o fornecedor, afinal, tinha respondido.
- **Jobs batch e crons.** Um job noturno classifica as mesmas descrições de produto, entradas de FAQ ou macros de suporte que já classificou ontem.
- **Fan-out.** Dois workers, dois separadores do browser ou um effect do React que corre duas vezes em desenvolvimento enviam o mesmo prompt com milissegundos de diferença.
- **Agentes e pipelines.** Um pipeline de vários passos faz a mesma subpergunta em vários ramos.
- **Testes e evals.** A CI corre as mesmas fixtures contra a API real a cada push.

O primeiro e o último grupo são repetições ao longo do tempo; o fan-out é concorrência. Precisam de soluções diferentes, e é por isso que este guia cobre as duas.

## Mede primeiro a tua taxa de duplicados

Antes de construíres o que quer que seja, descobre quanto do teu tráfego se repete. Calcula o hash de cada corpo de pedido durante um dia e conta. A chave tem de ser **canónica**: o mesmo pedido tem de dar os mesmos bytes, seja qual for a ordem das chaves do JSON.

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

Se a taxa estiver perto de zero, uma cache de respostas não te vai poupar muito, e deves olhar antes para a [cache de prompts](/pt/guides/claude-prompt-caching-not-working) ou para a [escolha de modelo](/pt/guides/reduce-openai-api-costs). Se uma parte considerável dos teus pedidos se repete, continua a ler.

## Constrói uma chave de cache que seja mesmo segura

Uma cache exata só é tão boa quanto a sua chave. A regra é simples: **tudo o que pode mudar a resposta entra na chave, e nada se perde na normalização.**

- O id do modelo, a lista completa de mensagens, o prompt de sistema, as definições de ferramentas, o formato de resposta ou o JSON schema, e todos os parâmetros de amostragem (`temperature`, `top_p`, `max_tokens`, `seed`, esforço de raciocínio).
- Um **âmbito** (scope) quando o prompt leva dados do utilizador. Dois utilizadores que perguntam «qual é o meu saldo?» enviam o mesmo texto e precisam de respostas diferentes. Põe o id do utilizador ou do tenant na chave, ou não ponhas esses pedidos em cache de todo.
- Nada de normalizações «espertas». Passar para minúsculas, cortar espaços ou tirar a pontuação para conseguir mais acertos transforma uma cache exata numa cache difusa, e uma cache difusa pode devolver a resposta a outra pergunta.

## O que nunca deve ser servido a partir de uma cache

Alguns pedidos repetem-se, mas mesmo assim têm de chegar ao modelo de todas as vezes:

- **Respostas que têm de mudar**: «escolhe um nome ao acaso», «gera uma palavra-passe», «que horas são», «o preço de hoje». Aqui, uma resposta em cache é um bug, não uma poupança.
- **Ferramentas com efeitos secundários.** Se a resposta pede para chamar `send_email` ou `create_order`, voltar a servi-la a partir da cache salta a ação. Põe em cache só os pedidos cujas ferramentas sejam só de leitura, ou que não tenham nenhuma.
- **Saídas amostradas que os utilizadores esperam que variem.** Com uma `temperature` alta, uma resposta em cache é só uma amostra, servida para sempre.
- **Erros, respostas vazias, recusas e respostas truncadas.** Nunca as escrevas na cache; deixa o pedido seguinte tentar de novo.
- **Temas sensíveis.** Um bot de suporte que põe em cache respostas sobre autolesão ou uma emergência médica não o deveria fazer; envia esses pedidos ao modelo de todas as vezes.

## Agrupa os pedidos idênticos em curso

Uma cache só ajuda depois de a primeira resposta ter chegado. Se dez pedidos idênticos começarem nos mesmos 300 ms, os dez falham. A solução é um padrão minúsculo, muitas vezes chamado *singleflight*: quem chama primeiro faz a chamada, os outros esperam pela mesma promise.

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

Em produção, há três pormenores que importam. Os erros têm de chegar a todos os que estão à espera (o padrão acima faz isso). Se um deles cancelar, a chamada partilhada não pode ser cancelada para os outros. E o streaming é mais difícil: um stream que já começou não pode simplesmente ser entregue a um segundo cliente, por isso a maioria das implementações deixa um pedido normal juntar-se a uma chamada em curso, mas não deixa nada juntar-se a um stream.

## Como o BV-SALA o faz

O [BV-SALA](https://github.com/BiVelio/bivelio-savings-layer) é uma camada de poupança Apache-2.0 para TypeScript. O seu SDK envolve o teu fornecedor e, **sem chave e sem registo**, liga as duas técnicas por predefinição: uma cache exata e a deduplicação de pedidos em curso. Também aplica as regras de «nunca em cache» acima: os pedidos que pedem algo atual ou aleatório, os formulados em termos pessoais sem uma sessão, os temas sensíveis, as recusas e os erros ficam fora da cache.

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

Um pedido que pareça pessoal («a minha encomenda», «a nossa fatura») não é posto em cache a não ser que digas de quem é. Passa um âmbito e a cache volta a funcionar, separadamente para cada sessão:

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

A cache predefinida vive na memória de um único processo. Para a partilhares entre vários servidores ou instâncias serverless, passa através da opção `exactCache` um armazenamento gerido por ti. Precisa de três métodos, por isso qualquer armazenamento chave-valor serve:

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

As respostas em cache ficam na tua infraestrutura. Quando o usas sem chave, nada é enviado à BiVelio.

## Confronta a poupança com os números do teu fornecedor

A poupança de uma cache é fácil de verificar, porque é uma contagem de chamadas que não aconteceram.

1. **Conta as chamadas dos dois lados.** Durante um dia, conta as chamadas a `generate()` que a tua aplicação fez e compara-as com o número de pedidos que o teu fornecedor mostra para a mesma chave de API e o mesmo modelo (a página de uso da consola da OpenAI ou da Anthropic, ou as respetivas API de uso). A diferença deve ser igual à soma de `report.calls.avoidedLlm`.
2. **Vê como cada repetição foi valorizada.** `report.cost.basis` diz de onde vem o número. Uma repetição é `reference` quando a chamada idêntica que correu foi diretamente para a API da OpenAI, da Anthropic ou do Gemini da Google (`api.openai.com`, `api.anthropic.com` ou `generativelanguage.googleapis.com`): a sua linha de base é o contador de uso dessa mesma chamada, valorizado de forma conservadora à tarifa de entrada em cache. Fica `estimated` quando a chamada que correu foi para qualquer outro lado, incluindo a API própria de outro fornecedor, como a da DeepSeek, um proxy, o Azure ou um gateway, porque só nessas três API se sabe que os preços de tabela da camada coincidem com a fatura. O dinheiro estimado é sempre apresentado à parte.
3. **Compara o gasto, não só as chamadas.** Soma `report.cost.netSavingsUsd` por base. Nunca somes montantes medidos com estimados, e nunca faças a média de `netSavingsRatio` entre pedidos.

Se quiseres um teste mais limpo, corre a mesma carga duas vezes, uma com as alavancas desligadas nessa execução (`savings: { exactCache: false, singleflight: false }` em cada pedido) e outra com as predefinições, e compara as duas faturas.

## O que dizem os números públicos

O repositório publica as execuções do seu banco. Numa carga pública construída com perguntas do GSM8K em que 30 % dos pedidos eram repetições exatas, a redução agregada medida foi de **31.50 %** no `gpt-4o-mini`, com um intervalo de 95 % entre 25.7 % e 36.7 % (artefactos do SDK 0.4.31 de setembro de 2026; fonte: a [página do banco público](/pt/benchmarks#savings) e o README). Em tráfego que nunca se repete, a poupança ronda os 0 %, e a [página do banco público](/pt/benchmarks#no-savings) também mostra esses resultados planos. Conta ainda a falha que mais importa numa cache: **0 de 198** variantes de perguntas receberam a resposta de outra pergunta ([garantias](/pt/benchmarks#guarantees)).

A tua poupança depende da tua taxa de duplicados, por isso mede-a primeiro com o excerto do início desta página. O código, o artigo e os relatórios em bruto estão no [GitHub](https://github.com/BiVelio/bivelio-savings-layer).
