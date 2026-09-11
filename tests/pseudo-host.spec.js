const { test, expect } = require('@playwright/test');

const pveBase = (process.env.PVE_URL || 'https://pve.example.com:8006/').replace(/\/+$/, '');
// nó PVE alvo (no publicador do status.json): pve01, pve02, ...
const host = process.env.PVE_HOST || 'pve02';
const user = process.env.PVE_USER || 'root@pam';
const password = process.env.PVE_PASSWORD;

async function login(page) {
  const resp = await page.request.post(`${pveBase}/api2/extjs/access/ticket`, {
    form: { username: user, password },
  });
  expect(resp.ok()).toBeTruthy();
  const body = await resp.json();
  expect(body?.data?.ticket).toBeTruthy();
  await page.context().addCookies([{
    name: 'PVEAuthCookie', value: body.data.ticket, url: `${pveBase}/`,
  }]);
  await page.goto(`${pveBase}/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((cap) => {
    if (window.Ext && Ext.state && Ext.state.Manager) Ext.state.Manager.set('GuiCap', cap);
  }, body.data.cap);
  await expect(page.locator('body')).toContainText('Datacenter', { timeout: 30000 });
  await page.waitForFunction(
    () => typeof window.PVE !== 'undefined' &&
      typeof window.PVE.k8s?.ClusterBrowser !== 'undefined' &&
      typeof window.PVE.k8sapp?.CmdMenu !== 'undefined',
    null, { timeout: 30000 },
  );
  // Wait for the store to actually hold the k8sapp records (async poll).
  await page.waitForFunction(
    () => PVE.data.ResourceStore.getData().items.some((r) => r.data.type === 'k8sapp'),
    null, { timeout: 30000 },
  );
}

test.describe('Kubernetes pseudo-host grouping', () => {
  test.skip(!password, 'Set PVE_PASSWORD to run');

  test('all k8sapp records are grouped under the Kubernetes pseudo-host', async ({ page }) => {
    await login(page);
    const check = await page.evaluate(() => {
      const recs = PVE.data.ResourceStore.getData().items
        .filter((r) => r.data.type === 'k8sapp');
      return {
        total: recs.length,
        allPseudo: recs.every((r) => r.data.node === 'Kubernetes'),
        k8snodes: [...new Set(recs.map((r) => r.data.k8snode).filter(Boolean))],
      };
    });
    expect(check.total).toBeGreaterThan(0);
    expect(check.allPseudo, 'every record groups under node=Kubernetes').toBe(true);
    expect(check.k8snodes.length, 'k8snode carries the real API node').toBeGreaterThan(0);

    // The Server View tree must render the pseudo-host row itself.
    await page.evaluate(() => {
      const tree = Ext.ComponentQuery.query('pveResourceTree')[0];
      if (tree) tree.getRootNode().expandChildren?.(true);
    });
    const row = page.locator('.x-tree-node-text').filter({ hasText: /^Kubernetes$/ }).first();
    await expect(row).toBeVisible({ timeout: 30000 });
  });

  test('clicking the pseudo-host opens the cluster browser with all apps', async ({ page }) => {
    await login(page);
    await page.evaluate(() => {
      const tree = Ext.ComponentQuery.query('pveResourceTree')[0];
      if (tree) tree.getRootNode().expandChildren?.(true);
    });
    const row = page.locator('.x-tree-node-text').filter({ hasText: /^Kubernetes$/ }).first();
    await expect(row).toBeVisible({ timeout: 30000 });
    await row.click();

    await expect(page.locator('body')).toContainText('Kubernetes Cluster', { timeout: 30000 });
    // Summary is fed by status.json (the publishing node) ...
    await expect(page.locator('body')).toContainText(host, { timeout: 30000 });
    // ... and the Applications grid lists every app from apps.json. The
    // Config panel creates cards lazily: activate the tab before reading.
    // PVE.panel.Config renders tabs as a side treelist (same as the guest
    // panels), not as a tab bar.
    const appsTab = page.locator('.x-treelist-item-text').filter({ hasText: 'Applications' }).first();
    await appsTab.click();
    // The Applications grid loads apps.json through a store proxy: the
    // component can exist while the request is still in flight (store at 0),
    // which is common from high-latency runners. Wait for data, not just
    // for the component.
    await page.waitForFunction(
      () => {
        const grid = Ext.ComponentQuery.query('pveK8sClusterBrowser #apps')[0];
        return grid && grid.getStore().getCount() > 0;
      },
      null, { timeout: 30000 },
    );
    const apps = await page.evaluate(() => {
      const grid = Ext.ComponentQuery.query('pveK8sClusterBrowser #apps')[0];
      return grid ? grid.getStore().getCount() : -1;
    });
    expect(apps).toBeGreaterThan(0);
  });

  test('pseudo-host gets no PVE node context menu', async ({ page }) => {
    await login(page);
    await page.evaluate(() => {
      const tree = Ext.ComponentQuery.query('pveResourceTree')[0];
      if (tree) tree.getRootNode().expandChildren?.(true);
    });
    const row = page.locator('.x-tree-node-text').filter({ hasText: /^Kubernetes$/ }).first();
    await expect(row).toBeVisible({ timeout: 30000 });
    await row.click({ button: 'right' });
    await page.waitForTimeout(1200);
    const bad = page.locator('.x-menu:visible', { hasText: /Shutdown|Reboot|Shell/ });
    await expect(bad).toHaveCount(0);
  });

  test('app panel still resolves the real API node', async ({ page }) => {
    await login(page);
    const target = await page.evaluate(() => {
      const rec = PVE.data.ResourceStore.getData().items
        .find((r) => r.data.type === 'k8sapp');
      return rec ? rec.data : null;
    });
    expect(target).toBeTruthy();
    await page.evaluate((id) => {
      const tree = Ext.ComponentQuery.query('pveResourceTree')[0];
      tree.selectById(id);
    }, target.id);
    await expect(page.locator('body'))
      .toContainText(`on node '${target.k8snode}'`, { timeout: 30000 });
  });
});
