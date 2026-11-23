«Quanto custa o Claude Code?» tem duas respostas honestas. Numa subscrição do Claude, o preço é o do plano, e o custo por token só interessa quando ultrapassas os seus limites. Com uma chave de API ou um fornecedor cloud, pagas por token, e o custo de uma sessão depende de quantos pedidos o Claude Code envia, do tamanho de cada um e de quanto disso é lido da cache de prompts. Este guia mostra o que a Anthropic publica, que ferramentas integradas te dão totais e como ver o custo de cada pedido na tua própria máquina, de graça, para encontrares os turnos que tornam uma sessão cara.

## O que a Anthropic diz que custa

A [página de custos do Claude Code](https://code.claude.com/docs/en/costs) da própria Anthropic dá médias de implementações empresariais: cerca de US$ 13 por programador e por dia ativo e de US$ 150 a US$ 250 por programador por mês, com 90% dos utilizadores abaixo de US$ 30 por dia ativo. São médias de muitas equipas. O teu número depende do modelo que escolheres, do tamanho do teu repositório e da forma como trabalhas, e é por isso que o resto deste guia é sobre como medi-lo.

## As ferramentas integradas, e o que não mostram

- **`/usage` no Claude Code.** O bloco Session mostra um custo *estimado* a preço de tabela, com os tokens por modelo divididos em entrada, saída, leituras de cache e escritas na cache. As versões recentes acrescentam uma linha de cache de prompts com a taxa de acerto e o número de falhas. É um total da sessão, calculado localmente.
- **A Claude Console.** Para chaves de API, as páginas Cost e Usage mostram o que foi faturado, por dia, workspace e modelo. É este o número com que deves fazer a reconciliação.
- **Exportação para OpenTelemetry.** O Claude Code pode enviar métricas de tokens e de custo para a tua própria stack de observabilidade, por utilizador e sessão ([documentação de monitorização](https://code.claude.com/docs/en/monitoring-usage)).

O que nenhuma destas facilita é a **vista por pedido**: que turno foi o caro, e porquê. Uma sessão são dezenas ou centenas de chamadas à API, e as caras têm causas reconhecíveis:

- **Uma cache fria.** O primeiro turno depois de uma pausa mais longa do que a duração da cache volta a ler a conversa inteira a preço completo, e escreve-a de novo.
- **Uma troca de modelo.** Cada modelo tem a sua própria cache, por isso trocar de modelo a meio da sessão volta a processar tudo.
- **Resultados de ferramentas enormes.** Um log de testes ou um ficheiro grande lido uma única vez fica no contexto de todos os turnos seguintes.
- **Demasiadas definições de ferramentas.** Os servidores MCP podem acrescentar muitos kilobytes de definições a cada pedido.
- **A compactação.** Resumir uma conversa longa é, em si mesmo, um pedido grande.

## Mede cada pedido com um gateway local

Um gateway é um pequeno proxy entre o Claude Code e a API que lê os contadores de uso de cada resposta. O Claude Code suporta isto oficialmente através de `ANTHROPIC_BASE_URL`. O [BV-SALA](https://github.com/BiVelio/bivelio-savings-layer) inclui um no seu pacote npm: Apache-2.0, **sem chave, sem registo**, e nada é enviado à BiVelio. Precisa do Node.js 20.19.0 ou mais recente.

Com um único comando:

```bash
# Starts a local gateway on a free port, runs Claude Code through it, and stops it on exit.
npx @bivelio/savings-layer claude
```

O wrapper silencia o log por pedido para não desenhar por cima da interface do Claude Code. Ao sair, mostra quantos pedidos mediu, quanto custaram a preço de tabela, o que poupou ou porque não poupou nada, e que pedidos reencaminhou sem medir e porquê. Para veres cada pedido no momento, ou pedes o log no stderr:

```bash
BVSALA_GATEWAY_LOG=1 npx @bivelio/savings-layer claude
```

ou arrancas o gateway no seu próprio terminal, numa porta fixa:

```bash
# Terminal 1: the gateway (Anthropic is the default upstream, port 8402)
npx @bivelio/savings-layer gateway

# Terminal 2: Claude Code, pointed at it (no /v1 at the end).
# ENABLE_TOOL_SEARCH=true only matters before Claude Code v2.1.304 (see below).
ENABLE_TOOL_SEARCH=true ANTHROPIC_BASE_URL=http://127.0.0.1:8402 claude
```

Cada pedido passa a ser uma linha. Estas duas vêm de um teste local contra um servidor de teste, com tráfego inventado: o formato é real e os números não são os teus:

```text
[gateway] POST /v1/messages  · claude-sonnet-5 · $0.007700 (in 40, cache↑3000 cache↓0, out 12)
[gateway] POST /v1/messages  · claude-sonnet-5 · $0.000800 (in 40, cache↑0 cache↓3000, out 12)
```

Lê-se da esquerda para a direita: o modelo, o custo ao preço de tabela padrão do modelo (os turnos em modo rápido são a exceção, mais abaixo), depois os tokens de entrada faturados por inteiro, os tokens escritos na cache (`cache↑`), os tokens lidos dela (`cache↓`) e os tokens de saída. A primeira linha é um turno a frio que escreve o prefixo; a segunda volta a lê-lo por uma fração do preço. Uma sessão em que `cache↑` se mantém alto turno após turno tem um problema de cache: vê [porque é que o prompt caching do Claude deixa de funcionar](/pt/guides/claude-prompt-caching-not-working).

`ENABLE_TOOL_SEARCH=true` depende da tua versão do Claude Code. Desde a v2.1.304, a pesquisa de ferramentas (tool search) continua ativa atrás de um gateway ([documentação de MCP do Claude Code](https://code.claude.com/docs/en/mcp)), e a variável não muda nada. Antes da v2.1.304, o Claude Code desligava o tool search atrás de qualquer base URL que não fosse a da Anthropic e metia todas as definições de ferramentas em cada pedido. Nessas versões mais antigas, isso saía caro: o guia do Claude Code do gateway, incluído no pacote npm, regista uma configuração com 226 ferramentas MCP, medida a 9 de setembro de 2026, em que isso significava 450 KB por pedido e um quarto da fatura desse dia. O wrapper `claude` define a variável por ti, a não ser que já a tenhas definido.

## O que o gateway vê, e o que não vê

- **Reencaminha o que o Claude Code envia.** Sem nenhuma alavanca a atuar sobre um pedido, o corpo chega à Anthropic byte a byte, incluindo as marcas `cache_control` e o cabeçalho `anthropic-beta`, por isso a cache funciona exatamente como sem o gateway. Um teste no repositório verifica isto contra um upstream falso a cada alteração.
- **Duas chamadas pequenas passam ao lado.** Segundo o [guia de compatibilidade com gateways](https://code.claude.com/docs/en/llm-gateway-protocol) do Claude Code, a verificação de disponibilidade do modo rápido e a verificação de segurança de domínios do WebFetch chamam diretamente `api.anthropic.com` em vez de seguirem `ANTHROPIC_BASE_URL`. Nenhuma delas é um pedido ao modelo: a inferência em modo rápido segue, essa sim, a base URL e passa pelo gateway.
- **Os turnos em modo rápido são registados ao preço padrão.** A Anthropic marca um pedido em modo rápido com `speed: "fast"` e fatura-o com um sobrecusto: US$ 8 de entrada e US$ 40 de saída por milhão de tokens no Claude Opus 5.5, o dobro da tarifa padrão, com os multiplicadores de cache por cima ([documentação do modo rápido](https://platform.claude.com/docs/en/build-with-claude/fast-mode)). A versão 1.2.5 do gateway, como a 1.2.3, não lê `speed`, por isso conta bem esses tokens mas atribui-lhes o preço de um turno padrão: no Opus 5.5, metade do que a Anthropic fatura. Se usares `/fast`, o total do gateway para esses turnos fica abaixo do real.
- **O tráfego de subscrição é medido, não faturado.** Com uma sessão iniciada no Claude Pro ou Max não há fatura por token; o gateway valoriza esse tráfego ao equivalente a preço de tabela para que o possas ver, e não lhe credita nenhuma poupança.

## O gateway também poupa dinheiro?

Tal como vem, com o Claude Code numa chave de API, mede e não poupa nada, e a versão 1.2.5 di-lo. A mensagem de arranque diz que o ajuste do TTL da cache é a única alavanca de poupança ligada por predefinição e que só atua sobre o tráfego da Anthropic com chave de API que pede a cache de uma hora, e o resumo de saída põe o que foi poupado ao lado do que foi gasto, com o motivo quando a poupança é zero. A versão 1.2.3 dizia que todas as alavancas de poupança locais estavam ligadas, e o resumo de saída só contava pedidos: se ainda a usas, não leias nenhum dos dois como uma promessa. A alavanca predefinida do gateway baixa a duração da escrita na cache de uma hora para cinco minutos nos turnos em que grande parte do pedido é nova, porque uma escrita de uma hora custa o dobro do preço de entrada e uma de cinco minutos 1,25 vezes. O Claude Code numa chave de API já pede cinco minutos, a não ser que definas `promptCacheTtl` como `1h`, por isso não há nada para baixar.

Quando a cache de uma hora entra em jogo, a poupança é pequena e depende do teu tráfego. A [página do banco público](/pt/benchmarks#gateway-ttl) publica um replay do próprio tráfego de Claude Code de uma organização: um líquido de **+2,49%** da fatura a preço de tabela (US$ 113,45 de US$ 4.563,61), com um intervalo de 95% de +1,50% a +3,57% quando reamostrado por sessão, e um teto de 7,2% para qualquer política deste tipo. Num modelo o resultado foi quase nulo, e num período perdeu dinheiro. É um replay com uma linha de base parcialmente reconstruída, não uma fatura, e a página lista todos os seus limites.

## Confronta os números do gateway com a tua fatura

1. **Com o `/usage`.** Para uma sessão, soma os custos por pedido do gateway e compara-os com o bloco Session do `/usage`. Os dois valorizam os mesmos contadores a preço de tabela, por isso devem ficar próximos, exceto nos turnos em modo rápido, que o `/usage` valoriza à tarifa rápida e o gateway 1.2.5 à padrão.
2. **Com a Console.** Usa uma chave de API ou um workspace dedicados durante um dia e depois compara os totais por modelo do gateway com a página Usage da Console para essa chave: entrada, saída, escritas e leituras de cache, primeiro em tokens e depois em dólares.
3. **Explica qualquer diferença.** O preço de tabela nem sempre é o teu preço: descontos contratados, residência de dados ou níveis de prioridade mudam o dinheiro, mas não as contagens de tokens. O modo rápido também: com `/fast` ligado, o total do gateway fica abaixo do da Console, porque a 1.2.5 valoriza os turnos em modo rápido à tarifa padrão. O tráfego que não passou por este gateway, como outra máquina, um script ou um job de CI que use a mesma chave, só aparece na Console.

Se as contagens de tokens coincidirem e os dólares não, a diferença está nos preços, não na medição. Para o método completo, lê [como verificar a poupança em LLM com a fatura do teu fornecedor](/pt/guides/verify-llm-savings-against-provider-bill).

## Cortar na fatura quando já a vês

Com os números por pedido à frente, as correções habituais são simples: limpa o contexto entre tarefas sem relação em vez de arrastares um contexto longo, escolhe o modelo antes da sessão e mantém-no, compacta nas pausas naturais, deixa os logs grandes fora do contexto e retira os servidores MCP que não usas. Usar o modelo de outro fornecedor por trás do Claude Code é explicado em [custos da API da DeepSeek e da Qwen](/pt/guides/deepseek-qwen-api-cost-local-gateway).

O código-fonte do gateway, o seu guia do Claude Code e os testes que verificam que reencaminha os teus pedidos sem alterações estão no [GitHub](https://github.com/BiVelio/bivelio-savings-layer).
