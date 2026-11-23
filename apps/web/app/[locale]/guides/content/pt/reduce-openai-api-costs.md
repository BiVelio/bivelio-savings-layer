Uma fatura da OpenAI é a soma de alguns números por pedido: tokens de entrada sem cache, tokens de entrada em cache, escritas na cache (no GPT-5.6 e posteriores), tokens de saída (raciocínio incluído) e o preço do modelo. Qualquer forma de a reduzir mexe num desses números. Este guia percorre as alavancas pela ordem em que costumam compensar, diz quando cada uma não compensa e mostra como provar cada poupança com os dados de uso da própria OpenAI, e não com uma projeção. Quase tudo se faz sem ferramenta nenhuma; onde o SDK open source BV-SALA automatiza uma alavanca, vais ver como.

## Começa por medir cada pedido

Antes de mudar o que quer que seja, regista o bloco `usage` de cada resposta juntamente com a funcionalidade ou o template de prompt que a gerou: `prompt_tokens`, `prompt_tokens_details.cached_tokens`, `cache_write_tokens` quando o modelo o devolve, `completion_tokens` e, nos modelos de raciocínio, `completion_tokens_details.reasoning_tokens`. Atribui um preço a cada parcela com as tarifas da página de preços da OpenAI e guarda a data em que as copiaste. No GPT-5.6 e posteriores, as escritas na cache são uma parcela à parte: a OpenAI fatura-as a 1,25 vezes a tarifa de entrada sem cache com a duração predefinida de 30 minutos, e a 2,5 vezes com a de 12 horas ([guia de prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching), consultado a 23 de novembro de 2026). Se as valorizares como entrada normal, ficas aquém do custo real. Uma semana assim responde à única pergunta que interessa no início: **que duas ou três funcionalidades fazem a maior parte da fatura.** Otimiza essas; ignora o resto.

## 1. Não pagues duas vezes o mesmo pedido

Os retries, os cliques duplos, os jobs noturnos que voltam a classificar o que já classificaram ontem e os workers em paralelo que enviam o mesmo prompt custam, cada um, uma chamada completa. Uma cache de respostas por correspondência exata e a deduplicação de pedidos em curso eliminam-nos sem mudar uma única resposta. Quanto poupas depende por completo da frequência com que os teus pedidos se repetem, por isso mede primeiro a tua taxa de duplicados. Guia completo: [deduplicar pedidos idênticos a um LLM](/pt/guides/deduplicate-llm-requests).

## 2. Deixa a cache de prompts da OpenAI trabalhar

Os prompts de cerca de 1.024 tokens ou mais ficam em cache automaticamente, e os tokens de entrada em cache são faturados com desconto. No GPT-5.6 e posteriores, encher a cache não é gratuito: a parte que lá é escrita é faturada acima da tarifa sem cache, como se explica acima, por isso um prompt que é escrito e nunca mais é lido custa mais do que sem cache, e um que volta a ser lido pouco depois custa muito menos. Os modelos anteriores não cobram nada a mais pelas escritas. A cache só faz correspondência a partir do primeiro token, por isso só funciona quando o início do teu prompt é idêntico entre pedidos. Põe primeiro as instruções, as definições de ferramentas e os exemplos, e no fim as datas, os nomes de utilizador e a pergunta. Se `cached_tokens` não sair do 0, vê [porque é que cached_tokens é 0 na OpenAI](/pt/guides/openai-prompt-caching-cached-tokens).

## 3. Manda para a Batch API o trabalho que pode esperar

As avaliações, os backfills, os embeddings de um conjunto de documentos e a classificação noturna não precisam de resposta em dois segundos. A [Batch API](https://developers.openai.com/api/docs/guides/batch) da OpenAI recebe um ficheiro de pedidos, devolve os resultados em menos de um dia e fatura-os a uma tarifa mais baixa do que os mesmos pedidos enviados um a um (as condições em vigor estão no [guia de otimização de custos](https://developers.openai.com/api/docs/guides/cost-optimization)). No trabalho offline é muitas vezes a maior poupança individual, e não muda nada nas respostas.

## 4. Usa o modelo mais pequeno que passe na tua avaliação

As diferenças de preço entre gamas de modelos são grandes, e muitas tarefas (classificação, extração, reescritas curtas, encaminhamento) não precisam do modelo maior. Monta um pequeno conjunto de avaliação com pedidos reais, corre-o contra dois ou três modelos e fica com o mais barato que passe. Volta a corrê-lo quando sair um modelo novo. Sem a avaliação, descer de modelo é um palpite, e o custo das respostas erradas não aparece na fatura da API.

## 5. Controla a saída

Os tokens de saída custam normalmente várias vezes mais do que os de entrada, e os tokens de raciocínio são faturados como saída.

- Ajusta `max_completion_tokens` ao que a funcionalidade precisa de facto.
- Nos modelos de raciocínio, baixa o esforço de raciocínio nas tarefas que não precisam de raciocinar a fundo, e mede `reasoning_tokens` antes e depois.
- Pede saída estruturada com um JSON schema quando o teu código faz o parsing da resposta. Uma falha de parsing seguida de um retry paga o pedido inteiro duas vezes.

## 6. Envia menos entrada

- Não reenvies a conversa inteira quando a tarefa só precisa dos últimos turnos.
- Tira dos turnos seguintes as saídas grandes de ferramentas (logs, conteúdo de ficheiros, resultados de pesquisa) depois de usadas.
- Envia os dados estruturados em formato compacto: o JSON formatado gasta tokens em espaços em branco.
- Recupera os três parágrafos relevantes em vez de colar o documento inteiro.

Cuidado com as duas últimas em ciclos de agente longos: editar o meio de um histórico que a OpenAI já tem em cache faz com que tudo o que vem depois da edição volte a ser faturado, à tarifa sem cache ou, no GPT-5.6 e posteriores, à tarifa mais alta de escrita na cache quando volta a ficar em cache. Encurta o que é novo, não o que já está em cache.

## Como o BV-SALA automatiza algumas destas alavancas

O [BV-SALA](https://github.com/BiVelio/bivelio-savings-layer) é uma camada de poupança Apache-2.0 que envolve qualquer endpoint compatível com a OpenAI em TypeScript. Poupa com todas as alavancas **de graça, sem chave e sem registo**, e não envia nada à BiVelio a não ser que acrescentes uma chave para o painel opcional na cloud. Ligadas por predefinição: a cache exata, a deduplicação de pedidos idênticos em curso, a resposta local a contas aritméticas simples e a serialização compacta dos dados estruturados que lhe passas. Ligam-se com uma opção cada: a cascata de modelos, a compactação das saídas de ferramentas e a reordenação para um prefixo que possa ficar em cache. Cada pedido devolve um relatório que diz o que se poupou e de onde vem o número.

```ts
// npm i @bivelio/savings-layer   (ESM: a "type": "module" project or a .mts file)
import { createSavingsLayer, OpenAICompatibleProvider } from "@bivelio/savings-layer";

const layer = createSavingsLayer({
  provider: new OpenAICompatibleProvider({
    baseUrl: "https://api.openai.com/v1",
    apiKey: process.env.OPENAI_API_KEY,
  }),
});

const { text, report } = await layer.generate({
  model: "openai/gpt-4o-mini",
  messages: [{ role: "user", content: "What is 2 + 2 * 3?" }],
});
console.log(text); // "8": computed on your machine, no call to OpenAI
console.log(report.calls.avoidedLlm); // 1: a whole call you did not pay for
console.log(report.cost.basis); // "estimated": nothing ran, so there is no provider counter to read
```

Dois limites, ditos com franqueza. Primeiro, o tráfego que nunca se repete poupa cerca de 0% com a cache e a deduplicação, por conceção. Segundo, o corte que a camada faz por predefinição dos resultados de ferramentas substituídos pode custar mais do que poupa em ciclos de agente longos com um fornecedor que põe em cache o prompt inteiro: o changelog do projeto regista +12,2% num ciclo de 60 passos com `gpt-5`, medido contra um fornecedor falso com as versões 1.2.3 e 1.2.4 e sem chave; a 1.2.5 corta da mesma forma. Em ciclos de agente longos, passa `savings: { elision: false }` no pedido e compara.

## Prova cada poupança com os números da OpenAI

Uma poupança que não consegues verificar é uma projeção. Para cada alavanca:

1. **Escolhe o contador em que ela deve mexer.** A cache e a deduplicação mexem no número de pedidos. A cache de prompts mexe em `cached_tokens` e, no GPT-5.6 e posteriores, também em `cache_write_tokens`. A Batch mexe no preço. A escolha de modelo mexe no preço por token. O controlo da saída mexe em `completion_tokens`.
2. **Lê esse contador na OpenAI.** A [Usage API](https://developers.openai.com/api/reference/resources/organization/subresources/usage) devolve pedidos e tokens de entrada, de entrada em cache e de saída por dia, modelo, projeto e chave. O endpoint de Costs e o painel de uso dão o dinheiro.
3. **Compara o que é comparável.** A mesma funcionalidade, os mesmos dias da semana, antes e depois ou, melhor ainda, dois braços do mesmo tráfego ao mesmo tempo. Olha primeiro para os tokens e só depois para os dólares: os dólares também variam com os preços.

Com a camada, cada relatório traz `cost.basis`: os montantes `measured` e `reference` vêm do contador da própria OpenAI, e os `estimated` são apresentados à parte e nunca misturados. O método completo: [verificar a poupança em LLM com a fatura do teu fornecedor](/pt/guides/verify-llm-savings-against-provider-bill).

## O que dizem os números publicados

A [página do banco público](/pt/benchmarks) do projeto mede os dois braços de cada teste com o contador de uso do próprio fornecedor. Numa carga pública construída com perguntas do GSM8K em que 30% dos pedidos eram repetições exatas, a redução agregada no `gpt-4o-mini` foi de **31,50%**, com um intervalo de 95% entre 25,7% e 36,7% (artefactos do SDK 0.4.31, setembro de 2026; também no README). Em chat de dois turnos sem repetições (MT-Bench), as diferenças foram indistinguíveis de zero ou não atribuíveis à camada, e a página di-lo. O método, os intervalos e todas as limitações estão no [artigo](/pt/paper). O código está no [GitHub](https://github.com/BiVelio/bivelio-savings-layer).
