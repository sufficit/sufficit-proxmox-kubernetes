module.exports = {
  testDir: __dirname,
  timeout: 180_000,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    headless: true,
    // The PVE web UI serves a self-signed certificate by default.
    ignoreHTTPSErrors: true,
    viewport: { width: 1600, height: 900 },
    locale: 'en-US',
    actionTimeout: 30_000,
    baseURL: process.env.PVE_URL || 'https://pve.example.com:8006/',
  },
};
