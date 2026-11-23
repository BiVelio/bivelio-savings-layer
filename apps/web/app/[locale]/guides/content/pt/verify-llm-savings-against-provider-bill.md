Todas as ferramentas de custos de LLM mostram um número de poupança. Poucas mostram como verificá-lo, e é na verificação que a maioria das promessas cai por terra: o painel mostra uma grande poupança e a fatura quase não mexe. Este guia dá-te um método que podes aplicar com qualquer ferramenta, ou com nenhuma: o que registar, como reconciliar isso com os dados de uso do fornecedor, como distinguir uma poupança real de uma estimativa e como garantir que a poupança veio da alteração que fizeste. No fim vais ver como o SDK open source BV-SALA etiqueta cada montante para que esta verificação seja possível.

## Porque é que os números de poupança e as faturas não batem certo

A diferença vem quase sempre de uma destas causas:

- **Preço de tabela versus o teu preço.** As ferramentas valorizam os tokens aos preços de tabela públicos. A tua fatura pode incluir descontos, contratos de consumo comprometido, tarifas regionais ou de residência de dados, níveis de prioridade e impostos.
- **Estimativas apresentadas como medições.** Se uma ferramenta tirou 2.000 tokens de um prompt, o fornecedor nunca os contou. O número «poupado» é a contagem da própria ferramenta, feita com um tokenizador que pode não ser o do fornecedor.
- **O desconto do fornecedor reclamado pela ferramenta.** A cache de prompts da OpenAI, da Anthropic, da DeepSeek ou do Gemini é faturada pelo fornecedor a uma tarifa mais baixa. Uma ferramenta que conta esse desconto como poupança sua inflaciona o seu número.
- **Tráfego que a ferramenta nunca viu.** As chamadas de outro serviço, o script de um colega, os pedidos secundários de um agente de programação ou um job batch aparecem todos na fatura e não na ferramenta.
- **Uso em falta.** Um pedido em streaming sem o seu evento final de uso não tem contagens de tokens nenhumas. Contá-lo como zero sem avisar faz com que tudo o que vem depois pareça mais barato.
- **O tempo.** Os fornecedores agrupam o uso por dia UTC, e parte do uso aparece com atraso.

## O método, passo a passo

### 1. Regista os contadores do próprio fornecedor em cada pedido

Não a tua estimativa: o bloco `usage` que o fornecedor devolveu. Entrada, entrada em cache (e escritas na cache, quando existem), saída, tokens de raciocínio, o id de modelo que o fornecedor reporta, a chave de API ou o projeto, e o timestamp UTC. Marca um pedido cujo uso não chegou como **não medido**, nunca como zero.

### 2. Reconcilia os tokens antes dos dólares

Exporta o uso diário do fornecedor para as mesmas chaves e os mesmos dias: a [Usage API](https://developers.openai.com/api/reference/resources/organization/subresources/usage) da OpenAI, a [Usage and Cost API](https://platform.claude.com/docs/en/manage-claude/usage-cost-api) da Anthropic, ou as páginas de uso das consolas da DeepSeek e do Model Studio. Depois compara parcela a parcela:

```ts
interface Row { day: string; model: string; input: number; cachedInput: number; output: number }

function byDayAndModel(rows: Row[]): Map<string, Row> {
  const totals = new Map<string, Row>();
  for (const r of rows) {
    const k = `${r.day}|${r.model}`;
    const t = totals.get(k) ?? { day: r.day, model: r.model, input: 0, cachedInput: 0, output: 0 };
    t.input += r.input;
    t.cachedInput += r.cachedInput;
    t.output += r.output;
    totals.set(k, t);
  }
  return totals;
}

/** Lines where your log and the provider disagree by more than the tolerance. Empty means they agree. */
export function reconcile(mine: Row[], provider: Row[], tolerance = 0.01): string[] {
  const a = byDayAndModel(mine);
  const b = byDayAndModel(provider);
  const gaps: string[] = [];
  for (const k of new Set([...a.keys(), ...b.keys()])) {
    for (const field of ["input", "cachedInput", "output"] as const) {
      const yours = a.get(k)?.[field] ?? 0;
      const theirs = b.get(k)?.[field] ?? 0;
      const gap = theirs === 0 ? (yours === 0 ? 0 : 1) : Math.abs(yours - theirs) / theirs;
      if (gap > tolerance) gaps.push(`${k} ${field}: yours ${yours}, provider ${theirs}`);
    }
  }
  return gaps;
}
```

Se os tokens baterem certo, o teu registo está completo e podes confiar no resto da análise. Se o fornecedor mostrar mais, encontra o tráfego que não estás a registar antes de avançares.

### 3. Depois atribui-lhe um preço, com uma tabela de preços datada

Multiplica cada parcela pela sua tarifa, guarda a data em que as tarifas foram copiadas e compara com o relatório de custos do fornecedor. Uma diferença estável de uma pequena percentagem é normalmente um desconto ou uma tarifa regional, e é a mesma com e sem a tua otimização, por isso não muda a poupança.

### 4. Mantém separados três tipos de números

- **Medido:** lido do contador do fornecedor para uma chamada que correu.
- **Medido por referência:** uma chamada que não aconteceu (um acerto de cache, um pedido deduplicado), valorizada com o contador do fornecedor da chamada idêntica que correu. É a melhor prova disponível de uma chamada que nunca aconteceu.
- **Estimado:** tudo o que o fornecedor nunca contou, como os tokens que uma ferramenta tirou de um prompt.

Soma cada tipo por si. Nunca somes montantes estimados aos medidos, e nunca faças a média de percentagens entre pedidos: soma o dinheiro e depois divide.

### 5. Separa o desconto do fornecedor do teu

Os tokens de entrada em cache são mais baratos por causa do fornecedor. Se não mudaste nada e a tua taxa de acerto já era alta, esse desconto não é uma poupança do teu projeto. Valoriza os tokens em cache à tarifa de cache nos dois lados da comparação; o que sobra é teu.

## Foi a alteração que causou a poupança?

Uma fatura que desceu depois de um deploy também pode ser uma semana calma. Para atribuir uma poupança:

- **Corre dois braços ao mesmo tempo.** Envia os mesmos pedidos com e sem a alteração, ao mesmo tempo e pela mesma chave, e compara os contadores do fornecedor de ambos. Pedidos repartidos ao acaso entre os braços são a versão limpa.
- **Apresenta um intervalo, não um ponto.** Reamostra conversas ou dias inteiros e diz «entre X e Y %». Um intervalo que cruza o zero significa que não consegues distinguir a diferença do ruído, e esse é um resultado legítimo.
- **Verifica a qualidade na mesma execução.** Uma resposta mais barata mas errada não é uma poupança. Mede a exatidão, ou uma verificação específica da tarefa, nos dois braços.

## Como o BV-SALA torna esta verificação possível

O [BV-SALA](https://github.com/BiVelio/bivelio-savings-layer) é uma camada de poupança Apache-2.0, gratuita e sem chave. Cada pedido devolve um `SavingsReport` feito exatamente para este método:

- `cost.basis` é `measured`, `reference`, `estimated` ou `unmeasured`, segundo as definições acima. Uma repetição só é valorizada por referência quando a chamada que correu foi diretamente para a API da OpenAI, da Anthropic ou do Gemini da Google; em qualquer outro caso fica `estimated`.
- A poupança é mantida em quatro livros-razão separados que nunca são somados num único número: `avoided_calls`, `eliminated_tokens`, `compressed_tokens` e `provider_cached_tokens`.
- O desconto de cache do próprio fornecedor é apresentado à parte, em `report.nativeSavings`, e nunca é contado como poupança da camada.
- Um stream que termina sem o seu uso é `unmeasured`, nunca é valorizado como zero.

Somar os relatórios por base leva poucas linhas:

```ts
import type { SavingsReport } from "@bivelio/savings-layer";

/** Spend and saving per basis. Never mix bases, never average ratios. */
export function totalsByBasis(reports: SavingsReport[]) {
  const totals: Record<string, { requests: number; spendUsd: number; savedUsd: number }> = {};
  for (const r of reports) {
    const t = (totals[r.cost.basis] ??= { requests: 0, spendUsd: 0, savedUsd: 0 });
    t.requests += 1;
    t.spendUsd += r.cost.actual;
    t.savedUsd += r.cost.netSavingsUsd;
  }
  return totals;
}
```

A partir de Python, o cliente do pacote lê os mesmos relatórios do gateway local e mantém a mesma separação:

```python
# pip install bivelio-savings-layer
import bvsala

gw = bvsala.Gateway("http://127.0.0.1:8403")
# ... send requests with gw.wrap(client) and read each one with gw.report(response) ...
t = gw.totals()
print(t.requests, t.metered, t.not_metered, t.actual_cost_usd)
print(t.net_savings_usd_by_basis)  # one amount per basis, never added together
```

Depois aplica o passo 2 acima a estes totais: o gasto `measured` da camada deve coincidir com o uso do fornecedor para a mesma chave e o mesmo dia, exatamente em tokens e, em dólares, salvo os teus descontos. Os relatórios valorizam a preço de tabela; não são uma fatura.

## O mesmo método, aplicado em público

O projeto publica as suas próprias execuções A/B na [página do banco público](/pt/benchmarks): dois braços com os mesmos pedidos, um diretamente para o fornecedor e outro através da camada, ambos medidos com o contador de uso do próprio fornecedor, com intervalos de 95% e a data e a versão de cada execução. Os resultados que não pouparam nada, ou que custaram mais, estão na mesma página. O método completo, o estimador e os seus limites estão no [artigo](/pt/paper).

Para os pormenores de cada fornecedor, vê [porque é que cached_tokens é 0 na OpenAI](/pt/guides/openai-prompt-caching-cached-tokens), [porque é que o prompt caching do Claude não funciona](/pt/guides/claude-prompt-caching-not-working) e [como medir o custo do Claude Code por pedido](/pt/guides/claude-code-cost-per-request). O código e os relatórios em bruto estão no [GitHub](https://github.com/BiVelio/bivelio-savings-layer).
