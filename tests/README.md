# Testes E2E (Playwright)

`context-menu.spec.js` roda contra a **UI real** do Proxmox: faz
login, espera o `ResourceStore` receber os recursos `k8sapp`, clica com o
botão direito numa app da árvore e valida o menu completo. O segundo teste
invoca o dispatcher `PVE.Utils.createCmdMenu` com um registro sintético e
confere classe, título, os 13 itens e o estado habilitado/desabilitado
refinado a partir do `apps.json`. A app alvo é escolhida de `apps.json`
priorizando um `Deployment` — DaemonSet não é escalável e o menu
(corretamente) desabilita `Scale`; a expectativa segue o kind do workload.
Também verifica que o painel Summary mantém as notas na linha superior, ao
lado do StatusView, como no Summary do LXC — sem inserir uma descrição
intermediária entre Notes e os demais cards. Há ainda um teste de feedback
que simula o início/fim de uma ação sem executar `kubectl`: verifica o
mapeamento para o estado final, a classe `k8s-pending` e a remoção do
spinner. O teste de consolidação valida o round-trip das notas pela API
real (PUT protegido → pvedaemon/root; GET → pveproxy/www-data; era o
caminho que falhava com "Permission denied 500"), uma ação `scale` no-op
que precisa retornar um UPID `k8sscale`, aparecer com status `OK` no
histórico de tarefas do nó e ser registrada no cluster log, e que
`/nodes/{node}/k8sapp/{appid}/tasks` — o endpoint dedicado por aplicação —
devolva a task recém-criada e **somente** tasks `k8s*` com o `id` desta app.
A única mutação é um `scale` para o mesmo número de réplicas atuais (no-op)
e as notas são restauradas ao valor original.

## Testes do pseudo-host (pseudo-host.spec.js)

`pseudo-host.spec.js` valida o agrupamento das apps sob o pseudo-host
**Kubernetes** na Server View: todo registro `k8sapp` carrega
`node='Kubernetes'` (agrupamento) e `k8snode` (o nó real que serve a API);
clicar no pseudo-host abre o `pveK8sClusterBrowser` com o resumo alimentado
por `status.json` (o host publicador aparece no Summary) e a grade
Applications listando todas as apps de `apps.json`; o pseudo-host não
recebe menu de contexto de nó PVE (nenhum Shutdown/Reboot/Shell); e o
painel da app resolve o nó real pela API (`on node '<k8snode>'`).

## Testes dos pods aninhados por host (pods-in-tree.spec.js)

`pods-in-tree.spec.js` valida o recurso `k8spod`: cada pod do snapshot sobe
com o host onde roda. Na **Server View** os pods aninham DENTRO do host real
— o filtro da view esconde pods de hosts fora deste PVE (em cluster PVE
multi-nó, cada host com o patch publica seus pods locais sob o próprio
hostname) e nenhum host-fantasma é materializado; na **Folder View** a pasta
"Kubernetes Pods" carrega o cluster inteiro (inclusive os pods publicados
com `node='Kubernetes'`). Clicar num pod abre o `pveK8sPodPanel` com o
resumo (Application/Pod/Node/Status) e o menu de contexto oferece Console /
Pod logs / Describe pod / View YAML / Delete pod — nunca Shutdown/Shell de
nó. Os testes não dependem de nomes fixos de pods/apps nem assumem cluster
PVE de nó único.

Notas de infraestrutura da suíte: a árvore lateral usa buffered rendering
do ExtJS (só as linhas visíveis existem no DOM) — os testes usam viewport
alto e rolam o nó para a view antes de interagir; o `expandAll` repete até
o grupo estar aberto no DOM porque o `updateTree` recria grupos colapsados
a cada poll do `ResourceStore`.

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
PVE_HOST=pve02 \
npx playwright test -c playwright.config.js
```

Sem `PVE_PASSWORD` a suite é pulada com aviso (nada de credencial em
arquivo). `pods-in-tree.spec.js` e `pseudo-host.spec.js` exigem também
`PVE_HOST`: o nome do nó PVE alvo (o mesmo que aparece em
`/api2/json/nodes`), que publica o snapshot local e deve receber seus pods
aninhados. Para cobrir todos os hosts do cluster, rode a suite uma vez por
host trocando `PVE_URL`/`PVE_HOST`. Certificados autoassinados são aceitos
(`ignoreHTTPSErrors`) — `PVE_URL` pode apontar direto para o IP.

## E2E noturno (GitHub Actions)

`.github/workflows/e2e-nightly.yml` roda a suite completa todos os dias
(02:30 UTC) contra cada host da matrix, direto do GitHub — um upgrade do
PVE que quebrar as ancoras da UI e descoberto no dia, nao quando alguem
abre a tela. Falhas enviam e-mail ao dono do repositorio pelo proprio
GitHub Actions e sobem os traces como artefatos (7 dias).

Configuracao (uma vez, admin do repo):

```bash
# hosts da matrix (URLs e nomes de no ficam em SECRETS: sao mascarados
# automaticamente nos logs, e o repositorio e publico):
gh variable set E2E_HOSTS_JSON \
  --body '[{"name":"eveo","slot":"EVEO"},{"name":"apoint","slot":"APOINT"}]'
gh secret set PVE_URL_EVEO    --body 'https://<host-eveo>:8006/'
gh secret set PVE_HOST_EVEO   --body '<no-pve-do-eveo>'
gh secret set PVE_E2E_USER    --body 'k8s-e2e@pve'
gh secret set PVE_E2E_PASSWORD --body '<senha do k8s-e2e>'
```

Cada entrada da matrix resolve seus secrets pelo `slot`:
`PVE_URL_<slot>` e `PVE_HOST_<slot>`.

O usuario `k8s-e2e@pve` e **persistente** (a suite noturna roda sem
ninguem para cria-lo), com o mesmo perfil restrito (`Sys.Audit` +
`Sys.Modify` + `Sys.Console` em `/`) mas em role **propria**
(`K8sE2eRole`), distinta da `K8sTestRole` do usuario temporario: em
cluster PVE, `user.cfg`/`acl.cfg` sao compartilhados por todos os nos
via pmxcfs -- `pve-test-user.sh remove` em qualquer no do cluster apaga
a role e, com ela, as permissoes do CI no cluster inteiro. Crie a role
uma vez por cluster (e uma vez em cada host standalone):

```bash
pveum role add K8sE2eRole -privs 'Sys.Audit Sys.Modify Sys.Console' 2>/dev/null || true
pveum user add k8s-e2e@pve --password '<senha do secret>' \
  --comment 'CI E2E noturno - GitHub Actions'
pveum aclmod / -users k8s-e2e@pve -roles K8sE2eRole
```

Sem `E2E_HOSTS_JSON` o job e pulado (o CI estatico de push nao depende
de host real).

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

- `context-menu.spec.js` — menu de contexto, dispatcher, feedback de ações
  e consolidação com a API real do Proxmox.
- `pseudo-host.spec.js` — agrupamento sob o pseudo-host Kubernetes e
  cluster browser.
- `pods-in-tree.spec.js` — pods (`k8spod`) aninhados por host, painel do
  pod e Folder View.
- `summary-reactivation.spec.js` — reativação do card Summary após troca
  de aba.
- `dc-network.spec.js` — aba Datacenter → Kubernetes → Network.
- `playwright.config.js` — 1 worker, HTTPS autoassinado aceito, `baseURL`
  de `PVE_URL`.
- `pve-test-user.sh` — ciclo de vida do usuário de teste (roda no host).
- `.gitignore` — `node_modules/`, `test-results/`, `playwright-report/`.
