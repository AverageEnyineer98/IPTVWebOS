const puppeteer = require('puppeteer');
const { spawn } = require('child_process');

async function testApp() {
  console.log('Starting proxy and app servers for testing...');
  
  const proxyProcess = spawn('npm', ['run', 'proxy']);
  const appProcess = spawn('npm', ['run', 'dev']);

  await new Promise(r => setTimeout(r, 4000));

  console.log('Servers started. Launching Chrome/Puppeteer...');
  
  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      '--no-sandbox', 
      '--disable-web-security', 
      '--autoplay-policy=no-user-gesture-required'
    ]
  });

  try {
    const page = await browser.newPage();
    
    // Track network errors for the current channel
    let currentNetworkErrors = [];
    page.on('response', response => {
      const status = response.status();
      if (status >= 400 && response.url().includes('/proxy')) {
        currentNetworkErrors.push({ url: response.url(), status });
      }
    });

    await page.goto('http://localhost:8888', { waitUntil: 'networkidle0', timeout: 15000 });
    
    await page.waitForSelector('#app:not(.hidden)', { timeout: 10000 });
    console.log('App loaded successfully.');

    // Switch to China tab
    await page.click('#tab-cn');
    await page.waitForSelector('#tab-cn.active', { timeout: 2000 });
    await page.waitForSelector('.channel-item', { timeout: 10000 });

    // Get all channels
    const channels = await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll('.channel-item'));
      return items.map(el => ({
        index: el.dataset.channelIndex,
        name: el.querySelector('.channel-name').textContent,
        id: el.id
      }));
    });

    const cctvChannels = channels.filter(c => c.name.toLowerCase().includes('cctv'));
    console.log(`Found ${cctvChannels.length} CCTV channels. Testing playback for each...`);

    const results = [];

    for (let i = 0; i < cctvChannels.length; i++) {
      const ch = cctvChannels[i];
      console.log(`\nTesting [${i+1}/${cctvChannels.length}] ${ch.name}...`);
      
      currentNetworkErrors = []; // Reset errors for this channel
      
      // Click channel
      await page.click(`#${ch.id}`);
      
      // Wait up to 10 seconds for video to start playing
      let isPlaying = false;
      for (let w = 0; w < 10; w++) {
        await new Promise(r => setTimeout(r, 1000));
        isPlaying = await page.evaluate(() => {
          const video = document.getElementById('video-player');
          return !video.paused && video.readyState >= 3; // HAVE_FUTURE_DATA
        });
        if (isPlaying) break;
      }
      
      if (isPlaying) {
        console.log(`✅ ${ch.name} is PLAYING.`);
        results.push({ name: ch.name, status: 'PLAYING', errors: currentNetworkErrors });
      } else {
        console.log(`❌ ${ch.name} FAILED to play.`);
        if (currentNetworkErrors.length > 0) {
          console.log(`   Network Errors:`);
          currentNetworkErrors.slice(0, 3).forEach(err => {
            // decode the proxy url to show the actual url
            let actualUrl = err.url;
            try {
              const urlObj = new URL(err.url);
              actualUrl = decodeURIComponent(urlObj.searchParams.get('url'));
            } catch(e){}
            console.log(`   - Status ${err.status}: ${actualUrl}`);
          });
        }
        results.push({ name: ch.name, status: 'FAILED', errors: currentNetworkErrors });
      }
    }

    console.log('\n=== FINAL SUMMARY ===');
    const working = results.filter(r => r.status === 'PLAYING').length;
    console.log(`Working: ${working}/${cctvChannels.length}`);
    const failed = results.filter(r => r.status === 'FAILED');
    if (failed.length > 0) {
      console.log('Failed Channels:');
      failed.forEach(f => {
         const uniqueStatuses = [...new Set(f.errors.map(e => e.status))].join(',');
         console.log(`- ${f.name} (HTTP ${uniqueStatuses || 'timeout'})`);
      });
    }

    process.exit(0);
  } catch (error) {
    console.error('Test failed:', error);
    process.exit(1);
  } finally {
    await browser.close();
    proxyProcess.kill();
    appProcess.kill();
  }
}

testApp();