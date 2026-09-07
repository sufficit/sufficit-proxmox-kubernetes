const { test, expect } = require('@playwright/test');

const pveBase = (process.env.PVE_URL || 'https://pve.example.com:8006/').replace(/\/+$/, '');
const user = process.env.PVE_USER || 'root@pam';
const password = process.env.PVE_PASSWORD;

// Same login contract as context-menu.spec.js: POST /access/ticket (username+
// password only, so the realm comes from the userid), cookie in the jar and
// GuiCap seeded exactly like PVE.window.LoginWindow#success does.
async function login(page) {
  const resp = await page.request.post(`${pveBase}/api2/extjs/access/ticket`, {
    form: { username: user, password },
  });
  expect(resp.ok(), `ticket request for ${user} -> ${resp.status()}`).toBeTruthy();
  const body = await resp.json();
  expect(body?.data?.ticket, 'PVE ticket issued').toBeTruthy();

  await page.context().addCookies([{
    name: 'PVEAuthCookie',
    value: body.data.ticket,
    url: `${pveBase}/`,
  }]);
  await page.goto(`${pveBase}/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((cap) => {
    if (window.Ext && Ext.state && Ext.state.Manager) {
      Ext.state.Manager.set('GuiCap', cap);
    }
  }, body.data.cap);
  await expect(page.locator('body')).toContainText('Datacenter', { timeout: 30000 });
}

test.describe('Datacenter -> Kubernetes -> Network submenu', () => {
  test.skip(!password, 'Set PVE_PASSWORD to run the authenticated browser test');

  test('GET /cluster/k8snet/network serves config, sdn and conflicts', async ({ page }) => {
    await login(page);
    const resp = await page.request.get(`${pveBase}/api2/json/cluster/k8snet/network`);
    expect(resp.status(), 'k8snet network GET status').toBe(200);
    const body = await resp.json();
    const d = body?.data || {};
    expect(d.effective?.podcidr, 'effective pod CIDR').toMatch(/^\d+\.\d+\.\d+\.\d+\/\d+$/);
    expect(d.effective?.servicecidr, 'effective service CIDR').toMatch(/^\d+\.\d+\.\d+\.\d+\/\d+$/);
    expect(Array.isArray(d.interfaces), 'interfaces array').toBe(true);
    expect(Array.isArray(d.sdn?.vnets), 'sdn vnets array').toBe(true);
    expect(Array.isArray(d.conflicts), 'conflicts array').toBe(true);
    // multi-node aggregate
    expect(Array.isArray(d.nodes), 'per-node snapshots array').toBe(true);
    expect(d.nodes.length, 'at least the answering node reports').toBeGreaterThan(0);
    expect(d.nodes[0].node, 'node name').toBeTruthy();
    expect(d.nodes[0].podcidr, 'node podcidr').toMatch(/^\d+\.\d+\.\d+\.\d+\/\d+$/);
    expect(d.cluster?.nodes_total, 'cluster nodes_total').toBeGreaterThanOrEqual(1);
    expect(d.cluster?.nodes_reporting, 'cluster nodes_reporting').toBeGreaterThanOrEqual(1);
    expect(d.cluster?.consistent, 'no CIDR divergence in this PoC host').toBe(1);
  });

  test('Kubernetes submenu appears in the Datacenter tree and Network panel loads', async ({ page }) => {
    await login(page);

    // The patched PVE.dc.Config must contain the new submenu items. The
    // CmdMenu-style guard keeps older cached app-browser.js from breaking the
    // whole DC panel; here the classes are expected to exist.
    const present = await page.evaluate(() => {
      const cls = Ext.ClassManager.get('PVE.k8s.NetworkPanel');
      const dc = Ext.ComponentQuery.query('PVE.dc.Config')[0]
        // fallback: any Config panel whose savedItems know the submenu id
        || Ext.ComponentQuery.query('panel').find((p) => p.savedItems && p.savedItems.kubernetesnetwork);
      return {
        cls: !!cls,
        dcFound: !!dc,
        item: dc && dc.savedItems ? !!dc.savedItems.kubernetesnetwork : false,
      };
    });
    expect(present.cls, 'PVE.k8s.NetworkPanel class registered').toBe(true);

    // The DC config panel only exists in the workspace while the Datacenter
    // tree node is selected; driving the workspace selection proved flaky in
    // headless runs. Create the panel directly instead -- exactly the pattern
    // context-menu.spec.js uses for PVE.k8sapp.CmdMenu (hand-built pveSelNode,
    // real GuiCap already seeded by login()).
    const dcOpened = await page.evaluate(() => {
      if (!Ext.ClassManager.get('PVE.dc.Config')) {
        return { ok: false, reason: 'PVE.dc.Config class missing' };
      }
      const sel = new Ext.data.TreeModel({ data: { text: 'Datacenter', id: 'root' } });
      const dc = Ext.create('PVE.dc.Config', {
        pveSelNode: sel,
        renderTo: Ext.getBody(),
        width: 1280,
        height: 720,
      });
      window.__dcProbe = dc;
      return { ok: true, items: dc.savedItems ? Object.keys(dc.savedItems).length : 0 };
    });
    expect(dcOpened.ok, dcOpened.reason || 'DC config created').toBe(true);
    // The submenu must be registered inside the panel's treelist items.
    const hasSubmenu = await page.evaluate(() => {
      const dc = window.__dcProbe;
      return !!(dc && dc.savedItems && dc.savedItems.kubernetesnetwork && dc.savedItems.kubernetes);
    });
    expect(hasSubmenu, 'savedItems contain kubernetes + kubernetesnetwork').toBe(true);

    // Select the Kubernetes -> Network item through the public selectById
    // helper used by PVE's own automation.
    await page.evaluate(() => window.__dcProbe.selectById('kubernetesnetwork'));

    await page.waitForFunction(() => Ext.ComponentQuery.query('pveK8sNetworkPanel').length > 0,
      null, { timeout: 30000 });
    await page.waitForTimeout(1200); // first API load + grid render

    const state = await page.evaluate(() => {
      const p = Ext.ComponentQuery.query('pveK8sNetworkPanel')[0];
      if (!p) return { ok: false, reason: 'no panel' };
      const rows = p.summaryStore.getData().items.map((r) => r.data.key);
      const vnetRows = p.vnetStore.getCount();
      const ifaceRows = p.ifaceStore.getCount();
      const nodeRows = p.nodesStore ? p.nodesStore.getCount() : 0;
      const applyDisabled = p.down('#apply-btn')?.isDisabled();
      return {
        ok: true,
        rows,
        vnetRows,
        ifaceRows,
        nodeRows,
        applyDisabled,
        summaryPopulated: rows.some((k) => /Pod CIDR/.test(k)),
        clusterRowShown: rows.some((k) => /Cluster nodes/.test(k)),
      };
    });
    expect(state.ok, state.reason || 'panel queried').toBe(true);
    expect(state.summaryPopulated, 'summary store filled with Pod CIDR row').toBe(true);
    expect(state.ifaceRows, 'node interfaces listed').toBeGreaterThan(0);
    expect(state.nodeRows, 'per-node grid has the answering node').toBeGreaterThan(0);
    expect(state.clusterRowShown, 'summary shows cluster coverage row').toBe(true);
    expect(state.applyDisabled, 'apply button enabled after load').toBe(false);
    console.log('DC-NETWORK:', JSON.stringify(state));
  });
});
