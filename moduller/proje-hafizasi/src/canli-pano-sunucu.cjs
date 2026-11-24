'use strict';

/**
 * Canlı Yerel Takip Panosu Sunucusu (`canli-pano-sunucu.cjs`)
 *
 * Kullanıcı yan ekranda panoyu açtığında her 3 saniyede bir diskteki son durumu
 * ve kanıt sağlığını otomatik yeniler. Yalnızca `127.0.0.1` üzerinde dinler!
 */

const http = require('node:http');
const { once } = require('node:events');
const { renderDashboardHtml } = require('./sunum-uretici.cjs');

async function startLiveDashboardServer(store, { port = 0, host = '127.0.0.1' } = {}) {
  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
      if (url.pathname === '/api/durum') {
        const ledger = store.load();
        const auditReport = store.audit();
        const recentHistory = store.readRecentHistory(25);
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify({ ledger, auditReport, recentHistory, generatedAt: new Date().toISOString() }));
        return;
      }

      if (url.pathname === '/' || url.pathname === '/pano') {
        const ledger = store.load();
        const auditReport = store.audit();
        const recentHistory = store.readRecentHistory(25);
        const html = renderDashboardHtml(ledger, auditReport, recentHistory, { liveServerMode: true });
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(html);
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Bulunamadı');
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message }));
    }
  });

  server.listen(port, host);
  await once(server, 'listening');
  const addr = server.address();
  return {
    server,
    port: addr.port,
    url: `http://${host}:${addr.port}/`,
    close: () => new Promise(resolve => server.close(() => resolve())),
  };
}

module.exports = {
  startLiveDashboardServer,
};
