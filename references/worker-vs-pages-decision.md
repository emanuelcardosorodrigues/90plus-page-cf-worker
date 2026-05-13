# Worker vs Pages — Decision Tree

> **Why this document exists.** The single most common mistake when working with Cloudflare deployments is reaching for Pages when a Worker is the correct choice. This file codifies the rule and the decision tree so the same wrong turn does not repeat.

## A regra

**Worker é o default absoluto.** Toda nova landing, quiz, página, redirect router, API edge, ou site servindo HTML personalizado deveria usar um Cloudflare Worker. Pages só entra em uma de três exceções explícitas listadas no final deste arquivo.

Não há "talvez Pages seria melhor aqui". Comece pelo Worker. Mude para Pages só se cair em uma das exceções.

## Por quê

Workers oferecem, simultaneamente:

- **Per-request middleware.** Você pode rodar lógica antes/depois de servir um asset, injetar headers, redirecionar, filtrar bots, aplicar A/B.
- **Edge cache personalizado.** `cache.match`/`cache.put` com chave que inclui variant, slug, cookie ou qualquer dado que você decida — algo que o cache do Pages só faz via header `Cache-Control`.
- **Bindings unificados.** KV, D1, R2, Vectorize, Queues, Durable Objects, Service Bindings, secrets — tudo declarado em um único `wrangler.jsonc`.
- **`wrangler tail` em produção.** Stream de logs em tempo real do tráfego real, sem precisar adicionar instrumentação.
- **Iteração rápida.** `wrangler deploy` leva 2-5 segundos. Pages via git push leva 30-120 segundos.

Pages adiciona uma camada (Pages Functions) que, na prática, é só Workers com convenções de arquivo. Você ganha um pouco menos de controle (estrutura de pastas obrigatória, sem `cache.put` direto) e perde nada em troca.

## Decision tree

Responda na ordem. A primeira pergunta que casar dita a decisão.

1. **Existe um Worker no monorepo que já cobre o domínio/subdomínio?**
   - Sim → adicione a nova rota ao Worker existente (`routes` no `wrangler.jsonc`).
   - Não → próxima pergunta.

2. **A página é puramente estática, sem nenhuma personalização per-request?**
   - Sim → ainda use Worker via `assets` binding. Você ganha edge cache controlado, `wrangler tail`, e a opção de adicionar middleware depois sem migrar.
   - Não → próxima pergunta.

3. **A stack é Astro/Remix/SvelteKit SSR ou similar com adapter Cloudflare?**
   - Sim → use o adapter para Workers (não para Pages). Todos os adapters modernos têm preset `cloudflare` que gera um Worker.
   - Não → próxima pergunta.

4. **A stack é Vite+React, HTML+JS puro, ou outra SPA/MPA simples?**
   - Sim → crie um Worker novo com [`assets/wrangler-template.jsonc`](../assets/wrangler-template.jsonc), aponte `assets.directory` para `dist/` ou `public/`, faça `wrangler deploy`.
   - Não → você está em território de exceção; releia as exceções no final.

5. **A stack é Next.js?**
   - Idealmente, sim, use OpenNext (preset Cloudflare) que gera um Worker. Esta skill não cobre Next/OpenNext em profundidade, mas a regra "Worker, não Pages" continua valendo.

## Exceções legítimas (raras)

Use Pages **somente se uma destas três condições for verdade**. Caso contrário, Worker.

1. **Deploy gerenciado por terceiro sem acesso a `wrangler`.** Ex.: cliente entrega o site num provedor que só sabe operar Pages, e mudar isso não está no escopo. Saber o trade-off e seguir.
2. **Preview por PR para QA visual em time não-técnico.** Pages preview deploys são automáticos via git, e o link é fácil de compartilhar. Workers preview é possível mas requer mais setup.
3. **Site institucional 100% estático, sem tracking, sem A/B, sem personalização.** Marketing ou landing simples que não vai ter Pixel, GTM, redirect, edge cache custom. Pages serve, e a equivalência operacional praticamente some.

Em todos os outros casos: Worker.

## Sinais de que você está prestes a errar

Pare se ouvir, ler ou pensar:

- "Vou criar um projeto Pages no dashboard da Cloudflare."
- "Deploy via dashboard, não via CLI."
- "`wrangler pages deploy`"
- "Pages Functions resolve isso."
- "Acho que Pages é mais simples pra este caso."
- "Esse site não precisa de Worker, é só estático."

Quando algum desses gatilhos aparecer: reabra este documento e refaça o decision tree. 9 em 10 vezes a resposta correta é Worker via `assets` binding.

## Como criar um Worker novo (template mínimo)

```bash
# Diretório novo
mkdir my-worker && cd my-worker

# Inicializa Worker (não Pages)
npm create cloudflare@latest -- --type=javascript --no-git

# Edita wrangler.jsonc (use o template em assets/wrangler-template.jsonc)
# Configura assets binding apontando pra dist/ ou public/

# Build + deploy
npm run build
wrangler deploy
```

Para Vite+React, ajuste `assets.directory` para `dist/` (saída do `vite build`). Para HTML+JS puro, aponte para a pasta com `index.html`.

## Notas operacionais

- **Sempre `wrangler.jsonc`, nunca `wrangler.toml`.** JSON com comentários é mais robusto a editores modernos, tem schema validation via `$schema`, e suporta blocos comentados sem quebrar parsing. TOML continua suportado, mas é legado.
- **Antes de `wrangler deploy`, confirme `wrangler.jsonc > name`.** Esta é a fonte número 1 de deploys acidentais no Worker errado. Use `wrangler whoami` e `wrangler deployments list` antes de qualquer push em produção.
- **`account_id` não vai pro `wrangler.jsonc` versionado.** Use `wrangler config` ou a env var `CLOUDFLARE_ACCOUNT_ID` em CI. O template em `assets/wrangler-template.jsonc` omite `account_id` propositalmente.

## Quando recriar este documento mentalmente

Sempre que alguém — você, o usuário, um colega — disser "talvez Pages seja melhor aqui", releia a sessão "A regra" em voz alta. Workers SEMPRE. Pages NUNCA, salvo as três exceções acima.
