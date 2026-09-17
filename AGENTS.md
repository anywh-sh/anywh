# anywh

Wrapper multiplataforma para o Claude Code CLI. O `claude` continua rodando numa máquina que você controla (tipicamente uma Debian headless); o app é só uma forma melhor de falar com ele de qualquer device.

## Arquitetura

- **`relay/`** — servidor Node/TypeScript. Dá spawn em `claude -p ...` por turno, faz streaming dos eventos JSON de volta por WebSocket, e persiste estado de sessão/aba em disco. As credenciais que causam billing por token (`BILLED_CREDENTIAL_VARS` em `runtimes/executables.ts` — hoje `ANTHROPIC_API_KEY` e `ANTHROPIC_AUTH_TOKEN`) são removidas do ambiente do filho de propósito, nos quatro pontos de spawn, pra que o uso sempre caia na assinatura e nunca em billing por token. A lista é escopada ao provedor do CLI que o relay realmente spawna — ensinar um segundo agente ao relay inclui acrescentar as credenciais dele ali.
- **`client/`** — React + TypeScript + Tailwind + shadcn/ui, empacotado com Tauri 2.0 pra desktop e iOS a partir de uma codebase só.
- **`infra/systemd/`** — unit template pra rodar o relay como serviço. Opcional; o caminho normal é `npm start`.

## Estado atual

MVP funcional e usado diariamente: chat, voz, upload de imagem, multi-sessão, multi-perfil, barra de título customizada, painel de terminal e navegador de arquivos do diretório da sessão (listar/ler/baixar, renomear/excluir via menu de contexto desde 2026-09-09, e desde 2026-09-09 também "abrir no editor" — Zed/VS Code/Cursor/Windsurf, local ou via SSH remoto, com locality declarada por env no relay em vez de inferida, já que os arquivos vivem na máquina do relay, não na do client). Validado em Windows, macOS e iOS.

O port iOS está completo menos a distribuição — TestFlight/App Store dependem de conta Apple Developer paga. Sem ela, o app é totalmente iterável no Simulator e instalável em device físico via Xcode local.

## Armadilhas conhecidas

Achados que custaram caro pra descobrir e não são óbvios lendo o código:

- **Os serviços systemd rodam `dist/server.js` compilado, não `src/`.** Reiniciar o serviço sozinho não pega mudança de código — precisa `npm run build` no `relay/` antes. Não há watch/hot-reload em produção.
- **`window.confirm`/`alert`/`prompt` não são confiáveis** entre as webviews do Tauri. O `DropdownMenu` do Radix em modo modal quebra o focus-trap no WKWebView (macOS/iOS) — usar `modal={false}`.
- **Watch de arquivo roda só na forma não-recursiva** (um watcher por diretório/arquivo visível). Watch recursivo não escala em repo com `node_modules`.
- **`codesign` de iOS não funciona via SSH** — falha com `errSecInternalComponent` por não ter contexto de sessão gráfica. Build pra device físico só roda no Terminal.app local do Mac; nem `security set-key-partition-list` nem `unlock-keychain` contornam.
- **Notificação no macOS não funciona via `npm run tauri dev`.** `tauri-plugin-notification`/`notify-rust` usam a API legada `NSUserNotificationCenter`, que só consegue mostrar notificação "emprestando" a identidade de um bundle registrado (o processo de dev não é um `.app` de verdade) — o próprio plugin já faz isso de propósito, usando `com.apple.Terminal` como identidade em dev. No macOS 26 (Tahoe) o daemon `usernoted` passou a negar essa conexão pra qualquer identidade que não bata com a assinatura de código real do processo (`log stream --predicate 'process == "usernoted"'` mostra `Denying message ... LegacyConnection` no momento do disparo) — testado trocar a identidade emprestada pelo identifier real do app instalado (`sh.anywh.client`, via `mdfind`) e a negação persiste, então não é um problema de "qual identidade escolher". Só funciona em build assinado de verdade (`npm run tauri build` → `.app` instalado).
- **Foco de janela no iOS**: usar `document.visibilityState`, não a API de foco do Tauri — a segunda dispara falso positivo em qualquer interrupção momentânea (Control Center, alerta do sistema), não só background real.
- **Qualquer boot avulso do relay (`npm run dev`/`npm start` fora do `add-profile.sh`) se auto-registra como perfil `"default"`** (`ensureSelfRegistered`, `relay/src/host/profileRegistry.ts`) sempre que a porta do processo não bate com nenhum `.env` já existente — mesmo numa máquina que já tem perfis reais (`pessoal`/`trabalho`). Esse `default.env` fica órfão (fora do `profiles.json`, sem serviço systemd) e normalmente reporta `RELAY_HOST=127.0.0.1`, diferente do IP Tailscale dos perfis de verdade. O client deduplicava por `host` em vez de `id` (`syncProfilesForHost`, `client/src/lib/profiles/profiles.ts`), então esse "default" fantasma nunca era limpo entre syncs e cada porta nova empilhava mais uma cópia — apareciam vários "Default" no seletor a cada troca de perfil (corrigido 2026-09-07, commit `2eff9a7`). Se reaparecer um `default.env` órfão em `~/.config/anywh/env/`, é sinal de um teste avulso do relay rodando sem passar pelo `add-profile.sh` — é seguro apagar o arquivo se não houver `anywh-relay@default` habilitado.
- **O binário Go do `tailnet-sidecar` não é commitado** (`.gitignore` da raiz
  cobre `client/src-tauri/binaries/`), então cada máquina constrói o seu. Até
  2026-09-13 isso era armadilha de esquecimento: o Tauri empacota
  silenciosamente o binário que já estiver lá, então mudança no Go parecia não
  ter efeito, e mudança no Rust que passasse flag nova fazia o binário velho
  sair com código 2 — o que chega na UI como `tailnet-sidecar exited before
  printing LISTENING` e parece falha de tailnet sem ser. Agora um hook
  `pretauri` no `client/package.json` roda `npm run build:sidecar` antes de
  todo comando Tauri, `tauri dev` incluso, e não há mais o que lembrar.
  **Script novo que invoque o Tauri tem que passar por `npm run tauri -- ...`**
  (como `ios:device` e os `tauri:build:win:*` já fazem) — chamar o binário
  `tauri` direto pula o hook e traz a armadilha de volta. Resta um caso vivo:
  numa máquina sem Go o script avisa e segue com o binário que estiver em
  disco em vez de falhar, de propósito, pra não inutilizar o cross-build feito
  noutra máquina — ali o binário velho volta a ser empacotado, e o aviso no
  stdout do build é o único sinal.
- **`infra/systemd/restart-profiles.sh` reinicia todos os perfis anywh-relay habilitados de uma vez**, e a sessão do Claude Code que está lendo este arquivo provavelmente está rodando como processo filho de um desses serviços agora mesmo. Rodar esse script (ou qualquer `systemctl --user restart/stop anywh-relay@*`) sem avisar antes derruba essa sessão no meio do turno — confirmado ao vivo mais de uma vez, inclusive rodando o próprio script "só pra testar". **Nunca rodar sem confirmação explícita do usuário na conversa atual**, mesmo em contexto de teste/dev — perguntar antes, não só avisar depois.
- **Um `pkill -f "node dist/server.js"` (ou qualquer padrão igualmente genérico) bate nos serviços systemd reais por coincidência de argv, não só em processos de teste avulsos.** `ExecStart` de `anywh-relay@.service` é literalmente `node dist/server.js` com `WorkingDirectory=relay/` — qualquer processo de teste manual rodado da mesma forma (ex.: `node dist/server.js` numa porta de teste pra checar uma rota nova) tem argv indistinguível dos serviços reais pro `-f` do `pkill`. Confirmado ao vivo em 2026-09-16: um `pkill -f` usado só pra encerrar um `node dist/server.js` de teste mandou `SIGTERM` pros dois (`anywh-relay@pessoal` e `anywh-relay@trabalho`) — `Restart=always`/`RestartSec=3` no unit recuperou sozinho em segundos, mas ambos passaram por um ciclo de drenagem-e-restart não intencional, e uma sessão de agente rodando como filho de um deles esteve em risco de ser derrubada no meio do turno. Pra testar `dist/server.js` manualmente sem esse risco: rodar em background com `run_in_background` (nunca `pkill` genérico pra limpar depois) ou deixar o processo morrer sozinho com `timeout N` sem `pkill` nenhum — o `timeout` já mata só aquele PID específico.
- **Nenhuma derivação de tema é testável no tier unitário.** `themeApply.ts` resolve cor lendo de volta por `getComputedStyle` num elemento sonda (`parseColor`, `client/src/lib/theme/color.ts`) — é assim que suporta `rgb()`/`hsl()`/`oklch()` sem parsear à mão. O happy-dom, onde roda o `npm test` do client, não computa `color`, então `parseColor` devolve `undefined` e **toda** derivação cai silenciosamente no valor embutido do tema escuro: um teste que passe um tema claro custom e confira um token derivado está conferindo a constante do tema escuro e passando por acidente. É a razão de `themeApply.ts` não ter teste próprio. O que dá pra testar é função pura extraída dali (`readableInkOn`), e o resto é trabalho do tier E2E, que tem engine de verdade (`tests/e2e/theme.spec.js`).
- **As classes de animação do shadcn (`animate-in`, `fade-in-0`, `zoom-in-95`, `slide-in-from-*`) não existem neste projeto.** Elas vêm do `tw-animate-css`, que o scaffold pressupõe e que nunca foi instalado aqui — e no Tailwind v4 utilidade desconhecida simplesmente não gera CSS. Colar um trecho de shadcn traz classe que parece movimento deliberado e não anima nada. Foram todas removidas em 2026-09-13; `client/tests/designVocabulary.test.ts` falha se voltarem.
- **Qualquer elemento `position: fixed` renderizado dentro do conteúdo de uma aba de sessão (chat, terminal, painel de arquivos) acaba ancorado no *wrapper* da aba, não no viewport real.** `TabGroupLayout` envolve cada painel de aba num `div` com `contain: layout paint` — decisão deliberada pra escopar o re-layout de um resize de grupo só àquele painel — mas containment CSS também torna esse `div` o *containing block* de qualquer descendente `fixed`, do mesmo jeito que um `transform` faria. Descoberto porque os menus de contexto do painel de arquivos (`FileTree.tsx`) passaram a abrir longe do clique com um gap grande e direcional depois que esse `contain` foi introduzido (`92d3554`, tab splitting) — o span invisível usado como âncora do `DropdownMenu` (`left`/`top` = `event.clientX`/`clientY`, coordenadas de viewport) parou de resolver contra o viewport e passou a resolver contra o wrapper. Corrigido portando o próprio trigger pra `document.body` (`ContextMenuAnchor`, `client/src/hooks/platform/useContextMenu.tsx`) em vez de só o `DropdownMenuContent` (que o Radix já porta por padrão) — `DownloadToasts.tsx` segue o mesmo padrão pro stack de toasts no canto da tela. Qualquer UI nova com posicionamento `fixed` (tooltip customizado, menu, toast) que precise viver dentro do conteúdo de uma aba tem que passar por um portal pra `document.body`, não confiar em `position: fixed` inline.



## Idioma

Tudo que não for texto de UI precisa estar em inglês, mesmo quando a conversa com o agente for em português:

- **Sempre em inglês**: comentário de código (`//`, `/* */`, doc comments), mensagem de commit (título + corpo), `console.log`/`console.error`/logs de servidor, e qualquer string que exista só pro desenvolvedor (nunca chega a ser renderizada pro usuário final).
- **Texto de UI passa pelo dicionário** (`client/src/i18n/`): qualquer string que é de fato mostrada na UI (texto JSX, `placeholder`/`title`/`aria-label`, toast, mensagem de erro que chega até o usuário) vive como chave em `dictionary.ts`, com as duas traduções em `en.ts` e `pt-br.ts`. Nunca literal cravado no componente. O padrão e o fallback é **`en`**; `pt-BR` é a segunda tradução. O tipo `Dictionary` garante que nenhum idioma fique com chave faltando — não existe "traduzo depois". Antes de decidir se uma string é "UI" ou "não-UI", rastreia onde ela é consumida (ex.: um erro que sobe até um toast é UI; um `console.error` não é) — não decide só por "parece uma frase".
- **Migração concluída** (2026-09-13): a copy de UI toda vive no dicionário. Restam de fora, de propósito e por rastreio, duas categorias que não são UI: texto que o relay manda **ao modelo** (`sharedSession.ts`, `planChoiceMarker.ts`, `buildWireMessage`) — que é conteúdo de um turno sintético do usuário, então o idioma dele decide o idioma da resposta, e mudar isso é decisão de produto ainda em aberto; e erro que ninguém lê, como as rejeições de `videoPreview.ts`, que o chamador engole de propósito e por isso ficam em inglês como qualquer outro texto de desenvolvedor. Um literal de UI novo num componente não tem mais desculpa: não existe mais um "resto" a migrar.
- Este `AGENTS.md` continua em português por ora.
- Contexto: o projeto foi construído em conversas em português sem essa diretriz explícita, e acumulou texto em PT em código e commits. Corrigido retroativamente em 2026-09 (histórico de commit reescrito via `git filter-repo`, comentários/logs traduzidos) — esta seção existe pra isso não voltar a acontecer.

## Workflow de contribuição

- Commits separados por responsabilidade (atômicos) — nunca misturar mudanças de propósitos diferentes num único commit, mesmo que tenham sido feitas na mesma sessão. Se o working tree acumulou mais de uma feature/fix, separa em commits distintos (stage seletivo por arquivo/hunk) em vez de um commit único.
- Sempre seguir [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `refactor:`, `style:`, `docs:` etc., com escopo quando fizer sentido, ex. `feat(client): ...`).
- **Texto do commit (título + corpo) sempre em inglês**, mesmo com o resto da conversa em português — ver seção "Idioma" acima.
- Ao terminar um trabalho (bug corrigido, feature implementada, o que foi pedido na sessão), o passo de conclusão inclui commitar (nos moldes acima) e dar `git push` pro repo remoto — isso faz parte de "terminar a tarefa", não é uma ação extra que precisa ser pedida à parte toda vez.

## Release

- **Tag é imutável neste repo, e isso muda como se conserta uma release
  quebrada.** Um ruleset do GitHub bloqueia deleção de tag: `git push
  origin :refs/tags/vX.Y.Z` volta com `push declined due to repository rule
  violations`, e o `--cleanup-tag` do `gh release delete` falha
  silenciosamente pelo mesmo motivo (apaga a release, deixa a tag). Então
  **uma release que falhou no meio se conserta com bump de versão, nunca
  com retag** — corrige o defeito, mergeia, e corta a tag seguinte. A regra
  está certa: uma tag que existiu deve continuar apontando pro que apontava.
  Aconteceu de verdade em 2026-09-16 com a `v0.1.6`, que ficou na lista sem
  release atrás dela; a correção saiu como `v0.1.7`.
- **Uma leg da matriz que falha não produz release parcial.** A job
  `checksums` do `release.yml` depende da matriz inteira, e é ela que
  publica os aliases sem versão, escreve o `SHA256SUMS` e tira a release de
  draft. Com qualquer leg vermelha nada disso roda: a release fica em draft,
  com assets pela metade, e nada chega a usuário nenhum — inclusive o
  `anywh.sh/install`, que resolve por `releases/latest/download/` e continua
  servindo a release anterior.

## Testes

Doutrina completa (o quê testar, onde cada tipo de teste mora, a única exceção sancionada a "sem mock" — o processo `claude`) está em `.anywh/skills/tests/SKILL.md`, symlinkado em `.claude/skills/tests` pra ficar auto-descoberto pelo Claude Code. Canônico fica em `.anywh/` de propósito (não `.claude/`) porque o roadmap já prevê suporte a múltiplos coding agents além do Claude Code — mesmo raciocínio por trás deste arquivo: `AGENTS.md` é o canônico, `CLAUDE.md` é symlink pra ele (não duplicar conteúdo entre convenções de nome de cada provider).

## Documentação

O `README.md` da raiz cobre o que é preciso pra rodar e contribuir. O histórico de decisão detalhado do projeto (o porquê de cada escolha de arquitetura) mora em `~/anywh/journal/` — um nível acima deste repo, fora dele. Nunca vai pro remote de nenhum dos quatro repos — é local à máquina do autor e compartilhado entre eles.

Três documentos vivem em `docs/` e valem antes de tocar em `relay/src/`: [`docs/architecture.md`](./docs/architecture.md) (o que mora em qual pasta e por quê — o mapa de `runtimes/`, `session/`, `host/`, `bridges/`, `fs/`), [`docs/invariants.md`](./docs/invariants.md) (as regras que o lint/os testes seguram, com o porquê — e as que ainda são direcionais, não hoje) e [`docs/extract-test-refactor.md`](./docs/extract-test-refactor.md) (o workflow de commit — Extract, Test, Refactor — pra mover ou fatiar um arquivo existente sem misturar mudança de local com mudança de comportamento no mesmo commit).

**Comentário de código nunca cita esse histórico por número** (`docs/NN`, `journal/NN`) — o repo é público, e esse journal não é. Uma citação desse tipo não ajuda quem lê o código de fora (aponta pra um documento que não existe pra eles) e, pior, pode acabar correlacionando decisões do lado aberto com o journal privado da Frente 2 (control plane, billing, provisionamento). Isso já aconteceu por engano: um comentário do `tailnet-sidecar` chegou a nomear o repo privado `anywh-control-plane` e caminhos de arquivo internos dele (`nodeSignature.ts`, `edge/internal/proxy`), o que é exatamente o tipo de vazamento de fronteira que a regra 1 do `~/anywh/CLAUDE.md` do workspace proíbe — corrigido retroativamente em 2026-09 junto com a varredura de citações. Um comentário deve carregar o achado inteiro (o quê, por que, o bug real que motivou) sem depender de nada fora do repo; se a explicação faz sentido sem a citação, a citação não acrescenta nada além de uma referência morta pra quem não tem acesso ao `journal/`.
