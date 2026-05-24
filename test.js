const puppeteer = require('puppeteer');
const { spawn } = require('child_process');

async function testApp() {
  console.log('Starting proxy and app servers for testing...');
  
  // Start the proxy and app server
  const proxyProcess = spawn('npm', ['run', 'proxy']);
  const appProcess = spawn('npm', ['run', 'dev']);

  // Give servers a few seconds to start
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
    
    // Enable console logging from the browser
    page.on('console', msg => console.log('BROWSER LOG:', msg.text()));
    page.on('pageerror', err => console.error('BROWSER ERROR:', err.toString()));
    
    // Navigate to the app
    console.log('Navigating to http://localhost:8888 ...');
    await page.goto('http://localhost:8888', { waitUntil: 'networkidle0', timeout: 15000 });
    
    console.log('Checking if splash screen hides and app shows up...');
    await page.waitForSelector('#app:not(.hidden)', { timeout: 10000 });
    console.log('App loaded successfully.');

    // Test History tab
    console.log('Clicking on History tab...');
    await page.click('#tab-hist');
    await page.waitForSelector('#tab-hist.active', { timeout: 2000 });
    console.log('History tab activated.');
    
    // Test China tab
    console.log('Clicking on China tab...');
    await page.click('#tab-cn');
    await page.waitForSelector('#tab-cn.active', { timeout: 2000 });
    console.log('China tab activated. Wait for channels...');

    // Wait for channel list to populate
    await page.waitForSelector('.channel-item', { timeout: 10000 });
    const channelCount = await page.evaluate(() => document.querySelectorAll('.channel-item').length);
    console.log(`Found ${channelCount} China channels.`);

    if (channelCount > 0) {
      console.log('Attempting to play the first channel...');
      await page.click('.channel-item');
      
      // Wait a few seconds to verify it doesn't crash immediately and HLS starts
      await new Promise(r => setTimeout(r, 10000));
      
      const isPlaying = await page.evaluate(() => {
        const video = document.getElementById('video-player');
        // readyState >= 2 means HAVE_CURRENT_DATA
        return !video.paused && video.readyState >= 2;
      });
      console.log(`Video playing status after 10 seconds: ${isPlaying ? 'PLAYING' : 'BUFFERING/FAILED'}`);
    }

    console.log('Auto-testing completed successfully!');
    process.exit(0);
  } catch (error) {
    console.error('Test failed:', error);
    process.exit(1);
  } finally {
    console.log('Cleaning up...');
    await browser.close();
    proxyProcess.kill();
    appProcess.kill();
  }
}

testApp();