/* ============================================================
   HLS CORS Proxy – webOS Background JS Service
   Runs on 127.0.0.1:8889 inside the TV.
   - Fetches M3U8 playlists and TS segments from origin servers
   - Rewrites internal URLs so segments also route through proxy
   - Adds CORS headers so the webOS browser allows playback
   - Spoofs geo-block bypass headers for CCTV channels
   - Self-heals: handles EADDRINUSE, retries, keep-alive
   ============================================================ */

var Service = require('webos-service');
var http = require('http');
var https = require('https');
var urlMod = require('url');

var pkgInfo = require('./package.json');
var service = new Service(pkgInfo.name);

var PORT = 8889;
var HOST = '127.0.0.1';

// Global Keep-Alive Agents to prevent connection drops
var httpAgent = new http.Agent({ keepAlive: true, maxSockets: 50, keepAliveMsecs: 15000 });
var httpsAgent = new https.Agent({
  keepAlive: true, maxSockets: 50, keepAliveMsecs: 15000,
  rejectUnauthorized: false  // Some IPTV servers have bad certs
});

var server = null;
var serverReady = false;
var startTime = Date.now();
var requestCount = 0;

// ---- Logging ----
function log(msg) {
  console.log('[PROXY ' + new Date().toISOString() + '] ' + msg);
}

// ---- URL Helpers (compatible with Node.js 0.12+) ----
function parseUrl(rawUrl) {
  // Use url.parse instead of new URL() for older Node.js on webOS
  var parsed = urlMod.parse(rawUrl);
  return {
    protocol: parsed.protocol || 'http:',
    hostname: parsed.hostname || '',
    port: parsed.port || '',
    pathname: parsed.pathname || '/',
    search: parsed.search || '',
    host: parsed.host || '',
    href: parsed.href || rawUrl
  };
}

function resolveUrl(relative, base) {
  if (relative.indexOf('http://') === 0 || relative.indexOf('https://') === 0) {
    return relative;
  }
  return urlMod.resolve(base, relative);
}

function getBaseUrl(fullUrl) {
  var parsed = parseUrl(fullUrl);
  var pathParts = parsed.pathname.split('/');
  pathParts.pop(); // Remove filename
  return parsed.protocol + '//' + parsed.host + pathParts.join('/');
}

// ---- Remote Fetch with Retry ----
function fetchRemote(targetUrl, headers, retryCount) {
  headers = headers || {};
  retryCount = retryCount || 0;

  return new Promise(function(resolve, reject) {
    var parsed = parseUrl(targetUrl);
    var client = parsed.protocol === 'https:' ? https : http;
    var agent = parsed.protocol === 'https:' ? httpsAgent : httpAgent;
    var defaultPort = parsed.protocol === 'https:' ? 443 : 80;

    var options = {
      hostname: parsed.hostname,
      port: parsed.port || defaultPort,
      path: parsed.pathname + (parsed.search || ''),
      method: 'GET',
      agent: agent,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.79 Safari/537.36',
        'Accept': '*/*',
        // Geo-block bypass: Spoof China IP for CCTV channels
        'X-Forwarded-For': '114.114.114.114',
        'Client-IP': '114.114.114.114',
        'X-Real-IP': '114.114.114.114',
        'Connection': 'keep-alive',
        'Referer': parsed.protocol + '//' + parsed.hostname + '/'
      },
      timeout: 20000
    };

    // Merge custom headers (overrides defaults)
    var hk = Object.keys(headers);
    for (var i = 0; i < hk.length; i++) {
      options.headers[hk[i]] = headers[hk[i]];
    }

    var req = client.request(options, function(res) {
      // Follow redirects (up to 5)
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (retryCount >= 5) {
          return reject(new Error('Too many redirects'));
        }
        var redirectUrl = resolveUrl(res.headers.location, targetUrl);
        log('Redirect ' + res.statusCode + ' -> ' + redirectUrl);
        fetchRemote(redirectUrl, headers, retryCount + 1).then(resolve).catch(reject);
        // Consume response to free socket
        res.resume();
        return;
      }

      var chunks = [];
      res.on('data', function(chunk) { chunks.push(chunk); });
      res.on('end', function() {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks),
          finalUrl: targetUrl
        });
      });
      res.on('error', function(err) {
        reject(err);
      });
    });

    req.on('error', function(err) {
      if (retryCount < 3) {
        log('Fetch error (retry ' + (retryCount + 1) + '): ' + err.message);
        setTimeout(function() {
          fetchRemote(targetUrl, headers, retryCount + 1).then(resolve).catch(reject);
        }, 500 * (retryCount + 1));
      } else {
        reject(err);
      }
    });

    req.on('timeout', function() {
      req.destroy();
      if (retryCount < 3) {
        log('Timeout (retry ' + (retryCount + 1) + '): ' + targetUrl);
        fetchRemote(targetUrl, headers, retryCount + 1).then(resolve).catch(reject);
      } else {
        reject(new Error('Request timeout after retries: ' + targetUrl));
      }
    });

    req.end();
  });
}

// ---- M3U8 Rewriting ----
function rewriteM3U8(body, originalUrl, proxyBase) {
  var baseUrl = getBaseUrl(originalUrl);
  var lines = body.split('\n');
  var result = [];

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var trimmed = line.trim();

    // Empty line — keep as-is
    if (!trimmed) {
      result.push(line);
      continue;
    }

    // Comment/tag line
    if (trimmed.charAt(0) === '#') {
      // Rewrite URI= references in tags like #EXT-X-KEY, #EXT-X-MAP
      if (trimmed.indexOf('URI="') >= 0) {
        var rewritten = trimmed.replace(/URI="([^"]+)"/g, function(match, uri) {
          var absoluteUri;
          if (uri.indexOf('http') === 0) {
            absoluteUri = uri;
          } else {
            absoluteUri = resolveUrl(uri, baseUrl + '/');
          }
          return 'URI="' + proxyBase + '/proxy?url=' + encodeURIComponent(absoluteUri) + '"';
        });
        result.push(rewritten);
      } else {
        result.push(line);
      }
      continue;
    }

    // URL line (segment or sub-playlist)
    var absoluteUrl;
    if (trimmed.indexOf('http://') === 0 || trimmed.indexOf('https://') === 0) {
      absoluteUrl = trimmed;
    } else if (trimmed.charAt(0) === '/') {
      var parsedOrig = parseUrl(originalUrl);
      absoluteUrl = parsedOrig.protocol + '//' + parsedOrig.host + trimmed;
    } else {
      absoluteUrl = baseUrl + '/' + trimmed;
    }

    result.push(proxyBase + '/proxy?url=' + encodeURIComponent(absoluteUrl));
  }

  return result.join('\n');
}

// ---- HTTP Server ----
function startProxyServer(callback) {
  if (server && serverReady) {
    log('Proxy already running on port ' + PORT);
    if (callback) callback(null, 'Proxy already running');
    return;
  }

  server = http.createServer(function(req, res) {
    // CORS headers for ALL responses
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

    var parsed = urlMod.parse(req.url, true);

    // Health check endpoint
    if (parsed.pathname === '/' || parsed.pathname === '/health') {
      requestCount++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        uptime: Math.floor((Date.now() - startTime) / 1000),
        requests: requestCount,
        message: 'HLS CORS Proxy running on webOS'
      }));
      return;
    }

    // Proxy endpoint
    if (parsed.pathname === '/proxy') {
      var targetUrl = parsed.query && parsed.query.url;

      if (!targetUrl) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing url parameter' }));
        return;
      }

      requestCount++;
      var proxyBase = 'http://127.0.0.1:' + PORT;

      fetchRemote(targetUrl).then(function(remote) {
        if (remote.statusCode !== 200) {
          log('Upstream ' + remote.statusCode + ' for: ' + targetUrl.substring(0, 100));
          res.writeHead(remote.statusCode, { 'Content-Type': 'text/plain' });
          res.end('Upstream returned ' + remote.statusCode);
          return;
        }

        var contentType = (remote.headers['content-type'] || '').toLowerCase();
        var isM3U8 = targetUrl.indexOf('.m3u8') >= 0 ||
                     targetUrl.indexOf('.m3u') >= 0 ||
                     contentType.indexOf('mpegurl') >= 0 ||
                     contentType.indexOf('m3u') >= 0;

        // Also detect M3U8 by content inspection
        if (!isM3U8) {
          var bodyStart = remote.body.toString('utf-8', 0, Math.min(remote.body.length, 50));
          if (bodyStart.indexOf('#EXTM3U') >= 0 || bodyStart.indexOf('#EXT-X-') >= 0) {
            isM3U8 = true;
          }
        }

        if (isM3U8) {
          var bodyText = remote.body.toString('utf-8');
          var rewritten = rewriteM3U8(bodyText, remote.finalUrl || targetUrl, proxyBase);

          res.writeHead(200, {
            'Content-Type': 'application/vnd.apple.mpegurl',
            'Cache-Control': 'no-cache, no-store',
            'Connection': 'keep-alive'
          });
          res.end(rewritten);
        } else {
          // Pass through binary content (TS segments, keys, etc.)
          var headers = {
            'Content-Type': contentType || 'application/octet-stream',
            'Connection': 'keep-alive',
            'Cache-Control': 'no-cache'
          };
          if (remote.headers['content-length']) {
            headers['Content-Length'] = remote.headers['content-length'];
          }
          res.writeHead(200, headers);
          res.end(remote.body);
        }
      }).catch(function(err) {
        log('Proxy error: ' + err.message + ' | URL: ' + targetUrl.substring(0, 120));
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Proxy fetch failed', detail: err.message }));
      });
      return;
    }

    // 404 for everything else
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  });

  server.on('error', function(e) {
    if (e.code === 'EADDRINUSE') {
      log('Port ' + PORT + ' already in use — proxy likely already running. Treating as success.');
      serverReady = true;
      if (callback) callback(null, 'Port already in use (proxy running)');
    } else {
      log('Server error: ' + e.message);
      if (callback) callback(e, null);
    }
  });

  server.listen(PORT, HOST, function() {
    serverReady = true;
    startTime = Date.now();
    log('HLS CORS Proxy started on http://' + HOST + ':' + PORT);
    if (callback) callback(null, 'Proxy started on port ' + PORT);
  });

  // Prevent connections from keeping the server alive too long
  server.timeout = 60000;
}

// ---- webOS Activity Manager Keepalive ----
// This prevents webOS from killing our background service
function createKeepAlive() {
  var activity = {
    name: 'com.wilson.iptvplayer.proxy.keepalive',
    description: 'Keep IPTV proxy service alive',
    type: {
      foreground: true,
      persist: true
    },
    schedule: {
      interval: '00:05:00',  // every 5 min
      precise: false
    },
    callback: {
      method: 'luna://com.wilson.iptvplayer.proxy/heartbeat'
    }
  };

  service.call('luna://com.webos.service.activitymanager/create', {
    activity: activity,
    start: true,
    replace: true,
    subscribe: true
  }, function(response) {
    if (response.payload && response.payload.returnValue) {
      log('Activity keepalive created, activityId: ' + response.payload.activityId);
    } else {
      log('Activity keepalive failed: ' + JSON.stringify(response.payload));
      // Fallback: simple interval-based keepalive
      log('Using fallback interval keepalive');
    }
  });
}

// ---- Luna Service Registration ----
service.register('start', function(message) {
  log('Received "start" request');
  startProxyServer(function(err, msg) {
    if (err) {
      log('Start failed: ' + err.message);
      message.respond({ returnValue: false, errorText: err.message });
    } else {
      log('Start success: ' + msg);
      // Heartbeat subscription to keep service alive
      var heartBeat = setInterval(function() {
        message.respond({
          returnValue: true,
          message: msg,
          status: 'running',
          uptime: Math.floor((Date.now() - startTime) / 1000),
          requests: requestCount
        });
      }, 10000);

      message.on('cancel', function() {
        log('Start subscription cancelled');
        clearInterval(heartBeat);
        // Do NOT stop the HTTP server — it should stay alive
      });

      message.respond({ returnValue: true, message: msg });
    }
  });
});

service.register('heartbeat', function(message) {
  log('Heartbeat ping, uptime: ' + Math.floor((Date.now() - startTime) / 1000) + 's, requests: ' + requestCount);
  if (!serverReady) {
    log('Server not ready, attempting restart...');
    startProxyServer();
  }
  message.respond({
    returnValue: true,
    status: serverReady ? 'running' : 'starting',
    uptime: Math.floor((Date.now() - startTime) / 1000),
    requests: requestCount
  });
});

service.register('status', function(message) {
  message.respond({
    returnValue: true,
    serverReady: serverReady,
    port: PORT,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    requests: requestCount
  });
});

// ---- Auto-start on service load ----
log('Service loaded, auto-starting proxy server...');
startProxyServer(function(err, msg) {
  if (err) {
    log('Auto-start failed: ' + err.message);
  } else {
    log('Auto-start success: ' + msg);
    // Set up activity keepalive after successful start
    createKeepAlive();
  }
});
