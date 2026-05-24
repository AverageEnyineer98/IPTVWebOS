/* ============================================================
   HLS CORS Proxy Server
   A lightweight local proxy that:
   1. Fetches M3U8 playlists and .ts segments from origin servers
   2. Rewrites internal URLs so segments also route through proxy
   3. Adds CORS headers so the browser/webOS allows playback
   ============================================================ */

const http = require('http');
const https = require('https');
const url = require('url');
const path = require('path');

const PORT = 8889;
const HOST = '0.0.0.0';

// ---- Helpers ----
function fetchRemote(targetUrl, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(targetUrl);
    const client = parsed.protocol === 'https:' ? https : http;

    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': '*/*',
        ...headers,
      },
      timeout: 15000,
    };

    const req = client.request(options, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = new URL(res.headers.location, targetUrl).href;
        fetchRemote(redirectUrl, headers).then(resolve).catch(reject);
        return;
      }

      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks),
        });
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    req.end();
  });
}

function getBaseUrl(fullUrl) {
  const parsed = new URL(fullUrl);
  const pathParts = parsed.pathname.split('/');
  pathParts.pop(); // Remove filename
  return `${parsed.protocol}//${parsed.host}${pathParts.join('/')}`;
}

function rewriteM3U8(body, originalUrl, proxyBase) {
  const baseUrl = getBaseUrl(originalUrl);
  const lines = body.split('\n');

  return lines.map((line) => {
    const trimmed = line.trim();

    // Skip empty lines and comments (except URI in EXT-X-KEY etc.)
    if (!trimmed || trimmed.startsWith('#')) {
      // Rewrite URI= references in tags like #EXT-X-KEY
      if (trimmed.includes('URI="')) {
        return trimmed.replace(/URI="([^"]+)"/g, (match, uri) => {
          const absoluteUri = uri.startsWith('http') ? uri : new URL(uri, baseUrl + '/').href;
          return `URI="${proxyBase}/proxy?url=${encodeURIComponent(absoluteUri)}"`;
        });
      }
      return line;
    }

    // It's a URL line (segment or sub-playlist)
    let absoluteUrl;
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
      absoluteUrl = trimmed;
    } else if (trimmed.startsWith('/')) {
      const parsed = new URL(originalUrl);
      absoluteUrl = `${parsed.protocol}//${parsed.host}${trimmed}`;
    } else {
      absoluteUrl = `${baseUrl}/${trimmed}`;
    }

    return `${proxyBase}/proxy?url=${encodeURIComponent(absoluteUrl)}`;
  }).join('\n');
}

// ---- HTTP Server ----
const server = http.createServer(async (req, res) => {
  // CORS headers for all responses
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Range');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Content-Type');

  // Handle preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsed = url.parse(req.url, true);

  // Health check
  if (parsed.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', message: 'HLS CORS Proxy running' }));
    return;
  }

  // Proxy endpoint
  if (parsed.pathname === '/proxy') {
    const targetUrl = parsed.query.url;

    if (!targetUrl) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing url parameter' }));
      return;
    }

    try {
      const proxyBase = `http://${req.headers.host || `localhost:${PORT}`}`;
      const remote = await fetchRemote(targetUrl);

      if (remote.statusCode !== 200) {
        res.writeHead(remote.statusCode, { 'Content-Type': 'text/plain' });
        res.end(`Upstream returned ${remote.statusCode}`);
        return;
      }

      const contentType = remote.headers['content-type'] || '';
      const isM3U8 = targetUrl.includes('.m3u8') ||
                     contentType.includes('mpegurl') ||
                     contentType.includes('m3u');

      if (isM3U8) {
        // Rewrite M3U8 playlist URLs
        const bodyText = remote.body.toString('utf-8');
        const rewritten = rewriteM3U8(bodyText, targetUrl, proxyBase);

        res.writeHead(200, {
          'Content-Type': 'application/vnd.apple.mpegurl',
          'Cache-Control': 'no-cache',
        });
        res.end(rewritten);
      } else {
        // Pass through binary content (TS segments, keys, etc.)
        const headers = {
          'Content-Type': contentType || 'application/octet-stream',
        };
        if (remote.headers['content-length']) {
          headers['Content-Length'] = remote.headers['content-length'];
        }
        res.writeHead(200, headers);
        res.end(remote.body);
      }
    } catch (err) {
      console.error(`Proxy error for ${targetUrl}:`, err.message);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Proxy fetch failed', detail: err.message }));
    }
    return;
  }

  // 404 for everything else
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.listen(PORT, HOST, () => {
  console.log(`\n  🛰️  HLS CORS Proxy running on http://localhost:${PORT}`);
  console.log(`  Usage: http://localhost:${PORT}/proxy?url=<encoded_stream_url>\n`);
});
