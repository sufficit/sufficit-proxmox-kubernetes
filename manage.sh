#!/bin/bash
# manage.sh — verificação e rollback da integração K3s <-> UI do Proxmox (POC)
# Uso: bash manage.sh verify   (checagem completa)
#      bash manage.sh uninstall (remove SÓ a integração da UI; o K3s continua ativo)
# Rollback restaurável apenas na mesma versão do PVE dos backups (9.2.11).
set -u

SERVICES_PM=/usr/share/perl5/PVE/API2/Services.pm
CLUSTER_PM=/usr/share/perl5/PVE/API2/Cluster.pm
NODES_PM=/usr/share/perl5/PVE/API2/Nodes.pm
K8SAPP_PM=/usr/share/perl5/PVE/API2/K8sApp.pm
K8SNET_PM=/usr/share/perl5/PVE/API2/Cluster/K8sNet.pm
NODEK8SNET_PM=/usr/share/perl5/PVE/API2/NodeK8sNet.pm
K8SNET_APPLY=/usr/local/sbin/k8snet-apply-node
JS=/usr/share/pve-manager/js/pvemanagerlib.js
TPL=/usr/share/pve-manager/index.html.tpl
K8S_DIR=/usr/share/pve-manager/js/k8s
K8S_STATE_DIR=/var/lib/pve-manager/k8s
GEN=/usr/local/sbin/gen-k8s-status.py
FQDN=$(hostname -f)
SHORT=$(hostname)

ok()   { printf "  [OK]   %s\n" "$1"; }
fail() { printf "  [FAIL] %s\n" "$1"; RC=1; }
RC=0

verify() {
  echo "== Patches =="
  grep -q "^    'k3s',$" "$SERVICES_PM" && ok "k3s listado em Services.pm" || fail "k3s ausente em Services.pm"
  grep -q "POC k8s (k8s-poc)" "$CLUSTER_PM" && ok "Cluster.pm injeta k8sapp em /cluster/resources" || fail "Cluster.pm sem patch k8sapp"
  grep -q "POC k8s (k8s-poc)" "$NODES_PM" && ok "Nodeinfo.pm registra /nodes/{node}/k8sapp" || fail "Nodeinfo.pm sem endpoint k8sapp"
  [ -f "$K8SAPP_PM" ] && ok "K8sApp.pm instalado" || fail "K8sApp.pm ausente"
  [ -f "$K8SNET_PM" ] && ok "K8sNet.pm instalado" || fail "K8sNet.pm ausente"
  [ -f "$NODEK8SNET_PM" ] && ok "NodeK8sNet.pm instalado" || fail "NodeK8sNet.pm ausente"
  grep -q 'subclass => "PVE::API2::NodeK8sNet"' "$NODES_PM" && ok "Nodes.pm registra /nodes/{node}/k8snet" || fail "Nodes.pm sem rota k8snet"
  grep -q "PVE::API2::Cluster::K8sNet" "$CLUSTER_PM" && ok "Cluster.pm registra /cluster/k8snet" || fail "Cluster.pm sem rota k8snet"
  [ -x "$K8SNET_APPLY" ] && ok "aplicador instalado ($K8SNET_APPLY)" || fail "aplicador ausente ($K8SNET_APPLY)"
  crontab -l 2>/dev/null | grep -q "k8snet-apply-node --publish" && ok "cron publisher do snapshot ativo (1 min)" || fail "cron publisher ausente"
  grep -q "pveK8sNetworkPanel" "$K8S_DIR/app-browser.js" 2>/dev/null && grep -q "Cluster nodes" "$K8S_DIR/app-browser.js" && ok "painel com grade multi-no" || fail "app-browser.js sem grade multi-no"
  grep -q "itemId: 'kubernetesnetwork'," "$JS" && ok "submenu Datacenter Kubernetes/Network" || fail "submenu Kubernetes/Network ausente"
  grep -q "k8sapp: 'pveK8sAppBrowser'," "$JS" && ok "k8sapp abre painel pveK8sAppBrowser" || fail "treeTypeToClass sem k8sapp"
  grep -q "enum => \['vm', 'storage', 'node', 'sdn', 'k8sapp'\]" "$CLUSTER_PM" && ok "Cluster.pm: filtro type aceita k8sapp" || fail "Cluster.pm: enum sem k8sapp"
  grep -q "itemId: 'kubernetes'," "$JS" && ok "aba Kubernetes no pvemanagerlib.js" || fail "aba Kubernetes ausente"
  grep -q "k3s: true," "$JS" && ok "k3s em startOnlyServices (protegido contra Stop pela UI)" || fail "startOnlyServices sem k3s"
  grep -q "k8sapp: {" "$JS" && ok "tipo k8sapp em typeDefaults (ícone/label na árvore)" || fail "typeDefaults sem k8sapp"
  grep -q "src: '/pve2/js/k8s/index.html'," "$JS" && ok "iframe apontando para /pve2/js/k8s/" || fail "iframe ausente"
  grep -q "k8s/app-browser.js" "$TPL" && ok "index.html.tpl carrega app-browser.js" || fail "TPL sem app-browser.js"
  grep -q "Ext.ClassManager.get('PVE.k8sapp.CmdMenu')" "$JS" && ok "dispatcher createCmdMenu com guarda (menu k8sapp)" || fail "dispatcher CmdMenu sem k8sapp/guarda"

  echo "== Arquivos =="
  [ -s "$K8S_DIR/index.html" ] && ok "index.html presente" || fail "index.html ausente"
  [ -s "$K8S_DIR/app-browser.js" ] && ok "app-browser.js presente" || fail "app-browser.js ausente"
  [ -s "$K8S_DIR/apps.json" ] && ok "apps.json presente" || fail "apps.json ausente"
  [ -s "$K8S_DIR/status.json" ] && ok "status.json presente" || fail "status.json ausente"
  [ -s "$K8S_DIR/history.json" ] && ok "history.json presente" || fail "history.json ausente"
  [ -f "$K8S_STATE_DIR/desired.json" ] && ok "desired.json persistente presente" || ok "desired.json ainda vazio (criado ao primeiro Stop/Scale)"
  [ -f "$K8S_STATE_DIR/notes.json" ] && ok "notes.json persistente presente" || ok "notes.json ainda vazio (criado no primeiro Notes save)"
  [ ! -e "$K8S_DIR/notes.json" ] && ok "diretorio estatico sem notes.json" || fail "notes.json no diretorio estatico (mover para $K8S_STATE_DIR)"
  grep -q "k8s_task_id\|fork_worker" "$K8SAPP_PM" && ok "acoes k8sapp viram tasks PVE (fork_worker)" || fail "K8sApp.pm sem integracao de tasks"
  grep -q "k8stermproxy" "$K8SAPP_PM" && ok "console interativo (termproxy) presente em K8sApp.pm" || fail "K8sApp.pm sem termproxy"
  grep -q "pveK8sConsole\|loadXterm" "$K8S_DIR/app-browser.js" && ok "app-browser.js com widget de console (xterm.js)" || fail "app-browser.js sem console"
  [ -x "$GEN" ] && ok "gerador instalado ($GEN)" || fail "gerador ausente"
  crontab -l 2>/dev/null | grep -q gen-k8s-status && ok "cron ativo (1 min)" || fail "cron ausente"

  echo "== Serviços =="
  for s in k3s pveproxy pvedaemon pvestatd docker; do
    st=$(systemctl is-active "$s" 2>/dev/null)
    [ "$st" = active ] && ok "$s: active" || fail "$s: $st"
  done

  echo "== Freshness de pvedaemon/pveproxy =="
  # .pm são carregados UMA vez: pvedaemon (Services.pm, Cluster.pm) e os
  # workers do pveproxy (Cluster.pm em /cluster/... só se aplicável) precisam
  # ser mais novos que os arquivos patcheados.
  pm_ts=$(stat -c %Y "$CLUSTER_PM")
  for unit in pvedaemon pveproxy; do
    pid=$(systemctl show -p MainPID --value "$unit")
    ts=$(stat -c %Y "/proc/$pid" 2>/dev/null || echo 0)
    if [ "$ts" -ge "$pm_ts" ]; then
      ok "$unit iniciado após o patch dos .pm"
    else
      fail "$unit mais antigo que os .pm — rode: systemctl restart $unit"
    fi
  done

  echo "== HTTP via pveproxy =="
  for p in /pve2/js/k8s/index.html /pve2/js/k8s/app-browser.js /pve2/js/k8s/status.json /pve2/js/k8s/apps.json; do
    code=$(curl -sk --resolve "$FQDN:8006:127.0.0.1" -o /dev/null -w "%{http_code}" "https://$FQDN:8006$p")
    [ "$code" = 200 ] && ok "$p -> 200" || fail "$p -> $code (novo dir criado? systemctl restart pveproxy)"
  done

  echo "== API k8sapp =="
  TOK=""; AUTH=""
  TOK=$(pveum user token add root@pam k8sui-verify --privsep 0 --output-format json 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin)["value"])' 2>/dev/null || true)
  if [ -n "$TOK" ]; then
    AUTH="PVEAPIToken=root@pam!k8sui-verify=$TOK"
    appid=$(python3 -c 'import json; d=json.load(open("/usr/share/pve-manager/js/k8s/apps.json")); a=(d.get("apps") or [{}])[0]; print(a.get("appid") or ((a.get("namespace","")+":"+a.get("name","")) if a else ""))' 2>/dev/null)
    code=$(curl -sk --resolve "$FQDN:8006:127.0.0.1" -H "Authorization: $AUTH" -o /dev/null -w "%{http_code}" "https://$FQDN:8006/api2/json/nodes/$SHORT/k8sapp/$appid/rrddata?timeframe=hour")
    [ "$code" = 200 ] && ok "/k8sapp/{appid}/rrddata -> 200" || fail "/k8sapp/{appid}/rrddata -> $code"
    code=$(curl -sk --resolve "$FQDN:8006:127.0.0.1" -H "Authorization: $AUTH" -o /dev/null -w "%{http_code}" "https://$FQDN:8006/api2/extjs/nodes/$SHORT/k8sapp/$appid/config")
    [ "$code" = 200 ] && ok "/k8sapp/{appid}/config -> 200" || fail "/k8sapp/{appid}/config -> $code"
    code=$(curl -sk --resolve "$FQDN:8006:127.0.0.1" -H "Authorization: $AUTH" -o /dev/null -w "%{http_code}" "https://$FQDN:8006/api2/extjs/nodes/$SHORT/k8sapp/$appid/tasks?source=all")
    [ "$code" = 200 ] && ok "/k8sapp/{appid}/tasks -> 200 (historico por app)" || fail "/k8sapp/{appid}/tasks -> $code"
    # Rotas de acao: chamar com appid inexistente -> o handler rejeita ANTES de
    # qualquer kubectl (400/500 "not found"). 200/4xx/5xx de validacao provam
    # registro; 404/501 provam rota ausente. NUNCA executa a acao de verdade.
    bogus="zz-nonexistent-ns:zz-nonexistent-app"
    for action in start stop restart scale rollback pause resume deletepod termproxy vncwebsocket describe rollout; do
      case "$action" in
        describe|rollout|vncwebsocket) method=GET ;;
        *) method=POST ;;
      esac
      extra=""
      [ "$action" = scale ] && extra="-d replicas=1"
      code=$(curl -sk --resolve "$FQDN:8006:127.0.0.1" -H "Authorization: $AUTH" $extra \
        -o /dev/null -w "%{http_code}" -X "$method" \
        "https://$FQDN:8006/api2/json/nodes/$SHORT/k8sapp/$bogus/$action")
      [ "$code" != 404 ] && [ "$code" != 501 ] \
        && ok "/k8sapp/$action rota registrada ($code)" \
        || fail "/k8sapp/$action -> $code (rota ausente)"
    done
    pveum user token remove root@pam k8sui-verify >/dev/null 2>&1
  else
    fail "sem token temporario para validar /k8sapp"
  fi

  echo "== API do PVE =="
  out=$(pvesh get "/nodes/$SHORT/services" --output-format json 2>/dev/null | python3 -c "
import json,sys
d=json.load(sys.stdin)
m=[s for s in d if s['service']=='k3s']
print(m[0]['state'] if m else 'AUSENTE')" 2>/dev/null)
  [ "$out" = running ] && ok "/services lista k3s=running" || fail "/services: $out"

  napps=$(pvesh get /cluster/resources --output-format json 2>/dev/null | python3 -c "
import json,sys
d=json.load(sys.stdin)
ks=[x for x in d if x.get('type')=='k8sapp']
print(len(ks))" 2>/dev/null)
  if [ "${napps:-0}" -ge 1 ] 2>/dev/null; then
    ok "/cluster/resources com $napps aplicação(ões) k8sapp"
  else
    fail "/cluster/resources sem k8sapp ($napps)"
  fi

  echo "== Cluster K3s =="
  node=$(k3s kubectl get nodes --no-headers 2>/dev/null | awk '{print $2}')
  [ "$node" = Ready ] && ok "nó Kubernetes Ready" || fail "nó Kubernetes: ${node:-sem resposta}"

  echo; [ $RC -eq 0 ] && echo "RESULTADO: TUDO OK" || echo "RESULTADO: FALHAS ACIMA"
  return $RC
}

uninstall() {
  echo "== Removendo integração da UI (K3s permanece ativo) =="
  for f in "$SERVICES_PM" "$CLUSTER_PM" "$JS" "$TPL" "$NODES_PM" "$K8SAPP_PM"; do
    if [ -f "$f.bak-k8spoc" ]; then cp -a "$f.bak-k8spoc" "$f" && echo "  restaurado: $f"; fi
  done
  rm -f "$K8SAPP_PM.bak-k8spoc" 2>/dev/null
  if [ -f "$K8SNET_PM" ]; then rm -f "$K8SNET_PM" && echo "  removido: $K8SNET_PM"; fi
  if [ -f "$NODEK8SNET_PM" ]; then rm -f "$NODEK8SNET_PM" && echo "  removido: $NODEK8SNET_PM"; fi
  if [ -f "$K8SNET_APPLY" ]; then rm -f "$K8SNET_APPLY" && echo "  removido: $K8SNET_APPLY"; fi
  perl -MPVE::Cluster -e 'PVE::Cluster::broadcast_node_kv("k8snet-network", undef)' 2>/dev/null \
    && echo "  removido: snapshot k8snet do pmxcfs"
  if [ -d "$K8S_DIR" ]; then
    rm -f "$K8S_DIR/index.html" "$K8S_DIR/status.json" "$K8S_DIR/apps.json" "$K8S_DIR/app-browser.js" "$K8S_DIR/history.json"
    rmdir "$K8S_DIR" 2>/dev/null && echo "  removido: $K8S_DIR"
  fi
  # notas sao dados do usuario: o padrao do PVE e preservar /var/lib em
  # desinstalacoes, mas como a integracao e um POC removemos o diretorio nosso.
  rm -rf "$K8S_STATE_DIR" && echo "  removido: $K8S_STATE_DIR (notas)"
  ( crontab -l 2>/dev/null | grep -v gen-k8s-status | grep -v 'k8snet-apply-node' || true ) | crontab -
  rm -f "$GEN" && echo "  removido: $GEN"
  systemctl restart pveproxy && echo "  pveproxy reiniciado"
  systemctl restart pvedaemon && echo "  pvedaemon reiniciado"
  echo "== Concluído. Faça reload forte (Ctrl+F5) na UI. =="
  echo "== Para remover o próprio K3s: /usr/local/bin/k3s-uninstall.sh =="
}

case "${1:-verify}" in
  verify) verify ;;
  uninstall) uninstall ;;
  *) echo "uso: $0 {verify|uninstall}"; exit 2 ;;
esac
