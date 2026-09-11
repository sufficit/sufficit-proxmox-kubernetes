# sufficit-proxmox-kubernetes — Kubernetes na interface do Proxmox VE (POC)

Integra o K3s que roda no host PVE à própria UI do Proxmox (validado em
hosts PVE 9.1.x e 9.2.x, Debian 12/13). Consulta dos dados do
cluster + **ações declarativas** (`kubectl scale/rollout/delete pod`) no menu
de contexto — sem expor kubeconfig, tokens, shell do host ou edição livre de
YAML.

## O que o usuário vê

1. **Node → System (grade de serviços):** linha `k3s` —
   "Lightweight Kubernetes", estado, unit-state, Start habilitado.
   (k3s foi incluído em `startOnlyServices`: a UI não permite Stop,
   mesma proteção aplicada a pveproxy/pvedaemon/pve-cluster.)
2. **Node → aba "Kubernetes"** (entre System e Network): painel com
   serviço systemd, nó do cluster, pods de kube-system e contagem por
   namespace; atualiza a cada 30 s.
3. **Árvore de recursos (Server View e Folder View):** cada aplicação
   Kubernetes (`Deployment`/`StatefulSet`/`DaemonSet`/Pod solto) aparece como
   recurso `k8sapp` — mesma lista de VMs, LXCs e storages, ícone de navio,
   agrupado sob o **pseudo-host “Kubernetes”** no nível do datacenter (Server
   View), igual a um servidor PVE: o cluster inteiro num único lugar, sem vínculo
   com o host que publica o snapshot. Clicar no pseudo-host abre o
   `pveK8sClusterBrowser` (visão cluster-wide, somente leitura, com todas as
   aplicações e o resumo do nó); as ações continuam no menu/contexto de cada app.
   O nó real que serve a API (`/nodes/{node}/k8sapp`, kubectl local) viaja no
   campo `k8snode` do registro da árvore; os nós reais de cada workload aparecem
   na coluna Nodes do painel do pseudo-host e na coluna NODE dos pods da app. O pseudo-host não recebe menu de contexto
   de nó PVE nem console (guardas no dispatcher e no `openTreeConsole`).
   Clicar numa aplicação abre um painel que replica a interface do LXC: `Summary` (ícone `fa-book`, `StatusView` com barras, `Notes` Markdown e gráficos), `Console` (shell interativo no pod via termproxy/websocket, com seleção de pod/container, e logs somente leitura), `Resources` (containers), `Network` (Services), `DNS`, `Options` e `Task History` (somente as tasks PVE Start/Stop/Scale/Restart/Rollback/Pause/Resume/Delete pod desta aplicação), além de `K8s Events`, `Images` e `Volumes`. O histórico usa a mesma grade nativa do Proxmox, mas consulta `/nodes/{node}/k8sapp/{appid}/tasks`; não exibe tasks de outras aplicações, VMs, containers ou apenas do nó. O conteúdo vem da API própria `/nodes/{node}/k8sapp/{appid}` e do snapshot local, sem abrir shell do host.

**Notas e logs integrados:** as notas das aplicações são persistidas em `/var/lib/pve-manager/k8s/notes.json` (diretório de estado do próprio `pve-manager`, ao lado de `jobs/` e `pkgupdates/` — não em `/usr/share`, que é asset estático do pacote). Cada mutação de nota registra `k8sapp update notes <appid>` no cluster log. As ações Start/Stop/Scale/Restart/Rollback/Pause/Resume/Delete pod retornam um UPID PVE real (`fork_worker`), gravam a saída em `/var/log/pve/tasks` e aparecem em `Cluster → Tasks`, `Cluster → Log` e no `Task History` do nó.

**Task History por aplicação:** o UPID de cada ação carrega a identidade da app no campo `id` (`kube-system-coredns`), e o endpoint `/nodes/{node}/k8sapp/{appid}/tasks` lê os mesmos arquivos de task do PVE (`/var/log/pve/tasks/index`, `index.1` e a lista `active`) devolvendo **apenas** as tasks `k8s*` daquela aplicação. A aba do painel é a grade nativa `proxmoxNodeTasks` apontada para esse endpoint (com `preFilter: { source: 'all' }`, que inclui a task ainda em execução), preservando colunas, `Task Viewer`, download de log, paginação (`start`/`limit` + total) e os filtros de usuário/tipo/status/data. O endpoint nativo do nó só sabe filtrar por VMID — daí a rota dedicada.

4. **Menu de contexto da aplicação:** botão direito na app da árvore abre um `PVE.k8sapp.CmdMenu`, com a mesma aparência/estrutura de VM/CT (ícones Font Awesome, separadores, confirmações e itens desabilitados por capacidade e estado). Ações disponíveis: `Start` (restaura a última quantidade de réplicas), `Stop` (escala Deployment/StatefulSet para zero), `Restart` (rolling restart), `Scale replicas`, `Rollback`, `Pause rollout`, `Resume rollout`, `Pod logs` (janela somente leitura com seleção de pod/container), `Delete pod` (o controlador recria o pod), `Describe / YAML` (saída somente leitura) e `Rollout status`. DaemonSet não é escalável para zero, mas suporta rollout, logs, describe e exclusão de pod. **Feedback na árvore:** durante a ação o ícone do recurso ganha um spinner girando (`k8s-pending`), respeitando o que está acontecendo — Stop/Start/Restart/Rollback/Scale só devolvem o ícone (`running`/`stopped`/`degraded`) quando a árvore reflete o estado final (ou após a janela de segurança de 8 min); ações instantâneas giram o tempo mínimo. Implementado em `app-browser.js` (wrapper de `get_object_icon_class` + hook no `load` do `ResourceStore`), sem tocar no `pvemanagerlib.js`.
5. **Ações não destrutivas do host:** nenhuma opção usa console do PVE, migração, clone, backup ou exclusão do recurso PVE. Todas as mutações são limitadas ao namespace e workload encontrados em `apps.json`, exigem `Sys.Modify`, passam por validação/taint-mode e chamam somente o binário local `/usr/local/bin/k3s kubectl`.

## Datacenter → Kubernetes → Network

O submenu agora é uma visão **multi-nó por padrão**:

- **GET `/cluster/k8snet/network`** agrega o snapshot local ao estado publicado por cada nó no KV do pmxcfs. A grade mostra, por host, pod CIDR, service CIDR, interface Flannel, node IP, idade do snapshot e conflitos.
- `cluster.nodes_total`, `cluster.nodes_reporting` e `cluster.consistent` indicam cobertura e consistência. Divergência de `cluster-cidr`/`service-cidr` entre servidores k3s aparece como conflito, pois essas faixas são globais do cluster Kubernetes.
- O snapshot é publicado a cada minuto por `/usr/local/sbin/k8snet-apply-node --publish`. Dados com mais de 10 minutos ficam `stale` e não entram na comparação de consistência.
- **PUT `/cluster/k8snet/network`** faz pre-flight em todos os nós alvo e, por padrão, aplica a configuração em todos os nós PVE. O campo opcional `nodes` (lista separada por vírgulas) restringe o alvo. `cluster-cidr`/`service-cidr` devem ser iguais nos servidores; `flannel-iface`/`node-ip` continuam específicos de cada host, então a UI só preenche os valores comuns e permite restringir o fan-out quando necessário.
- A rota per-node `/nodes/{node}/k8snet/network` usa o dispatcher `proxyto => node` e mantém a operação no host selecionado. A SDN permanece somente leitura nesta tela.

O Datacenter agora possui um grupo expansível **Kubernetes**, inicialmente com
um filho **Network**. A estrutura usa o mesmo mecanismo de submenu do SDN do
Proxmox: novos recursos podem ser adicionados futuramente referenciando
`groups: ['kubernetes']`.

O item **Network** é somente leitura para os objetos SDN e mostra:

- CIDR efetivo dos Pods e Services;
- backend e interface do Flannel;
- IP do nó e interfaces IPv4 do host;
- VNets SDN disponíveis neste nó, subnet, gateway, SNAT e estado;
- conflitos entre as faixas Kubernetes, interfaces locais e subnets SDN.

A API dedicada é `GET /cluster/k8snet/network`. A tela também oferece um
aplicador protegido por `Sys.Modify` para as flags `cluster-cidr`,
`service-cidr`, `flannel-iface` e `node-ip`. A alteração cria a task PVE
`k8snet`, preserva backup da unit do K3s, executa `daemon-reload` e reinicia o
serviço; se o nó não voltar a `Ready`, a configuração anterior é restaurada
automaticamente. Nenhuma alteração foi aplicada ao K3s durante a instalação
desta aba.

A configuração SDN nativa continua sendo administrada nas telas próprias do
Proxmox. Mantenha as VNets SDN fora das faixas usadas pelo Kubernetes
(`cluster-cidr`/`service-cidr` e as bridges de nó) — a aba Network destaca
qualquer conflito entre elas.

## Modelo de recursos

O K3s roda **direto no host** (decisão do projeto; sem VM/LXC dedicada). A
reserva de recursos continua lógica, dentro do Kubernetes
(`requests`/`limits` por container) — a integração não cria recurso PVE
fictício nem transforma Pod em VM. O que sobe para a árvore são as
**aplicações**, com `node='Kubernetes'` (pseudo-host do agrupamento),
`k8snode` = nó real que serve a API e `status` (`ok`/`degraded`) calculado a
partir das réplicas. A Server View agrupa tudo sob `Datacenter → Kubernetes`;
a Folder View continua agrupando por tipo em “Kubernetes Applications”.

| Arquivo | Papel |
|---|---|
| `patch_ui.py` | patches idempotentes: Services.pm (k3s), **Cluster.pm (tipo `k8sapp` em `/cluster/resources`)**, pvemanagerlib.js (aba, `typeDefaults`, `getTypeOrder`, `treeTypeToClass`, campo `k8sapp`, `startOnlyServices`) e index.html.tpl (script `app-browser.js`). Backups `*.bak-k8spoc`; reinicia `pvedaemon`/`pveproxy` só se ficaram velhos frente aos `.pm` |
| `gen-status.py` | gera `status.json` **e `apps.json`** (apps, réplicas, requests/limits agregados, pods) a partir do k3s local; sem segredos; no host: `/usr/local/sbin/gen-k8s-status.py`, cron root a cada minuto |
| `app-browser.js` | widget `pveK8sAppBrowser` + `PVE.k8sapp.CmdMenu` — painel e menu de contexto da aplicação; janelas de escala, logs, describe e exclusão de pod |
| `index.html` | painel da aba do nó, servido em `/pve2/js/k8s/index.html` |
| `manage.sh` | `verify` (checagem completa, inclui a guarda do dispatcher e as 10 rotas de ação) e `uninstall` (rollback da UI) |
| `tests/` | suíte Playwright: menu de contexto e ações, pseudo-host Kubernetes, pods aninhados por host (`k8spod`) e reativação do Summary (login real, clique direito na árvore, dispatcher, estado dos 13 itens e navegação entre abas) — ver `tests/README.md` |

## Instalação (host PVE com k3s ativo)

```bash
python3 /root/k8s-ui/patch_ui.py          # aplica/reaplica patches, cria o
                                          # painel, instala cron + guard e
                                          # reinicia pvedaemon/pveproxy
bash /root/k8s-ui/manage.sh verify        # tudo verde?
```

O cron do `gen-k8s-status.py` (publica `apps.json`/`status.json` a cada
minuto) é instalado pelo próprio patcher — sem passo manual.

## Verificação e rollback

```bash
bash /root/k8s-ui/manage.sh verify      # tudo verde?
bash /root/k8s-ui/manage.sh uninstall   # restaura originais, remove painel/cron/gerador
```

`uninstall` NÃO remove o K3s (`/usr/local/bin/k3s-uninstall.sh` faz isso).

## Reaplicar depois de upgrade do PVE

O `pve-manager` entrega `Services.pm`, `Cluster.pm`, `Nodes.pm`,
`pvemanagerlib.js` e `index.html.tpl` — um upgrade os sobrescreve. Desde o
guard isso é **automático**:

- `patch_ui.py` instala `/usr/local/sbin/k8s-ui-guard` + timer systemd
  (`k8s-ui-guard.timer`, a cada 30 min + 10 min após boot) + hook apt
  (`/etc/apt/apt.conf.d/99k8s-ui-guard`, `DPkg::Post-Invoke`).
- O guard confere os markers de integridade; se algum patch sumiu, reexecuta
  `python3 $K8SUI_DIR/patch_ui.py` (idempotente — reaplica patches, reinstala
  os arquivos nossos e reinicia `pvedaemon`/`pveproxy` se necessário) e roda
  `manage.sh verify` como health-check (uma retry de 10 s).
- O hook do apt nunca bloqueia nem falha a transação (`|| true`); qualquer
  falha fica em `/var/log/k8s-ui-guard.log` e a UI volta ao estado nativo.
- A pasta do deploy fica em `/var/lib/pve-manager/k8s/guard-src-dir`
  (gravada a cada execução do `patch_ui.py`); `K8SUI_DIR=... k8s-ui-guard`
  sobrepõe para testes.

Manual: `k8s-ui-guard -v` (mostra saída; sempre loga).

## Limitações e cuidados

- **Upgrade do `pve-manager`** sobrescreve `Services.pm`, `Cluster.pm`,
  `Nodes.pm`, `pvemanagerlib.js` e `index.html.tpl`: o guard reaplica
  automaticamente (hook apt + timer 30 min; detalhes acima). Se o guard
  falhar (anchors mudaram no PVE novo), a UI volta ao estado nativo e o
  reparo manual é `python3 $K8SUI_DIR/patch_ui.py`.
  Os backups `.bak-k8spoc` são da versão 9.2.11 — não restaurar em outra.
- **Hosts-fantasma (v4/v5):** pods de nós que existem NESTE PVE (`%pve_nodes`
  a partir de `get_nodelist`) sobem com `node=<host real>` e aninham na Server
  View; pods de nós gerenciados por OUTROS PVEs sobem com `node='Kubernetes'`.
  Nenhum host sintético (ex.: VMs desativadas do cluster) é materializado —
  nem com JS antigo em cache (registros remotos agrupam no pseudo-host já
  existente). O filtro da Server View esconde os pods remotos;
  a Folder View mostra o cluster inteiro na pasta "Kubernetes Pods".
- **Cache:** `patch_ui.py` acrescenta `k8spoc=<hash-do-código>` aos dois
  scripts da UI. Assim, após reaplicar, o navegador baixa automaticamente o
  dispatcher e o `PVE.k8sapp.CmdMenu` novos; Ctrl+F5 continua sendo útil para
  descartar uma sessão já aberta. O token anterior é removido no início de
  cada execução, senão a âncora do `index.html.tpl` não seria encontrada na
  segunda rodada e o patch abortaria antes de gravar o token novo.
- **Layout do Summary:** a identidade da app (Kind, Namespace, Node) fica no
  `StatusView`, como no Summary do LXC. Não use um `component` solto entre o
  bloco `StatusView`/`Notes` e os gráficos: ele herda `minHeight: 360` do
  `defaults` do `itemcontainer` e empurra as notas para longe, deixando uma
  faixa vazia no meio do painel.
- **Restart pela grade de serviços** envia `reload` (padrão da UI para
  evitar disrupção); k3s não suporta reload — reinício real via
  Shell/SSH: `systemctl restart k3s`.
- Este modelo de integração serve para o modo HOST (lab/edge). Para
  produção, o produto final deve usar endpoint dedicado na API do PVE e
  clusters em VMs.

## Pods aninhados por host (tipo k8spod)

Cada pod do snapshot sobe em `/cluster/resources` como recurso `k8spod` com
`node=<host onde o pod roda>`:

- **Server View**: os pods aparecem DENTRO do host real correspondente (o
  filtro da view só deixa passar pods cujo host existe nesta instalação —
  no host local, os pods do próprio host). Pods de outros PVEs ficam fora.
- **Folder View**: pasta "Kubernetes Pods" com o cluster INTEIRO (inclui os
  pods de outros PVEs — publicados com node='Kubernetes', sem nunca
  materializar host-fantasma na Server View).
- Clique no pod: painel `pveK8sPodPanel` (resumo + Console do próprio pod).
- Botão direito no pod: Console / Pod logs / Describe pod / View YAML /
  Delete pod (a validação de permissão do pod é a mesma do app).
- `describe?pod=<nome>` restringe o kubectl ao pod (validado contra o snapshot).

Não há rotas novas: tudo reusa os endpoints `/nodes/{node}/k8sapp/...`, com o
nó real viajando no campo `k8snode` do registro do pod.

## Instalação em outros hosts PVE do cluster k8s

A mesma integração roda em **cada host PVE que participa do K3s** — cada UI
mostra o cluster inteiro (apps + pods de todos os nós), com os pods locais
aninhados sob o próprio host. Já validado em hosts PVE 9.1.x e 9.2.x a
partir do mesmo repositório:

```bash
# 1. copie o repo para o host alvo (scp/git) e, na ORIGEM:
ssh root@<origem> 'tar czf - -C /root k8s-ui --exclude="*/backup-*"' > k8s-ui.tar.gz
scp -P <porta> k8s-ui.tar.gz root@<alvo>:/root/
# 2. no alvo:
cd /root && tar xzf k8s-ui.tar.gz
python3 /root/k8s-ui/patch_ui.py --dry-run   # pre-valida TODAS as ancoras sem alterar nada
python3 /root/k8s-ui/patch_ui.py             # aplica
bash /root/k8s-ui/manage.sh verify           # TUDO OK
```

Notas:

- `--dry-run` roda o patcher inteiro sobre um overlay em memória: escritas,
  cron, systemctl e installs viram no-ops e nada toca o disco. Serve para
  pré-validar em versões de PVE ainda não testadas antes de aplicar.
- O patcher aceita âncoras variantes por versão (já cobre 9.1.x e 9.2.x):
  se uma âncora não casa, ele tenta a variante seguinte e aborta sem
  alterar caso nenhuma case exatamente 1x.
- O cron do `gen-k8s-status.py` agora é instalado pelo próprio patcher
  (instalações anteriores o tinham criado à mão — é o que publica
  apps.json/status.json/history.json a cada minuto).
- `manage.sh verify` trata `docker` como opcional (hosts sem Docker).
- Suite E2E: `PVE_URL`/`PVE_USER`/`PVE_PASSWORD`/`PVE_HOST` apontam para o
  host alvo; os testes não dependem mais de nomes fixos de pods/apps nem
  assumem cluster PVE de nó único.
