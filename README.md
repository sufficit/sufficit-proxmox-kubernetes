# sufficit-proxmox-kubernetes — Kubernetes na interface do Proxmox VE (POC)

Integra o K3s que roda no host PVE à própria UI do Proxmox (validado no
PVE 9.2.11, Debian 13). Consulta dos dados do
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
   aninhada sob o nó que executa o K3s. Clicar abre um painel que replica a interface do LXC: `Summary` (ícone `fa-book`, `StatusView` com barras, `Notes` Markdown e gráficos), `Console` (shell interativo no pod via termproxy/websocket, com seleção de pod/container, e logs somente leitura), `Resources` (containers), `Network` (Services), `DNS`, `Options` e `Task History` (somente as tasks PVE Start/Stop/Scale/Restart/Rollback/Pause/Resume/Delete pod desta aplicação), além de `K8s Events`, `Images` e `Volumes`. O histórico usa a mesma grade nativa do Proxmox, mas consulta `/nodes/{node}/k8sapp/{appid}/tasks`; não exibe tasks de outras aplicações, VMs, containers ou apenas do nó. O conteúdo vem da API própria `/nodes/{node}/k8sapp/{appid}` e do snapshot local, sem abrir shell do host.
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
Proxmox. A VNet de teste encontrada no host permanece separada do K3s:
`k8s` → `vnk8s` → `172.20.10.0/24`, fora das redes `172.16.0.0/16` e
`172.19.0.0/16`.

## Modelo de recursos

O K3s roda **direto no host** (decisão do projeto; sem VM/LXC dedicada). A
reserva de recursos continua lógica, dentro do Kubernetes
(`requests`/`limits` por container) — a integração não cria recurso PVE
fictício nem transforma Pod em VM. O que sobe para a árvore são as
**aplicações**, com `node=<host>` e `status` (`ok`/`degraded`) calculado a
partir das réplicas.

| Arquivo | Papel |
|---|---|
| `patch_ui.py` | patches idempotentes: Services.pm (k3s), **Cluster.pm (tipo `k8sapp` em `/cluster/resources`)**, pvemanagerlib.js (aba, `typeDefaults`, `getTypeOrder`, `treeTypeToClass`, campo `k8sapp`, `startOnlyServices`) e index.html.tpl (script `app-browser.js`). Backups `*.bak-k8spoc`; reinicia `pvedaemon`/`pveproxy` só se ficaram velhos frente aos `.pm` |
| `gen-status.py` | gera `status.json` **e `apps.json`** (apps, réplicas, requests/limits agregados, pods) a partir do k3s local; sem segredos; no host: `/usr/local/sbin/gen-k8s-status.py`, cron root a cada minuto |
| `app-browser.js` | widget `pveK8sAppBrowser` + `PVE.k8sapp.CmdMenu` — painel e menu de contexto da aplicação; janelas de escala, logs, describe e exclusão de pod |
| `index.html` | painel da aba do nó, servido em `/pve2/js/k8s/index.html` |
| `manage.sh` | `verify` (checagem completa, inclui a guarda do dispatcher e as 10 rotas de ação) e `uninstall` (rollback da UI) |
| `tests/` | suíte Playwright do menu, ações e reativação do Summary (login real, clique direito na árvore, dispatcher, estado dos 13 itens e navegação entre abas) — ver `tests/README.md` |

## Instalação (host PVE com k3s ativo)

```bash
python3 /root/k8s-ui/patch_ui.py          # aplica/reaplica patches
mkdir -p /usr/share/pve-manager/js/k8s    # painel + status.json aqui
systemctl restart pveproxy                # OBRIGATÓRIO: pveproxy mapeia
                                          # subdiretórios novos só no boot
```

Cron (root): `* * * * * /usr/local/sbin/gen-k8s-status.py >/dev/null 2>&1`

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
