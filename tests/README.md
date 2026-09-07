# Testes do menu de contexto (Playwright)

`context-menu.spec.js` roda contra a **UI real** do Proxmox: faz
login, espera o `ResourceStore` receber os recursos `k8sapp`, clica com o
botão direito numa app da árvore e valida o menu completo. O segundo teste
invoca o dispatcher `PVE.Utils.createCmdMenu` com um registro sintético e
confere classe, título, os 13 itens e o estado habilitado/desabilitado
refinado a partir do `apps.json`. Também verifica que o painel Summary mantém
as notas na linha superior, ao lado do StatusView, como no Summary do LXC —
sem inserir uma descrição intermediária entre Notes e os demais cards.
Também há um teste de feedback que simula o início/fim de uma ação sem executar `kubectl`: verifica o mapeamento para o estado final, a classe `k8s-pending` e a remoção do spinner. O quarto teste valida a consolidação com o Proxmox pela API real: round-trip das notas (PUT protegido → pvedaemon/root; GET → pveproxy/www-data; era o caminho que falhava com "Permission denied 500"), uma ação `scale` no-op que precisa retornar um UPID `k8sscale`, aparecer com status `OK` no histórico de tarefas do nó e ser registrada no cluster log (`starting task ...`). Também confere que `/nodes/{node}/k8sapp/{appid}/tasks` — o endpoint dedicado por aplicação — devolve a task recém-criada e **somente** tasks `k8s*` com o `id` desta app (nenhuma linha de outro app, VM, container ou tarefa do nó), e que a aba `Task History` do painel é a grade nativa `proxmoxNodeTasks` apontando para essa rota (`preFilter: { source: 'all' }`), não para `/nodes/{node}/tasks`. A única mutação é um `scale` para o mesmo número de réplicas atuais (no-op) e as notas são restauradas ao valor original.

## Testes do Summary (summary-reactivation.spec.js)

`summary-reactivation.spec.js` reproduz o ciclo que deixava o painel
quebrado: abre a aplicação, sai para **Console** (o `PVE.panel.Config`
destrói o card Summary), volta para Summary e mede os componentes Ext vivos.
Antes do conserto o card recriado renderizava com os gráficos espremidos
(`columnWidth: 0.5` do config salvo, nunca normalizado pelo `resize` que só
existe no primeiro mount) e os widgets Status/Node nos placeholders `—`
(a `statusStore` compartilhada não dispara novo `load` para a instância
nova). O teste exige que, após voltar, os gráficos ocupem a coluna inteira
e os widgets mostrem os valores reais — o mesmo estado da primeira abertura.

## Executando

Na estação com Node 18+ (Chromium do Playwright é baixado no `npm install`):

```bash
cd sufficit-proxmox-kubernetes/tests
npm install
PVE_URL=https://pve.example.com:8006/ \
PVE_USER='k8s-test@pve' \
PVE_PASSWORD='...' \
npx playwright test -c playwright.config.js
```

Sem `PVE_PASSWORD` a suite é pulada com aviso (nada de credencial em arquivo).

## Usuário de teste

O login do teste usa `/access/ticket` com `username` já contendo o realm
(`k8s-test@pve`) — sem o parâmetro `realm` separado, que no formulário da UI
sobrepõe o realm do userid e faria o login falhar.

Crie o usuário temporário **no host PVE** (como root) e remova depois:

```bash
scp pve-test-user.sh root@<host-pve>:/root/k8s-ui/
ssh root@<host-pve> bash /root/k8s-ui/pve-test-user.sh create   # imprime PVE_PASSWORD
ssh root@<host-pve> bash /root/k8s-ui/pve-test-user.sh remove   # limpa usuário e role
```

O papel tem apenas `Sys.Audit` + `Sys.Modify` + `Sys.Console` em `/` — as
capacidades que o menu consulta. A senha é sorteada a cada `create`.

## Arquivos

- `context-menu.spec.js` — os dois testes de navegador.
- `playwright.config.js` — 1 worker, HTTPS autoassinado aceito, `baseURL`
  de `PVE_URL`.
- `pve-test-user.sh` — ciclo de vida do usuário de teste (roda no host).
- `.gitignore` — `node_modules/`, `test-results/`, `playwright-report/`.
