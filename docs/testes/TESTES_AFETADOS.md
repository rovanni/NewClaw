# Testes de regressão por módulo (testes afetados)

A suíte completa (`npm run test:regression`) passou de 25 minutos. Desde 30/10/2026 (decisão da operadora), roda-se só o que
as mudanças podem afetar, na máquina e no CI de todo pull request; a completa roda no CI a cada push no `main`, logo depois
do merge.

| Momento | Comando | O que roda |
|---|---|---|
| Durante o trabalho | `npm run test:regression:afetados` | Testes afetados pelas mudanças desde que a branch saiu de `origin/main`: commits da branch, alterações não commitadas e arquivos novos |
| Comparando com outra referência | `node scripts/run-regression-tests.cjs --base <ref>` | Idem, a partir de `<ref>` |
| CI, em todo pull request | `--afetados --base origin/<base>` | Os afetados pelo PR, com o mapa da última completa do `main` (cache do GitHub Actions) |
| CI, a cada push no `main` | `npm run test:regression` | Todos os testes; grava o mapa e o guarda no cache para os PRs seguintes |

O resultado dos afetados **não é** a suíte completa: a linha final diz `AFETADOS (n de N — não é a suíte completa)`
e o relatório JSON (`--report`) traz `modo: "afetados"` com a lista de arquivos alterados e o motivo de cada teste escolhido.
Zero testes afetados (por exemplo, quando só a documentação mudou) é um resultado legítimo nesse modo; zero testes
*descobertos* continua sendo falha.

## Como a seleção decide

A seleção (`scripts/testes-afetados.cjs`) é conservadora: na dúvida, o teste roda. Um teste é selecionado quando:

1. ele próprio mudou;
2. importa, direta ou transitivamente, um arquivo alterado (`import`, `require`, `import()` relativos);
3. importava um arquivo que foi removido;
4. cita o arquivo alterado pelo nome entre aspas — é como os testes que leem o código como texto alcançam o que verificam;
5. leu o arquivo na última suíte completa (mapa observado, ver abaixo);
6. varreu uma pasta que contém o arquivo (leu ao menos 75% dos arquivos rastreados dela, recursivamente ou por extensão) —
   isso inclui arquivos **novos** nessa pasta;
7. lista pastas (testes de recenseamento: arquivo sem consumidor, chamadas ao LLM, endereço privado no código) e algum
   arquivo foi criado ou removido.

Mudança no próprio executor, no `tsconfig.json`, no `package.json`, no `package-lock.json` ou no workflow do CI
(`.github/workflows/regressao.yml`) seleciona a suíte inteira.

### Mapa observado

Toda suíte completa registra quais arquivos do repositório cada teste leu (módulos carregados — inclusive os que só a
checagem de tipos consulta — e arquivos abertos como texto) e grava o resultado em
`node_modules/.cache/newclaw-regressao/mapa-de-leituras.json`. O arquivo é local, por máquina, e não vai para o Git. O registro
não teve custo mensurável: 1533 s com registro contra 1539 s sem, para a mesma suíte.

Sem o mapa (clone novo, ou depois de `npm ci`), a seleção fica só com as regras 1–4 e 7 e avisa. Uma suíte completa recria
o mapa. No CI, o `npm ci` apaga o `node_modules`; o mapa volta do cache (chave por sistema e versão do Node), gravado pela
última suíte completa do `main`.

## Evidência

Conferida contra o que cada um dos 386 testes realmente leu numa suíte completa (10/2026; 25.551 pares teste × arquivo):

| Regras usadas | Pares omitidos |
|---|---|
| Só análise estática (1–4) | 2.581 (10,1%) — testes que varrem pastas inteiras ou carregam todas as skills |
| Todas, com o arquivo tratado como **novo** para o teste (tirado do mapa dele) | 0 (o único caso restante, `data/telegram.lock`, é ignorado pelo Git e nunca aparece como alterado) |
| Todas, com o mapa completo | 0 |

Custo típico, com as durações reais da suíte completa, por arquivo alterado em `src/` ou `skills/` (286 arquivos):
mediana de 115 testes e 11,3 min; p90 de 190 testes e 15,2 min. Arquivos centrais pesam mais (`ProviderFactory.ts`: 247 testes,
19,3 min) porque quase todo teste os importa; um adaptador de canal ou uma ferramenta fica em torno de 3 min, e uma skill em
menos de 1 min.

O teste `S392_Runner_AffectedTestSelection` trava cada regra. Cada regra desligada numa cópia do seletor fez o S392 falhar.

## Limites

- O mapa reflete a última suíte completa **nesta máquina**. Um teste novo é sempre selecionado (regra 1); dependências
  dinâmicas novas de um teste antigo só entram no mapa depois da próxima suíte completa — as regras 2, 4, 6 e 7 cobrem os casos
  medidos.
- Subprocessos que um teste dispara não são observados; os testes que fazem isso citam os arquivos pelo nome (regra 4).
- Uma quebra fora do que o PR alcança (dependência que nenhuma das regras enxerga) só aparece na suíte completa do `main`,
  depois do merge. É o custo aceito em troca de não esperar ~28 min em cada PR.
