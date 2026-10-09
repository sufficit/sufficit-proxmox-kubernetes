const { test, expect } = require('@playwright/test');

const pveBase = (process.env.PVE_URL || 'https://pve.example.com:8006/').replace(/\/+$/, '');
const user = process.env.PVE_USER || 'root@pam';
const password = process.env.PVE_PASSWORD;

// Same login contract as the other specs: POST /access/ticket, cookie in the
// jar (the k8s statics + /api2/json calls of index.html are same-origin).
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
}

test.describe('Node Kubernetes tab - aggregated usage charts', () => {
  test.skip(!password, 'Set PVE_PASSWORD to run the authenticated browser test');

  test('GET /pve2/js/k8s/node-history.json serves the aggregated series', async ({ page }) => {
    await login(page);
    const resp = await page.request.get(`${pveBase}/pve2/js/k8s/node-history.json`);
    test.skip(resp.status() === 404, 'deploy do host ainda sem graficos do no (pre-v1.0.6)');
    expect(resp.status(), 'node-history GET status').toBe(200);
    const h = await resp.json();
    expect(typeof h.generated, 'generated epoch').toBe('number');
    expect(h.node, 'node name').toBeTruthy();
    expect(Array.isArray(h.max) && h.max.length === 2, 'max = [cpuMilli, bytes]').toBe(true);
    expect(h.max[0], 'cpu capacity > 0').toBeGreaterThan(0);
    expect(h.max[1], 'mem capacity > 0').toBeGreaterThan(0);
    expect(typeof h.pods, 'pods count').toBe('number');
    expect(Array.isArray(h.series), 'series array').toBe(true);
    for (const s of h.series.slice(-5)) {
      expect(s.length, 'sample = [ts, cpuMilli, bytes]').toBe(3);
      expect(s[0], 'sample ts > 0').toBeGreaterThan(0);
      expect(s[1], 'sample cpuMilli >= 0').toBeGreaterThanOrEqual(0);
      expect(s[2], 'sample memBytes >= 0').toBeGreaterThanOrEqual(0);
    }
  });

  test('usage card renders charts in the node Kubernetes tab', async ({ page }) => {
    await login(page);

    // The card stays hidden until node-history.json has >= 2 samples (cron
    // ticks every minute). Poll from Node (page.request shares the cookie
    // jar) before navigating: on a fresh deploy the 2nd sample can take ~1 min.
    let hist = null;
    const deadline = Date.now() + 150_000;
    while (Date.now() < deadline) {
      const r = await page.request.get(`${pveBase}/pve2/js/k8s/node-history.json`);
      if (r.ok()) {
        const h = await r.json();
        if ((h.series || []).length >= 2) { hist = h; break; }
      } else if (r.status() === 404) {
        break; // deploy antigo: nem adianta esperar
      }
      await page.waitForTimeout(10_000);
    }
    test.skip(!hist, 'node-history.json ausente ou com <2 amostras (deploy pre-v1.0.6 ou recem-instalado)');

    // The tab is a plain iframe: load the page directly (same origin, same
    // cookie jar) instead of driving the ExtJS tree.
    await page.goto(`${pveBase}/pve2/js/k8s/index.html`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#usage-card')).toBeVisible({ timeout: 30_000 });

    // Two charts, both painted (non-blank canvas).
    await expect(page.locator('#cpu-chart')).toBeVisible();
    await expect(page.locator('#mem-chart')).toBeVisible();
    const painted = await page.evaluate(() => ['cpu-chart', 'mem-chart'].map((id) => {
      const c = document.getElementById(id);
      const g = c.getContext('2d');
      const d = g.getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] !== 0) n++;
      return n;
    }));
    expect(painted[0], 'cpu canvas painted').toBeGreaterThan(50);
    expect(painted[1], 'mem canvas painted').toBeGreaterThan(50);

    // Header shows current usage against node capacity.
    await expect(page.locator('#cpu-now')).toContainText(/m$|n[úu]cleo/);
    await expect(page.locator('#mem-now')).toContainText(/(Ki|Mi|Gi|Ti)B/);
    if (Number.isFinite(hist.pods) && hist.pods > 0) {
      await expect(page.locator('#pods-count')).toContainText(`${hist.pods} pods`);
    }

    // Time-frame selector redraws without errors.
    await page.locator('#tfbar button[data-min="720"]').click();
    await expect(page.locator('#tfbar button[data-min="720"]')).toHaveClass(/on/);
    await page.locator('#tfbar button[data-min="60"]').click();
    await expect(page.locator('#tfbar button[data-min="60"]')).toHaveClass(/on/);
  });
});
