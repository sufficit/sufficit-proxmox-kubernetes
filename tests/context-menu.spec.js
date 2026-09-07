const { test, expect } = require('@playwright/test');

const pveBase = (process.env.PVE_URL || 'https://pve.example.com:8006/').replace(/\/+$/, '');
const user = process.env.PVE_USER || 'root@pam';
const password = process.env.PVE_PASSWORD;

const MENU_LABELS = [
  'Start', 'Stop', 'Restart', 'Scale replicas', 'Rollback',
  'Pause rollout', 'Resume rollout', 'Console', 'Pod logs', 'Delete pod',
  'Describe', 'View YAML', 'Rollout status',
];

/**
 * Authenticate through the same /access/ticket endpoint the login form uses.
 *
 * The GUI form additionally submits a `realm` parameter, which OVERRIDES the
 * realm encoded in the username (k8s-test@pve + realm=pam is tried as
 * k8s-test@pam and fails). Posting only username+password keeps the realm
 * from the userid and works for every realm.
 *
 * The ticket cookie is then placed in the browser-context jar explicitly:
 * Playwright's request fixture does not reliably apply the PVE Set-Cookie to
 * the shared jar, and an unauthenticated page load boots the login screen
 * instead of the workspace. GuiCap is seeded exactly like PVE's own login
 * success handler does (Ext.state.Manager.set('GuiCap', loginData.cap)).
 */
async function login(page) {
  const resp = await page.request.post(`${pveBase}/api2/extjs/access/ticket`, {
    form: { username: user, password },
  });
  expect(resp.ok(), `ticket request for ${user} -> ${resp.status()}`).toBeTruthy();
  const body = await resp.json();
  expect(body?.data?.ticket, `PVE ticket issued for ${user}`).toBeTruthy();
  expect(body.data.cap?.nodes, 'capabilities returned by the ticket').toBeTruthy();

  await page.context().addCookies([{
    name: 'PVEAuthCookie',
    value: body.data.ticket,
    url: `${pveBase}/`,
  }]);

  await page.goto(`${pveBase}/`, { waitUntil: 'domcontentloaded' });

  // Same call PVE.window.LoginWindow#success performs after a GUI login.
  await page.evaluate((cap) => {
    if (window.Ext && Ext.state && Ext.state.Manager) {
      Ext.state.Manager.set('GuiCap', cap);
    }
  }, body.data.cap);

  await expect(page.locator('body')).toContainText('Datacenter', { timeout: 30000 });

  // app-browser.js must have registered the plugin classes and the patched
  // pvemanagerlib.js must expose the k8sapp dispatcher branch.
  await page.waitForFunction(
    () => typeof window.PVE !== 'undefined' &&
      typeof window.PVE.Utils?.createCmdMenu === 'function' &&
      typeof window.PVE.k8sapp?.CmdMenu !== 'undefined',
    null,
    { timeout: 30000 },
  );

  // Wait until the patched /cluster/resources fed k8sapp records into the
  // resource store (the same store that backs the tree).
  await expect.poll(
    () => page.evaluate(() => (
      PVE.data.ResourceStore.getData().items.filter((r) => r.data.type === 'k8sapp').length
    )),
    { timeout: 30000, message: 'k8sapp records in ResourceStore' },
  ).toBeGreaterThan(0);

  // State-changing calls with cookie auth need the CSRF token (the GUI sends
  // the same header on every PUT/POST).
  return { csrf: body.data.CSRFPreventionToken };
}

// Browser tests use the real PVE resource tree and the plugin's real
// dispatcher. They intentionally do not activate mutating actions.
test.describe('Kubernetes application context menu', () => {
  test.skip(!password, 'Set PVE_PASSWORD to run the authenticated browser test');

  test('right click on a k8sapp tree node opens the plugin menu', async ({ page }) => {
    await login(page);

    const apps = await page.evaluate(() => (
      PVE.data.ResourceStore.getData().items
        .filter((r) => r.data.type === 'k8sapp')
        .map((r) => ({
          id: r.data.id,
          name: r.data.name,
          node: r.data.node,
          k8sapp: r.data.k8sapp,
          status: r.data.status,
        }))
    ));
    expect(apps.length).toBeGreaterThan(0);

    // Make sure the branch holding the apps is rendered before right-clicking.
    await page.evaluate(() => {
      const tree = Ext.ComponentQuery.query('pveResourceTree')[0];
      if (tree) tree.getRootNode().expandChildren?.(true);
    });

    const treeNode = page.locator('.x-tree-node-text', { hasText: apps[0].name }).first();
    await expect(treeNode).toBeVisible({ timeout: 30000 });
    await treeNode.click({ button: 'right' });

    const menu = page.locator('.x-menu').last();
    await expect(menu).toBeVisible();
    await expect(menu).toContainText(`K8s ${apps[0].name}`);
    for (const label of MENU_LABELS) {
      await expect(menu).toContainText(label);
    }
    await page.keyboard.press('Escape');
  });

  test('dispatcher builds PVE.k8sapp.CmdMenu with refined enabled state', async ({ page }) => {
    await login(page);

    const created = await page.evaluate(() => {
      const record = PVE.data.ResourceStore.getData().items
        .find((r) => r.data.type === 'k8sapp');
      if (!record) return { ok: false, reason: 'no k8sapp record in ResourceStore' };

      const fakeRecord = { data: Ext.clone(record.data), isRoot: () => false };
      const treePanel = Ext.ComponentQuery.query('treepanel')[0];
      const fakeEvent = { stopEvent() {}, getXY: () => [200, 200] };
      const menu = PVE.Utils.createCmdMenu(
        treePanel ? treePanel.getView() : null,
        fakeRecord, null, 0, fakeEvent,
      );
      window.__k8sMenu = menu;
      return {
        ok: true,
        className: menu.self.getName(),
        title: menu.title,
        recordStatus: fakeRecord.data.status,
      };
    });
    expect(created.ok, created.reason || 'menu created').toBe(true);
    expect(created.className).toBe('PVE.k8sapp.CmdMenu');
    expect(created.title).toMatch(/^K8s /);

    // The menu refines enabled/disabled from apps.json asynchronously.
    await page.waitForTimeout(1000);
    const state = await page.evaluate(() => {
      const menu = window.__k8sMenu;
      const items = {};
      menu.query('menuitem').forEach((item) => {
        if (item.itemId) items[item.itemId] = item.disabled;
      });
      const caps = Ext.state.Manager.get('GuiCap') || { nodes: {} };
      return { items, caps, title: menu.title };
    });
    await page.evaluate(() => { window.__k8sMenu.destroy(); delete window.__k8sMenu; });

    expect(Object.keys(state.items).sort()).toEqual([
      'console', 'deletepod', 'describe', 'logs', 'pause', 'restart',
      'resume', 'rollback', 'rollout', 'scale', 'start', 'stop', 'yaml',
    ]);

    const hasModify = !!(state.caps.nodes && state.caps.nodes['Sys.Modify']);
    const hasAudit = !!(state.caps.nodes && state.caps.nodes['Sys.Audit']);
    const hasConsole = !!(state.caps.nodes && state.caps.nodes['Sys.Console']);
    test.info().annotations.push({
      type: 'capabilities',
      description: `Sys.Modify=${hasModify} Sys.Audit=${hasAudit} Sys.Console=${hasConsole}`,
    });

    if (hasModify && hasAudit && hasConsole && created.recordStatus !== 'stopped') {
      // Running workload seen by a full-capability user: everything available
      // except Start (which only makes sense when stopped).
      expect(state.items.start).toBe(true);
      expect(state.items.stop).toBe(false);
      expect(state.items.restart).toBe(false);
      expect(state.items.scale).toBe(false);
      expect(state.items.rollback).toBe(false);
      expect(state.items.pause).toBe(false);
      expect(state.items.resume).toBe(false);
      expect(state.items.describe).toBe(false);
      expect(state.items.yaml).toBe(false);
      expect(state.items.rollout).toBe(false);
      expect(state.items.deletepod).toBe(false);
      expect(state.items.console).toBe(false);
      expect(state.items.logs).toBe(false);
    }
  });

  test('action feedback: tree icon spins while an action is pending', async ({ page }) => {
    await login(page);

    const app = await page.evaluate(() => {
      const rec = PVE.data.ResourceStore.getData().items
        .find((r) => r.data.type === 'k8sapp');
      return rec ? { k8sapp: rec.data.k8sapp } : null;
    });
    expect(app, 'k8sapp record present').toBeTruthy();

    // Make sure the branch holding the apps is rendered.
    await page.evaluate(() => {
      const tree = Ext.ComponentQuery.query('pveResourceTree')[0];
      if (tree) tree.getRootNode().expandChildren?.(true);
    });

    // Pure mapping check: stop/scale-to-zero converge to 'stopped',
    // everything else converges to 'running'.
    const targets = await page.evaluate(() => ({
      stop: PVE.k8s.pendingTarget('stop'),
      start: PVE.k8s.pendingTarget('start'),
      restart: PVE.k8s.pendingTarget('restart'),
      scale0: PVE.k8s.pendingTarget('scale', { replicas: 0 }),
      scale3: PVE.k8s.pendingTarget('scale', { replicas: 3 }),
    }));
    expect(targets).toEqual({
      stop: 'stopped',
      start: 'running',
      restart: 'running',
      scale0: 'stopped',
      scale3: 'running',
    });

    // Simulated action: set the pending state exactly like PVE.k8s.runAction
    // does before firing the API request (no cluster mutation here).
    await page.evaluate((appid) => PVE.k8s.setPending(appid, 'restart'), app.k8sapp);

    const iconCls = await page.evaluate((appid) => {
      const tree = Ext.ComponentQuery.query('pveResourceTree')[0];
      const node = tree.getRootNode().findChild('k8sapp', appid, true);
      return node ? node.data.iconCls : '';
    }, app.k8sapp);
    expect(iconCls, 'pending class added to the tree icon').toContain('k8s-pending');
    await expect(page.locator('.x-tree-icon-custom.k8s-pending')).toHaveCount(1);

    // Clearing (action failed or state converged) hands the icon back to the
    // standard running/stopped/degraded classes.
    await page.evaluate((appid) => PVE.k8s.setPending(appid, null), app.k8sapp);
    await expect(page.locator('.x-tree-icon-custom.k8s-pending')).toHaveCount(0);

    const iconClsAfter = await page.evaluate((appid) => {
      const tree = Ext.ComponentQuery.query('pveResourceTree')[0];
      const node = tree.getRootNode().findChild('k8sapp', appid, true);
      return node ? node.data.iconCls : '';
    }, app.k8sapp);
    expect(iconClsAfter).not.toContain('k8s-pending');
    expect(iconClsAfter, 'standard state class restored')
      .toMatch(/running|stopped|degraded/);
  });

  // Consolidated logging + notes, through the real API the panel uses.
  // Notes: PUT (protected -> pvedaemon/root) then GET (pveproxy/www-data)
  // must round-trip; this is the exact path that used to fail with
  // "unable to open file ... Permission denied (500)".
  // Actions: a no-op scale (same replica count) must return a real UPID and
  // land in the node task list AND the cluster log, like every PVE task.
  test('notes round-trip and k8s actions land in the PVE task/cluster logs', async ({ page }) => {
    const { csrf } = await login(page);

    const app = await page.evaluate(() => {
      const rec = PVE.data.ResourceStore.getData().items
        .find((r) => r.data.type === 'k8sapp');
      return rec ? {
        node: rec.data.node,
        appid: rec.data.k8sapp.replace('/', ':'),
      } : null;
    });
    expect(app, 'k8sapp record present').toBeTruthy();

    // Current desired replica count (a no-op scale changes nothing).
    const current = await page.evaluate((appid) => new Promise((resolve) => {
      PVE.k8s.getApp(appid, (a) => resolve(a ? (a.replicas || {}).desired ?? 1 : null));
    }), app.appid);
    expect(current, 'app snapshot available').not.toBeNull();

    const headers = { CSRFPreventionToken: csrf };

    // --- notes: read original, write a markdown note, verify, restore ---
    const cfgBefore = await page.request.get(
      `${pveBase}/api2/json/nodes/${app.node}/k8sapp/${app.appid}/config`,
    );
    expect(cfgBefore.ok()).toBeTruthy();
    const before = (await cfgBefore.json())?.data?.description || '';

    const marker = `pw-notes-${Date.now()}`;
    const put = await page.request.put(
      `${pveBase}/api2/json/nodes/${app.node}/k8sapp/${app.appid}/config`,
      { headers, form: { description: `# ${marker}\n- **bold** item` } },
    );
    expect(put.status(), `notes PUT -> ${put.status()}`).toBe(200);

    const cfgAfter = await page.request.get(
      `${pveBase}/api2/json/nodes/${app.node}/k8sapp/${app.appid}/config`,
    );
    const after = (await cfgAfter.json())?.data?.description || '';
    expect(after, 'saved note is served back').toContain(marker);

    // restore the previous content (empty string removes the note)
    const restore = await page.request.put(
      `${pveBase}/api2/json/nodes/${app.node}/k8sapp/${app.appid}/config`,
      { headers, form: { description: before } },
    );
    expect(restore.status(), `notes restore -> ${restore.status()}`).toBe(200);

    // --- action: no-op scale returns a UPID and becomes a real PVE task ---
    const scale = await page.request.post(
      `${pveBase}/api2/json/nodes/${app.node}/k8sapp/${app.appid}/scale`,
      { headers, form: { replicas: current } },
    );
    expect(scale.ok(), `scale -> ${scale.status()}`).toBeTruthy();
    const upid = (await scale.json())?.data;
    expect(upid, 'action returns a UPID').toMatch(/^UPID:[^:]+:[0-9A-F]+:[0-9A-F]+:[0-9A-F]+:k8sscale:/);

    await expect.poll(async () => {
      const resp = await page.request.get(
        `${pveBase}/api2/json/nodes/${app.node}/tasks?source=all&typefilter=k8sscale`,
      );
      const tasks = (await resp.json())?.data || [];
      return tasks.some((t) => t.upid === upid && t.status === 'OK');
    }, { timeout: 30000, message: 'k8sscale task finishes OK in task history' })
      .toBe(true);

    await expect.poll(async () => {
      const resp = await page.request.get(`${pveBase}/api2/json/cluster/log?max=200`);
      const log = (await resp.json())?.data || [];
      return log.some((e) => (e.msg || '').includes(`starting task ${upid}`));
    }, { timeout: 30000, message: 'cluster log records the k8s task' })
      .toBe(true);

    // --- per-app Task History: only THIS application's PVE tasks ---
    const scoped = await page.request.get(
      `${pveBase}/api2/json/nodes/${app.node}/k8sapp/${app.appid}/tasks?source=all`,
    );
    expect(scoped.ok(), `scoped task history -> ${scoped.status()}`).toBeTruthy();
    const scopedTasks = (await scoped.json())?.data || [];
    const scopedId = app.appid.replace(/[^A-Za-z0-9_.-]+/g, '-');
    expect(scopedTasks.some((t) => t.upid === upid && t.status === 'OK'),
      'scoped history contains the action created above').toBe(true);
    expect(scopedTasks.length, 'scoped history is not empty').toBeGreaterThan(0);
    for (const t of scopedTasks) {
      // no other guest, node or Kubernetes task may leak into this panel
      expect(t.type, 'scoped history only contains k8s task types').toMatch(/^k8s/);
      expect(t.id, `scoped history rows belong to ${scopedId}`).toBe(scopedId);
    }

    // --- panel: the Task History tab is the native node tasks grid ---
    await page.evaluate(() => {
      const tree = Ext.ComponentQuery.query('pveResourceTree')[0];
      if (tree) tree.getRootNode().expandChildren?.(true);
    });
    const treeNode = page.locator('.x-tree-node-text', { hasText: app.appid.split(':')[1] }).first();
    await expect(treeNode).toBeVisible({ timeout: 30000 });
    await treeNode.click();

    await page.waitForFunction(
      () => Ext.ComponentQuery.query('pveK8sAppBrowser').length > 0,
      null,
      { timeout: 30000 },
    );
    // Cards are lazily instantiated by PVE.panel.Config: click the tab label
    // first, only then does browser.down('#tasks') exist. The task we just
    // created must appear in the native grid ("K8s <id> - Scale"). The grid
    // uses a BufferedStore (remote prefetch), so it is checked via the DOM --
    // calling getRange() before the range is cached throws in Ext.
    await page.getByText('Task History', { exact: true }).first().click();
    await expect(
      page.locator('.x-grid-item', { hasText: 'kube-system-coredns' }).first(),
    ).toBeVisible({ timeout: 30000 });
    const taskTab = await page.evaluate(() => {
      const browser = Ext.ComponentQuery.query('pveK8sAppBrowser')[0];
      if (!browser) return { ok: false, reason: 'no pveK8sAppBrowser' };
      const tab = browser.down('#tasks');
      if (!tab) return { ok: false, reason: 'no #tasks item' };
      if (!tab.isXType || !tab.isXType('proxmoxNodeTasks')) {
        return { ok: false, reason: tab.self?.getName() || 'wrong type' };
      }
      const vm = tab.getViewModel();
      const preFilter = vm.get('preFilter');
      return {
        ok: true,
        url: vm.get('url'),
        preFilter,
        requestUrl: tab.getStore().getProxy().getUrl(),
      };
    });
    expect(taskTab.ok, `Task History tab is proxmoxNodeTasks (${taskTab.reason})`).toBe(true);
    expect(taskTab.url).toContain(`/k8sapp/${app.appid}/tasks`);
    expect(taskTab.preFilter).toEqual({ source: 'all' });
    expect(taskTab.requestUrl).toContain(`/k8sapp/${app.appid}/tasks`);
  });
});
