DeepSeek e Qwen são baratos por token, e isso faz com que seja fácil deixar de vigiar a fatura. Os dois fornecedores põem os prompts em cache do lado deles, e a entrada que acerta na cache é faturada muito abaixo da que falha. Por isso, o custo real do teu tráfego depende de um número que a maioria dos painéis esconde: quantos tokens de entrada acertam na cache em cada pedido. Este guia explica como os dois fornecedores faturam e usam a cache, como calcular o preço de um pedido a partir dos seus campos de uso e como vê-lo pedido a pedido com um gateway local gratuito.

## Como a DeepSeek fatura um pedido

A DeepSeek divide a entrada de cada pedido em duas: os tokens que acertam na sua cache de contexto e os que falham, cada um com o seu preço, mais os tokens de saída. A sua [cache de contexto](https://api-docs.deepseek.com/guides/kv_cache) está ligada por predefinição em todas as contas. Para haver um acerto, o início do pedido tem de coincidir exatamente com o de um pedido anterior; a cache funciona sem garantias, e as entradas que não são usadas são apagadas ao fim de algumas horas ou dias. A resposta diz-te o que aconteceu:

- `usage.prompt_cache_hit_tokens`: tokens de entrada servidos a partir da cache.
- `usage.prompt_cache_miss_tokens`: tokens de entrada processados por inteiro.
- `usage.prompt_tokens_details.cached_tokens`: a mesma contagem de acertos, no campo que as ferramentas compatíveis com a OpenAI leem.

A [página de preços](https://api-docs.deepseek.com/quick_start/pricing) da DeepSeek indica os preços de acerto, de falha e de saída de cada modelo, e um horário fora de ponta com um preço mais baixo. Os preços mudam; copia-os com a data em que os consultaste.

## Como a Qwen fatura um pedido

Os modelos Qwen no Alibaba Cloud Model Studio têm dois tipos de [cache de contexto](https://www.alibabacloud.com/help/en/model-studio/context-cache). A cache implícita é automática para prompts acima de um comprimento mínimo, e os seus acertos são faturados com desconto. A explícita funciona como a da Anthropic: marcas um bloco com `cache_control`, a entrada dura alguns minutos, e escrevê-la custa um pouco mais do que a entrada normal, enquanto lê-la custa muito menos. Na API compatível com a OpenAI, a contagem de acertos chega em `usage.prompt_tokens_details.cached_tokens`. O Model Studio tem endpoints regionais, por isso confirma a qual deles pertence a tua chave.

## Faz a cache acertar, em qualquer um dos dois

As regras são as mesmas de qualquer cache de prefixo:

1. Põe primeiro o que nunca muda: o prompt de sistema, as definições de ferramentas, o texto de referência longo, os exemplos few-shot.
2. Mantém-no idêntico byte a byte entre pedidos: nada de timestamps, ids de pedido ou nomes de utilizador lá dentro, e as definições de ferramentas numa ordem fixa.
3. Põe no fim o que muda: a pergunta do utilizador, o último resultado de uma ferramenta.
4. Nos agentes, acrescenta ao histórico em vez de o reescreveres. Editar uma mensagem antiga a meio invalida tudo o que vem a seguir.

## Calcula o custo de um pedido

Não precisas de ferramenta nenhuma para calcular o preço de um pedido. Lê o bloco de uso e multiplica cada parcela pelo seu preço:

```python
def request_cost(usage: dict, price_miss: float, price_hit: float, price_out: float) -> float:
    """USD cost of one chat completion. Prices are per million tokens, from the provider's pricing page."""
    details = usage.get("prompt_tokens_details") or {}
    hit = usage.get("prompt_cache_hit_tokens", details.get("cached_tokens", 0)) or 0
    miss = usage["prompt_tokens"] - hit
    return (miss * price_miss + hit * price_hit + usage["completion_tokens"] * price_out) / 1_000_000
```

Regista esse número com o modelo, a fração de acertos (`hit / prompt_tokens`) e um timestamp em cada pedido, e consegues responder às perguntas que interessam: que funcionalidade custa mais, se a taxa de acerto da cache caiu depois de um deploy e quanto do teu tráfego cai no horário fora de ponta.

## Vê cada pedido com um gateway local

Para não teres de mexer em cada ponto do código que chama a API, põe um gateway à frente do fornecedor. O [BV-SALA](https://github.com/BiVelio/bivelio-savings-layer) inclui um no seu pacote npm: Apache-2.0, local, **sem chave e sem registo**, e nada é enviado à BiVelio. Arranca um gateway por fornecedor, cada um na sua porta:

```bash
# DeepSeek
npx @bivelio/savings-layer gateway --upstream deepseek --port 8403

# Qwen on Model Studio's international endpoint (`--upstream qwen` is the Beijing one)
npx @bivelio/savings-layer gateway --upstream https://dashscope-intl.aliyuncs.com --port 8404
```

O gateway reencaminha para o fornecedor o caminho que o teu cliente envia, por isso a tua base URL é a do próprio fornecedor com o gateway como host:

| Fornecedor | `--upstream` | Base URL para o teu cliente OpenAI |
| --- | --- | --- |
| DeepSeek | `deepseek` | `http://127.0.0.1:8403` |
| Qwen (Pequim) | `qwen` | `http://127.0.0.1:<port>/compatible-mode/v1` |
| Qwen (internacional) | `https://dashscope-intl.aliyuncs.com` | `http://127.0.0.1:8404/compatible-mode/v1` |
| GLM | `glm` | `http://127.0.0.1:<port>/api/paas/v4` |

`npx @bivelio/savings-layer --help` lista os outros upstreams (Moonshot, MiniMax, OpenRouter, Gemini, Ollama, vLLM, LM Studio).

Em Python, o pequeno cliente do pacote trata da base URL por ti: cria o teu cliente OpenAI do costume para o fornecedor, e `wrap()` devolve uma cópia que passa pelo gateway, mantendo o caminho do fornecedor.

```python
# pip install bivelio-savings-layer openai
import os

import bvsala
from openai import OpenAI

gw = bvsala.Gateway("http://127.0.0.1:8403")  # the DeepSeek gateway started above
deepseek = gw.wrap(OpenAI(base_url="https://api.deepseek.com", api_key=os.environ["DEEPSEEK_API_KEY"]))

resp = deepseek.chat.completions.create(
    model="deepseek-flash",
    messages=[
        {"role": "system", "content": "You review Python diffs for an invented team. House rules: ..."},
        {"role": "user", "content": "Review this diff: ..."},
    ],
)
report = gw.report(resp)
print(report.summary())  # model · basis · cost (in, cached, out)
print(report.tokens.provider_cached_input, report.cost.actual)
```

O mesmo funciona para a Qwen com o outro gateway e `OpenAI(base_url="https://dashscope-intl.aliyuncs.com/compatible-mode/v1", ...)`. Se encaminhares o teu tráfego por um proxy HTTP, define `NO_PROXY=127.0.0.1,localhost` para que os pedidos ao gateway local não passem por ele. Se não houver nenhum gateway a correr, `wrap()` lança `GatewayUnavailable` em vez de chamar o fornecedor diretamente. Na versão 1.2.3, essa mensagem de erro diz também que o gateway precisa de uma chave de serviço: não precisa, arranca sem nenhuma.

Qualquer outra linguagem ou ferramenta também serve: aponta a respetiva base URL da OpenAI para o gateway, e cada pedido passa a ser uma linha no log do gateway, com o modelo, o custo a preço de tabela e a entrada dividida em tokens a preço completo e leituras de cache (`cache↓`).

Há uma exceção que importa nas ferramentas de chat e nos agentes: um pedido em **streaming** que não pede o uso (`stream_options: {"include_usage": true}`) não recebe nenhum do fornecedor, por isso a versão 1.2.3 regista-o como `not metered: the request did not ask for usage`. Pede o uso no teu cliente, ou arranca o gateway com `BVSALA_GATEWAY_USAGE_INJECT=1`, que acrescenta essa opção aos streams que não a têm. O último chunk desses streams traz então uma lista `choices` vazia, algo que o código que lê `choices[0]` sem verificar não espera.

## Agentes de programação com DeepSeek ou Qwen

A DeepSeek também publica um endpoint no formato da Anthropic e documenta como usá-lo com o Claude Code. Com `--upstream deepseek`, o gateway envia sozinho para esse endpoint os pedidos no formato da Anthropic:

```bash
npx @bivelio/savings-layer gateway --upstream deepseek --port 8402
ANTHROPIC_BASE_URL=http://127.0.0.1:8402 ANTHROPIC_AUTH_TOKEN="$DEEPSEEK_API_KEY" ANTHROPIC_MODEL=deepseek-flash claude
```

Usar um modelo que não é o Claude por trás do Claude Code é uma integração da DeepSeek, não uma configuração que a Anthropic suporte, e cabe-te a ti avaliar a qualidade do modelo para o teu trabalho.

**O Qwen Code com modelos Qwen** precisa de outro caminho. O wrapper `qwen` do pacote não o cobre: na versão 1.2.3, `npx @bivelio/savings-layer qwen` corre o Qwen Code com o seu tipo de autenticação da Anthropic e reencaminha para a API da Anthropic, por isso só mede modelos Claude usados com uma chave da Anthropic, e recusa uma base URL da DashScope no formato da Anthropic. Para modelos Qwen, usa o modo compatível com a OpenAI do Qwen Code, que [a sua documentação](https://qwenlm.github.io/qwen-code-docs/en/users/configuration/auth/) configura com `OPENAI_API_KEY`, `OPENAI_BASE_URL` e `OPENAI_MODEL`, e aponta essa base URL para um gateway. Define `DASHSCOPE_PROXY_BASE_URL` exatamente com o mesmo URL:

```bash
npx @bivelio/savings-layer gateway --upstream https://dashscope-intl.aliyuncs.com --port 8404

GW=http://127.0.0.1:8404/compatible-mode/v1
OPENAI_BASE_URL="$GW" DASHSCOPE_PROXY_BASE_URL="$GW" OPENAI_API_KEY="$DASHSCOPE_API_KEY" OPENAI_MODEL=qwen-plus qwen
```

A segunda variável conta para a fatura. O Qwen Code decide pelo host da base URL se está a falar com a DashScope, e `127.0.0.1` não é um host da DashScope. Sem a variável, recorre ao seu fornecedor OpenAI genérico, que não envia marcas de cache explícita (`cache_control` e o cabeçalho `X-DashScope-CacheControl`). Os teus pedidos caem então na cache implícita do Model Studio, onde os acertos custam tipicamente 20% do preço de entrada e funcionam sem garantias, em vez dos 10% da cache explícita ([cache de contexto](https://www.alibabacloud.com/help/en/model-studio/context-cache)). O Qwen Code trata como DashScope uma base URL que coincida exatamente com `DASHSCOPE_PROXY_BASE_URL`, e mantém as marcas ([o seu fornecedor DashScope](https://github.com/QwenLM/qwen-code/blob/8fab857da5/packages/core/src/core/openaiContentGenerator/provider/dashscope.ts), consultado a 23 de novembro de 2026). O gateway reencaminha as duas sem alterações: verificámo-lo com a versão 1.2.3.

Verificámos o lado do gateway deste caminho com a versão 1.2.3, não o próprio Qwen Code, por isso lê o log do gateway: uma linha com um custo por pedido. Uma linha `not metered` diz porquê: normalmente, um stream que não pede o uso (reinicia o gateway com `BVSALA_GATEWAY_USAGE_INJECT=1`) ou um modelo sem linha no catálogo da 1.2.3, que tem `qwen-plus`, `qwen-flash`, `qwen3.7-flash`, `qwen3.8-flash` e `qwen3.8-max`, mas não, por exemplo, `qwen3-coder-plus`.

Há duas discrepâncias de preço na 1.2.3 que dependem da segunda variável. **Com `DASHSCOPE_PROXY_BASE_URL` definida**, como acima, o Model Studio fatura cada escrita na cache explícita a 125% do preço de entrada e reporta-a em `usage.prompt_tokens_details.cache_creation_input_tokens`. O gateway 1.2.3 não lê esse campo: regista esses tokens como entrada normal, com `cache↑0`, a 80% do que custam. O seu preço de acerto para o `qwen-plus` é o da cache explícita, 10%, o que coincide. **Sem a variável** não há escritas explícitas, mas os acertos são implícitos, faturados a cerca de 20%, e o gateway regista-os aos mesmos 10%, cerca de metade do que custam.

## O que o gateway mede, e o que não mede

- **O valor em dólares vem de um catálogo, não dos preços por horário da DeepSeek.** A versão 1.2.3 tem linhas para `deepseek-flash` e `deepseek-v4-pro`. Para as falhas de cache e a saída usam o preço de hora de ponta da DeepSeek, por isso fora de ponta essas parcelas mostram o dobro do que a DeepSeek fatura. Para os acertos de cache, as duas linhas usam US$ 0,003 por milhão de tokens, que é o preço de acerto fora de ponta da DeepSeek para o `deepseek-flash` (o seu preço de acerto em hora de ponta é o dobro) e fica abaixo dos dois preços de acerto que a DeepSeek publica para o `deepseek-v4-pro` ([página de preços](https://api-docs.deepseek.com/quick_start/pricing), consultada a 23 de novembro de 2026). Conforme a hora e a parte da tua entrada que acerta na cache, o total do gateway pode ficar acima ou abaixo da fatura. As contagens de tokens são exatas; compara essas primeiro. O clássico alias `deepseek-chat` não tem linha: é reencaminhado, e o log diz que não foi medido.
- **Não altera estes pedidos.** No tráfego compatível com a OpenAI, o gateway mede e reencaminha (a única exceção é a injeção opcional do uso descrita acima); as suas alavancas de poupança são para o tráfego no formato da Anthropic. A poupança na DeepSeek e na Qwen vem das caches delas, e é por isso que a contagem de acertos é o número a vigiar.

## Se chamas a DeepSeek ou a Qwen a partir de TypeScript

O SDK do BV-SALA fala com qualquer endpoint compatível com a OpenAI e salta as repetições exatas e os pedidos idênticos em curso, de graça e sem chave ([como isso funciona](/pt/guides/deduplicate-llm-requests)). Na DeepSeek, essas chamadas evitadas são reportadas como `estimated`, não como `reference`: a versão 1.2.3 só valoriza uma repetição por referência quando a chamada que correu foi para a API própria da OpenAI, da Anthropic ou da Google. Um aviso para os ciclos de agente: o corte predefinido dos resultados de ferramentas substituídos reescreve o meio do histórico, e com um fornecedor que põe em cache o prompt inteiro por si próprio isso pode custar mais do que poupa. O changelog do projeto regista +166% num ciclo de agente de 60 passos na DeepSeek, medido contra um fornecedor falso com as versões 1.2.3 e 1.2.4 e sem chave. Nos ciclos de agente, desliga-o por pedido:

```ts
// npm i @bivelio/savings-layer   (ESM: a "type": "module" project or a .mts file)
import { createSavingsLayer, OpenAICompatibleProvider } from "@bivelio/savings-layer";

const layer = createSavingsLayer({
  provider: new OpenAICompatibleProvider({ baseUrl: "https://api.deepseek.com/v1", apiKey: process.env.DEEPSEEK_API_KEY }),
});

const { text, report } = await layer.generate({
  model: "deepseek-flash",
  messages: [{ role: "user", content: "Explain what a race condition is in two sentences." }],
  savings: { elision: false }, // keep the history byte-identical for DeepSeek's own cache
});
console.log(text, report.tokens.providerCachedInput, report.cost.basis);
```

## Confronta os números com o teu fornecedor

Uma vez por dia, compara os totais por modelo do gateway (entrada, acertos de cache, saída) com a página de uso da plataforma da DeepSeek ou do Model Studio para a mesma chave. As contagens totais de tokens devem coincidir, com uma exceção na forma como se dividem: na Qwen, a versão 1.2.3 conta as escritas na cache explícita como entrada normal, não como escritas na cache. Os montantes em dólares podem diferir, em qualquer dos sentidos, por razões conhecidas. Os preços do catálogo não são os preços por horário da DeepSeek. Na Qwen, a 1.2.3 valoriza as escritas na cache explícita como entrada normal, abaixo do que o Model Studio fatura, e os acertos implícitos à tarifa explícita (ambos descritos acima). Os preços regionais e os descontos também mudam o dinheiro. Para um método passo a passo, vê [como verificar a poupança em LLM com a fatura do teu fornecedor](/pt/guides/verify-llm-savings-against-provider-bill). O código do gateway e os seus guias por terminal estão no [GitHub](https://github.com/BiVelio/bivelio-savings-layer), e o que o projeto mediu, e o que não mediu, está na [página do banco público](/pt/benchmarks).
