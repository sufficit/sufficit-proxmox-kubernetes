Ext.define('PVE.k8s.NetworkApplyWindow', {
    extend: 'Ext.window.Window',
    alias: 'widget.pveK8sNetworkApplyWindow',

    title: gettext('Apply Kubernetes network settings'),
    modal: true,
    width: 460,
    layout: 'anchor',
    bodyPadding: 10,

    initComponent: function () {
        let me = this;
        me.form = Ext.create('Ext.form.Panel', {
            border: false,
            layout: 'anchor',
            defaults: { anchor: '100%', labelWidth: 140 },
            items: [
                {
                    xtype: 'proxmoxtextfield',
                    name: 'cluster-cidr',
                    fieldLabel: gettext('Pod CIDR'),
                    emptyText: '10.42.0.0/16',
                    regex: /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/,
                    allowBlank: true,
                },
                {
                    xtype: 'proxmoxtextfield',
                    name: 'service-cidr',
                    fieldLabel: gettext('Service CIDR'),
                    emptyText: '10.43.0.0/16',
                    regex: /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/,
                    allowBlank: true,
                },
                {
                    xtype: 'proxmoxtextfield',
                    name: 'flannel-iface',
                    fieldLabel: gettext('Flannel interface'),
                    emptyText: gettext('auto-detect'),
                    allowBlank: true,
                },
                {
                    xtype: 'proxmoxtextfield',
                    name: 'node-ip',
                    fieldLabel: gettext('Node IP'),
                    emptyText: gettext('auto-detect'),
                    regex: /^\d{1,3}(\.\d{1,3}){3}$/,
                    allowBlank: true,
                },
                {
                    xtype: 'proxmoxcheckbox',
                    name: 'restart',
                    fieldLabel: gettext('Restart k3s'),
                    checked: true,
                    boxLabel: gettext('restarts the service and validates Ready state'),
                },
                {
                    xtype: 'proxmoxtextfield',
                    name: 'nodes',
                    fieldLabel: gettext('Target nodes'),
                    emptyText: gettext('all cluster nodes (comma-separated to restrict)'),
                    allowBlank: true,
                },
            ],
        });

        Ext.apply(me, {
            items: [me.form],
            buttons: [
                {
                    text: gettext('Cancel'),
                    handler: () => me.close(),
                },
                {
                    text: gettext('Apply'),
                    iconCls: 'fa fa-check-circle',
                    formBind: true,
                    handler: () => me.apply(),
                },
            ],
        });
        me.callParent();
    },

    apply: function () {
        let me = this;
        let values = me.form.getValues();
        let params = {};
        ['cluster-cidr', 'service-cidr', 'flannel-iface', 'node-ip'].forEach(k => {
            if (values[k]) params[k] = values[k];
        });
        params.restart = values.restart ? 1 : 0;
        if (values.nodes) params.nodes = values.nodes;
        if (!Object.keys(params).some(k => k !== 'restart')) {
            Ext.Msg.alert(gettext('Error'), gettext('No network setting supplied'));
            return;
        }
        Proxmox.Utils.API2Request({
            url: '/cluster/k8snet/network',
            method: 'PUT',
            params,
            waitMsgTarget: me,
            failure: response => Ext.Msg.alert(gettext('Error'), response.htmlStatus),
            success: response => {
                me.close();
                let upid = response.result.data;
                Ext.create('Proxmox.window.TaskProgress', {
                    upid,
                    // the panel (not this window) owns the reload; fire the
                    // event when the task finishes so the data is fresh.
                    taskDone: () => me.fireEvent('applied', me),
                }).show();
            },
        });
    },
});

Ext.define('PVE.k8s.NetOverview', {
    extend: 'Ext.panel.Panel',
    alias: 'widget.pveK8sNetOverview',

    layout: 'fit',
    bodyPadding: 24,
    html: `<div style="max-width:760px">
        <h2>${gettext('Kubernetes network')}</h2>
        <p>${gettext('This submenu is the home for Kubernetes network integrations.')}</p>
        <p>${gettext('Choose Network to inspect the k3s CIDRs, node interfaces and the SDN VNets available on this node.')}</p>
        <p><i class="fa fa-info-circle"></i> ${gettext('SDN objects remain managed by the native Proxmox SDN screens. This view is read-only for SDN.')}</p>
    </div>`,
});

/*
 * Kubernetes network panel in Datacenter -> Kubernetes -> Network.
 */
Ext.define('PVE.k8s.NetworkPanel', {
    extend: 'Ext.panel.Panel',
    alias: 'widget.pveK8sNetworkPanel',

    layout: {
        type: 'vbox',
        align: 'stretch',
    },
    scrollable: true,
    bodyPadding: 10,

    initComponent: function () {
        let me = this;

        // ---- stores ----
        let ifaceStore = Ext.create('Ext.data.Store', {
            fields: ['name', 'ip', 'prefix'],
            data: [],
        });
        let vnetStore = Ext.create('Ext.data.Store', {
            fields: ['vnet', 'zone', 'zone_type', 'alias', 'applied', 'up', 'cidr', 'gateway', 'snat', 'dhcp-range'],
            data: [],
        });
        let conflictStore = Ext.create('Ext.data.Store', {
            fields: ['cidr', 'kind', 'against', 'against_kind', 'detail'],
            data: [],
        });
        // um registro por no do cluster PVE (snapshot publicado no pmxcfs;
        // o no local vem sempre ao vivo)
        let nodesStore = Ext.create('Ext.data.Store', {
            fields: ['node', 'podcidr', 'servicecidr', 'flannel-iface', 'node-ip', 'conflicts', 'stale', 'live', 'age'],
            data: [],
        });

        me.ifaceStore = ifaceStore;
        me.vnetStore = vnetStore;
        me.conflictStore = conflictStore;
        me.nodesStore = nodesStore;

        // ---- resumo (store local: o payload e aninhado, o jsonobject reader
        // do Proxmox.data.ObjectStore so sabe achatar {chave: valor} plano) ----
        me.summaryStore = Ext.create('Ext.data.Store', {
            fields: ['key', 'value'],
            data: [],
        });

        let gridCfg = (store, columns, title, iconCls, emptyText) => ({
            xtype: 'grid',
            title: gettext(title),
            iconCls,
            store,
            emptyText: gettext(emptyText || 'No data'),
            margin: '0 0 10 0',
            columns,
            viewConfig: { stripeRows: true },
            collapsible: true,
            titleCollapse: true,
        });

        me.items = [
            {
                xtype: 'container',
                layout: 'hbox',
                margin: '0 0 10 0',
                items: [
                    {
                        xtype: 'grid',
                        title: gettext('Kubernetes Network'),
                        iconCls: 'fa fa-exchange',
                        flex: 1,
                        margin: '0 5 0 0',
                        hideHeaders: true,
                        minHeight: 180,
                        store: me.summaryStore,
                        columns: [
                            { text: gettext('Key'), dataIndex: 'key', width: 190 },
                            { text: gettext('Value'), dataIndex: 'value', flex: 1 },
                        ],
                        viewConfig: { stripeRows: true },
                    },
                    {
                        xtype: 'container',
                        width: 260,
                        margin: '0 0 0 5',
                        layout: 'vbox',
                        items: [
                            {
                                xtype: 'button',
                                text: gettext('Refresh'),
                                iconCls: 'fa fa-refresh',
                                width: '100%',
                                margin: '0 0 6 0',
                                handler: () => me.load(),
                            },
                            {
                                xtype: 'button',
                                itemId: 'apply-btn',
                                text: gettext('Apply network settings'),
                                iconCls: 'fa fa-check-circle',
                                width: '100%',
                                disabled: true,
                                margin: '0 0 6 0',
                                handler: () => me.openApplyWindow(),
                            },
                            {
                                xtype: 'component',
                                itemId: 'k8snet-note',
                                html: '',
                            },
                        ],
                    },
                ],
            },
            gridCfg(nodesStore, [
                { text: gettext('Node'), dataIndex: 'node', width: 130 },
                { text: gettext('Pod CIDR'), dataIndex: 'podcidr', width: 140 },
                { text: gettext('Service CIDR'), dataIndex: 'servicecidr', width: 140 },
                { text: gettext('Flannel iface'), dataIndex: 'flannel-iface', width: 110 },
                { text: gettext('Node IP'), dataIndex: 'node-ip', width: 130 },
                {
                    text: gettext('State'),
                    dataIndex: 'live',
                    width: 110,
                    renderer: (v, meta, rec) => {
                        if (rec.get('stale')) {
                            return `<span style="color:#d99b26">${gettext('stale')}</span>`;
                        }
                        return v
                            ? `<span style="color:#21a666">${gettext('live')}</span>`
                            : `<span style="color:#21a666">${gettext('published')}</span>`;
                    },
                },
                { text: gettext('Conflicts'), dataIndex: 'conflicts', width: 90 },
            ], 'Cluster nodes', 'fa fa-server'),
            gridCfg(conflictStore, [
                { text: gettext('K8s range'), dataIndex: 'cidr', width: 160 },
                { text: gettext('Type'), dataIndex: 'kind', width: 100 },
                { text: gettext('Conflicts with'), dataIndex: 'detail', flex: 1 },
            ], 'Range conflicts', 'fa fa-exclamation-triangle', gettext('No conflicts detected')),
            gridCfg(vnetStore, [
                { text: gettext('VNet'), dataIndex: 'vnet', width: 110 },
                { text: gettext('Zone'), dataIndex: 'zone', width: 100 },
                { text: gettext('Type'), dataIndex: 'zone_type', width: 90 },
                { text: gettext('CIDR'), dataIndex: 'cidr', width: 150 },
                { text: gettext('Gateway'), dataIndex: 'gateway', width: 120 },
                { text: gettext('SNAT'), dataIndex: 'snat', width: 70, renderer: v => v ? 'yes' : '' },
                { text: gettext('State'), dataIndex: 'up', width: 90, renderer: v => v ? 'up' : 'pending' },
                { text: gettext('Alias'), dataIndex: 'alias', flex: 1 },
            ], 'SDN Virtual Networks (read-only)', 'fa fa-network-wired'),
            gridCfg(ifaceStore, [
                { text: gettext('Interface'), dataIndex: 'name', width: 160 },
                { text: gettext('IPv4'), dataIndex: 'ip', width: 160 },
                { text: gettext('Prefix'), dataIndex: 'prefix', width: 90 },
            ], 'Node interfaces (read-only)', 'fa fa-ethernet'),
        ];

        me.callParent();
        me.on('activate', me.load, me);
    },

    load: function () {
        let me = this;
        Proxmox.Utils.API2Request({
            url: '/cluster/k8snet/network',
            method: 'GET',
            waitMsgTarget: me,
            failure: response => Ext.Msg.alert(gettext('Error'), response.htmlStatus),
            success: response => me.fill(response.result.data || {}),
        });
    },

    fill: function (data) {
        let me = this;
        let eff = data.effective || {};
        let declared = data.declared || {};
        let rows = [
            { key: gettext('Pod CIDR (effective)'), value: eff.podcidr || gettext('unknown') },
            { key: gettext('Service CIDR (effective)'), value: eff.servicecidr || gettext('unknown') },
            { key: gettext('Backend'), value: eff.backend || 'vxlan' },
            { key: gettext('Flannel interface'), value: eff['flannel-iface'] || '(auto)' },
            { key: gettext('Node IP'), value: eff['node-ip'] || '(auto)' },
            { key: gettext('Declared cluster-cidr'), value: declared['cluster-cidr'] || gettext('(default)') },
            { key: gettext('Declared service-cidr'), value: declared['service-cidr'] || gettext('(default)') },
            { key: gettext('Unit file'), value: data.unit || '' },
        ];
        if (data.cluster) {
            rows.push({
                key: gettext('Cluster nodes'),
                value: `${data.cluster.nodes_reporting || 0}/${data.cluster.nodes_total || 0}`
                    + (data.cluster.consistent ? ` (${gettext('consistent')})` : ` (${gettext('CIDR divergence')})`),
            });
        }
        me.summaryStore.setData(rows);

        me.nodesStore.loadData((data.nodes || []).map(n => ({
            node: n.node,
            podcidr: n.podcidr,
            servicecidr: n.servicecidr,
            'flannel-iface': n['flannel-iface'],
            'node-ip': n['node-ip'],
            conflicts: n.conflicts,
            stale: n.stale,
            live: n.live,
            age: n.age,
        })));

        me.conflictStore.loadData((data.conflicts || []).map(c => ({
            cidr: c.cidr, kind: c.kind, against: c.against,
            against_kind: c.against_kind, detail: c.detail,
        })));
        me.vnetStore.loadData((data.sdn?.vnets || []).map(v => ({
            vnet: v.vnet, zone: v.zone, zone_type: v.zone_type, alias: v.alias,
            applied: v.applied, up: v.up, cidr: v.cidr, gateway: v.gateway,
            snat: v.snat, 'dhcp-range': v['dhcp-range'],
        })));
        me.ifaceStore.loadData((data.interfaces || []).map(i => ({
            name: i.name, ip: i.ip, prefix: '/' + i.prefix,
        })));

        let conflicts = (data.conflicts || []).length;
        let note = me.down('#k8snet-note');
        note.setHtml(conflicts
            ? `<span style="color:#d99b26"><i class="fa fa-warning"></i> ${conflicts} conflict(s) found</span>`
            : '<span style="color:#21a666"><i class="fa fa-check"></i> no conflicts</span>');
        me.down('#apply-btn').setDisabled(false);
    },

    openApplyWindow: function () {
        let me = this;
        Ext.create('PVE.k8s.NetworkApplyWindow', {
            listeners: { applied: () => me.load() },
        }).show();
    },
});

/*
 * Kubernetes application detail panel.
 *
 * This intentionally follows PVE.lxc.Config + PVE.guest.Summary: the same
 * left navigation, Summary icon, StatusView/Notes composition, RRD selector,
 * charts and standard Proxmox grids. Kubernetes has no VMID, so the data is
 * read from the local, read-only K3s snapshot and its companion PVE API.
 */
/* Same shape as pve-rrd-guest, extended with replica/restart series that the
 * Kubernetes history collects (metrics-server has no per-pod network data). */
Ext.define('pve-rrd-k8sapp', {
    extend: 'Ext.data.Model',
    fields: [
        {
            name: 'cpu',
            convert: function (value) {
                return value == null ? null : value * 100;
            },
        },
        'maxcpu',
        { name: 'mem', defaultValue: null },
        'maxmem',
        'podsReady',
        'podsTotal',
        'restarts',
        'netin',
        'netout',
        { type: 'date', dateFormat: 'timestamp', name: 'time' },
    ],
});

Ext.define('PVE.k8s.NotesView', {
    extend: 'Proxmox.panel.NotesView',
    alias: 'widget.pveK8sNotesView',

    // The stock NotesView rejects a pveSelNode whose type is not node/qemu/lxc.
    // Keep its exact renderer/editor, but use the Kubernetes config endpoint.
    cbindData: function () {
        let me = this;
        me.pveType = '';
        me.load();
        return {};
    },
});

Ext.define('PVE.k8s.AppStatusView', {
    extend: 'Proxmox.panel.StatusView',
    alias: 'widget.pveK8sAppStatusView',

    layout: {
        type: 'vbox',
        align: 'stretch',
    },

    defaults: {
        xtype: 'pmxInfoWidget',
        padding: '2 25',
    },

    items: [
        {
            xtype: 'box',
            height: 20,
        },
        {
            itemId: 'status',
            title: gettext('Status'),
            iconCls: 'fa fa-info fa-fw',
            printBar: false,
            multiField: true,
            renderer: function (record) {
                let status = record.data.status || record.data.k8sstatus || 'unknown';
                let color = status === 'running' || status === 'ok' ? '#21a666' : '#d99b26';
                return `<span style="color:${color};font-weight:600">${Ext.htmlEncode(status)}</span>`;
            },
        },
        {
            itemId: 'ha',
            iconCls: 'fa fa-heartbeat fa-fw',
            title: gettext('HA State'),
            printBar: false,
            text: gettext('unmanaged'),
        },
        {
            itemId: 'node',
            iconCls: 'fa fa-building fa-fw',
            title: gettext('Node'),
            text: '—',
            printBar: false,
        },
        {
            itemId: 'namespace',
            iconCls: 'fa fa-sitemap fa-fw',
            title: gettext('Namespace'),
            textField: 'namespace',
            printBar: false,
        },
        {
            // Kubernetes workload type (Deployment/StatefulSet/DaemonSet/Pod).
            // It belongs here, next to Node/Namespace, exactly like the guest
            // StatusView keeps every identity field -- never as free text in
            // the Summary column, which would inherit minHeight:360 and open a
            // blank band between the status/notes row and the charts.
            itemId: 'kind',
            iconCls: 'fa fa-ship fa-fw',
            title: gettext('Kind'),
            textField: 'kind',
            printBar: false,
        },
        {
            xtype: 'box',
            height: 10,
        },
        {
            itemId: 'cpu',
            iconCls: 'fa fa-fw pmx-itype-icon-processor pmx-icon',
            title: gettext('CPU usage'),
            valueField: 'cpu',
            maxField: 'cpus',
            renderer: Proxmox.Utils.render_cpu_usage,
            calculate: Ext.identityFn,
        },
        {
            itemId: 'memory',
            iconCls: 'fa fa-fw pmx-itype-icon-memory pmx-icon',
            title: gettext('Memory usage'),
            valueField: 'mem',
            maxField: 'maxmem',
            renderer: Proxmox.Utils.render_size_usage,
            warningThreshold: 0.9,
            criticalThreshold: 0.975,
        },
        {
            itemId: 'replicas',
            iconCls: 'fa fa-cubes fa-fw',
            title: gettext('Replicas'),
            valueField: 'podsReady',
            maxField: 'podsTotal',
            renderer: function (used, max) {
                return `${used || 0}/${max || 0}`;
            },
            calculate: function (used, max) {
                return max > 0 ? used / max : 0;
            },
        },
        {
            itemId: 'restarts',
            iconCls: 'fa fa-refresh fa-fw',
            title: gettext('Restarts'),
            textField: 'restarts',
            printBar: false,
        },
        {
            xtype: 'box',
            height: 10,
        },
        {
            xtype: 'container',
            itemId: 'ipview',
            padding: '2 25',
            html: '<i class="fa fa-exchange fa-fw"></i> IPs <span class="right-aligned">—</span>',
        },
    ],

    updateTitle: function () {
        let me = this;
        let name = me.getRecordValue('name') || me.pveSelNode.data.name || '—';
        let ns = me.getRecordValue('namespace') || me.pveSelNode.data.namespace;
        let uptime = Number(me.getRecordValue('uptime'));
        let elapsed = uptime > 0
            ? ` (${gettext('Uptime')}: ${Proxmox.Utils.format_duration_long(uptime)})`
            : '';
        me.setTitle(`<div class="left-aligned">${Ext.htmlEncode(name)}${elapsed}</div>` +
            `<div class="right-aligned"><i class="fa fa-ship fa-fw"></i>&nbsp;` +
            `${Ext.htmlEncode(ns || 'Kubernetes')}</div>`);
    },
});

/* Lazily load the stock PVE xterm.js assets (pve-xtermjs package, served at
 * /xtermjs/ by pveproxy). Loaded only when a console is actually opened, so
 * the normal UI never pays for them. */
PVE.k8s.xtermPromise = null;
PVE.k8s._consoleSeq = 0;
PVE.k8s.loadXterm = function () {
    if (!PVE.k8s.xtermPromise) {
        PVE.k8s.xtermPromise = new Promise((resolve, reject) => {
            let loadScript = src => new Promise((res, rej) => {
                let s = document.createElement('script');
                s.src = src;
                s.onload = () => res();
                s.onerror = () => rej(new Error(`failed to load ${src}`));
                document.head.appendChild(s);
            });
            // Not fatal: our scoped .k8s-term-wrap rules already style the box.
            let link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = '/xtermjs/xterm.css';
            document.head.appendChild(link);
            loadScript('/xtermjs/xterm.js')
                .then(() => loadScript('/xtermjs/addon-fit.js'))
                .then(() => {
                    if (!window.Terminal || !(window.FitAddon && window.FitAddon.FitAddon)) {
                        throw new Error('xterm.js did not initialize');
                    }
                    resolve();
                })
                .catch(reject);
        });
    }
    return PVE.k8s.xtermPromise;
};

/* Console for a Kubernetes application: an interactive shell (xterm.js over
 * the native termproxy/vncwebsocket protocol) plus the read-only pod log
 * viewer, in the same tab. The backend command is ALWAYS `kubectl exec` in
 * the selected pod/container - the browser never gets a host shell. */
Ext.define('PVE.k8s.Console', {
    extend: 'Ext.panel.Panel',
    alias: 'widget.pveK8sConsole',

    layout: 'card',
    border: false,
    // 'shell' for the panel Console tab, 'logs' for the "Pod logs" window.
    defaultMode: 'shell',

    initComponent: function () {
        let me = this;
        me.podStore = Ext.create('Ext.data.Store', {
            fields: ['name', 'node', 'status'],
            data: [],
        });
        me.containerStore = Ext.create('Ext.data.Store', {
            fields: ['name'],
            data: [],
        });
        me.mode = me.defaultMode;
        // Unique per console instance: the panel tab and the "Pod logs" window
        // must not share a toggle group.
        let toggleGroup = `k8s-console-${++PVE.k8s._consoleSeq || (PVE.k8s._consoleSeq = 1)}`;

        Ext.apply(me, {
            activeItem: me.mode === 'logs' ? 1 : 0,
            tbar: [
                { xtype: 'tbtext', text: gettext('Pod') },
                {
                    xtype: 'combobox',
                    itemId: 'pod',
                    width: 250,
                    editable: false,
                    queryMode: 'local',
                    displayField: 'name',
                    valueField: 'name',
                    store: me.podStore,
                    listeners: { change: () => me.onSelectionChange() },
                },
                { xtype: 'tbtext', text: gettext('Container'), margin: '0 0 0 8' },
                {
                    xtype: 'combobox',
                    itemId: 'container',
                    width: 170,
                    editable: false,
                    queryMode: 'local',
                    displayField: 'name',
                    valueField: 'name',
                    store: me.containerStore,
                    listeners: { change: () => me.onSelectionChange() },
                },
                '-',
                // Classic-toolkit toggle buttons (segmentedbutton is a modern
                // toolkit widget): exactly two views of the same console.
                {
                    xtype: 'button',
                    itemId: 'mode-shell',
                    text: gettext('Shell'),
                    iconCls: 'fa fa-terminal',
                    enableToggle: true,
                    pressed: me.mode === 'shell',
                    toggleGroup,
                    listeners: { toggle: btn => { if (btn.pressed) me.setMode('shell'); } },
                },
                {
                    xtype: 'button',
                    itemId: 'mode-logs',
                    text: gettext('Logs'),
                    iconCls: 'fa fa-file-text-o',
                    enableToggle: true,
                    pressed: me.mode === 'logs',
                    toggleGroup,
                    listeners: { toggle: btn => { if (btn.pressed) me.setMode('logs'); } },
                },
                {
                    xtype: 'button',
                    itemId: 'action',
                    text: me.mode === 'logs' ? gettext('Refresh') : gettext('Connect'),
                    iconCls: me.mode === 'logs' ? 'fa fa-refresh' : 'fa fa-terminal',
                    handler: () => me.onAction(),
                },
                '->',
                {
                    xtype: 'tbtext',
                    itemId: 'status',
                    text: me.mode === 'shell'
                        ? gettext('Connect opens a shell inside the selected pod') : '',
                },
            ],
            items: [
                {
                    xtype: 'component',
                    itemId: 'shell',
                    cls: 'k8s-term-wrap',
                    autoEl: { tag: 'div' },
                    html: gettext('Click Connect to open a shell inside the selected pod.'),
                },
                {
                    xtype: 'component',
                    itemId: 'output',
                    autoEl: { tag: 'pre' },
                    padding: 8,
                    style: {
                        'font-family': 'monospace',
                        'white-space': 'pre-wrap',
                        'overflow': 'auto',
                    },
                    html: gettext('Select a pod to load its log.'),
                },
            ],
        });
        me.callParent();
        me.on('resize', () => me.scheduleFit());
        me.on('destroy', () => me.teardown());
    },

    setMode: function (mode) {
        let me = this;
        if (mode === me.mode && me.rendered) return;
        me.mode = mode;
        if (me.rendered) {
            me.getLayout().setActiveItem(mode === 'logs' ? me.down('#output') : me.down('#shell'));
        }
        let action = me.down('#action');
        if (mode === 'logs') {
            action.setText(gettext('Refresh'));
            action.setIconCls('fa fa-refresh');
            me.updateStatus('');
        } else {
            action.setText(me.isConnected() ? gettext('Disconnect') : gettext('Connect'));
            action.setIconCls('fa fa-terminal');
            me.updateStatus(me.isConnected()
                ? gettext('Connected')
                : gettext('Connect opens a shell inside the selected pod'));
            me.scheduleFit();
        }
    },

    onAction: function () {
        let me = this;
        if (me.mode === 'logs') {
            me.loadLogs();
        } else if (me.isConnected()) {
            me.disconnect();
        } else {
            me.connect();
        }
    },

    onSelectionChange: function () {
        let me = this;
        // The running shell belongs to the previous pod: drop it, exactly
        // like the stock console window closes when its guest changes.
        if (me.isConnected()) me.disconnect();
        if (me.mode === 'logs') me.loadLogs();
    },

    isConnected: function () {
        return !!(this.ws && this.ws.readyState === WebSocket.OPEN && this.connected);
    },

    updateStatus: function (text) {
        this.down('#status')?.setText?.(text);
    },

    setApp: function (app) {
        let me = this;
        me.app = app;
        me.podStore.loadData((app.pods || []).map(p => ({
            name: p.name, node: p.node, status: p.status,
        })));
        me.containerStore.loadData((app.containers || []).map(c => ({ name: c.name })));
        let pod = me.down('#pod');
        let container = me.down('#container');
        if (pod && me.podStore.getCount()) {
            let prev = pod.getValue();
            let keep = prev && me.podStore.findExact('name', prev) >= 0;
            pod.setValue(keep ? prev : me.podStore.first().get('name'));
        }
        if (container && me.containerStore.getCount()) {
            let prev = container.getValue();
            let keep = prev && me.containerStore.findExact('name', prev) >= 0;
            container.setValue(keep ? prev : me.containerStore.first().get('name'));
        }
        if (me.mode === 'logs') me.loadLogs();
    },

    loadLogs: function () {
        let me = this;
        if (!me.app) return;
        let pod = me.down('#pod')?.getValue();
        let container = me.down('#container')?.getValue();
        if (!pod) return;
        let output = me.down('#output');
        output.update(Ext.htmlEncode(gettext('Loading...')));
        let params = { pod };
        if (container) params.container = container;
        Proxmox.Utils.API2Request({
            url: `/nodes/${me.node}/k8sapp/${me.appid}/log`,
            method: 'GET',
            params,
            waitMsgTarget: me,
            failure: response => output.update(Ext.htmlEncode(response.htmlStatus || gettext('Error'))),
            success: response => {
                let lines = (response.result.data || []).map(line => line.t || '');
                output.update(Ext.htmlEncode(lines.join('\n')) || Ext.htmlEncode(gettext('No output')));
            },
        });
    },

    connect: function () {
        let me = this;
        let pod = me.down('#pod')?.getValue();
        if (!pod) {
            me.updateStatus(gettext('Select a pod'));
            return;
        }
        me.disconnect();
        me.updateStatus(gettext('Starting console proxy...'));
        let container = me.down('#container')?.getValue();
        let params = { pod };
        if (container) params.container = container;
        Proxmox.Utils.API2Request({
            url: `/nodes/${me.node}/k8sapp/${me.appid}/termproxy`,
            method: 'POST',
            params,
            waitMsgTarget: me,
            failure: response => me.terminalError(response.htmlStatus || gettext('Error')),
            success: response => {
                let info = response.result.data || {};
                if (!info.port || !info.ticket) {
                    me.terminalError(gettext('Console proxy returned no ticket'));
                    return;
                }
                PVE.k8s.loadXterm()
                    .then(() => me.createTerminal())
                    .then(() => me.openSocket(info))
                    .catch(err => me.terminalError(`${gettext('Error')}: ${err.message || err}`));
            },
        });
    },

    createTerminal: function () {
        let me = this;
        let host = me.down('#shell');
        if (!host || !host.el) {
            throw new Error('terminal container not rendered');
        }
        if (!me.term) {
            me.term = new window.Terminal({
                fontFamily: 'Consolas,"DejaVu Sans Mono","Liberation Mono",Courier,monospace',
                fontSize: 12,
                cursorBlink: true,
            });
            me.term.open(host.el.dom);
            // Remove the instructional HTML left by the Ext component before
            // xterm takes ownership of the terminal host element.
            host.el.dom.textContent = '';
            me.fit = new window.FitAddon.FitAddon();
            me.term.loadAddon(me.fit);
            me.term.onData(data => {
                if (me.isConnected()) {
                    // Same framing as the stock viewer: UTF-8 byte length.
                    let len = unescape(encodeURIComponent(data)).length;
                    me.ws.send(`0:${len}:${data}`);
                }
            });
            me.term.onResize(size => {
                if (me.isConnected()) me.ws.send(`1:${size.cols}:${size.rows}:`);
            });
            me.ping = setInterval(() => {
                if (me.isConnected()) me.ws.send('2');
            }, 30000);
        }
        me.term.reset();
        me.term.focus();
        me.scheduleFit();
    },

    openSocket: function (info) {
        let me = this;
        let proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
        let url = proto + location.host +
            `/api2/json/nodes/${me.node}/k8sapp/${me.appid}/vncwebsocket` +
            `?port=${encodeURIComponent(info.port)}` +
            `&vncticket=${encodeURIComponent(info.ticket)}`;
        let ws;
        try {
            ws = new WebSocket(url, 'binary');
        } catch (e) {
            me.terminalError(`${gettext('Error')}: ${e.message || e}`);
            return;
        }
        me.ws = ws;
        me.connected = false;
        ws.binaryType = 'arraybuffer';

        ws.onopen = () => {
            // Same handshake line the stock xterm.js viewer sends.
            ws.send(`${Proxmox.UserName}:${info.ticket}\n`);
        };
        ws.onmessage = event => {
            let data = new Uint8Array(event.data);
            if (!me.connected) {
                if (data[0] === 79 && data[1] === 75) { // "OK"
                    me.connected = true;
                    me.updateStatus(gettext('Connected'));
                    me.down('#action')?.setText(gettext('Disconnect'));
                    me.term?.write(data.slice(2));
                    me.term?.focus();
                    me.scheduleFit();
                } else {
                    ws.close();
                }
                return;
            }
            me.term?.write(data);
        };
        ws.onclose = () => {
            let was = me.connected;
            me.connected = false;
            me.updateStatus(was ? gettext('Connection closed') : gettext('Connection failed'));
            if (me.mode === 'shell') me.down('#action')?.setText(gettext('Connect'));
        };
        ws.onerror = () => { /* onclose follows */ };
        me.updateStatus(gettext('Connecting...'));
    },

    terminalError: function (message) {
        let me = this;
        let text = String(message).replace(/<[^>]+>/g, ' ');
        me.disconnect();
        me.updateStatus(text);
        if (me.term) {
            me.term.reset();
            me.term.write(`\x1b[31m${text}\x1b[0m\r\n`);
        } else {
            let host = me.down('#shell');
            host?.el?.dom && (host.el.dom.textContent = text);
        }
    },

    disconnect: function () {
        let me = this;
        me.connected = false;
        if (me.ws) {
            let ws = me.ws;
            me.ws = null;
            // close() synchronously emits onclose in some browsers. Clear
            // callbacks before closing because PVE.panel.Config may already
            // be destroying this card and its component tree.
            ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
            try { ws.close(); } catch (e) { /* already closed */ }
        }
        // Ext sets this.destroyed only AFTER the destroy event fires; during
        // the event this.destroying is true and the component tree may already
        // be torn down, so me.down() would throw and abort the tab transition
        // (leaving PVE.panel.Config's layout suspended -> broken Summary).
        if (!me.destroying && !me.destroyed && me.rendered && me.mode === 'shell') {
            me.down('#action')?.setText(gettext('Connect'));
        }
    },

    teardown: function () {
        let me = this;
        me.disconnect();
        clearTimeout(me._fitTimer);
        if (me.ping) {
            clearInterval(me.ping);
            me.ping = null;
        }
        if (me.term) {
            try { me.term.dispose(); } catch (e) { /* ignore */ }
            me.term = null;
        }
    },

    scheduleFit: function () {
        let me = this;
        if (!me.term || !me.fit || me.mode !== 'shell') return;
        clearTimeout(me._fitTimer);
        me._fitTimer = setTimeout(() => {
            try { me.fit.fit(); } catch (e) { /* not laid out yet */ }
        }, 100);
    },
});

/* Shared helpers for every Kubernetes action surface (tree context menu and
 * panel toolbar), mirroring how PVE.window.Migrate serves qemu+lxc. */
Ext.define('PVE.k8s.Util', {});

// Use the native Proxmox task descriptions in both Task History and the
// standard Task Viewer. The server returns a real UPID for every mutation.
Proxmox.Utils.override_task_descriptions({
    k8sscale: ['K8s', gettext('Scale')],
    k8sstart: ['K8s', gettext('Start')],
    k8sstop: ['K8s', gettext('Stop')],
    k8srestart: ['K8s', gettext('Restart')],
    k8srollback: ['K8s', gettext('Rollback')],
    k8spause: ['K8s', gettext('Pause rollout')],
    k8sresume: ['K8s', gettext('Resume rollout')],
    k8sdeletepod: ['K8s', gettext('Delete pod')],
    k8stermproxy: ['K8s', gettext('Console')],
});

// Fetch one application record from the UI snapshot (apps.json).
PVE.k8s.getApp = function (appid, callback) {
    Ext.Ajax.request({
        url: '/pve2/js/k8s/apps.json?_=' + Date.now(),
        method: 'GET',
        failure: () => callback(null),
        success: response => {
            let data = {};
            try { data = JSON.parse(response.responseText || '{}'); } catch (e) { /* keep {} */ }
            let app = (data.apps || []).find(a => `${a.namespace}:${a.name}` === appid);
            callback(app || null);
        },
    });
};

/* Pending-action state: after Start/Stop/Restart/... the tree icon must show
 * the activity in progress (spinner overlay, like PVE's lock icons) until the
 * resource store reflects the real state, then hand the icon back to the
 * standard running/stopped/degraded classes. Implemented here (not in
 * pvemanagerlib.js) by wrapping get_object_icon_class, which the ResourceTree
 * calls on every addChildSorted/updateTree. */
PVE.k8s.pending = {};
// The API address uses 'ns:name' (colon) while the tree record carries
// 'ns/name' (slash): normalize the key so both surfaces agree.
PVE.k8s.pendingKey = function (appid) {
    return String(appid).replace(':', '/');
};
// Even an instant convergence shows the spinner for a moment (visible
// feedback). Rolling actions are held longer on purpose: `rollout restart`
// returns immediately while pods replace in the background, and the local
// snapshot only refreshes once a minute -- 5s would lie about the activity.
PVE.k8s.PENDING_MIN_HOLD_MS_DEFAULT = 5000;
PVE.k8s.PENDING_MIN_HOLD_MS = { restart: 20000, rollback: 30000 };
PVE.k8s.PENDING_MAX_HOLD_MS = 8 * 60000;

// The tree state each action converges to. Cluster.pm maps apps.json
// 'ok'->'running' and 'stopped'->'stopped' for the resource store.
// Scale-to-zero (Scale window) converges to 'stopped' exactly like Stop.
PVE.k8s.pendingTarget = function (action, params) {
    if (action === 'stop') return 'stopped';
    if (action === 'scale' && Number(params?.replicas) === 0) return 'stopped';
    return 'running';
};

// Actions whose spinner should follow the REAL state transition: they only
// hand the icon back once the tree actually shows the target state. The rest
// (pause/resume/deletepod) do not change the tree status at all -- without
// this gate they would spin for the whole safety window for nothing.
PVE.k8s.PENDING_WAIT_STATUS = new Set(['start', 'stop', 'restart', 'rollback', 'scale']);

(function injectK8sCss() {
    // Our own keyframes: the vendored Font Awesome build does not expose
    // .fa-spin, and a <style> injected here ships cache-busted with this file
    // and needs no extra vendor patch. display:inline-block is required for
    // the transform to apply to the :after overlay glyph. !important because
    // the vendored .running:after has the same specificity and we must win.
    let css = [
        '@keyframes k8s-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }',
        '.x-tree-icon-custom.k8s-pending:after,',
        '.x-grid-icon-custom.k8s-pending:after {',
        '    content: "\\f110" !important;', // fa-spinner
        '    color: #cc8e00 !important;',
        '    font-size: 0.75em !important;',
        '    display: inline-block;',
        '    text-shadow: none;',
        '    animation: k8s-spin 1.1s linear infinite;',
        '}',
        // Same look as the stock xterm.js console window (pve-xtermjs/style.css),
        // but scoped to our panel so it never touches the rest of the UI.
        '.k8s-term-wrap { height: 100%; width: 100%; background: #101010; padding: 4px; color: #f0f0f0; }',
        '.k8s-term-wrap .terminal { height: 100%; background-color: #101010; color: #f0f0f0; }',
        '.k8s-term-wrap .xterm-rows > div > span { display: inline-block; }',
    ].join('\n');
    if (Ext.util.CSS?.createStyleSheet) {
        Ext.util.CSS.createStyleSheet(css, 'k8s-pending-css');
    } else {
        // Not every Ext build ships Ext.util.CSS; fall back to a plain tag.
        let style = document.createElement('style');
        style.id = 'k8s-pending-css';
        style.textContent = css;
        document.head.appendChild(style);
    }
})();

PVE.k8s.pendingMinHold = function (action) {
    return PVE.k8s.PENDING_MIN_HOLD_MS[action] ?? PVE.k8s.PENDING_MIN_HOLD_MS_DEFAULT;
};

let k8sStoreHooked = false;
PVE.k8s.refreshTreeIcons = function () {
    if (!k8sStoreHooked && PVE.data?.ResourceStore?.on) {
        k8sStoreHooked = true;
        // ResourceTree's own load handler runs first (it attached earlier);
        // defer so the nodes already carry the fresh status from the poll.
        PVE.data.ResourceStore.on('load', () => Ext.defer(PVE.k8s.refreshTreeIcons, 200));
    }
    let tree = Ext.ComponentQuery.query('pveResourceTree')[0];
    if (!tree) return;
    let now = Date.now();
    // leftover state for apps that left the tree entirely
    Object.keys(PVE.k8s.pending).forEach((key) => {
        if (now - PVE.k8s.pending[key].started > PVE.k8s.PENDING_MAX_HOLD_MS) {
            delete PVE.k8s.pending[key];
        }
    });
    tree.getRootNode().cascadeBy({
        before: function (node) {
            let d = node.data;
            if (d.type !== 'k8sapp' || !d.k8sapp) return true;
            let key = PVE.k8s.pendingKey(d.k8sapp);
            let pend = PVE.k8s.pending[key];
            if (pend) {
                let held = now - pend.started;
                let waits = PVE.k8s.PENDING_WAIT_STATUS.has(pend.action);
                let converged = waits
                    ? d.status === pend.target
                    : held >= PVE.k8s.pendingMinHold(pend.action);
                if (held > PVE.k8s.PENDING_MAX_HOLD_MS ||
                    (held >= PVE.k8s.pendingMinHold(pend.action) && converged)) {
                    // converged (or gave up): hand the icon back to the
                    // standard running/stopped/degraded classes right here.
                    delete PVE.k8s.pending[key];
                    pend = null;
                }
            }
            let cls = PVE.Utils.get_object_icon_class(d.type, d);
            if (cls && d.iconCls !== cls) {
                node.set('iconCls', cls);
                // node.set alone updates the model; refreshNode makes sure
                // the tree view repaints the icon cell for this row.
                tree.getView()?.refreshNode?.(node);
            }
            return true;
        },
    });
    // Self-managing ticker: while any action is pending, keep refreshing even
    // if the resource store is slow; stops itself once pending empties.
    if (Object.keys(PVE.k8s.pending).length) {
        if (!PVE.k8s._pendingTimer) {
            PVE.k8s._pendingTimer = setInterval(() => {
                if (!Object.keys(PVE.k8s.pending).length) {
                    clearInterval(PVE.k8s._pendingTimer);
                    PVE.k8s._pendingTimer = null;
                    return;
                }
                PVE.k8s.refreshTreeIcons();
            }, 1500);
        }
    }
};

PVE.k8s.setPending = function (appid, action, params) {
    let key = PVE.k8s.pendingKey(appid);
    if (action) {
        PVE.k8s.pending[key] = {
            action,
            started: Date.now(),
            target: PVE.k8s.pendingTarget(action, params),
        };
    } else {
        delete PVE.k8s.pending[key];
    }
    PVE.k8s.refreshTreeIcons();
};

(function wrapIconClass() {
    let orig = PVE.Utils.get_object_icon_class;
    PVE.Utils.get_object_icon_class = function (type, record) {
        let cls = orig.apply(this, arguments);
        if (cls && record && record.type === 'k8sapp' && record.k8sapp &&
            PVE.k8s.pending[PVE.k8s.pendingKey(record.k8sapp)]) {
            cls += ' k8s-pending';
        }
        return cls;
    };
})();

PVE.k8s.runAction = function (node, appid, action, params, name) {
    PVE.k8s.setPending(appid, action, params);
    Proxmox.Utils.API2Request({
        url: `/nodes/${node}/k8sapp/${appid}/${action}`,
        method: 'POST',
        params: params || {},
        failure: response => {
            PVE.k8s.setPending(appid, null);
            Ext.Msg.alert(gettext('Error'), response.htmlStatus);
        },
        success: response => {
            // The server returns the UPID of a real PVE task (fork_worker),
            // exactly like the guest Start/Stop buttons: follow it in the
            // standard task progress window. On success the pending spinner
            // is NOT dropped here -- refreshTreeIcons keeps it until the tree
            // reflects the target state (or the 8min safety net), exactly like
            // the pre-task behavior; on failure it goes away immediately.
            let upid = response.result.data;
            Ext.create('Proxmox.window.TaskProgress', {
                upid: upid,
                // TaskProgress already alerts on failure; here we only drop the
                // pending spinner (on success refreshTreeIcons keeps it until
                // the tree reflects the target state or the 8min safety net).
                taskDone: success => {
                    if (!success) PVE.k8s.setPending(appid, null);
                    PVE.data.ResourceStore.load();
                },
            }).show();
        },
    });
};

PVE.k8s.confirmAction = function (node, appid, action, params, message, name) {
    Ext.Msg.confirm(gettext('Confirm'),
        Ext.String.format(gettext('{0} application "{1}"?'), message, name || appid),
        btn => {
            if (btn === 'yes') PVE.k8s.runAction(node, appid, action, params, name);
        });
};

Ext.define('PVE.k8s.ScaleWindow', {
    extend: 'Ext.window.Window',
    alias: 'widget.pveK8sScaleWindow',

    modal: true,
    width: 380,
    title: gettext('Scale application'),
    bodyPadding: 10,
    layout: 'form',

    initComponent: function () {
        let me = this;
        me.items = {
            xtype: 'numberfield',
            itemId: 'replicas',
            fieldLabel: gettext('Replicas'),
            minValue: 0,
            maxValue: 1000,
            value: me.current ?? 1,
            allowBlank: false,
        };
        me.buttons = [
            {
                text: gettext('Scale'),
                handler: function () {
                    let win = this.up('window');
                    PVE.k8s.runAction(win.node, win.appid, 'scale',
                        { replicas: win.down('#replicas').getValue() }, win.appname);
                    win.close();
                },
            },
            { text: gettext('Cancel'), handler: 'close' },
        ];
        me.callParent();
        if (me.current === undefined || me.current === null) {
            PVE.k8s.getApp(me.appid, app => {
                let desired = (app?.replicas || {}).desired;
                if (desired !== undefined) me.down('#replicas').setValue(desired);
            });
        }
    },
});

Ext.define('PVE.k8s.PodWindow', {
    extend: 'Ext.window.Window',
    alias: 'widget.pveK8sPodWindow',

    modal: true,
    width: 520,
    title: gettext('Delete pod'),
    bodyPadding: 10,
    layout: 'form',

    initComponent: function () {
        let me = this;
        me.podStore = Ext.create('Ext.data.Store', {
            fields: ['name', 'status'],
            data: me.pods || [],
        });
        me.items = {
            xtype: 'combobox',
            itemId: 'pod',
            fieldLabel: gettext('Pod'),
            store: me.podStore,
            displayField: 'name',
            valueField: 'name',
            queryMode: 'local',
            editable: false,
            allowBlank: false,
            width: 420,
        };
        me.buttons = [
            {
                text: gettext('Delete'),
                iconCls: 'fa fa-trash-o',
                handler: function () {
                    let win = this.up('window');
                    let pod = win.down('#pod').getValue();
                    if (!pod) return;
                    PVE.k8s.confirmAction(win.node, win.appid, 'deletepod', { pod },
                        gettext('Delete pod from'), win.appname);
                    win.close();
                },
            },
            { text: gettext('Cancel'), handler: 'close' },
        ];
        me.callParent();
        if (me.podStore.getCount()) {
            me.down('#pod').setValue(me.podStore.first().get('name'));
        } else {
            PVE.k8s.getApp(me.appid, app => {
                me.podStore.loadData((app?.pods || []).map(p => ({ name: p.name, status: p.status })));
                if (me.podStore.getCount()) me.down('#pod').setValue(me.podStore.first().get('name'));
            });
        }
    },
});

/* Pod logs in a window: reuses the read-only console (pod/container pickers). */
Ext.define('PVE.k8s.LogsWindow', {
    extend: 'Ext.window.Window',
    alias: 'widget.pveK8sLogsWindow',

    modal: false,
    width: 860,
    height: 560,
    layout: 'fit',
    title: gettext('Pod logs'),
    defaultMode: 'logs',

    initComponent: function () {
        let me = this;
        me.items = {
            xtype: 'pveK8sConsole', itemId: 'console', node: me.node, appid: me.appid,
            defaultMode: me.defaultMode,
        };
        me.buttons = [{ text: gettext('Close'), handler: 'close' }];
        me.callParent();
        PVE.k8s.getApp(me.appid, app => {
            if (app) {
                me.down('#console').setApp(app);
            } else {
                me.down('#console').loadLogs();
            }
        });
    },
});

/* Interactive shell window: same console widget, shell view. Mirrors the
 * "Console" entry every guest context menu has. */
Ext.define('PVE.k8s.ConsoleWindow', {
    extend: 'Ext.window.Window',
    alias: 'widget.pveK8sConsoleWindow',

    modal: false,
    width: 900,
    height: 600,
    layout: 'fit',
    title: gettext('Console'),

    initComponent: function () {
        let me = this;
        me.items = {
            xtype: 'pveK8sConsole', itemId: 'console', node: me.node, appid: me.appid,
            defaultMode: 'shell',
        };
        me.buttons = [{ text: gettext('Close'), handler: 'close' }];
        me.callParent();
        PVE.k8s.getApp(me.appid, app => {
            if (app && !me.destroyed) me.down('#console').setApp(app);
        });
    },
});

/* Read-only kubectl output: describe / YAML / rollout status. */
Ext.define('PVE.k8s.OutputWindow', {
    extend: 'Ext.window.Window',
    alias: 'widget.pveK8sOutputWindow',

    modal: true,
    width: 900,
    height: 600,
    layout: 'fit',
    bodyPadding: 8,

    initComponent: function () {
        let me = this;
        me.items = {
            xtype: 'component',
            itemId: 'output',
            autoEl: { tag: 'pre' },
            autoScroll: true,
            style: { 'font-family': 'monospace', 'white-space': 'pre-wrap' },
            html: gettext('Loading...'),
        };
        me.buttons = [{ text: gettext('Close'), handler: 'close' }];
        me.callParent();
        Proxmox.Utils.API2Request({
            url: me.apiUrl,
            method: 'GET',
            params: me.params || {},
            failure: response =>
                me.down('#output').update(Ext.htmlEncode(response.htmlStatus || gettext('Error'))),
            success: response => {
                let d = response.result.data || {};
                let text = Ext.isArray(d)
                    ? d.map(line => line.t || '').join('\n')
                    : `${d.status || ''}\n${d.history || ''}`;
                me.down('#output').update(Ext.htmlEncode(text) || Ext.htmlEncode(gettext('No output')));
            },
        });
    },
});

/* Right-click menu for a k8sapp tree record. Mirrors PVE.lxc.CmdMenu: same
 * structure, separators and icon classes, with the Kubernetes equivalents of
 * the power actions (scale to zero = Stop, restore replicas = Start, rolling
 * restart = Reboot). Enabled/disabled state is refined asynchronously from
 * apps.json, exactly like lxc.CmdMenu does for the snapshot feature. */
Ext.define('PVE.k8sapp.CmdMenu', {
    extend: 'Ext.menu.Menu',

    showSeparator: false,

    initComponent: function () {
        let me = this;

        let info = me.pveSelNode.data;
        if (!info.node) {
            throw 'no node name specified';
        }
        let appid = (info.k8sapp || '').replace('/', ':');
        if (!appid) {
            throw 'no Kubernetes application specified';
        }
        let name = info.name || appid;

        let caps = Ext.state.Manager.get('GuiCap') || { nodes: {} };
        let modify = !!(caps.nodes && caps.nodes['Sys.Modify']);
        let audit = !!(caps.nodes && caps.nodes['Sys.Audit']);
        let consoleCap = !!(caps.nodes && caps.nodes['Sys.Console']);

        // The tree record only carries status; kind/replicas/pods come from
        // the snapshot asynchronously (menu opens right away, then refines).
        let stopped = info.status === 'stopped';

        let k8s_command = (action, message) =>
            message
                ? PVE.k8s.confirmAction(info.node, appid, action, {}, message, name)
                : PVE.k8s.runAction(info.node, appid, action, {}, name);
        let window_command = (winClass, cfg) =>
            Ext.create(winClass, Ext.apply({ node: info.node, appid, appname: name }, cfg)).show();

        me.title = `K8s ${name}`;

        me.items = [
            {
                itemId: 'start',
                text: gettext('Start'),
                iconCls: 'fa fa-fw fa-play',
                disabled: !modify || !stopped,
                tooltip: gettext('Restore the previous replica count'),
                handler: () => k8s_command('start'),
            },
            {
                itemId: 'stop',
                text: gettext('Stop'),
                iconCls: 'fa fa-fw fa-stop',
                disabled: !modify || stopped,
                tooltip: gettext('Scale the application to zero replicas'),
                handler: () => k8s_command('stop', gettext('Stop')),
            },
            {
                itemId: 'restart',
                text: gettext('Restart'),
                iconCls: 'fa fa-fw fa-refresh',
                disabled: !modify || stopped,
                tooltip: gettext('Rolling restart of all pods'),
                handler: () => k8s_command('restart', gettext('Restart')),
            },
            { xtype: 'menuseparator' },
            {
                itemId: 'scale',
                text: gettext('Scale replicas'),
                iconCls: 'fa fa-fw fa-arrows-v',
                disabled: !modify,
                handler: () => window_command('PVE.k8s.ScaleWindow'),
            },
            {
                itemId: 'rollback',
                text: gettext('Rollback'),
                iconCls: 'fa fa-fw fa-history',
                disabled: !modify,
                tooltip: gettext('Roll back to the previous revision'),
                handler: () => k8s_command('rollback', gettext('Roll back to the previous revision of')),
            },
            {
                itemId: 'pause',
                text: gettext('Pause rollout'),
                iconCls: 'fa fa-fw fa-pause',
                disabled: !modify,
                handler: () => k8s_command('pause'),
            },
            {
                itemId: 'resume',
                text: gettext('Resume rollout'),
                iconCls: 'fa fa-fw fa-play',
                disabled: !modify,
                handler: () => k8s_command('resume'),
            },
            { xtype: 'menuseparator' },
            {
                itemId: 'console',
                text: gettext('Console'),
                iconCls: 'fa fa-fw fa-terminal',
                disabled: !consoleCap,
                tooltip: gettext('Interactive shell inside the selected pod'),
                handler: () => window_command('PVE.k8s.ConsoleWindow'),
            },
            {
                itemId: 'logs',
                text: gettext('Pod logs'),
                iconCls: 'fa fa-fw fa-file-text-o',
                disabled: !consoleCap,
                handler: () => window_command('PVE.k8s.LogsWindow'),
            },
            {
                itemId: 'deletepod',
                text: gettext('Delete pod'),
                iconCls: 'fa fa-fw fa-trash-o',
                disabled: !modify,
                handler: () => window_command('PVE.k8s.PodWindow'),
            },
            {
                itemId: 'describe',
                text: gettext('Describe'),
                iconCls: 'fa fa-fw fa-file-text-o',
                disabled: !audit,
                handler: () => window_command('PVE.k8s.OutputWindow', {
                    title: gettext('Describe application'),
                    apiUrl: `/nodes/${info.node}/k8sapp/${appid}/describe`,
                    params: { format: 'describe' },
                }),
            },
            {
                itemId: 'yaml',
                text: gettext('View YAML'),
                iconCls: 'fa fa-fw fa-file-code-o',
                disabled: !audit,
                handler: () => window_command('PVE.k8s.OutputWindow', {
                    title: gettext('Application YAML'),
                    apiUrl: `/nodes/${info.node}/k8sapp/${appid}/describe`,
                    params: { format: 'yaml' },
                }),
            },
            {
                itemId: 'rollout',
                text: gettext('Rollout status'),
                iconCls: 'fa fa-fw fa-tasks',
                disabled: !audit,
                handler: () => window_command('PVE.k8s.OutputWindow', {
                    title: gettext('Rollout status'),
                    apiUrl: `/nodes/${info.node}/k8sapp/${appid}/rollout`,
                }),
            },
        ];

        me.callParent();

        // Refine the enable/disable state from the snapshot, like
        // PVE.lxc.CmdMenu does with the /feature endpoint. The rollout family
        // works on every controller kind; scale/start/stop need a scalable
        // kind (DaemonSet must run on every node).
        PVE.k8s.getApp(appid, app => {
            if (!app || me.destroyed) return;
            let scalable = app.kind === 'Deployment' || app.kind === 'StatefulSet';
            let controllable = scalable || app.kind === 'DaemonSet';
            let desired = (app.replicas || {}).desired;
            let stoppedNow = app.status === 'stopped' || (scalable && desired === 0);
            let set = (itemId, disabled) => me.down(itemId)?.setDisabled(disabled);
            if (me.destroyed) return;
            set('#start', !modify || !stoppedNow);
            set('#stop', !modify || stoppedNow);
            set('#restart', !modify || stoppedNow || !controllable);
            set('#scale', !modify || !scalable);
            set('#rollback', !modify || !controllable);
            set('#pause', !modify || !controllable || stoppedNow);
            set('#resume', !modify || !controllable);
            set('#deletepod', !modify || !(app.pods || []).length);
            set('#describe', !audit || !controllable);
            set('#yaml', !audit || !controllable);
            set('#rollout', !audit || !controllable);
            set('#console', !consoleCap || !(app.pods || []).length);
            set('#logs', !consoleCap || !(app.pods || []).length);
        });
    },
});

Ext.define('PVE.k8s.AppBrowser', {
    extend: 'PVE.panel.Config',
    alias: 'widget.pveK8sAppBrowser',

    onlineHelp: 'pve_service_daemons',
    userCls: 'proxmox-tags-full',

    setError: function (html) {
        let error = this.down('#k8s-error');
        if (error) {
            error.update(html || '');
            error.setVisible(!!html);
        }
    },

    buildActionsMenu: function (xy) {
        let me = this;
        // Same CmdMenu as the tree's right-click (PVE.k8sapp.CmdMenu).
        let menu = Ext.create('PVE.k8sapp.CmdMenu', { pveSelNode: me.pveSelNode });
        if (xy) menu.showAt(xy);
        return menu;
    },

    // PVE.panel.Config suspends this panel's layout while it destroys the
    // active card and creates the selected one (treelist selectionchange).
    // If anything throws inside that transition -- e.g. a destroy listener on
    // the old card touching its already torn-down component tree -- the base
    // handler never resumes the layout and every later card renders with
    // stale/natural sizes until the whole panel is reopened. Recover here:
    // always resume the layout and flush it, and never let a card's teardown
    // break the tab navigation.
    repairActiveCardLayout: function () {
        let me = this;
        if (me.destroyed || me.destroying) return;
        let card = me.getLayout().getActiveItem();
        let container = card && card.itemId === 'summary'
            ? card.down('#itemcontainer') : null;
        if (!container) return;

        let repair = function () {
            if (me.destroyed || me.destroying || container.destroyed) return;
            if (container.getWidth() <= 0) {
                container.on('boxready', repair, null, { single: true });
                return;
            }
            // The saved card config retains the chart columnWidth values
            // (0.5), while the original live card had them normalized by its
            // resize listener. Force the same normalization on every fresh
            // Summary instance, even when the factor is still 1.
            container.oldFactor = null;
            Proxmox.Utils.updateColumnWidth(container);
        };
        repair();
    },

    activateCard: function (cardid) {
        let me = this;
        try {
            me.callParent(arguments);
        } catch (e) {
            console.warn('k8s-ui: card switch failed, recovering layout', e);
        } finally {
            // PVE.panel.Config sets this while switching cards. A destroy
            // listener may run after the base method starts, so resume even
            // when that old card has already torn down its component tree.
            me.suspendLayout = false;
        }
        // Run after the outer selectionchange handler releases its own layout
        // suspension; otherwise Ext silently queues the column changes.
        Ext.defer(() => {
            if (me.destroyed || me.destroying) return;
            me.updateLayout();
            me.repairActiveCardLayout();
            // The re-created card holds fresh components: the shared
            // statusStore will not fire 'load' for the new StatusView and the
            // imperative widgets start at their placeholders.
            if (me.appData) {
                try { me.applyAppData(me.appData); } catch (e) { /* keep layout alive */ }
            }
            me.repairActiveCardLayout();
        }, 10);
    },

    actionToolbar: function () {
        let me = this;
        return Ext.create('Ext.button.Button', {
            text: gettext('Actions'),
            iconCls: 'fa fa-fw fa-bars',
            handler: button => {
                let xy = [button.getX() - 140, button.getY() + button.getHeight()];
                me.buildActionsMenu(xy);
            },
        });
    },

    staticAppId: function () {
        let value = this.pveSelNode.data.k8sapp ||
            `${this.pveSelNode.data.namespace || ''}/${this.pveSelNode.data.name || ''}`;
        return value.replace('/', ':');
    },

    recordData: function (app) {
        let d = app.replicas || {};
        return {
            name: app.name,
            kind: app.kind,
            namespace: app.namespace,
            node: app.node,
            k8sstatus: app.status,
            status: app.status === 'ok' ? 'running' : 'degraded',
            ha: 'unmanaged',
            cpus: app.cpus || 1,
            cpu: app.cpu || 0,
            mem: app.mem || 0,
            maxmem: app.maxmem || 0,
            podsReady: app.podsReady || d.ready || 0,
            podsTotal: d.desired || app.podsTotal || 0,
            restarts: app.restarts || 0,
            uptime: app.uptime || 0,
        };
    },

    applyAppData: function (app) {
        let me = this;
        me.setError('');
        me.appData = app;
        let data = me.recordData(app);

        // Feed the standard StatusView with KeyValue records, exactly as the
        // Proxmox ObjectStore does for a guest's status/current endpoint.
        me.statusStore.removeAll();
        Object.entries(data).forEach(([key, value]) => me.statusStore.add({ key, value }));
        // StatusView listens to the store's load event, as it does for a real
        // Proxmox.data.ObjectStore response.
        me.statusStore.fireEvent('load', me.statusStore, me.statusStore.getRange(), true);

        let status = me.down('#gueststatus');
        if (status) {
            status.down('#node')?.updateValue(app.node || '—');
            status.down('#ha')?.updateValue('unmanaged');
            status.down('#ipview')?.update(
                `<i class="fa fa-exchange fa-fw"></i> IPs ` +
                `<span class="right-aligned">${Ext.htmlEncode((app.pods || [])
                    .map(p => p.ip).filter(ip => ip && ip !== '—').join(', ') || '—')}</span>`,
            );
        }

        me.down('#pods')?.getStore().loadData(app.pods || []);
        me.down('#containers')?.getStore().loadData(app.containers || []);
        me.down('#network-grid')?.getStore().loadData((app.services || []).map(s => ({
            name: s.name, type: s.type, clusterIP: s.clusterIP,
            ports: s.ports, externalIPs: s.externalIPs,
        })));
        me.down('#events-grid')?.getStore().loadData(app.events || []);
        me.down('#images-grid')?.getStore().loadData((app.images || []).map(image => ({ image })));
        me.down('#volumes-grid')?.getStore().loadData(app.volumes || []);
        me.down('#dns-grid')?.getStore().loadData(Object.entries(app.dns || {}).map(([key, value]) => ({ key, value })));
        me.down('#options-grid')?.getStore().loadData(me.optionRows(app));

        // The Config panel creates cards lazily: feed the console now if it is
        // already mounted, otherwise keep the app pending for its activation.
        let consolePanel = me.down('#console');
        if (consolePanel && !consolePanel.podStore.getCount()) {
            consolePanel.setApp(app);
            me.pendingConsoleApp = null;
        } else if (!consolePanel) {
            me.pendingConsoleApp = app;
        }
        let updated = me.down('#k8s-updated');
        if (updated) updated.update(`${gettext('Updated')}: ${Ext.htmlEncode(me.generated || '—')}`);
    },

    optionRows: function (app) {
        let spec = app.spec || {};
        let rows = {
            strategy: spec.strategy,
            serviceAccount: spec.serviceAccount,
            restartPolicy: spec.restartPolicy,
            priorityClass: spec.priorityClass,
            nodeSelector: spec.nodeSelector,
            dnsPolicy: spec.dnsPolicy,
            hostNetwork: spec.hostNetwork ? gettext('Yes') : gettext('No'),
            revision: spec.revision || '—',
            generation: spec.generation || '—',
            creationTimestamp: spec.creationTimestamp || '—',
            labels: Object.entries(app.labels || {}).map(x => `${x[0]}=${x[1]}`).join(', ') || '—',
        };
        return Object.entries(rows).map(([key, value]) => ({ key, value }));
    },

    refresh: function () {
        this.loadStaticData();
    },

    loadStaticData: function (callback) {
        let me = this;
        let info = me.pveSelNode.data;
        Ext.Ajax.request({
            url: '/pve2/js/k8s/apps.json?_=' + Date.now(),
            method: 'GET',
            failure: function (rsp) {
                me.setError(`<span class="red">${gettext('Error')}: ` +
                    gettext('Unable to load Kubernetes application data') +
                    ` (HTTP ${rsp.status})</span>`);
                (callback || Ext.emptyFn)(null);
            },
            success: function (rsp) {
                let data;
                try { data = Ext.decode(rsp.responseText); } catch (e) { data = null; }
                let app = data && (data.apps || []).find(a => a.id === info.id);
                if (!app) {
                    me.setError(`<span class="red">${gettext('Error')}: ` +
                        gettext('Application not found') + '</span>');
                    (callback || Ext.emptyFn)(null);
                    return;
                }
                me.generated = data.generated;
                me.applyAppData(app);
                (callback || Ext.emptyFn)(app);
            },
        });
    },

    initComponent: function () {
        let me = this;
        let node = me.pveSelNode.data.node;
        let appid = me.staticAppId();
        // ':' is a valid path character (RFC 3986 pchar) and PVE routes like
        // {userid}/{id} already rely on it — no percent-encoding needed.
        let safeAppid = appid;

        // StatusView precisa de um ObjectStore (records key/value + getRecord()),
        // exatamente como o PVE.lxc.Config cria para o endpoint status/current.
        me.statusStore = Ext.create('Proxmox.data.ObjectStore', {
            model: 'KeyValue',
            proxy: { type: 'memory', reader: { type: 'json' } },
            data: [],
        });
        me.rrdstore = Ext.create('Proxmox.data.RRDStore', {
            rrdurl: `/api2/json/nodes/${node}/k8sapp/${safeAppid}/rrddata`,
            model: 'pve-rrd-k8sapp',
        });

        let podStore = Ext.create('Ext.data.Store', { fields: [
            'name', 'ready', 'status', 'restarts', 'age', 'node', 'ip', 'hostip', 'cpu', 'mem',
        ], data: [] });
        let containerStore = Ext.create('Ext.data.Store', { fields: [
            'name', 'image', 'state', 'ready', 'restarts', 'requests', 'limits',
        ], data: [] });
        let serviceStore = Ext.create('Ext.data.Store', { fields: [
            'name', 'type', 'clusterIP', 'ports', 'externalIPs',
        ], data: [] });
        let eventStore = Ext.create('Ext.data.Store', { fields: [
            'type', 'reason', 'message', 'count', 'age', 'kind', 'ts',
        ], data: [] });
        let imageStore = Ext.create('Ext.data.Store', { fields: ['image'], data: [] });
        let volumeStore = Ext.create('Ext.data.Store', { fields: ['name', 'kind', 'detail'], data: [] });
        let dnsStore = Ext.create('Ext.data.Store', { fields: ['key', 'value'], data: [] });
        let optionsStore = Ext.create('Ext.data.Store', { fields: ['key', 'value'], data: [] });

        let keyValueGrid = (itemId, title, iconCls, store, columns) => ({
            xtype: 'grid', itemId, title: gettext(title), iconCls, store,
            emptyText: gettext('No data'), columns, viewConfig: { stripeRows: true },
        });

        let summaryItems = [
            {
                xtype: 'container',
                height: 300,
                columnWidth: 1,
                layout: { type: 'hbox', align: 'stretch' },
                items: [
                    {
                        xtype: 'pveK8sAppStatusView', itemId: 'gueststatus',
                        pveSelNode: me.pveSelNode, rstore: me.statusStore,
                        flex: 1, padding: '0 5 0 0',
                    },
                    {
                        xtype: 'pveK8sNotesView', itemId: 'notesview',
                        pveSelNode: me.pveSelNode,
                        url: `/api2/extjs/nodes/${node}/k8sapp/${safeAppid}/config`,
                        // same cap the K8sApp.pm update_config enforces
                        maxLength: 8 * 1024,
                        enableTBar: true, flex: 1, padding: '0 0 0 5',
                    },
                ],
            },
            { xtype: 'component', itemId: 'k8s-error', columnWidth: 1, hidden: true },
            keyValueGrid('pods', 'Pods', 'fa fa-cubes', podStore, [
                { text: 'POD', dataIndex: 'name', flex: 1, renderer: v => `<code>${Ext.htmlEncode(v)}</code>` },
                { text: 'READY', dataIndex: 'ready', width: 70 },
                { text: 'STATUS', dataIndex: 'status', width: 110, renderer: v => {
                    let c = v === 'Running' ? '#21a666' : '#d99b26';
                    return `<span style="color:${c};font-weight:600">${Ext.htmlEncode(v)}</span>`;
                } },
                { text: 'RESTARTS', dataIndex: 'restarts', width: 90 },
                { text: 'AGE', dataIndex: 'age', width: 70 },
                { text: 'NODE', dataIndex: 'node', width: 100 },
            ]),
            {
                xtype: 'proxmoxRRDChart', title: gettext('CPU Usage'), columnWidth: 0.5,
                pveSelNode: me.pveSelNode, fields: ['cpu'],
                fieldTitles: [gettext('CPU usage')], unit: 'percent', store: me.rrdstore,
            },
            {
                xtype: 'proxmoxRRDChart', title: gettext('Memory Usage'), columnWidth: 0.5,
                pveSelNode: me.pveSelNode, fields: ['maxmem', 'mem'],
                fieldTitles: [gettext('Total'), gettext('Used')], colors: ['#94ae0a', '#115fa6'],
                unit: 'bytes', powerOfTwo: true, store: me.rrdstore,
            },
        ];

        let summary = {
            xtype: 'panel', itemId: 'summary', title: gettext('Summary'), iconCls: 'fa fa-book',
            scrollable: true, bodyPadding: 5,
            tbar: ['->', { xtype: 'proxmoxRRDTypeSelector' }],
            items: [{
                xtype: 'container', itemId: 'itemcontainer', layout: { type: 'column' },
                minWidth: 700, defaults: { minHeight: 360, padding: 5 }, items: summaryItems,
                listeners: { resize: container => Proxmox.Utils.updateColumns(container) },
            }],
        };

        let resources = {
            xtype: 'panel', itemId: 'resources', title: gettext('Resources'), iconCls: 'fa fa-cube',
            layout: 'fit', items: keyValueGrid('containers', 'Containers', 'fa fa-cube', containerStore, [
                { text: gettext('Name'), dataIndex: 'name', width: 180 },
                { text: gettext('Image'), dataIndex: 'image', flex: 1 },
                { text: gettext('State'), dataIndex: 'state', width: 100 },
                { text: gettext('Ready'), dataIndex: 'ready', width: 70, renderer: Proxmox.Utils.format_boolean },
                { text: gettext('Restarts'), dataIndex: 'restarts', width: 80 },
                { text: gettext('Requests'), dataIndex: 'requests', width: 150 },
                { text: gettext('Limits'), dataIndex: 'limits', width: 150 },
            ]),
        };

        let network = {
            xtype: 'panel', itemId: 'network', title: gettext('Network'), iconCls: 'fa fa-exchange',
            layout: 'fit', items: keyValueGrid('network-grid', 'Services', 'fa fa-exchange', serviceStore, [
                { text: gettext('Name'), dataIndex: 'name', width: 180 },
                { text: gettext('Type'), dataIndex: 'type', width: 120 },
                { text: gettext('Cluster IP'), dataIndex: 'clusterIP', width: 130 },
                { text: gettext('Ports'), dataIndex: 'ports', flex: 1 },
                { text: gettext('External IPs'), dataIndex: 'externalIPs', width: 150 },
            ]),
        };

        let dns = {
            xtype: 'panel', itemId: 'dns', title: gettext('DNS'), iconCls: 'fa fa-globe', layout: 'fit',
            items: {
                xtype: 'grid', itemId: 'dns-grid', hideHeaders: true, store: dnsStore,
                columns: [{ text: gettext('Name'), dataIndex: 'key', width: 200 },
                    { text: gettext('Value'), dataIndex: 'value', flex: 1 }],
            },
        };

        let options = {
            xtype: 'panel', itemId: 'options', title: gettext('Options'), iconCls: 'fa fa-gear', layout: 'fit',
            items: {
                xtype: 'grid', itemId: 'options-grid', hideHeaders: true, store: optionsStore,
                columns: [{ text: gettext('Name'), dataIndex: 'key', width: 240 },
                    { text: gettext('Value'), dataIndex: 'value', flex: 1 }],
            },
        };

        // Kubernetes events from the snapshot (kubectl get events), kept in a
        // dedicated tab; the task history moved to its own native grid below.
        let events = {
            xtype: 'panel', itemId: 'events', title: gettext('K8s Events'), iconCls: 'fa fa-exclamation',
            layout: 'fit', items: keyValueGrid('events-grid', 'Events', 'fa fa-list-alt', eventStore, [
                { text: gettext('Type'), dataIndex: 'type', width: 80 },
                { text: gettext('Reason'), dataIndex: 'reason', width: 170 },
                { text: gettext('Message'), dataIndex: 'message', flex: 1, renderer: v => Ext.htmlEncode(v || '') },
                { text: gettext('Count'), dataIndex: 'count', width: 70 },
                { text: gettext('Age'), dataIndex: 'age', width: 70 },
            ]),
        };

        // Task History scoped to THIS application. The native /nodes/.../tasks
        // endpoint only filters by VMID, so k8s tasks carry the app identity in
        // their UPID id and this dedicated endpoint returns exactly the PVE
        // tasks that belong to this app (Start/Stop/Scale/Restart/Rollback/
        // Pause/Resume/Delete pod). Same grid, model, columns and Task Viewer
        // as the node/guest panels -- only the rows change.
        // preFilter is the component's contract for fixed filters: source=all
        // is always sent and, unlike the guest panels, includes the task that
        // is still RUNNING right after the action starts.
        let tasks = {
            xtype: 'proxmoxNodeTasks', itemId: 'tasks', nodename: node,
            url: `/api2/json/nodes/${node}/k8sapp/${safeAppid}/tasks`,
            preFilter: { source: 'all' },
            title: gettext('Task History'), iconCls: 'fa fa-list-alt',
            stateful: false,
        };

        let consolePanel = {
            xtype: 'panel', itemId: 'consolejs', title: gettext('Console'), iconCls: 'fa fa-terminal', layout: 'fit',
            items: { xtype: 'pveK8sConsole', itemId: 'console', node, appid: safeAppid },
        };

        let images = {
            xtype: 'panel', itemId: 'images', title: gettext('Images'), iconCls: 'fa fa-picture-o', layout: 'fit',
            items: keyValueGrid('images-grid', 'Container Images', 'fa fa-picture-o', imageStore, [
                { text: gettext('Image'), dataIndex: 'image', flex: 1 },
            ]),
        };

        let volumes = {
            xtype: 'panel', itemId: 'volumes', title: gettext('Volumes'), iconCls: 'fa fa-database', layout: 'fit',
            items: keyValueGrid('volumes-grid', 'Volumes', 'fa fa-database', volumeStore, [
                { text: gettext('Name'), dataIndex: 'name', width: 220 },
                { text: gettext('Type'), dataIndex: 'kind', width: 170 },
                { text: gettext('Source'), dataIndex: 'detail', flex: 1 },
            ]),
        };

        Ext.apply(me, {
            title: Ext.String.format(gettext("Kubernetes Application {0} on node '{1}'"),
                me.pveSelNode.data.name || appid, node),
            hstateid: 'k8sapptab',
            tbarSpacing: false,
            tbar: [
                { xtype: 'button', text: gettext('Refresh'), iconCls: 'fa fa-refresh', handler: () => me.refresh() },
                me.actionToolbar(),
                '->', { xtype: 'component', itemId: 'k8s-updated', html: '' },
            ],
            defaults: { statusStore: me.statusStore },
            items: [summary, consolePanel, resources, network, dns, options, events, tasks, images, volumes],
        });

        me.callParent();
        me.rrdstore.startUpdate();
        me.on('destroy', me.rrdstore.stopUpdate, me.rrdstore);
        me.on('afterlayout', function () {
            let consolePanel = me.down('#console');
            if (consolePanel && me.pendingConsoleApp) {
                consolePanel.setApp(me.pendingConsoleApp);
                me.pendingConsoleApp = null;
            }
        }, me, { single: true });
        me.loadStaticData();
    },
});
