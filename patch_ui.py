#!/usr/bin/env python3
"""
POC: integra o K3s na UI do Proxmox VE (no host alvo).

1. Services.pm: adiciona 'k3s' a lista de servicos da aba System.
2. Cluster.pm: injeta aplicacoes Kubernetes (tipo 'k8sapp') em /cluster/resources,
   lendo /usr/share/pve-manager/js/k8s/apps.json (gerado por gen-k8s-status.py).
   Com isso as apps aparecem NA ARVORE DE RECURSOS junto de VMs e LXCs.
3. pvemanagerlib.js:
   - aba "Kubernetes" no painel do no (iframe somente leitura);
   - k3s em startOnlyServices (libera Start/Restart na grade);
   - tipo 'k8sapp': icone+titulo (typeDefaults), ordem na arvore (getTypeOrder),
     mapeamento p/ o painel de detalhe (treeTypeToClass -> pveK8sAppBrowser)
     e campo 'k8sapp' no ResourceStore.
4. index.html.tpl: carrega /pve2/js/k8s/app-browser.js (widget do painel de app).

Idempotente: rodar de novo nao duplica (detecta por marker).
Backups: *.bak-k8spoc (criados apenas na primeira execucao).

IMPORTANTE: pveproxy mapeia diretorios estaticos no boot -> restart apos
criar arquivos sob /usr/share/pve-manager/js/.
IMPORTANTE 2: pvedaemon carrega modulos Perl uma unica vez -> o script
reinicia o pvedaemon se ele for mais antigo que Services.pm/Cluster.pm.
"""
import hashlib
import os
import re
import shutil
import subprocess
import sys

SERVICES = "/usr/share/perl5/PVE/API2/Services.pm"
CLUSTER = "/usr/share/perl5/PVE/API2/Cluster.pm"
NODES = "/usr/share/perl5/PVE/API2/Nodes.pm"
K8SAPP_API = "/usr/share/perl5/PVE/API2/K8sApp.pm"
K8SNET_API = "/usr/share/perl5/PVE/API2/Cluster/K8sNet.pm"
NODEK8SNET_API = "/usr/share/perl5/PVE/API2/NodeK8sNet.pm"
K8SNET_APPLY = "/usr/local/sbin/k8snet-apply-node"
JS = "/usr/share/pve-manager/js/pvemanagerlib.js"
TPL = "/usr/share/pve-manager/index.html.tpl"


def backup(path):
    bak = path + ".bak-k8spoc"
    if not os.path.exists(path):
        print(f"[skip] {bak} (arquivo original ainda nao existe)")
        return
    if not os.path.exists(bak):
        shutil.copy2(path, bak)
        print(f"[bkp] {bak}")
    else:
        print(f"[bkp] {bak} (ja existia)")


def patch(path, anchor, replacement, tag, marker=None):
    marker = replacement.strip() if marker is None else marker
    with open(path, encoding="utf-8") as f:
        data = f.read()
    if marker in data:
        print(f"[skip] {tag}: patch ja aplicado")
        return
    n = data.count(anchor)
    if n != 1:
        print(f"[erro] {tag}: ancora encontrada {n}x (esperado 1). Abortando sem alterar.")
        sys.exit(1)
    data = data.replace(anchor, replacement, 1)
    with open(path, "w", encoding="utf-8") as f:
        f.write(data)
    print(f"[ok] {tag}: patch aplicado")


# ---------- 1) k3s na lista de servicos (Services.pm) ----------
backup(SERVICES)
patch(
    SERVICES,
    "    'cron',\n    'ksmtuned',",
    "    'cron',\n    'k3s',\n    'ksmtuned',",
    "Services.pm: lista de servicos",
    marker="    'k3s',",
)

# ---------- 2) apps Kubernetes em /cluster/resources (Cluster.pm) ----------
backup(CLUSTER)
patch(
    CLUSTER,
    "                enum => ['vm', 'storage', 'node', 'sdn'],",
    "                enum => ['vm', 'storage', 'node', 'sdn', 'k8sapp'],",
    "Cluster.pm: enum do filtro type",
)
patch(
    CLUSTER,
    "                        ['node', 'storage', 'pool', 'qemu', 'lxc', 'openvz', 'sdn', 'network'],",
    "                        ['node', 'storage', 'pool', 'qemu', 'lxc', 'openvz', 'sdn', 'network', 'k8sapp'],",
    "Cluster.pm: enum do retorno",
)
patch(
    CLUSTER,
    "                network => {\n                    description => \"The name of a Network entity (for type 'network').\",",
    "                k8sapp => {\n                    description => \"The Kubernetes application identity (for type 'k8sapp').\",\n                    type => 'string',\n                    optional => 1,\n                },\n"
    "                network => {\n                    description => \"The name of a Network entity (for type 'network').\",", 
    "Cluster.pm: schema do campo k8sapp",
    marker="The Kubernetes application identity (for type 'k8sapp').",
)

k8s_block = """        # POC k8s (k8s-poc): aplicações Kubernetes como recursos da árvore
        if (!$param->{type} || $param->{type} eq 'k8sapp') {
            my $appsfile = '/usr/share/pve-manager/js/k8s/apps.json';
            if (-f $appsfile) {
                eval {
                    open(my $fh, '<', $appsfile) or die "open: $!";
                    local $/;
                    my $raw = <$fh>;
                    close($fh);
                    my $apps = decode_json($raw)->{apps} || [];
                    for my $app (@$apps) {
                        next if !$rpcenv->check($authuser, "/nodes/$app->{node}", ['Sys.Audit'], 1);
                        push @$res, {
                            id => "k8sapp/$app->{namespace}/$app->{name}",
                            type => 'k8sapp',
                            k8sapp => "$app->{namespace}/$app->{name}",
                            node => $app->{node},
                            name => $app->{name},
                            text => "$app->{name} [$app->{namespace}]",
                            # 'running'/'stopped' recebem o tratamento CSS padrao; 'degraded' fica neutro
                            status => ($app->{status} // '') eq 'ok' ? 'running'
                                : (($app->{status} // '') eq 'stopped' ? 'stopped' : 'degraded'),
                            hastate => 'unmanaged',
                        };
                    }
                };    # falha silenciosa: sem apps.json a árvore segue normal
            }
        }

"""
patch(
    CLUSTER,
    "        return $res;\n    },\n});\n\n__PACKAGE__->register_method({\n    name => 'tasks',",
    k8s_block + "        return $res;\n    },\n});\n\n__PACKAGE__->register_method({\n    name => 'tasks',",
    "Cluster.pm: injeta recursos k8sapp",
    marker="POC k8s (k8s-poc)",
)

# upgrade: instalacoes antigas tem o bloco sem o estado 'stopped' (escalado a
# zero). Em instalação nova o marker novo já existe -> skip; na antiga, troca
# a linha de status pela versão com stopped.
patch(
    CLUSTER,
    "                            # 'running' recebe o tratamento CSS padrao de icone; 'degraded' fica neutro\n"
    "                            status => ($app->{status} // 'unknown') eq 'ok' ? 'running' : 'degraded',",
    "                            # 'running'/'stopped' recebem o tratamento CSS padrao; 'degraded' fica neutro\n"
    "                            status => ($app->{status} // '') eq 'ok' ? 'running'\n"
    "                                : (($app->{status} // '') eq 'stopped' ? 'stopped' : 'degraded'),",
    "Cluster.pm: status stopped para escalado a zero",
    # o texto instalado termina em "'degraded')," (fecha o parenteses do
    # operador ternario externo antes da virgula) -- o marker precisa bater
    # com isso exatamente, senao a checagem de idempotencia falha e o script
    # tenta reaplicar sobre um anchor que nao existe mais.
    marker="'stopped' : 'degraded'),",
)

# POC k8s (k8s-poc): rede do Kubernetes no Datacenter (/cluster/k8snet/network)
patch(
    CLUSTER,
    "use PVE::API2::Cluster::Qemu;\n",
    "use PVE::API2::Cluster::K8sNet; # POC k8s (k8s-poc)\nuse PVE::API2::Cluster::Qemu;\n",
    "Cluster.pm: use K8sNet",
    marker="use PVE::API2::Cluster::K8sNet;",
)
patch(
    CLUSTER,
    """__PACKAGE__->register_method({
    subclass => "PVE::API2::Cluster::BulkAction",
    path => 'bulk-action',
});
""",
    """__PACKAGE__->register_method({
    subclass => "PVE::API2::Cluster::BulkAction",
    path => 'bulk-action',
});

__PACKAGE__->register_method({
    subclass => "PVE::API2::Cluster::K8sNet", # POC k8s (k8s-poc)
    path => 'k8snet',
});
""",
    "Cluster.pm: subclass k8snet",
    marker='subclass => "PVE::API2::Cluster::K8sNet"',
)
patch(
    CLUSTER,
    "            { name => 'jobs' },\n",
    "            { name => 'jobs' },\n            { name => 'k8snet' }, # POC k8s (k8s-poc)\n",
    "Cluster.pm: indice k8snet",
    marker="{ name => 'k8snet' },",
)

# gerador de JSONs: mesma politica do K8sApp.pm (arquivo nosso, sem .bak)
GEN_DST = "/usr/local/sbin/gen-k8s-status.py"
GEN_SRC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "gen-status.py")
if os.path.exists(GEN_SRC):
    with open(GEN_SRC, encoding="utf-8") as f:
        src = f.read()
    if not os.path.exists(GEN_DST) or open(GEN_DST, encoding="utf-8").read() != src:
        with open(GEN_DST, "w", encoding="utf-8") as f:
            f.write(src)
        os.chmod(GEN_DST, 0o755)
        print(f"[ok] gen-k8s-status.py instalado ({GEN_DST})")
    else:
        print("[skip] gen-k8s-status.py ja atualizado")

# ---------- 2a-bis) estaticos da UI (app-browser.js + index.html) ----------
# Mesma politica dos arquivos nossos: instala se faltar ou se diferir do repo.
K8S_DIR = "/usr/share/pve-manager/js/k8s"
_HERE = os.path.dirname(os.path.abspath(__file__))
os.makedirs(K8S_DIR, exist_ok=True)
for _name in ("app-browser.js", "index.html"):
    _src = os.path.join(_HERE, _name)
    _dst = os.path.join(K8S_DIR, _name)
    if not os.path.exists(_src):
        print(f"[aviso] {_name} nao encontrado ao lado do patch_ui.py")
        continue
    with open(_src, encoding="utf-8") as f:
        _data = f.read()
    _cur = open(_dst, encoding="utf-8").read() if os.path.exists(_dst) else None
    if _cur != _data:
        with open(_dst, "w", encoding="utf-8") as f:
            f.write(_data)
        os.chmod(_dst, 0o644)
        print(f"[ok] {_name} instalado ({_dst})")
    else:
        print(f"[skip] {_name} ja atualizado")

# ---------- 2b) API REST dedicada da app (K8sApp.pm) ----------
# Modulo novo (nao e patch): instalar so se faltar ou se diferir do repo.
K8SAPP_SRC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "k8sapp.pm")
if os.path.exists(K8SAPP_SRC):
    with open(K8SAPP_SRC, encoding="utf-8") as f:
        src = f.read()
    if not os.path.exists(K8SAPP_API) or open(K8SAPP_API, encoding="utf-8").read() != src:
        # K8sApp.pm is a new PVE module owned by this integration; there is no
        # vendor file to restore. Do not create a misleading .bak on upgrades.
        with open(K8SAPP_API, "w", encoding="utf-8") as f:
            f.write(src)
        os.chmod(K8SAPP_API, 0o644)
        print(f"[ok] K8sApp.pm instalado ({K8SAPP_API})")
    else:
        print("[skip] K8sApp.pm ja atualizado")
else:
    print("[aviso] k8sapp.pm nao encontrado ao lado do patch_ui.py")

# ---------- 2b-bis) API de rede do Kubernetes no Datacenter ----------
K8SNET_SRC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "k8snet.pm")
if os.path.exists(K8SNET_SRC):
    os.makedirs(os.path.dirname(K8SNET_API), exist_ok=True)
    with open(K8SNET_SRC, encoding="utf-8") as f:
        src = f.read()
    _cur = open(K8SNET_API, encoding="utf-8").read() if os.path.exists(K8SNET_API) else None
    if _cur != src:
        # modulo novo, propriedade desta integracao; sem backup vendor.
        with open(K8SNET_API, "w", encoding="utf-8") as f:
            f.write(src)
        os.chmod(K8SNET_API, 0o644)
        print(f"[ok] K8sNet.pm instalado ({K8SNET_API})")
    else:
        print("[skip] K8sNet.pm ja atualizado")
else:
    print("[aviso] k8snet.pm nao encontrado ao lado do patch_ui.py")

# ---------- 2b-ter) aplicador per-node + endpoint /nodes/{node}/k8snet ----------
# O aplicador encapsula apply/check/rollback/publish do K8sNet.pm; e executado
# como processo novo a cada chamada (local, via SSH no fan-out e pelo cron),
# portanto NAO entra no calculo de freshness dos daemons.
_HERE2 = os.path.dirname(os.path.abspath(__file__))
APPLY_SRC = os.path.join(_HERE2, "k8snet-apply-node")
if os.path.exists(APPLY_SRC):
    with open(APPLY_SRC, encoding="utf-8") as f:
        src = f.read()
    if not os.path.exists(K8SNET_APPLY) or open(K8SNET_APPLY, encoding="utf-8").read() != src:
        with open(K8SNET_APPLY, "w", encoding="utf-8") as f:
            f.write(src)
        os.chmod(K8SNET_APPLY, 0o755)
        print(f"[ok] k8snet-apply-node instalado ({K8SNET_APPLY})")
    else:
        print("[skip] k8snet-apply-node ja atualizado")
else:
    print("[aviso] k8snet-apply-node nao encontrado ao lado do patch_ui.py")

# Publica o snapshot local no KV do pmxcfs a cada minuto. A entrada e
# compartilhada entre os nos do cluster e lida pelo GET cluster-level; se o
# host e standalone, continua sendo apenas uma leitura local sem efeito extra.
PUBLISH_CRON = "* * * * * /usr/local/sbin/k8snet-apply-node --publish >/dev/null 2>&1"
_cron = subprocess.run(["crontab", "-l"], capture_output=True, text=True).stdout
_lines = [l for l in _cron.splitlines() if l.strip()]
if PUBLISH_CRON not in _lines:
    _lines.append(PUBLISH_CRON)
    subprocess.run(
        ["crontab", "-"],
        input=chr(10).join(_lines) + chr(10),
        text=True,
        check=True,
    )
    print("[ok] cron k8snet snapshot instalado (1 min)")
else:
    print("[skip] cron k8snet snapshot ja ativo")

# NodeK8sNet.pm e carregado pelo pvedaemon (via Nodes.pm) -> entra no
# calculo de freshness logo abaixo.
if os.path.exists(os.path.join(_HERE2, "nodek8snet.pm")):
    with open(os.path.join(_HERE2, "nodek8snet.pm"), encoding="utf-8") as f:
        src = f.read()
    _cur = open(NODEK8SNET_API, encoding="utf-8").read() if os.path.exists(NODEK8SNET_API) else None
    if _cur != src:
        with open(NODEK8SNET_API, "w", encoding="utf-8") as f:
            f.write(src)
        os.chmod(NODEK8SNET_API, 0o644)
        print(f"[ok] NodeK8sNet.pm instalado ({NODEK8SNET_API})")
    else:
        print("[skip] NodeK8sNet.pm ja atualizado")
else:
    print("[aviso] nodek8snet.pm nao encontrado ao lado do patch_ui.py")

# ---------- 2c) registrar as subclasses k8sapp + k8snet em Nodes.pm ----------
backup(NODES)
patch(
    NODES,
    """__PACKAGE__->register_method({
    subclass => "PVE::API2::LXC",
    path => 'lxc',
});
""",
    """__PACKAGE__->register_method({
    subclass => "PVE::API2::LXC",
    path => 'lxc',
});

__PACKAGE__->register_method({
    subclass => "PVE::API2::K8sApp", # POC k8s (k8s-poc)
    path => 'k8sapp',
});
""",
    "Nodeinfo.pm: subclass k8sapp",
    marker='subclass => "PVE::API2::K8sApp"',
)
# o bloco NodeK8sNet e ancorado no bloco K8sApp (que existe em instalacoes
# novas apos o patch acima e nas antigas da PoC anterior) -> nunca duplica
patch(
    NODES,
    """__PACKAGE__->register_method({
    subclass => "PVE::API2::K8sApp", # POC k8s (k8s-poc)
    path => 'k8sapp',
});
""",
    """__PACKAGE__->register_method({
    subclass => "PVE::API2::K8sApp", # POC k8s (k8s-poc)
    path => 'k8sapp',
});

__PACKAGE__->register_method({
    subclass => "PVE::API2::NodeK8sNet", # POC k8s (k8s-poc): rede k3s por no
    path => 'k8snet',
});
""",
    "Nodeinfo.pm: subclass k8snet",
    marker='subclass => "PVE::API2::NodeK8sNet"',
)
patch(
    NODES,
    "            { name => 'lxc' },\n",
    "            { name => 'k8snet' }, # POC k8s (k8s-poc)\n            { name => 'lxc' },\n",
    "Nodeinfo.pm: indice k8snet",
    marker="{ name => 'k8snet' },",
)
patch(
    NODES,
    "            { name => 'lxc' },\n",
    "            { name => 'k8sapp' }, # POC k8s (k8s-poc)\n            { name => 'lxc' },\n",
    "Nodeinfo.pm: indice k8sapp",
    marker="{ name => 'k8sapp' },",
)
patch(
    NODES,
    "use PVE::API2::LXC;\n",
    "use PVE::API2::K8sApp; # POC k8s (k8s-poc)\nuse PVE::API2::LXC;\n",
    "Nodeinfo.pm: use K8sApp",
    marker="use PVE::API2::K8sApp;",
)
patch(
    NODES,
    "use PVE::API2::K8sApp; # POC k8s (k8s-poc)\n",
    "use PVE::API2::K8sApp; # POC k8s (k8s-poc)\nuse PVE::API2::NodeK8sNet; # POC k8s (k8s-poc)\n",
    "Nodeinfo.pm: use NodeK8sNet",
    marker="use PVE::API2::NodeK8sNet;",
)


backup(JS)

tab = (
    "                {\n"
    "                    xtype: 'panel',\n"
    "                    title: gettext('Kubernetes'),\n"
    "                    iconCls: 'fa fa-ship',\n"
    "                    itemId: 'kubernetes',\n"
    "                    layout: 'fit',\n"
    "                    items: [\n"
    "                        {\n"
    "                            xtype: 'component',\n"
    "                            autoEl: {\n"
    "                                tag: 'iframe',\n"
    "                                src: '/pve2/js/k8s/index.html',\n"
    "                            },\n"
    "                        },\n"
    "                    ],\n"
    "                },\n"
)
anchor = (
    "                    onlineHelp: 'pve_service_daemons',\n"
    "                },\n"
    "                {\n"
    "                    xtype: 'proxmoxNodeNetworkView',\n"
)
replacement = (
    "                    onlineHelp: 'pve_service_daemons',\n"
    "                },\n"
    + tab +
    "                {\n"
    "                    xtype: 'proxmoxNodeNetworkView',\n"
)
patch(
    JS,
    anchor,
    replacement,
    "pvemanagerlib.js: aba Kubernetes",
    marker="itemId: 'kubernetes',",
)

# ---------- 3b) submenu Datacenter -> Kubernetes -> Network ----------
# Mesmo padrao do grupo SDN (header com itemId proprio + filhos com
# groups:[itemId]; ver PVE.panel.Config.insertNodes). O item "kubernetes" e
# o cabecalho/overview do submenu -- expansivel no futuro, bastando um novo
# item referenciar groups: ['kubernetes']; "kubernetesnetwork" e o unico
# filho por enquanto. Ancorado logo apos o ultimo item da familia SDN (ambos
# vivem dentro do mesmo "if (caps.dc['Sys.Audit'])"), sem duplicar o editor
# nativo do SDN: o card "Network" apenas LE /cluster/sdn (zones/vnets/
# subnets) para mapear interfaces, sem criar nem alterar objetos SDN.
dc_k8s_items = (
    "            // POC k8s (k8s-poc): submenu Kubernetes (Datacenter). A guarda\n"
    "            // evita quebrar TODO o painel do Datacenter se o app-browser.js\n"
    "            // estiver em cache antigo (classes ausentes).\n"
    "            if (Ext.ClassManager.get('PVE.k8s.NetworkPanel')) {\n"
    "                me.items.push(\n"
    "                    {\n"
    "                        xtype: 'pveK8sNetOverview',\n"
    "                        title: gettext('Kubernetes'),\n"
    "                        iconCls: 'fa fa-ship',\n"
    "                        itemId: 'kubernetes',\n"
    "                        expandedOnInit: true,\n"
    "                    },\n"
    "                    {\n"
    "                        xtype: 'pveK8sNetworkPanel',\n"
    "                        groups: ['kubernetes'],\n"
    "                        title: gettext('Network'),\n"
    "                        iconCls: 'fa fa-sitemap',\n"
    "                        itemId: 'kubernetesnetwork',\n"
    "                    },\n"
    "                );\n"
    "            }\n"
    "\n"
)
dc_anchor = (
    "                {\n"
    "                    xtype: 'pveSDNPrefixLists',\n"
    "                    groups: ['sdn'],\n"
    "                    // TRANSLATORS: Refers to an FRR prefix list, some\n"
    "                    // languages may prefer to keep \"prefix list\" as-is:\n"
    "                    // https://docs.frrouting.org/en/latest/filter.html#ip-prefix-list\n"
    "                    title: gettext('Prefix Lists'),\n"
    "                    hidden: true,\n"
    "                    iconCls: 'fa fa-list-ol',\n"
    "                    itemId: 'sdnprefixlists',\n"
    "                },\n"
    "            );\n"
    "\n"
    "            if (Proxmox.UserName === 'root@pam') {\n"
)
dc_replacement = (
    "                {\n"
    "                    xtype: 'pveSDNPrefixLists',\n"
    "                    groups: ['sdn'],\n"
    "                    // TRANSLATORS: Refers to an FRR prefix list, some\n"
    "                    // languages may prefer to keep \"prefix list\" as-is:\n"
    "                    // https://docs.frrouting.org/en/latest/filter.html#ip-prefix-list\n"
    "                    title: gettext('Prefix Lists'),\n"
    "                    hidden: true,\n"
    "                    iconCls: 'fa fa-list-ol',\n"
    "                    itemId: 'sdnprefixlists',\n"
    "                },\n"
    "            );\n"
    "\n"
    + dc_k8s_items
    + "            if (Proxmox.UserName === 'root@pam') {\n"
)
patch(
    JS,
    dc_anchor,
    dc_replacement,
    "pvemanagerlib.js: submenu Datacenter Kubernetes/Network",
    marker="itemId: 'kubernetesnetwork',",
)

patch(
    JS,
    "                    startOnlyServices: {\n"
    "                        pveproxy: true,\n"
    "                        pvedaemon: true,\n"
    "                        'pve-cluster': true,\n"
    "                    },",
    "                    startOnlyServices: {\n"
    "                        pveproxy: true,\n"
    "                        pvedaemon: true,\n"
    "                        'pve-cluster': true,\n"
    "                        k3s: true,\n"
    "                    },",
    "pvemanagerlib.js: startOnlyServices",
    marker="k3s: true,",
)

# icone + rotulo da pasta "Kubernetes Applications" (Folder View)
patch(
    JS,
    "            lxc: {\n"
    "                iconCls: 'fa fa-cube',\n"
    "                text: gettext('LXC Container'),\n"
    "            },",
    "            lxc: {\n"
    "                iconCls: 'fa fa-cube',\n"
    "                text: gettext('LXC Container'),\n"
    "            },\n"
    "            k8sapp: {\n"
    "                iconCls: 'fa fa-ship',\n"
    "                text: gettext('Kubernetes Applications'),\n"
    "            },",
    "pvemanagerlib.js: typeDefaults k8sapp",
    marker="text: gettext('Kubernetes Applications'),",
)

# ordem na arvore: depois das VMs (1), antes do no (2)
patch(
    JS,
    "            case 'sdn':\n                return 3;",
    "            case 'k8sapp':\n                return 1.5;\n"
    "            case 'sdn':\n                return 3;",
    "pvemanagerlib.js: getTypeOrder k8sapp",
)

# painel de detalhe ao clicar numa app
patch(
    JS,
    "                            lxc: 'pveLXCConfig',",
    "                            lxc: 'pveLXCConfig',\n"
    "                            k8sapp: 'pveK8sAppBrowser',",
    "pvemanagerlib.js: treeTypeToClass k8sapp",
)

# campo k8sapp no ResourceStore (modelo da arvore/grade)
patch(
    JS,
    "            hastate: {\n"
    "                header: gettext('HA State'),",
    "            k8sapp: {\n"
    "                header: gettext('Kubernetes App'),\n"
    "                type: 'string',\n"
    "                hidden: true,\n"
    "                sortable: true,\n"
    "                width: 110,\n"
    "            },\n"
    "            hastate: {\n"
    "                header: gettext('HA State'),",
    "pvemanagerlib.js: ResourceStore campo k8sapp",
    marker="header: gettext('Kubernetes App'),",
)

# ---------- 4) carregar o widget do painel de app (index.html.tpl) ----------
backup(TPL)
# A secao 5b cola "&amp;k8spoc=<hash>" no src dos dois scripts. Numa
# reexecucao esse sufixo quebra a ancora/marker abaixo (encontrada 0x) e o
# script ABORTA antes de regravar o token novo -> o navegador seguiria com o
# app-browser.js antigo em cache. Normaliza removendo tokens anteriores antes
# de reaplicar os patches; 5b recalcula o token do conteudo atual no final.
with open(TPL, encoding="utf-8") as f:
    _tpl_raw = f.read()
_tpl_clean = re.sub(r"&amp;k8spoc=[0-9a-f]+", "", _tpl_raw)
if _tpl_clean != _tpl_raw:
    with open(TPL, "w", encoding="utf-8") as f:
        f.write(_tpl_clean)
    print("[ok] index.html.tpl: token k8spoc anterior removido (idempotencia)")
patch(
    TPL,
    "    <script type=\"text/javascript\" src=\"/pve2/js/pvemanagerlib.js?ver=[% version %]\"></script>",
    "    <script type=\"text/javascript\" src=\"/pve2/js/pvemanagerlib.js?ver=[% version %]\"></script>\n"
    "    <script type=\"text/javascript\" src=\"/pve2/js/k8s/app-browser.js?ver=[% version %]\"></script>",
    "index.html.tpl: script app-browser.js",
)

# ---------- 5) registrar CmdMenu Kubernetes e roteamento do menu ----------
# O PVE.Utils.createCmdMenu e usado por todas as grids/tree views do PVE.
# Adicionamos o tipo k8sapp ao mesmo dispatcher, sem alterar os menus de VM/CT.
# A guarda Ext.ClassManager evita excecao quando o app-browser.js nao carregou
# (cache antigo, TPL sem o script): nesse caso o clique direito simplesmente
# nao abre menu, em vez de quebrar TODOS os menus de contexto.
backup(JS)
_GUARD_K8SMENU = "Ext.ClassManager.get('PVE.k8sapp.CmdMenu')"
_OLD_K8SMENU = (
    "            } else if (type === 'k8sapp') {\n"
    "                menu = Ext.create('PVE.k8sapp.CmdMenu', {\n"
    "                    pveSelNode: record,\n"
    "                });\n"
)
_NEW_K8SMENU = (
    "            } else if (type === 'k8sapp') {\n"
    "                // POC k8s (k8s-poc): so abre se o widget do plugin carregou;\n"
    "                // sem isso um JS ausente quebraria TODOS os menus de contexto.\n"
    "                if (" + _GUARD_K8SMENU + ") {\n"
    "                    menu = Ext.create('PVE.k8sapp.CmdMenu', {\n"
    "                        pveSelNode: record,\n"
    "                    });\n"
    "                } else {\n"
    "                    return undefined;\n"
    "                }\n"
)
with open(JS, encoding='utf-8') as f:
    _js = f.read()
if _GUARD_K8SMENU in _js:
    print('[skip] pvemanagerlib.js: guarda do CmdMenu k8sapp ja aplicada')
elif _OLD_K8SMENU in _js:
    # upgrade: instalacao anterior tem o bloco sem a guarda
    with open(JS, 'w', encoding='utf-8') as f:
        f.write(_js.replace(_OLD_K8SMENU, _NEW_K8SMENU, 1))
    print('[ok] pvemanagerlib.js: guarda do CmdMenu k8sapp aplicada (upgrade)')
else:
    # instalacao nova: insere antes do branch 'tag'
    patch(
        JS,
        "            } else if (type === 'tag') {\n                menu = Ext.create('PVE.dc.TagCmdMenu', {\n",
        _NEW_K8SMENU +
        "            } else if (type === 'tag') {\n                menu = Ext.create('PVE.dc.TagCmdMenu', {\n",
        'pvemanagerlib.js: dispatcher CmdMenu k8sapp',
        marker=_GUARD_K8SMENU,
    )

# ---------- 5b) cache-busting dos assets patchados ----------
# O PVE versiona os scripts com "?ver=[% version %]" (versao do PACOTE
# pve-manager). Nossos patches alteram pvemanagerlib.js e app-browser.js SEM
# mudar a versao do pacote -> o navegador continua servindo a copia antiga do
# cache e o menu de contexto k8sapp simplesmente nao existe na sessao do
# usuario (sintoma: "o menu nao abre", resolvido so com Ctrl+F5).
# Acrescentamos um token derivado do conteudo real dos dois arquivos: ele muda
# a cada patch, invalidando o cache automaticamente.
APP_BROWSER = "/usr/share/pve-manager/js/k8s/app-browser.js"


def _digest(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        h.update(fh.read())
    return h.hexdigest()


_parts = [_digest(JS)]
if os.path.exists(APP_BROWSER):
    _parts.append(_digest(APP_BROWSER))
CACHE_TOKEN = hashlib.sha256("".join(_parts).encode()).hexdigest()[:12]

with open(TPL, encoding="utf-8") as f:
    _tpl = f.read()
# "&amp;" e o correto dentro do atributo HTML; o navegador decodifica para "&".
_new_tpl = re.sub(
    r'(src="/pve2/js/(?:pvemanagerlib\.js|k8s/app-browser\.js)\?ver=\[% version %\])'
    r'(?:&amp;k8spoc=[0-9a-f]+)?"',
    r"\1&amp;k8spoc=" + CACHE_TOKEN + '"',
    _tpl,
)
if _new_tpl != _tpl:
    with open(TPL, "w", encoding="utf-8") as f:
        f.write(_new_tpl)
    print(f"[ok] index.html.tpl: cache-busting k8spoc={CACHE_TOKEN}")
else:
    print(f"[skip] index.html.tpl: cache-busting ja em k8spoc={CACHE_TOKEN}")

# ---------- 6) recarregar modulos Perl nos daemons ----------
# O pvedaemon carrega Services.pm/Cluster.pm UMA unica vez (modulo Perl em
# memoria + cache estatico), e o /cluster/resources (user=>'all') executa nos
# WORKERS do pveproxy (www-data), que tambem carregam Cluster.pm. Se qualquer
# um dos dois estava rodando antes do patch, a UI nao ve as mudancas ate o
# processo renascer. Detectamos pelo mtime e reiniciamos so se necessario
# (restart de pvedaemon/pveproxy nao afeta VMs/containers em execucao).


def _proc_start(pid: str) -> float:
    try:
        return os.stat(f"/proc/{pid}").st_mtime
    except OSError:
        return 0.0


newest_pm = max(
    os.path.getmtime(SERVICES),
    os.path.getmtime(CLUSTER),
    os.path.getmtime(NODES),
    os.path.getmtime(K8SAPP_API),
    os.path.getmtime(K8SNET_API) if os.path.exists(K8SNET_API) else 0.0,
    os.path.getmtime(NODEK8SNET_API) if os.path.exists(NODEK8SNET_API) else 0.0,
    os.path.getmtime(TPL),
)


def _maybe_restart(unit: str):
    pid = subprocess.run(
        ["systemctl", "show", "-p", "MainPID", "--value", unit],
        capture_output=True, text=True,
    ).stdout.strip()
    if pid.isdigit() and _proc_start(pid) < newest_pm:
        print(f"[fix] {unit} mais antigo que os .pm -> systemctl restart {unit}")
        subprocess.run(["systemctl", "restart", unit], check=True)
        print(f"[ok] {unit} reiniciado (modulos recarregados)")
    else:
        print(f"[skip] {unit} ja mais novo que os .pm")


_maybe_restart("pvedaemon")
_maybe_restart("pveproxy")

print("patch_ui: concluido")
