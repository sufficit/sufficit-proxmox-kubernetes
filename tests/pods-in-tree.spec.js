const { test, expect } = require('@playwright/test');

const pveBase = (process.env.PVE_URL || 'https://pve.example.com:8006/').replace(/\/+$/, '');
// nó PVE alvo (onde os pods locais devem aninhar): pve01, pve02, ...
const host = process.env.PVE_HOST || 'pve02';
const user = process.env.PVE_USER || 'root@pam';
const password = process.env.PVE_PASSWORD;

// Same login contract as pseudo-host.spec.js.
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
      typeof window.PVE.k8s?.PodPanel !== 'undefined' &&
      typeof window.PVE.k8spod?.CmdMenu !== 'undefined',
    null, { timeout: 30000 },
  );
  await page.waitForFunction(
    () => PVE.data.ResourceStore.getData().items.some((r) => r.data.type === 'k8spod'),
    null, { timeout: 30000 },
  );
}

async function expandAll(page) {
  // O updateTree recria/gruda grupos colapsados em cada poll do rstore: expandir
  // uma vez nao basta. Repete ate o grupo do host estar aberto no DOM.
  for (let i = 0; i < 20; i++) {
    await page.evaluate((h) => {
      const tree = Ext.ComponentQuery.query('pveResourceTree')[0];
      if (!tree) return;
      const root = tree.getRootNode();
      root.expand?.(false);
      root.expandChildren?.(true);
      const alt = root.findChild('id', `node/${h}`, true);
      if (alt && !alt.isExpanded()) alt.expand?.(true);
      const view = tree.getView();
      if (alt && view) view.refreshNode?.(alt);
    }, host);
    const ok = await page.evaluate((h) => {
      const tree = Ext.ComponentQuery.query('pveResourceTree')[0];
      if (!tree) return false;
      const alt = tree.getRootNode().findChild('id', `node/${h}`, true);
      return !!(alt && alt.isExpanded() && alt.childNodes.length);
    }, host);
    if (ok) return;
    await page.waitForTimeout(400);
  }
}

// A arvore usa buffered rendering: so as linhas visiveis existem no DOM. Os
// grupos ordenam depois do pseudo-host Kubernetes (74 apps acima), entao o
// grupo do host e seus pods ficam abaixo da dobra -- rola o NO ate a view
// renderizar a linha, exatamente como o usuario veria ao rolar a lateral.
async function scrollNodeIntoView(page, nodeId) {
  await page.evaluate((id) => {
    const tree = Ext.ComponentQuery.query('pveResourceTree')[0];
    const node = tree.getRootNode().findChild('id', id, true);
    if (node && tree.getView().scrollIntoView) tree.getView().scrollIntoView(node);
  }, nodeId);
  await page.waitForTimeout(400);
}

function podsInTree(page, parentId) {
  return page.evaluate((pid) => {
    const tree = Ext.ComponentQuery.query('pveResourceTree')[0];
    const root = tree.getRootNode();
    const group = pid ? root.findChild('id', pid, true) : root;
    if (!group) return null;
    return group.childNodes
      .filter((c) => c.data.type === 'k8spod')
      .map((c) => c.data.name);
  }, parentId);
}

test.describe('Kubernetes pods nested under real hosts (k8spod)', () => {
  test.skip(!password, 'Set PVE_PASSWORD to run');

  // A arvore lateral usa ExtJS buffered renderer: so as linhas que cabem na
  // viewport existem no DOM. Como o pseudo-host Kubernetes (74 apps) ordena
  // ANTES do host real, o grupo do host com seus pods fica abaixo da dobra em
  // 950px. Viewport alta renderiza a arvore inteira de uma vez (o usuario
  // normal simplesmente rola a lateral, o que o buffered renderer segue).
  test.use({ viewport: { width: 1280, height: 2200 } });

  test('store: every k8spod record carries the real host and its owning app', async ({ page }) => {
    await login(page);
    const check = await page.evaluate((h) => {
      const recs = PVE.data.ResourceStore.getData().items
        .filter((r) => r.data.type === 'k8spod');
      // Nos PVE reais visiveis neste cluster: em um cluster PVE multi-no
      // (ex.: pve01+pve02+pve03) cada host com o patch publica seus pods
      // locais ancorados no hostname real; nos k8s fora do cluster PVE
      // caem no pseudo-host Kubernetes.
      const realNodes = PVE.data.ResourceStore.getData().items
        .filter((r) => r.data.type === 'node')
        .map((r) => r.data.node);
      const known = [...realNodes, 'Kubernetes'];
      return {
        total: recs.length,
        known,
        allGrouped: recs.every((r) => known.includes(r.data.node)),
        remoteUnderPseudo: recs.filter((r) => r.data.node === 'Kubernetes').length,
        allCarryK8sapp: recs.every((r) => !!r.data.k8sapp),
        hostPods: recs.filter((r) => r.data.node === h).length,
        localCarryK8snode: recs
          .filter((r) => r.data.node === h)
          .every((r) => r.data.k8snode === h),
      };
    }, host);
    expect(check.total).toBeGreaterThan(0);
    expect(check.known, 'real PVE nodes are visible').toContain(host);
    expect(check.allGrouped, 'every pod groups under a real host or the pseudo-host').toBe(true);
    expect(check.remoteUnderPseudo, 'remote pods published for the Folder View').toBeGreaterThan(0);
    expect(check.allCarryK8sapp, 'each pod carries its owning application').toBe(true);
    expect(check.hostPods, 'this host contributes its own local pods').toBeGreaterThan(0);
    expect(check.localCarryK8snode, 'pods under a host carry that host as k8snode').toBe(true);
  });

  test(`Server View: only this host\'s pods nest inside ${host}`, async ({ page }) => {
    await login(page);
    await expandAll(page);

    const underAlt = await podsInTree(page, `node/${host}`);
    const underPseudo = await podsInTree(page, 'node/Kubernetes');
    const storeAlt = await page.evaluate((h) => (
      PVE.data.ResourceStore.getData().items
        .filter((r) => r.data.type === 'k8spod' && r.data.node === h)
        .map((r) => r.data.name)
    ), host);

    expect(underAlt, `${host} node exists with its pods`).not.toBeNull();
    expect(underPseudo, 'pseudo-host Kubernetes exists').not.toBeNull();
    expect(underPseudo.length, 'no pods under the pseudo-host').toBe(0);
    expect(underAlt.sort(), 'tree under host matches the local pods in the store')
      .toEqual(storeAlt.sort());
    const hostGroups = await page.evaluate(() => (
      Ext.ComponentQuery.query('pveResourceTree')[0].getRootNode()
        .childNodes.filter((c) => c.data.type === 'node').map((c) => c.data.text)
    ));
    const expectedGroups = await page.evaluate(() => (
      ['Kubernetes', ...new Set(
        PVE.data.ResourceStore.getData().items
          .filter((r) => r.data.type === 'node')
          .map((r) => r.data.node),
      )].sort()
    ));
    expect(hostGroups.slice().sort(), 'no ghost hosts materialize in Server View')
      .toEqual(expectedGroups);
    expect(underAlt.length, 'this host\'s pods render').toBeGreaterThan(0);

    // Em cluster PVE multi-no, TODOS os pods ancorados em hosts reais
    // renderizam (cada um sob o seu host); nenhum sob o pseudo-host.
    const storeRealCount = await page.evaluate(() => (
      PVE.data.ResourceStore.getData().items
        .filter((r) => r.data.type === 'k8spod' && r.data.node !== 'Kubernetes').length
    ));
    const totalRendered = await page.evaluate(() => {
      let n = 0;
      Ext.ComponentQuery.query('pveResourceTree')[0].getRootNode()
        .cascadeBy({ before: (node) => { if (node.data.type === 'k8spod') n++; return true; } });
      return n;
    });
    expect(totalRendered, 'Server View renders every pod bound to a real host')
      .toBe(storeRealCount);
  });

  test('clicking a pod opens the pod panel with its summary', async ({ page }) => {
    await login(page);
    await expandAll(page);

    const podName = (await podsInTree(page, `node/${host}`))[0];
    expect(podName, 'a pod is present under the host').toBeTruthy();
    // Mesma rota do clique: selectionchange -> setContent(pveK8sPodPanel).
    await page.evaluate(([n, h]) => {
      const tree = Ext.ComponentQuery.query('pveResourceTree')[0];
      tree.selectById(`k8spod/${h}/${n}`);
    }, [podName, host]);

    await page.waitForFunction(
      () => Ext.ComponentQuery.query('pveK8sPodPanel').length > 0,
      null, { timeout: 30000 },
    );
    await page.waitForTimeout(500); // snapshot fetch

    const rows = await page.evaluate(() => {
      const panel = Ext.ComponentQuery.query('pveK8sPodPanel')[0];
      const store = panel.down('#pod-grid')?.getStore();
      if (!store) return null;
      return Object.fromEntries(store.getRange().map((r) => [r.data.key, r.data.value]));
    });
    expect(rows, 'summary grid is loaded').not.toBeNull();
    const appid = await page.evaluate(([n, h]) => {
      const r = PVE.data.ResourceStore.getData().items
        .find((x) => x.data.type === 'k8spod' && x.data.node === h && x.data.name === n);
      return r ? r.data.k8sapp : null;
    }, [podName, host]);
    expect(appid, 'pod record carries its owning app').toBeTruthy();
    const [ns, appName] = appid.split('/');
    expect(rows['Application']).toBe(`${appName} [${ns}]`);
    expect(rows['Pod']).toBe(podName);
    expect(rows['Node']).toBe(host);
    expect(rows['Status']).toMatch(/Running|—/);
  });

  test('pod context menu offers pod actions (no node menu)', async ({ page }) => {
    await login(page);
    await expandAll(page);

    const podName = (await podsInTree(page, `node/${host}`))[0];
    expect(podName, 'a pod is present under the host').toBeTruthy();
    await scrollNodeIntoView(page, `k8spod/${host}/${podName}`);
    const row = page.locator('.x-tree-node-text').filter({ hasText: podName }).first();
    await expect(row, 'pod row rendered after scroll').toBeVisible({ timeout: 30000 });
    await row.click({ button: 'right' });

    const menu = page.locator('.x-menu');
    await expect(menu).toBeVisible({ timeout: 15000 });
    for (const label of ['Console', 'Pod logs', 'Describe pod', 'View YAML', 'Delete pod']) {
      await expect(menu.locator('.x-menu-item-text').filter({ hasText: label }).first())
        .toBeVisible();
    }
    // A node-level menu would offer Shutdown/Shell -- must never appear for pods.
    await expect(menu.locator('.x-menu-item-text').filter({ hasText: 'Shutdown' })).toHaveCount(0);
    await expect(menu.locator('.x-menu-item-text').filter({ hasText: 'Shell' })).toHaveCount(0);

    // Describe pod opens the output window restricted to this pod.
    await menu.locator('.x-menu-item-text').filter({ hasText: 'Describe pod' }).first().click();
    const win = page.locator('.x-window').filter({ hasText: 'Describe pod' });
    await expect(win).toBeVisible({ timeout: 15000 });
    await expect(win).toContainText(podName, { timeout: 30000 });
    await page.keyboard.press('Escape');
  });

  test('Folder View: "Kubernetes Pods" folder holds the whole cluster', async ({ page }) => {
    await login(page);

    // Mesma chamada que o combobox nativo dispara (selview.on('select') ->
    // rtree.setViewFilter). O Folder View agrupa por tipo: pasta Kubernetes Pods.
    const switched = await page.evaluate(() => {
      const tree = Ext.ComponentQuery.query('pveResourceTree')[0];
      if (!tree || typeof tree.setViewFilter !== 'function') return false;
      tree.setViewFilter({ text: 'Folder View', groups: ['type'] });
      return true;
    });
    expect(switched, 'tree switched to Folder View').toBe(true);
    await page.waitForTimeout(300);

    await expandAll(page);
    // A pasta "Kubernetes Pods" (grupo type/k8spod) ordena por ultimo no
    // Folder View -- abaixo da dobra do buffered renderer. Rola ate ela.
    await page.evaluate(() => {
      const tree = Ext.ComponentQuery.query('pveResourceTree')[0];
      const root = tree.getRootNode();
      const podFolder = root.findChild('id', 'type/k8spod', true)
        || root.findChild('groupbyid', 'k8spod', true);
      if (podFolder && tree.getView().scrollIntoView) tree.getView().scrollIntoView(podFolder);
    });
    await page.waitForTimeout(400);
    const folder = page.locator('.x-tree-node-text').filter({ hasText: /Kubernetes Pods/ });
    await expect(folder).toBeVisible({ timeout: 30000 });

    const total = await page.evaluate(() => {
      let n = 0;
      Ext.ComponentQuery.query('pveResourceTree')[0].getRootNode()
        .cascadeBy({ before: (node) => { if (node.data.type === 'k8spod') n++; return true; } });
      return n;
    });
    const inStore = await page.evaluate(() => (
      PVE.data.ResourceStore.getData().items.filter((r) => r.data.type === 'k8spod').length
    ));
    expect(total, 'every published pod renders in Folder View').toBe(inStore);
    expect(total, 'Folder View carries this host\'s pods').toBeGreaterThan(0);

    // v5: a Folder View carrega o cluster INTEIRO -- os pods remotos
    // (node='Kubernetes') renderizam aqui, nao na Server View.
    const remoteInFolder = await page.evaluate(() => {
      let n = 0;
      Ext.ComponentQuery.query('pveResourceTree')[0].getRootNode()
        .cascadeBy({ before: (node) => { if (node.data.type === 'k8spod' && node.data.node === 'Kubernetes') n++; return true; } });
      return n;
    });
    const remoteInStore = await page.evaluate(() => (
      PVE.data.ResourceStore.getData().items
        .filter((r) => r.data.type === 'k8spod' && r.data.node === 'Kubernetes').length
    ));
    expect(remoteInFolder, 'Folder View carries the whole cluster, not just this host')
      .toBe(remoteInStore);
    expect(remoteInFolder).toBeGreaterThan(0);
  });
});
