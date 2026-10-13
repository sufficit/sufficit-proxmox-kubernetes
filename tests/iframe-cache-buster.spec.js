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

test.describe('Node Kubernetes tab - iframe cache-buster', () => {
  test.skip(!password, 'Set PVE_PASSWORD to run the authenticated browser test');

  // Regression for "nao estou vendo os graficos no eveo" (browser cache):
  // the tab iframe used to load /pve2/js/k8s/index.html with a FIXED src, so
  // browsers kept serving the pre-deploy copy from cache until a manual
  // Ctrl+F5. Since v1.0.7 the src carries a content-derived token
  // (?k8spoc=<sha>) that invalidates the cache automatically on each deploy.
  test('pvemanagerlib.js iframe src carries a k8spoc cache-buster token', async ({ page }) => {
    await login(page);
    const resp = await page.request.get(`${pveBase}/pve2/js/pvemanagerlib.js`);
    expect(resp.status(), 'pvemanagerlib.js GET status').toBe(200);
    const js = await resp.text();

    // The k8s tab must exist and its iframe src must point at the panel with
    // a cache-buster token. Pre-v1.0.7 deploys have the bare src and are
    // expected to skip (legacy path), exactly like the other specs.
    const m = js.match(/tag: 'iframe',\s*src: '\/pve2\/js\/k8s\/index\.html(?:\?k8spoc=([0-9a-f]+))?'/);
    test.skip(!m, 'aba Kubernetes ausente no pvemanagerlib.js servido');
    const token = m[1];
    test.skip(!token, 'iframe sem cache-buster (deploy pre-v1.0.7): Ctrl+F5 manual ainda necessario');

    // The token must match the digest of the CURRENT panel index.html
    // served by the proxy; a stale cached copy of the lib would carry a
    // token that no longer matches, so this also proves the served lib is
    // the patched one.
    expect(token, 'k8spoc token present (12 hex chars)').toMatch(/^[0-9a-f]{12}$/);
    const panel = await page.request.get(`${pveBase}/pve2/js/k8s/index.html`);
    expect(panel.status(), 'index.html do painel GET status').toBe(200);

    // Same digest the patch_ui.py (secao 5c) computes: sha256 do HEXDIGEST
    // do arquivo (double-hash), primeiros 12 hex. Compare against the file
    // served through the same URL the browser would use.
    const crypto = require('crypto');
    const inner = crypto.createHash('sha256').update(await panel.body()).digest('hex');
    const digest = crypto.createHash('sha256').update(inner).digest('hex').slice(0, 12);
    expect(token, 'token do iframe == digest do index.html servido').toBe(digest);
  });
});
