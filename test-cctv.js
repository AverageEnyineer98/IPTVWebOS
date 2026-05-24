const fs = require('fs');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');

async function fetchM3u(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

function parseM3u(data) {
  const lines = data.split('\n');
  const channels = [];
  let currentChannel = null;
  
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#EXTINF:')) {
      const nameMatch = trimmed.match(/,(.+)$/);
      const name = nameMatch ? nameMatch[1].trim() : 'Unknown';
      currentChannel = { name };
    } else if (trimmed && !trimmed.startsWith('#') && currentChannel) {
      currentChannel.url = trimmed;
      channels.push(currentChannel);
      currentChannel = null;
    }
  }
  return channels;
}

async function testUrlThroughProxy(targetUrl) {
  const proxyUrl = `http://localhost:8889/proxy?url=${encodeURIComponent(targetUrl)}`;
  return new Promise((resolve) => {
    http.get(proxyUrl, (res) => {
      // Consume response data to free up memory
      res.resume();
      resolve(res.statusCode);
    }).on('error', (err) => {
      resolve(`Error: ${err.message}`);
    });
  });
}

async function runTests() {
  console.log('Starting proxy server...');
  const proxyProcess = spawn('node', ['proxy.js']);
  
  // Wait for proxy to start
  await new Promise(r => setTimeout(r, 2000));

  console.log('Fetching CN playlist...');
  const m3uData = await fetchM3u('https://iptv-org.github.io/iptv/countries/cn.m3u');
  const allChannels = parseM3u(m3uData);
  
  const cctvChannels = allChannels.filter(c => c.name.toLowerCase().includes('cctv'));
  console.log(`Found ${cctvChannels.length} CCTV channels. Testing them...`);

  const results = { 200: [], 404: [], other: [] };

  for (let i = 0; i < cctvChannels.length; i++) {
    const ch = cctvChannels[i];
    const status = await testUrlThroughProxy(ch.url);
    console.log(`[${i+1}/${cctvChannels.length}] ${ch.name} -> ${status}`);
    
    if (status === 200) results[200].push(ch.name);
    else if (status === 404) results[404].push(ch.name);
    else results.other.push({ name: ch.name, status });
  }

  console.log('\n--- Summary ---');
  console.log(`Working (200): ${results[200].length}`);
  console.log(`Not Found (404): ${results[404].length}`);
  console.log(`Other: ${results.other.length}`);
  
  if (results[404].length > 0) {
    console.log('\nSample 404 channels:');
    const sample404 = cctvChannels.filter(c => results[404].includes(c.name)).slice(0, 5);
    sample404.forEach(c => console.log(`${c.name} - ${c.url}`));
  }

  if (results.other.length > 0) {
    console.log('\nSample Other channels:');
    results.other.slice(0, 5).forEach(c => {
      const ch = cctvChannels.find(x => x.name === c.name);
      console.log(`${c.name} - Status: ${c.status} - ${ch.url}`);
    });
  }

  proxyProcess.kill();
}

runTests().catch(console.error);