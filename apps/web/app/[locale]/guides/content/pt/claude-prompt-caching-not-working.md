Acrescentaste `cache_control` aos teus pedidos ao Claude e a fatura não mexeu. Ou `cache_read_input_tokens` vem a `0` em todas as chamadas. Este guia explica porque é que isso acontece, como encontrar o byte exato que quebra a tua cache e como confrontar o resultado com os números de uso da própria Anthropic. Tudo o que está aqui funciona com qualquer SDK. No fim vais ver como o SDK open source BV-SALA coloca os pontos de corte (breakpoints) por ti, e o único caso em que lhe deves dizer que não o faça.

## Lê primeiro os três campos de uso

Cada resposta da Messages API diz-te o que aconteceu com a cache. Olha para três números em `usage`:

| Campo | O que conta |
| --- | --- |
| `cache_creation_input_tokens` | Tokens escritos na cache nesta chamada, faturados acima do preço normal de entrada |
| `cache_read_input_tokens` | Tokens servidos a partir da cache, faturados a uma fração do preço de entrada |
| `input_tokens` | Tokens depois do último ponto de corte da cache, faturados ao preço normal |

Os três padrões dizem-te onde procurar:

- **Os dois campos de cache estão a 0.** Nada ficou em cache: o prefixo é mais curto do que o mínimo do modelo, não há ponto de corte ou alguma coisa entre ti e a API removeu-o.
- **A criação é alta em todas as chamadas e as leituras ficam a 0.** A cache é escrita e nunca reutilizada: o prefixo muda entre chamadas, a entrada expirou ou as chamadas vão para outro modelo ou outro workspace.
- **As leituras são altas.** Funciona. Agora a única questão é quanto do prompt fica antes do ponto de corte.

## Como funciona a cache de prompts do Claude, em seis factos

1. Põe em cache um **prefixo**: o pedido desde o início até um ponto de corte `cache_control`. A correspondência é exata; basta um byte diferente para que tudo o que vem a seguir seja processado de novo.
2. A ordem é **tools, depois system, depois messages**. Uma alteração na lista de ferramentas invalida o prompt de sistema e as mensagens que vêm a seguir.
3. Podes colocar até **quatro pontos de corte**, e a partir de cada um a API procura para trás uma entrada anterior num número limitado de blocos (20 no momento em que isto foi escrito).
4. As entradas duram **cinco minutos** por predefinição e são renovadas a cada acerto. Com `"ttl": "1h"` tens uma duração de uma hora.
5. Escrever custa mais do que ler: uma escrita de cinco minutos é faturada a 1,25 vezes o preço de entrada e uma de uma hora a 2 vezes; uma leitura custa uma pequena fração do preço de entrada (0,1 vezes na maioria dos modelos). Consulta a [página de preços da Anthropic](https://platform.claude.com/docs/en/about-claude/pricing) para o teu modelo.
6. Há um **comprimento mínimo para ir para a cache** que depende do modelo, de 512 a 4.096 tokens. Abaixo disso, o pedido simplesmente não fica em cache, sem qualquer erro.

Tudo isto está na [documentação de prompt caching da Anthropic](https://platform.claude.com/docs/en/build-with-claude/prompt-caching), que é a fonte em que deves confiar quando um número muda.

## As causas habituais, pela ordem em que as deves verificar

1. **O prefixo é demasiado curto.** Um prompt de sistema de 600 tokens está abaixo do mínimo em vários modelos. Junta as instruções estáveis, os exemplos e o texto de referência para que a parte em cache seja suficientemente longa para fazer diferença.
2. **Alguma coisa no prefixo muda em cada chamada.** Os clássicos: um timestamp ou uma linha «Hoje é…» no prompt de sistema, um id de pedido, o nome do utilizador, uma ordem aleatória dos exemplos, definições de ferramentas geradas a partir de um objeto cuja ordem de chaves não é fixa, ou um documento JSON serializado com um espaçamento diferente.
3. **O ponto de corte está em conteúdo que muda.** Se o último `cache_control` estiver na pergunta do utilizador, cada chamada escreve uma entrada nova que ninguém lê. O ponto de corte deve ficar no fim da parte que não muda.
4. **A entrada expirou.** Duas chamadas com mais de cinco minutos de intervalo nunca leem a entrada uma da outra. Um batch noturno que processa um elemento a cada dez minutos paga o sobrecusto de escrita de todas as vezes e não lê nada.
5. **As chamadas não partilham cache.** Outro modelo, outro workspace ou uma troca de modelo a meio da conversa começam, cada um, com a cache vazia.
6. **As chamadas em paralelo competem entre si.** Uma entrada só pode ser lida depois de a primeira resposta ter começado. Dez chamadas idênticas disparadas ao mesmo tempo escrevem todas. Envia uma primeiro e depois as restantes.
7. **Um proxy remove a marca.** Um gateway que retira `cache_control`, ou que converte um `system` em forma de blocos numa string simples, faz com que o prompt inteiro seja faturado como entrada sem cache, enquanto todas as chamadas continuam a funcionar. A documentação do Claude Code descreve exatamente esta falha para os [gateways de LLM](https://code.claude.com/docs/en/prompt-caching).

## Encontra o byte que quebra a cache

Quando as leituras ficam a zero, regista dois corpos de pedido consecutivos e procura onde diferem pela primeira vez, pela ordem em que a cache os lê:

```ts
type Body = { tools?: unknown[]; system?: unknown; messages: unknown[] };

// The cache reads tools, then system, then messages. Compare in that order.
const inCacheOrder = (b: Body) => JSON.stringify([b.tools ?? [], b.system ?? "", b.messages]);

export function firstDifference(a: Body, b: Body): string | null {
  const x = inCacheOrder(a);
  const y = inCacheOrder(b);
  let i = 0;
  while (i < x.length && i < y.length && x[i] === y[i]) i++;
  if (i === x.length && i === y.length) return null;
  return `differs at character ${i}:\n  ${x.slice(Math.max(0, i - 40), i + 40)}\n  ${y.slice(Math.max(0, i - 40), i + 40)}`;
}
```

Se a primeira diferença estiver dentro do prompt de sistema ou da lista de ferramentas, encontraste a tua falha de cache. Passa essa parte para o fim do pedido, normalmente para a mensagem do utilizador.

Depois, acompanha a taxa de acerto de cada chamada, para que uma regressão apareça no próprio dia em que chega a produção:

```ts
interface ClaudeUsage {
  input_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

/** Share of the input tokens that were read from the cache on this call. */
export function cacheHitRate(u: ClaudeUsage): number {
  const read = u.cache_read_input_tokens ?? 0;
  const written = u.cache_creation_input_tokens ?? 0;
  const total = read + written + u.input_tokens;
  return total === 0 ? 0 : read / total;
}
```

## A cache compensa para o teu tráfego?

Como as escritas custam mais do que a entrada normal, usar a cache é apostar que o prefixo vai voltar a ser lido antes de expirar. Com a duração de cinco minutos, uma única leitura já paga a escrita. Um prefixo que é escrito e nunca lido custa cerca de 25% mais do que enviá-lo sem marca. É por isso que «põe `cache_control` em todo o lado» não é uma predefinição segura: compensa no tráfego de chat e de agentes que volta ao fim de poucos minutos, e perde em pedidos avulsos ou em prompts que mudam de todas as vezes.

## Como o BV-SALA trata disto

O [BV-SALA](https://github.com/BiVelio/bivelio-savings-layer) é uma camada de poupança Apache-2.0. Com o `AnthropicProvider`, coloca os pontos de corte por ti, de graça e sem chave: um no fim do prompt de sistema e outro no fim da parte da conversa que não muda, nunca mais do que a API permite. O relatório de cada chamada mostra o que a cache fez, a partir dos contadores da própria Anthropic:

```ts
// npm i @bivelio/savings-layer   (ESM: a "type": "module" project or a .mts file)
import { createSavingsLayer, AnthropicProvider } from "@bivelio/savings-layer";

const layer = createSavingsLayer({
  provider: new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY }),
});

// Long and stable: no dates, no user names, no request ids in here.
const SYSTEM = "You are the support assistant for Acme Outdoor, an invented shop. Our return policy: …";

const { text, report } = await layer.generate({
  model: "anthropic/claude-haiku-4-5",
  messages: [
    { role: "system", content: SYSTEM },
    { role: "user", content: "Can I return hiking boots after 20 days?" },
  ],
});
console.log(text);
console.log(report.nativeSavings?.cacheReadTokens, report.nativeSavings?.cacheWriteTokens);
console.log(report.nativeSavings?.netUsd); // read discount minus write premium; negative on a cold write
```

`report.nativeSavings` é o desconto da Anthropic, apresentado à parte: a camada nunca o conta como poupança sua, por isso o teu relatório bate certo com a fatura.

**O caso em que deves desligar as marcas.** Sem chave, se o teu prompt de sistema mudar em cada pedido (um timestamp, um id de utilizador) ou se as tuas chamadas estiverem separadas por mais de cinco minutos em processos novos, a marcação predefinida escreve uma entrada de cache que ninguém lê, e o README indica que isso custa cerca de 20% mais do que sem camada. Passa o que muda para a mensagem do utilizador, ou desliga as marcas:

```ts
import { createSavingsLayer, AnthropicProvider } from "@bivelio/savings-layer";

// A system prompt that changes every time: no cache marks, no write premium.
export const noMarks = createSavingsLayer({
  provider: new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY, maxCacheBreakpoints: 0 }),
});

// Or keep the marks and, per request, let the layer move timestamp and UUID
// lines to the end of the system prompt, outside the cached part (opt-in: the
// model reads the same lines in a different order).
const layer = createSavingsLayer({
  provider: new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY }),
});
export const reply = await layer.generate({
  model: "anthropic/claude-haiku-4-5",
  messages: [
    { role: "system", content: `Today is ${new Date().toISOString()}\nYou are the support assistant for Acme Outdoor, an invented shop. …` },
    { role: "user", content: "Can I return hiking boots after 20 days?" },
  ],
  savings: { cachePrefix: true },
});
```

Essa reordenação opcional é a alavanca por trás de um teste exploratório ao vivo publicado no README: no `claude-haiku-4-5`, numa sequência construída em que um timestamp envenenava a cache, levou a taxa de acerto de 0% para 95% e baixou o custo por pedido em 82,76%, em comparação com a própria camada sem a opção, com 20 pedidos por braço, medido com a versão 1.2.0 a 15 de novembro de 2026. É um teste pequeno e construído, não uma previsão para o teu tráfego.

## Confronta com os números da Anthropic

1. **Por chamada.** Regista o `usage` de cada resposta (ou `report.nativeSavings`, se usares a camada) e calcula a taxa de acerto acima. Uma carga saudável de chat ou de agentes mostra, depois da primeira chamada, muito mais leituras do que escritas.
2. **Por dia.** Na Claude Console, a página de uso divide a entrada em escritas e leituras de cache por modelo e chave de API. Soma os `cache_read_input_tokens` e `cache_creation_input_tokens` que registaste para a mesma chave e o mesmo dia UTC: os totais devem coincidir. Para uma verificação programática, a [Usage and Cost Admin API](https://platform.claude.com/docs/en/manage-claude/usage-cost-api) devolve os mesmos contadores.
3. **Em dinheiro.** Atribui preço às leituras, às escritas e à entrada normal em separado. Um relatório que só mostra «tokens poupados» e não o sobrecusto de escrita está a esconder metade da conta.

O [banco público](/pt/benchmarks) do repositório mede os dois braços de cada teste com o contador de uso do próprio fornecedor. Para o método geral, vê [como verificar a poupança em LLM com a tua fatura](/pt/guides/verify-llm-savings-against-provider-bill). Para o lado da OpenAI do mesmo problema, vê [porque é que cached_tokens é 0 na OpenAI](/pt/guides/openai-prompt-caching-cached-tokens). O código está no [GitHub](https://github.com/BiVelio/bivelio-savings-layer).
