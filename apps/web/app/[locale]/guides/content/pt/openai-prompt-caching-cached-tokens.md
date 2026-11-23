A OpenAI põe automaticamente em cache os prompts longos: quando o início de um pedido coincide com outro que processou recentemente, esses tokens de entrada são faturados com desconto e a resposta começa mais cedo. Não tens de ligar nada. Por isso mesmo, é fácil não dar conta quando deixa de funcionar. Se `cached_tokens` vier a `0` em todos os pedidos, este guia percorre as causas pela ordem em que as deves verificar, mostra como acompanhar a taxa de acerto por pedido e como a confrontar com os dados de uso da própria OpenAI.

## Onde ler o valor

Cada resposta diz-te quantos tokens de entrada vieram da cache:

- **Chat Completions:** `usage.prompt_tokens_details.cached_tokens`, num total de `usage.prompt_tokens`.
- **Responses API:** `usage.input_tokens_details.cached_tokens`, num total de `usage.input_tokens`.

Os tokens em cache fazem parte do total de entrada; não se somam a ele. O [guia de prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching) da OpenAI é a referência para as regras em vigor. Agora distingue os modelos mais recentes, que também reportam e faturam as escritas na cache e aceitam opções de cache explícitas, dos anteriores, em que escrever na cache é gratuito. Consulta-o para o modelo que usas.

## Porque é que cached_tokens é 0

1. **O prompt é demasiado curto.** A cache começa a partir de cerca de 1,024 tokens de prompt; o limiar exato e a forma como a contagem em cache é arredondada dependem do modelo. Um prompt de sistema de 600 tokens e uma pergunta curta nunca acertam na cache, e nada te avisa disso.
2. **O início do prompt muda.** A cache faz correspondência a partir do primeiríssimo token. Um timestamp, um id de pedido ou o nome do utilizador na primeira mensagem tornam cada pedido único logo a partir do primeiro token. As ferramentas, as imagens e os formatos de resposta também fazem parte do prefixo, por isso ferramentas listadas por outra ordem, ou um schema serializado de outra forma, quebram a correspondência.
3. **A entrada foi expulsa da cache.** As entradas são mantidas pouco tempo depois da última utilização, tipicamente minutos quando há pouco tráfego. Pedidos com uma hora de intervalo raramente acertam.
4. **O tráfego está disperso.** Os pedidos são encaminhados por um hash do início do prompt. Um volume muito alto com o mesmo prefixo transborda para outras máquinas que não têm a entrada. O parâmetro `prompt_cache_key` da OpenAI agrupa os pedidos que partilham um prefixo; usa uma chave por template de prompt, não por utilizador, e mantém moderado o ritmo de pedidos de cada chave, como o guia explica.
5. **Não estás a ler o campo.** Um pedido de Chat Completions em streaming não traz uso nenhum, a não ser que o peças com `stream_options: { include_usage: true }`. Muitos wrappers deitam fora `prompt_tokens_details`. Alguns fornecedores compatíveis com a OpenAI e algumas implementações do Azure reportam a cache de outra forma ou nem sequer a reportam.

## Testa-o em dois minutos

Antes de depurares a tua aplicação, confirma, antes de mais, que a cache funciona na tua conta e com o teu modelo. Envia o mesmo prompt longo duas vezes, com alguns segundos de intervalo, e lê o uso de cada resposta:

```bash
# A system prompt well above the threshold, sent twice. The second answer should report cached tokens.
BODY=$(python3 -c 'import json; print(json.dumps({"model": "gpt-4o-mini", "messages": [{"role": "system", "content": "You are a careful assistant for an invented shop. " * 200}, {"role": "user", "content": "Say OK."}]}))')
for i in 1 2; do
  curl -s https://api.openai.com/v1/chat/completions \
    -H "Authorization: Bearer $OPENAI_API_KEY" -H "Content-Type: application/json" \
    -d "$BODY" | python3 -c 'import json, sys; u = json.load(sys.stdin)["usage"]; print(u["prompt_tokens"], u.get("prompt_tokens_details"))'
done
```

Se a segunda linha mostrar tokens em cache, o lado do fornecedor funciona e o problema está na forma como a tua aplicação constrói os prompts: continua a ler. Se não mostrar nenhum, tenta mais algumas vezes (a cache funciona sem garantias e o primeiro pedido pode ir parar a outra máquina) e depois consulta a entrada do modelo no guia de cache da OpenAI. Usa o modelo que tens em produção; um teste noutro modelo prova pouco.

Este teste também te dá uma linha de base para as secções seguintes. Quando mudares a ordem do teu prompt ou acrescentares um `prompt_cache_key`, faz a mesma comparação com um template real da tua aplicação e guarda os números. Uma taxa de acerto medida antes e depois da alteração, num template que os teus utilizadores usam de facto, é um resultado que podes mostrar; «a cache deve ajudar» não é.

## Põe no fim o que muda

Na maioria dos casos, a solução é a ordem. Tudo o que é igual em todos os pedidos vai primeiro e mantém-se idêntico byte a byte; tudo o que muda vai para o fim.

```ts
type Message = { role: "system" | "user"; content: string };

const INSTRUCTIONS = "You answer questions about an invented product, Acme Notes. Rules: …"; // long, never changes
const EXAMPLES = "Example question: … Example answer: …"; // long, never changes

export function buildMessages(question: string, userName: string): Message[] {
  return [
    { role: "system", content: INSTRUCTIONS }, // cached
    { role: "system", content: EXAMPLES }, // cached
    // Everything that changes goes in the last message, after the cached part.
    { role: "user", content: `Date: ${new Date().toISOString().slice(0, 10)}. User: ${userName}.\n${question}` },
  ];
}
```

Depois, acompanha a fração de cada prompt que veio da cache, para que uma regressão apareça no próprio dia em que chega a produção:

```ts
interface OpenAIUsage {
  prompt_tokens?: number; // Chat Completions
  prompt_tokens_details?: { cached_tokens?: number };
  input_tokens?: number; // Responses API
  input_tokens_details?: { cached_tokens?: number };
}

/** Share of this request's input tokens that OpenAI served from its cache. */
export function cachedShare(u: OpenAIUsage): number {
  const total = u.prompt_tokens ?? u.input_tokens ?? 0;
  const cached = u.prompt_tokens_details?.cached_tokens ?? u.input_tokens_details?.cached_tokens ?? 0;
  return total === 0 ? 0 : cached / total;
}
```

Agrupa essa fração por template de prompt. Um template cuja fração fica nos 0 % apesar de os seus prompts terem mais de 1,024 tokens tem alguma coisa a mudar perto do início: regista dois pedidos e compara-os carácter a carácter, como se mostra na [versão deste guia para o Claude](/pt/guides/claude-prompt-caching-not-working#encontra-o-byte-que-quebra-a-cache).

## Como o BV-SALA ajuda

O [BV-SALA](https://github.com/BiVelio/bivelio-savings-layer) é uma camada de poupança Apache-2.0 para TypeScript que envolve qualquer endpoint compatível com a OpenAI, de graça e sem chave. A cache da OpenAI é automática, por isso a camada não marca nada na OpenAI. O que faz pela cache:

- **Pede sempre o uso nos streams,** para que um pedido em streaming seja medido em vez de ficar sem contador sem ninguém dar por isso.
- **Mostra o desconto da OpenAI em cada chamada,** em `report.nativeSavings`, a partir do contador da própria OpenAI, e mantém-no separado da sua própria poupança: o desconto é da OpenAI, não da camada.
- **Pode tirar do prefixo as linhas voláteis.** Com a opção `savings: { cachePrefix: true }`, as linhas do prompt de sistema que mudam em cada pedido (timestamps ISO, UUID, tempos epoch) passam para o fim, para que a parte estável possa ficar em cache. O modelo lê as mesmas linhas noutra ordem, e é por isso que a decisão é tua e nunca vem ligada por predefinição.

```ts
// npm i @bivelio/savings-layer   (ESM: a "type": "module" project or a .mts file)
import { createSavingsLayer, OpenAICompatibleProvider } from "@bivelio/savings-layer";

const layer = createSavingsLayer({
  provider: new OpenAICompatibleProvider({ baseUrl: "https://api.openai.com/v1", apiKey: process.env.OPENAI_API_KEY }),
});

const INSTRUCTIONS = "You write one-line summaries of release notes for an invented app. Style rules: …";

const stream = layer.generateStream({
  model: "openai/gpt-4o-mini",
  messages: [
    { role: "system", content: `Generated at ${new Date().toISOString()}\n${INSTRUCTIONS}` },
    { role: "user", content: "Summarize: fixed the export button; faster search; new dark theme." },
  ],
  savings: { cachePrefix: true }, // the timestamp line moves after the stable instructions
});
for await (const event of stream) {
  if (event.type === "text") process.stdout.write(event.delta);
}
const { report } = await stream.result;
console.log(report.tokens.providerCachedInput); // OpenAI's cached_tokens for this request
console.log(report.nativeSavings?.readDiscountUsd); // what those cached tokens saved at list price
```

As alavancas próprias da camada (saltar as repetições exatas e os pedidos idênticos em curso) são independentes da cache da OpenAI e são explicadas em [deduplicar pedidos idênticos a um LLM](/pt/guides/deduplicate-llm-requests).

## Confronta com os números da OpenAI

1. **Por pedido:** regista `cached_tokens` e o total de entrada de cada resposta, ou `report.tokens.providerCachedInput` com a camada.
2. **Por dia:** a [Usage API](https://developers.openai.com/api/reference/resources/organization/subresources/usage) da OpenAI devolve o uso de completions em intervalos diários que incluem os tokens de entrada em cache, por modelo e, se pedires, por chave de API ou projeto. Soma os teus registos da mesma chave, do mesmo modelo e do mesmo dia UTC: os totais com e sem cache devem coincidir.
3. **Em dinheiro:** valoriza em separado a entrada com e sem cache. Nos modelos que faturam as escritas na cache, inclui-as também, senão a tua estimativa da poupança vai sair alta demais.

Para o método completo, lê [como verificar a poupança em LLM com a fatura do teu fornecedor](/pt/guides/verify-llm-savings-against-provider-bill). Para o resto das alavancas numa fatura da OpenAI, vê [como reduzir os custos da API da OpenAI](/pt/guides/reduce-openai-api-costs). Os resultados medidos, incluindo os casos em que a camada não poupa nada, estão na [página do banco público](/pt/benchmarks), e o código está no [GitHub](https://github.com/BiVelio/bivelio-savings-layer).
