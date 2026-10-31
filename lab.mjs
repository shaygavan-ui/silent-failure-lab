import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {pathToFileURL} from 'node:url';

// Deliberately broken LOCAL fixtures, not payment or storage implementations.
export async function startLab(port = 0) {
  const documents = {
    broken: {title: 'Original document', revision: 1},
    fixed: {title: 'Original document', revision: 1},
  };
  const payments = {broken: {received: false, access: false}, fixed: {received: false, access: false}};
  let grants = 0;
  const internalErrors = [];
  function send(response, status, body, type = 'application/json') {
    response.writeHead(status, {'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff'});
    response.end(type === 'application/json' ? JSON.stringify(body) : body);
  }
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const match = /^\/(broken|fixed)\/(document|export\.csv|payment-receipt|paid-feature)$/.exec(url.pathname);
      if (url.pathname === '/sign-in' && request.method === 'GET') {
        return send(response, 200, '<!doctype html><title>Sign in</title><h1>Sign in to download your report</h1>', 'text/html; charset=utf-8');
      }
      if (!match) return send(response, 404, {error: 'Unknown lab endpoint'});
      const [, mode, route] = match;
      if (route === 'document' && request.method === 'GET') return send(response, 200, documents[mode]);
      if (route === 'document' && request.method === 'POST') {
        let body = '';
        for await (const chunk of request) {
          body += chunk;
          if (Buffer.byteLength(body) > 4096) return send(response, 413, {error: 'Lab input limit is 4096 bytes'});
        }
        let data;
        try { data = JSON.parse(body); } catch { return send(response, 400, {error: 'Expected JSON'}); }
        if (typeof data.title !== 'string' || !data.title.trim()) return send(response, 400, {error: 'A title is required'});
        const next = {title: data.title, revision: documents[mode].revision + 1};
        if (mode === 'fixed') documents[mode] = next;
        // The broken endpoint acknowledges a write it never performs.
        return send(response, 200, {saved: true, ...next});
      }
      if (route === 'export.csv' && request.method === 'GET') {
        if (mode === 'broken') {
          response.writeHead(302, {location: '/sign-in', 'cache-control': 'no-store'});
          return response.end();
        }
        response.setHeader('content-disposition', 'attachment; filename="report.csv"');
        return send(response, 200, url.searchParams.get('empty') === '1' ? 'id,total\n' : 'id,total\norder_1,19.00\norder_2,29.00\n', 'text/csv; charset=utf-8');
      }
      if (route === 'payment-receipt' && request.method === 'POST') {
        request.resume();
        payments[mode].received = true;
        if (mode === 'fixed' && !payments.fixed.access) { payments.fixed.access = true; grants++; }
        // Fake payment fixture. No signature verification or real payment.
        return send(response, 200, {received: true, fixture: 'local-payment-1'});
      }
      if (route === 'paid-feature' && request.method === 'GET') {
        return payments[mode].access ? send(response, 200, {available: true}) : send(response, 403, {available: false});
      }
      send(response, 405, {error: 'Method not supported by this lab endpoint'});
    } catch (error) {
      internalErrors.push(error.name);
      if (!response.headersSent) send(response, 500, {error: 'Unexpected lab failure'});
      else response.destroy();
    }
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.maxConnections = 20;
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    internalErrors,
    get grants() { return grants; },
    async close() {
      const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      server.closeIdleConnections();
      await closed;
    },
  };
}

export async function checkLab() {
  const lab = await startLab();
  const request = (path, options = {}) => fetch(lab.origin + path, {...options, signal: AbortSignal.timeout(5000)});
  const post = (path, value) => request(path, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(value)});
  const results = [];
  try {
    const write = await post('/broken/document', {title: 'Customer changes'});
    assert.equal(write.status, 200);
    assert.equal((await write.json()).saved, true);
    const read = await request('/broken/document');
    assert.equal(read.status, 200);
    assert.equal((await read.json()).title, 'Original document');
    results.push('SAVE: POST 200 says saved; fresh GET still returns the original document.');

    const corrected = await post('/fixed/document', {title: 'Customer changes'});
    const acknowledged = await corrected.json();
    assert.equal(corrected.status, 200);
    const committed = await (await request('/fixed/document')).json();
    assert.deepEqual(committed, {title: 'Customer changes', revision: acknowledged.revision});

    const redirect = await request('/broken/export.csv', {redirect: 'manual'});
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.get('location'), '/sign-in');
    await redirect.arrayBuffer();
    const download = await request('/broken/export.csv');
    assert.equal(download.ok, true);
    assert.equal(download.status, 200);
    assert.equal(download.redirected, true);
    assert.match(download.headers.get('content-type'), /^text\/html/);
    assert.match(await download.text(), /Sign in to download/);
    results.push('DOWNLOAD: final GET 200, but the response is a sign-in page, not a CSV.');

    const csv = await request('/fixed/export.csv');
    assert.match(csv.headers.get('content-type'), /^text\/csv/);
    assert.equal(await csv.text(), 'id,total\norder_1,19.00\norder_2,29.00\n');
    const empty = await request('/fixed/export.csv?empty=1');
    assert.equal(empty.status, 200);
    assert.equal(await empty.text(), 'id,total\n');

    const receipt = await post('/broken/payment-receipt', {});
    assert.equal(receipt.status, 200);
    assert.equal((await receipt.json()).received, true);
    const access = await request('/broken/paid-feature');
    assert.equal(access.status, 403);
    await access.arrayBuffer();
    results.push('ACCESS: payment fixture acknowledged with 200; the paid feature still returns 403.');

    for (let i = 0; i < 2; i++) {
      const accepted = await post('/fixed/payment-receipt', {});
      assert.equal(accepted.status, 200);
      await accepted.arrayBuffer();
    }
    const available = await request('/fixed/paid-feature');
    assert.equal(available.status, 200);
    assert.equal((await available.json()).available, true);
    assert.equal(lab.grants, 1, 'Repeated fixture receipt must not grant twice');

    const invalid = await post('/fixed/document', {title: ''});
    assert.equal(invalid.status, 400);
    await invalid.arrayBuffer();
    const unknown = await request('/does-not-exist');
    assert.equal(unknown.status, 404);
    await unknown.arrayBuffer();
    assert.deepEqual(lab.internalErrors, []);
    results.push('CONTROLS: corrected writes, usable CSV, valid empty CSV, repeat receipt and access checks passed.');
    results.push('No internal server exceptions. All requests stayed on loopback. No external APIs or payments.');
    return results;
  } finally { await lab.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (!args.length || (args.length === 1 && args[0] === '--check')) {
    console.log((await checkLab()).join('\n'));
  } else if (args[0] === '--serve' && args.length <= 2) {
    const port = args[1] === undefined ? 4374 : Number(args[1]);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Use --serve [port], with a port from 0 to 65535');
    const lab = await startLab(port);
    console.log(`Local fixtures at ${lab.origin}. See README.md for requests. Ctrl+C to stop.`);
    process.once('SIGINT', () => { void lab.close(); });
    process.once('SIGTERM', () => { void lab.close(); });
  } else { throw new Error('Use node lab.mjs, node lab.mjs --check, or node lab.mjs --serve [port]'); }
}
