const { test, expect } = require('@playwright/test');

const pveBase = (process.env.PVE_URL || 'https://pve.example.com:8006/').replace(/\/+$/, '');
const user = process.env.PVE_USER || 'root@pam';
const password = process.env.PVE_PASSWORD;

// Same login helper contract as context-menu.spec.js (see its comment block).
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

  await expect.poll(
    () => page.evaluate(() => (
      PVE.data.ResourceStore.getData().items.filter((r) => r.data.type === 'k8sapp').length
    )),
    { timeout: 30000, message: 'k8sapp records in ResourceStore' },
  ).toBeGreaterThan(0);

  await page.evaluate(() => {
    const tree = Ext.ComponentQuery.query('pveResourceTree')[0];
    if (tree) tree.getRootNode().expandChildren?.(true);
  });
  return { csrf: body.data.CSRFPreventionToken };
}

// Layout + data state of the Summary card, read through the live Ext components
// so the check works for any viewport and matches what the user actually sees.
async function summaryMetrics(page) {
  return page.evaluate(() => {
    const b = Ext.ComponentQuery.query('pveK8sAppBrowser')[0];
    if (!b) return { ok: false, reason: 'no pveK8sAppBrowser' };
    const summary = b.down('#summary');
    if (!summary) return { ok: false, reason: 'no #summary card' };
    const ic = summary.down('#itemcontainer');
    const charts = summary.query('proxmoxRRDChart').map((c) => ({
      title: typeof c.title === 'string' ? c.title : '',
      w: c.el ? c.getWidth() : 0,
      h: c.el ? c.getHeight() : 0,
    }));
    const status = summary.down('#gueststatus #status');
    const node = summary.down('#gueststatus #node');
    return {
      ok: true,
      summaryW: summary.el ? summary.getWidth() : 0,
      icW: ic && ic.el ? ic.getWidth() : 0,
      icOldFactor: ic ? ic.oldFactor : undefined,
      colWidths: ic ? ic.items.items.map((i) => i.columnWidth) : [],
      statusText: status && status.el ? status.el.dom.innerText.trim() : '',
      nodeText: node && node.el ? node.el.dom.innerText.trim() : '',
      charts,
    };
  });
}

test.describe('Kubernetes application Summary reactivation', () => {
  test.skip(!password, 'Set PVE_PASSWORD to run the authenticated browser test');

  test('Summary renders intact and populated after visiting another tab', async ({ page }) => {
    await login(page);

    const apps = await page.evaluate(() => (
      PVE.data.ResourceStore.getData().items
        .filter((r) => r.data.type === 'k8sapp')
        .map((r) => r.data.name)
    ));
    expect(apps.length).toBeGreaterThan(0);

    const treeNode = page.locator('.x-tree-node-text', { hasText: apps[0] }).first();
    await expect(treeNode).toBeVisible({ timeout: 30000 });
    await treeNode.click();

    await page.waitForFunction(
      () => Ext.ComponentQuery.query('pveK8sAppBrowser').length > 0,
      null,
      { timeout: 30000 },
    );
    await page.waitForTimeout(800); // first layout + charts

    const before = await summaryMetrics(page);
    expect(before.ok, before.reason || 'summary present').toBe(true);
    test.info().annotations.push({ type: 'before', description: JSON.stringify(before) });

    // Leave Summary: PVE.panel.Config destroys the card on tab switch.
    await page.locator('.x-treelist-item-text').filter({ hasText: 'Console' }).first().click();
    await page.waitForFunction(() => {
      const b = Ext.ComponentQuery.query('pveK8sAppBrowser')[0];
      return b && !b.down('#summary');
    }, null, { timeout: 30000 });

    // Come back: the Summary card is a BRAND NEW component instance now.
    await page.locator('.x-treelist-item-text').filter({ hasText: 'Summary' }).first().click();
    await page.waitForFunction(() => {
      const b = Ext.ComponentQuery.query('pveK8sAppBrowser')[0];
      return b && !!b.down('#summary');
    }, null, { timeout: 30000 });
    await page.waitForTimeout(800);

    const after = await summaryMetrics(page);
    test.info().annotations.push({ type: 'after', description: JSON.stringify(after) });
    console.log('SUMMARY BEFORE:', JSON.stringify(before));
    console.log('SUMMARY AFTER :', JSON.stringify(after));

    // Layout intact: same column plan, container width restored, no slivers.
    expect(after.charts.length, 'both RRD charts re-created').toBe(before.charts.length);
    for (const c of after.charts) {
      expect(c.w, `${c.title} width`).toBeGreaterThan(200);
      expect(c.h, `${c.title} height`).toBeGreaterThan(150);
    }
    expect(Math.abs(after.icW - before.icW), 'itemcontainer width unchanged')
      .toBeLessThanOrEqual(2);
    // The user-visible symptom: charts squeezed to their declared
    // columnWidth:0.5 instead of the normalized full column. They must span
    // the container exactly like on the first mount.
    for (const c of after.charts) {
      expect(c.w, `${c.title} spans the summary column`).toBeGreaterThanOrEqual(after.icW - 12);
    }
    expect(after.colWidths.filter((w) => w === null || w === undefined).length,
      'every visible column child has a columnWidth').toBeLessThanOrEqual(1);

    // Data intact: the StatusView must show real values, not placeholders —
    // this is the "broken until you switch apps and back" symptom.
    expect(after.statusText.toLowerCase(), 'status widget populated')
      .toMatch(/running|degraded|ok|stopped/);
    expect(after.nodeText, 'node widget populated').not.toContain('—');
  });
});
