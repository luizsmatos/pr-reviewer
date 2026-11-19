# pr-reviewer

Daemon local que acompanha os PRs que pedem **o seu** review no GitHub, roda o
skill `/the-judge --local` num clone dedicado e **publica o review sozinho**, com o
seu usuário, inclusive aprovações.

```
gh search prs --review-requested=@me   (a cada POLL_INTERVAL_S)
        │  PR novo, aberto, não-draft, org em ALLOWED_ORGS
        ▼
fila serial em ~/.pr-reviewer/state.json  (MAX_PER_DAY por dia, sem limite por padrão)
        │  CI ainda rodando? → waiting_ci, checado a cada polling (até CHECKS_MAX_WAIT_MIN)
        │  clone em repos/<org>/<repo>, worktree no head do PR
        ▼
claude -p  →  reviews/<org>-<repo>-<n>.md  +  notificação do macOS
        ▼
um review no GitHub, com inline (publicação automática)
        │  se a publicação for recusada, o item fica drafted com o motivo
        ▼
pr-reviewer publish <org>/<repo>#<n> [--force]   (manual, depois de editar)
```

## Antes de usar

- **O review sai na sua conta.** Aprovação, pedido de mudança e comentários são
  publicados com o seu usuário do `gh`, sem você ler antes. Confira os primeiros
  reviews no GitHub e use `status` para acompanhar.
- **Custo.** Cada review roda o Claude Opus e custa em torno de US$ 1 a 2. Sem
  `MAX_PER_DAY` não há teto diário; defina um no `.env` se quiser limitar.

## Setup

Node ≥ 20.12, `claude` logado, `gh` logado (`gh auth status`), `python3` e
[pm2](https://pm2.keymetrics.io/). Sem dependências npm. O skill de review
vem no repositório, em `skills/the-judge`; não precisa instalar nada em `~/.claude`.

```
git clone <url-deste-repo> pr-reviewer && cd pr-reviewer
cp .env.example .env     # defina ALLOWED_ORGS; o resto tem default
node index.js doctor
pm2 start index.js --name pr-reviewer
pm2 save                 # mantém o daemon depois de reiniciar o pm2
```

Na primeira execução o backlog vira `skipped`; só os pedidos de review que
chegarem depois são revisados. Para revisar um PR antigo, `node index.js review <url>`.

Logs: `pm2 logs pr-reviewer`. Estado, rascunhos e clones ficam em `~/.pr-reviewer`
(`STATE_DIR`).

## Usar outra skill

Quem revisa é o skill em `SKILL_DIR`, guiado pelo prompt em `REVIEW_PROMPT`.
Para trocar, coloque o skill numa pasta (pode ser em `skills/`) e aponte o `.env`:

```
SKILL_DIR=./skills/minha-skill
REVIEW_PROMPT=./prompts/minha-skill.md
```

O prompt de `prompts/review.md` é específico do `the-judge` (findings.json, gate,
severidades). Um skill novo precisa de um prompt próprio que termine pedindo a
resposta no formato do rascunho: linha `verdict:`, `## Resumo` e `## Achados`
com o bloco JSON de `path`, `line`, `severity` (`critical | major | nit`) e
`body`. Use `prompts/review.md` como modelo. Placeholders disponíveis: `{{org}}`,
`{{repo}}`, `{{pr}}`, `{{title}}`, `{{base}}`, `{{scratch}}` e `{{skillDir}}`.

O agent só roda scripts de `SKILL_DIR/scripts/` (direto ou com `python3`); outro
interpretador precisa entrar em `allowedTools`, no `review.js`. `node index.js doctor`
confere se o skill e o prompt existem.

## Comandos

| comando | efeito |
|---|---|
| `node index.js` | sobe o daemon (polling + fila) |
| `status` | orçamento do dia e itens por status |
| `review <url>` | enfileira à mão, mesmo já visto (re-review), sem esperar o CI |
| `publish <org>/<repo>#<n> [--force]` | posta o rascunho no GitHub |
| `skip <org>/<repo>#<n>` | marca `skipped`, mantém o rascunho |
| `retry <org>/<repo>#<n>` | reenfileira um `failed` |
| `doctor` | checa `claude`, `gh`, a busca e o disco |

## Comportamento

- **Espera o CI sem travar a fila.** Na vez do PR, `gh pr checks` diz se algum
  check está pendente; se estiver, o PR vira `waiting_ci` e a fila segue. A cada
  polling os `waiting_ci` são checados de novo, antes dos `queued`. CI que
  terminou com falha também libera o review, que cita o job no Resumo. Passados
  `CHECKS_MAX_WAIT_MIN` (45 por padrão), ou 5 min sem nenhum check, revisa assim
  mesmo. O orçamento só é debitado quando o review começa.
- **Primeira execução não revisa o backlog.** O que já pedia review vira
  `skipped`; use `review <url>` para o que quiser.
- **Depois de publicado, re-revisa só com novo pedido de review** ("Re-request
  review"): o PR some da busca quando o review sai e, ao reaparecer, volta
  para a fila. Push novo sozinho não dispara. Pedido a um time que não sai da
  busca não re-revisa; aí é `review <url>`.
- **Publica sozinho** assim que o rascunho fica pronto, e na subida publica os
  rascunhos pendentes sem erro. PR que recebeu push entre o review e a
  publicação volta para o fim da fila sozinho, no máximo 2 vezes por PR. As outras recusas não são re-tentadas:
  o item fica `drafted` com o motivo no `status`, esperando o `publish` manual.
- **A publicação recusa** quando: o rascunho é inválido; o PR recebeu push depois
  do review (`--force` publica ancorado no commit revisado); o verdict é
  `approve` com qualquer achado (`--force`); o PR é seu.
- Achado fora do diff não vira comentário inline: vai para o corpo, em
  `## Fora do diff`, para o GitHub não rejeitar o review inteiro.
- Rascunho inválido ganha uma re-execução; falhou de novo, a saída bruta fica
  em `reviews/<org>-<repo>-<n>.raw.md`. Timeout não re-executa.
- O agent não roda código do PR: lint, typecheck e testes vêm do CI, lidos com
  `gh pr checks` e `gh run view --log-failed` (o worktree não tem
  dependências). Rodam os scans e o gate do skill. Permissões: leitura,
  scripts do skill, `git diff/log/show/blame/grep`, `gh pr view/diff/checks`, `gh run view`,
  `WebSearch`, context7 e escrita só em `tmp/<org>-<repo>-<n>/`, onde fica o
  `findings.json`.
- O prompt é `prompts/review.md`; quem revisa é o skill. Severidades do
  `the-judge` viram `critical` (blocker), `major` (should-fix) e `nit`.
- Veredito: `critical`/`major` → REQUEST_CHANGES; só `nit` ou pré-existente
  que vale corrigir no PR → COMMENT; APPROVE só sem nada a corrigir e sem
  pedido de outro revisor em aberto. Achado que repete o pedido de um humano
  não é postado de novo.
- Daemon morto no meio de uma publicação: o item fica `publishing` e não é
  republicado sozinho, porque o review pode já ter saído. Confira o PR e rode
  `publish` se não saiu, ou `skip` se saiu.
- Daemon morto no meio de um review: na subida o item volta para a fila e a
  vaga do orçamento não é devolvida.

## Créditos

`skills/the-judge` é o skill The Judge, de Felipe Rodrigues
([github.com/felipfr](https://github.com/felipfr)), licença
[CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/). Esta cópia foi modificada
(versão 1.6.0): veredito sem "approve com nits", pré-existente só quando cabe no
PR, e pedidos abertos de revisores humanos impedem o APPROVE.
