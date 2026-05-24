/* ============================================================
   IPTV Player for webOS — v2 Complete Rewrite
   Features: Hierarchical nav, OSD, subtitles, auto-retry,
   favorites, last-channel memory, webOS remote keycodes
   ============================================================ */
(function () {
  'use strict';

  // ---- Config ----
  const PROXY_BASE = 'http://localhost:8889';
  const M3U_SOURCES = [
    { region: 'hk', label: '香港', url: 'https://iptv-org.github.io/iptv/countries/hk.m3u' },
    { region: 'cn', label: '中國', url: 'https://iptv-org.github.io/iptv/countries/cn.m3u' },
  ];
  const MAX_RETRIES = 5;
  const RETRY_DELAYS = [3000, 5000, 8000, 12000, 20000];

  function proxyUrl(u) { return PROXY_BASE + '/proxy?url=' + encodeURIComponent(u); }

  const CAT = {
    'all':'全部','General':'綜合','News':'新聞','Entertainment':'娛樂','Movies':'電影',
    'Sports':'體育','Kids':'少兒','Education':'教育','Music':'音樂','Documentary':'紀錄',
    'Business':'財經','Lifestyle':'生活','Culture':'文化','Religious':'宗教','Science':'科學',
    'Shop':'購物','Animation':'動畫','Weather':'天氣','Comedy':'喜劇','Family':'家庭',
    'Outdoor':'戶外','Legislative':'法治','Undefined':'其他',
  };

  // ---- webOS Remote Keycodes ----
  const KEY = {
    UP: 38, DOWN: 40, LEFT: 37, RIGHT: 39,
    ENTER: 13, BACK: 461, BACKSPACE: 8,
    RED: 403, GREEN: 404, YELLOW: 405, BLUE: 406,
    PLAY: 415, PAUSE: 19, STOP: 413, REW: 412, FF: 417,
    CH_UP: 33, CH_DOWN: 34, // PageUp/PageDown map to CH+/CH-
    INFO: 457,
    NUM0: 48, NUM1: 49, NUM2: 50, NUM3: 51, NUM4: 52,
    NUM5: 53, NUM6: 54, NUM7: 55, NUM8: 56, NUM9: 57,
  };

  // ---- State ----
  let allChannels = [], filteredChannels = [];
  let currentChannelIndex = -1, currentRegion = 'all', currentCategory = 'all';
  let hlsInstance = null, osdTimeout = null, sidebarOpen = true;
  let favorites = JSON.parse(localStorage.getItem('iptv_favs') || '[]');
  let watchHistory = JSON.parse(localStorage.getItem('iptv_history') || '[]');
  let lastChannel = parseInt(localStorage.getItem('iptv_last') || '-1');
  let subtitlesOn = true, retryCount = 0, retryTimer = null;
  let channelHistory = [];

  // Hierarchy: 'tabs' -> 'categories' -> 'channels'
  let navZone = 'channels';
  let tabIdx = 0, catIdx = 0, chIdx = 0;
  let numInputBuffer = '', numInputTimer = null;

  // ---- DOM ----
  const $ = id => document.getElementById(id);
  const splash = $('splash-screen'), app = $('app'), video = $('video-player');
  const chListEl = $('channel-list'), chCount = $('channel-count');
  const osd = $('channel-osd'), osdLogo = $('osd-logo'), osdNum = $('osd-number');
  const osdName = $('osd-name'), osdQual = $('osd-quality');
  const osdProg = $('osd-programme'), osdTime = $('osd-time');
  const osdProgBar = $('osd-progress-bar');
  const playerStatus = $('player-status'), statusIcon = $('status-icon');
  const statusText = $('status-text'), retryInfo = $('retry-info');
  const subIndicator = $('subtitle-indicator'), subLabel = $('subtitle-label');
  const regionTabs = $('region-tabs'), catFilter = $('category-filter');
  const chListContainer = $('channel-list-container');
  const toast = $('toast');

  // ---- M3U Parser ----
  function parseM3U(text, region) {
    const lines = text.split('\n'), chs = [];
    let cur = null;
    for (const raw of lines) {
      const line = raw.trim();
      if (line.startsWith('#EXTINF:')) {
        cur = { region };
        const logo = line.match(/tvg-logo="([^"]*)"/);
        cur.logo = logo ? logo[1] : '';
        const grp = line.match(/group-title="([^"]*)"/);
        cur.group = grp ? grp[1].split(';')[0] : 'Undefined';
        const nm = line.match(/,(.+)$/);
        cur.name = nm ? nm[1].trim() : 'Unknown';
        const q = cur.name.match(/\((\d+[pi]|4K|8K)\)/i);
        cur.quality = q ? q[1] : '';
        cur.geoBlocked = /\[Geo-blocked\]/i.test(cur.name);
      } else if (line && !line.startsWith('#') && cur) {
        cur.url = line;
        chs.push(cur);
        cur = null;
      }
    }
    return chs;
  }

  async function fetchAllChannels() {
    const results = await Promise.allSettled(
      M3U_SOURCES.map(async s => {
        const r = await fetch(s.url); if (!r.ok) throw new Error('HTTP ' + r.status);
        return parseM3U(await r.text(), s.region);
      })
    );
    let chs = [];
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') chs = chs.concat(r.value);
      else console.warn('Failed ' + M3U_SOURCES[i].label, r.reason);
    });
    chs.forEach((c, i) => { c.index = i; c.number = i + 1; });
    return chs;
  }

  // ---- Favorites ----
  function isFav(ch) { return favorites.includes(ch.name); }
  function toggleFav(ch) {
    const i = favorites.indexOf(ch.name);
    if (i >= 0) { favorites.splice(i, 1); showToast('已取消收藏: ' + ch.name); }
    else { favorites.push(ch.name); showToast('⭐ 已收藏: ' + ch.name); }
    localStorage.setItem('iptv_favs', JSON.stringify(favorites));
    if (currentRegion === 'fav') applyFilters();
    else renderChannelList(); // refresh star icons
  }

  // ---- Toast ----
  function showToast(msg) {
    toast.textContent = msg;
    toast.classList.remove('hidden');
    toast.style.animation = 'none'; toast.offsetHeight; toast.style.animation = '';
    setTimeout(() => toast.classList.add('hidden'), 2500);
  }

  // ---- Build Categories ----
  function buildCategories() {
    const cats = new Set();
    filteredChannels.forEach(c => cats.add(c.group));
    catFilter.innerHTML = '';
    function mk(cat, label) {
      const b = document.createElement('button');
      b.className = 'category-btn' + (currentCategory === cat ? ' active' : '');
      b.dataset.category = cat; b.textContent = label;
      b.setAttribute('tabindex', '-1');
      b.addEventListener('click', () => { currentCategory = cat; applyFilters(); });
      return b;
    }
    catFilter.appendChild(mk('all', '全部'));
    Array.from(cats).sort().forEach(c => catFilter.appendChild(mk(c, CAT[c] || c)));
  }

  // ---- Render Channel List ----
  function renderChannelList() {
    chListEl.innerHTML = '';
    filteredChannels.forEach((ch, i) => {
      const li = document.createElement('li');
      li.className = 'channel-item' + (ch.index === currentChannelIndex ? ' active' : '');
      li.dataset.channelIndex = ch.index; li.dataset.filteredIndex = i;
      li.setAttribute('tabindex', '-1'); li.id = 'channel-' + ch.index;
      const logoH = ch.logo
        ? '<img class="channel-logo" src="'+ch.logo+'" alt="" loading="lazy" onerror="this.parentElement.innerHTML=\'<span class=channel-logo-placeholder>📺</span>\'">'
        : '<span class="channel-logo-placeholder">📺</span>';
      const favStar = isFav(ch) ? '<span class="channel-fav">⭐</span>' : '';
      li.innerHTML =
        '<span class="channel-number">' + ch.number + '</span>' +
        '<div class="channel-logo-wrapper">' + logoH + '</div>' +
        '<div class="channel-info"><div class="channel-name">' + ch.name + '</div>' +
        '<div class="channel-meta"><span class="channel-group">' + (CAT[ch.group]||ch.group) + '</span>' +
        (ch.quality ? '<span class="channel-quality">'+ch.quality+'</span>' : '') +
        '</div></div>' + favStar +
        (ch.index === currentChannelIndex ? '<div class="channel-status-dot"></div>' : '');
      li.addEventListener('click', () => playChannel(ch.index));
      chListEl.appendChild(li);
    });
    chCount.textContent = filteredChannels.length + ' 個頻道';
  }

  // ---- Filters ----
  function applyFilters() {
    filteredChannels = allChannels.filter(ch => {
      if (currentRegion === 'fav') return isFav(ch);
      if (currentRegion === 'hist') return watchHistory.includes(ch.name);
      if (currentRegion !== 'all' && ch.region !== currentRegion) return false;
      if (currentCategory !== 'all' && ch.group !== currentCategory) return false;
      return true;
    });
    if (currentRegion === 'hist') {
      filteredChannels.sort((a, b) => watchHistory.indexOf(a.name) - watchHistory.indexOf(b.name));
    }
    buildCategories(); renderChannelList();
    if (filteredChannels.length > 0) {
      chIdx = 0;
      const pi = filteredChannels.findIndex(c => c.index === currentChannelIndex);
      if (pi >= 0) chIdx = pi;
    }
    if (navZone === 'channels') focusCh(chIdx);
  }

  // ---- HLS Player with Auto-Retry ----
  function playChannel(idx) {
    const ch = allChannels[idx]; if (!ch) return;
    clearRetry();
    // Push history
    if (currentChannelIndex >= 0 && currentChannelIndex !== idx)
      channelHistory.push(currentChannelIndex);
    if (channelHistory.length > 50) channelHistory.shift();

    currentChannelIndex = idx;
    localStorage.setItem('iptv_last', idx);

    // Update active states
    document.querySelectorAll('.channel-item').forEach(el => {
      const ci = parseInt(el.dataset.channelIndex);
      el.classList.toggle('active', ci === idx);
      const dot = el.querySelector('.channel-status-dot');
      if (ci === idx && !dot) { const d = document.createElement('div'); d.className='channel-status-dot'; el.appendChild(d); }
      else if (ci !== idx && dot) dot.remove();
    });

    showOSD(ch); showStatus('⏳', '正在載入...'); retryCount = 0;
    loadStream(ch);
  }

  function loadStream(ch) {
    if (hlsInstance) { hlsInstance.destroy(); hlsInstance = null; }
    const url = proxyUrl(ch.url);

    if (typeof Hls !== 'undefined' && Hls.isSupported()) {
      hlsInstance = new Hls({
        enableWorker: true, lowLatencyMode: false,
        maxBufferLength: 30, maxMaxBufferLength: 60, startLevel: -1,
        fragLoadingTimeOut: 20000, manifestLoadingTimeOut: 20000, levelLoadingTimeOut: 20000,
        maxLoadingDelay: 10, maxBufferHole: 1.5,
      });
      hlsInstance.loadSource(url);
      hlsInstance.attachMedia(video);
      hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => { video.play().catch(()=>{}); hideStatus(); });
      hlsInstance.on(Hls.Events.FRAG_BUFFERED, () => hideStatus());
      hlsInstance.on(Hls.Events.ERROR, (_, d) => {
        if (!d.fatal) return;
        console.warn('HLS Fatal:', d.type, d.details);
        if (d.type === Hls.ErrorTypes.MEDIA_ERROR) { hlsInstance.recoverMediaError(); return; }
        scheduleRetry(ch);
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = url;
      video.addEventListener('loadedmetadata', () => { video.play().catch(()=>{}); hideStatus(); }, { once: true });
      video.addEventListener('error', () => scheduleRetry(ch), { once: true });
    } else { showStatus('❌', '不支援 HLS 播放'); }
  }

  function scheduleRetry(ch) {
    if (retryCount >= MAX_RETRIES) {
      showStatus('❌', '無法播放: ' + ch.name);
      retryInfo.textContent = '已重試 ' + MAX_RETRIES + ' 次。按 OK 重試或換台';
      retryInfo.classList.remove('hidden');
      return;
    }
    retryCount++;
    const delay = RETRY_DELAYS[Math.min(retryCount - 1, RETRY_DELAYS.length - 1)];
    showStatus('🔄', '連線中斷，' + (delay/1000) + '秒後重試 (' + retryCount + '/' + MAX_RETRIES + ')');
    retryInfo.classList.add('hidden');
    retryTimer = setTimeout(() => loadStream(ch), delay);
  }

  function clearRetry() {
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    retryCount = 0; retryInfo.classList.add('hidden');
  }

  // ---- OSD (top-left popup) ----
  function showOSD(ch) {
    if (osdTimeout) clearTimeout(osdTimeout);
    osdNum.textContent = 'CH ' + ch.number;
    osdName.textContent = ch.name;
    osdQual.textContent = ch.quality || 'SD';
    if (ch.logo) { osdLogo.src = ch.logo; osdLogo.style.display = ''; } else { osdLogo.style.display = 'none'; }
    // Programme info placeholder
    const now = new Date();
    osdProg.textContent = (CAT[ch.group] || ch.group) + ' · 直播中';
    osdTime.textContent = now.getHours().toString().padStart(2,'0') + ':' + now.getMinutes().toString().padStart(2,'0');
    osdProgBar.style.width = Math.round((now.getMinutes()/60)*100) + '%';
    osd.classList.remove('hidden');
    osdTimeout = setTimeout(() => osd.classList.add('hidden'), 5000);
  }

  // ---- Status ----
  function showStatus(icon, text) { statusIcon.textContent = icon; statusText.textContent = text; playerStatus.classList.remove('hidden'); }
  function hideStatus() { playerStatus.classList.add('hidden'); }

  // ---- Subtitles ----
  function toggleSubtitles() {
    subtitlesOn = !subtitlesOn;
    if (video.textTracks) {
      for (let i = 0; i < video.textTracks.length; i++)
        video.textTracks[i].mode = subtitlesOn ? 'showing' : 'hidden';
    }
    subLabel.textContent = '字幕: ' + (subtitlesOn ? '開啟' : '關閉');
    subIndicator.classList.remove('hidden');
    subIndicator.style.animation = 'none'; subIndicator.offsetHeight; subIndicator.style.animation = '';
    setTimeout(() => subIndicator.classList.add('hidden'), 2000);
    showToast('字幕 ' + (subtitlesOn ? '已開啟' : '已關閉'));
  }

  // ---- Sidebar ----
  function openSidebar() { sidebarOpen = true; app.classList.add('sidebar-open'); navZone = 'channels'; focusCh(chIdx); }
  function closeSidebar() { sidebarOpen = false; app.classList.remove('sidebar-open'); navZone = 'player'; clearFocus(); }

  // ---- Focus ----
  function clearFocus() { document.querySelectorAll('.focused').forEach(e => e.classList.remove('focused')); }
  function focusCh(i) {
    clearFocus();
    const items = chListEl.querySelectorAll('.channel-item');
    if (i < 0 || i >= items.length) return;
    chIdx = i; items[i].classList.add('focused'); scrollTo(items[i]);
  }
  function focusTab(i) { clearFocus(); const t = regionTabs.querySelectorAll('.region-tab'); if (i>=0&&i<t.length) { tabIdx=i; t[i].classList.add('focused'); } }
  function focusCat(i) { clearFocus(); const b = catFilter.querySelectorAll('.category-btn'); if (i>=0&&i<b.length) { catIdx=i; b[i].classList.add('focused'); } }
  function scrollTo(el) {
    const c = chListContainer, cr = c.getBoundingClientRect(), er = el.getBoundingClientRect();
    if (er.top < cr.top) c.scrollTop -= (cr.top - er.top + 20);
    else if (er.bottom > cr.bottom) c.scrollTop += (er.bottom - cr.bottom + 20);
  }

  // ---- Hierarchical Navigation ----
  // Region → Category → Channel. ENTER = drill down, BACK = go up.
  function handleKey(e) {
    const kc = e.keyCode;
    if ([KEY.UP,KEY.DOWN,KEY.LEFT,KEY.RIGHT,KEY.ENTER,KEY.BACK,KEY.BACKSPACE,
         KEY.RED,KEY.GREEN,KEY.YELLOW,KEY.BLUE,KEY.CH_UP,KEY.CH_DOWN,KEY.INFO].includes(kc)
        || (kc >= KEY.NUM0 && kc <= KEY.NUM9)) {
      e.preventDefault();
    }

    // Number input for direct channel jump
    if (kc >= KEY.NUM0 && kc <= KEY.NUM9) { handleNumInput(kc - KEY.NUM0); return; }

    // Global keys (work in any state)
    if (kc === KEY.YELLOW) { // Toggle favorite
      const ch = allChannels[currentChannelIndex]; if (ch) toggleFav(ch); return;
    }
    if (kc === KEY.BLUE || kc === 67) { toggleSubtitles(); return; } // Blue or 'c' key
    if (kc === KEY.RED) { // Go back to previous channel
      if (channelHistory.length > 0) { playChannel(channelHistory.pop()); } return;
    }
    if (kc === KEY.GREEN || kc === KEY.INFO || kc === 73) { // Show OSD info (Green or 'i')
      const ch = allChannels[currentChannelIndex]; if (ch) showOSD(ch); return;
    }
    if (kc === KEY.CH_UP) { navChannel(-1); return; }
    if (kc === KEY.CH_DOWN) { navChannel(1); return; }

    // Sidebar closed = player mode
    if (!sidebarOpen) {
      if (kc === KEY.RIGHT || kc === KEY.ENTER) { openSidebar(); return; }
      if (kc === KEY.UP) { navChannel(-1); return; }
      if (kc === KEY.DOWN) { navChannel(1); return; }
      if (kc === KEY.BACK || kc === KEY.BACKSPACE) { openSidebar(); return; }
      return;
    }

    // Sidebar open — hierarchical
    switch (navZone) {
      case 'tabs': navTabs(kc); break;
      case 'categories': navCats(kc); break;
      case 'channels': navChs(kc); break;
    }
  }

  function navTabs(kc) {
    const tabs = regionTabs.querySelectorAll('.region-tab');
    switch (kc) {
      case KEY.LEFT: if (tabIdx > 0) focusTab(--tabIdx); break;
      case KEY.RIGHT: if (tabIdx < tabs.length-1) focusTab(++tabIdx); break;
      case KEY.ENTER: // Drill down: select region, go to categories
        currentRegion = tabs[tabIdx].dataset.region; currentCategory = 'all';
        tabs.forEach(t => t.classList.remove('active')); tabs[tabIdx].classList.add('active');
        applyFilters(); navZone = 'categories'; catIdx = 0; focusCat(0); break;
      case KEY.DOWN: navZone = 'categories'; focusCat(catIdx); break;
      case KEY.BACK: case KEY.BACKSPACE: closeSidebar(); break;
    }
  }

  function navCats(kc) {
    const btns = catFilter.querySelectorAll('.category-btn');
    switch (kc) {
      case KEY.LEFT: if (catIdx > 0) focusCat(--catIdx); break;
      case KEY.RIGHT: if (catIdx < btns.length-1) focusCat(++catIdx); break;
      case KEY.ENTER: // Drill down: select category, go to channels
        currentCategory = btns[catIdx].dataset.category;
        btns.forEach(b => b.classList.remove('active')); btns[catIdx].classList.add('active');
        applyFilters(); navZone = 'channels'; chIdx = 0; focusCh(0); break;
      case KEY.UP: navZone = 'tabs'; focusTab(tabIdx); break;
      case KEY.DOWN: navZone = 'channels'; focusCh(chIdx); break;
      case KEY.BACK: case KEY.BACKSPACE: navZone = 'tabs'; focusTab(tabIdx); break;
    }
  }

  function navChs(kc) {
    const items = chListEl.querySelectorAll('.channel-item');
    if (items.length === 0) return;
    switch (kc) {
      case KEY.UP: 
        if (chIdx > 0) focusCh(--chIdx); 
        else { navZone = 'categories'; focusCat(catIdx); }
        break;
      case KEY.DOWN: if (chIdx < items.length-1) focusCh(++chIdx); break;
      case KEY.ENTER:
        const ci = parseInt(items[chIdx].dataset.channelIndex);
        playChannel(ci); setTimeout(() => closeSidebar(), 300); break;
      case KEY.BACK: case KEY.BACKSPACE: // Go up to categories
        navZone = 'categories'; focusCat(catIdx); break;
      case KEY.LEFT: closeSidebar(); break;
      case KEY.RIGHT: closeSidebar(); break;
    }
  }

  // ---- Number Input (direct channel jump) ----
  function handleNumInput(num) {
    numInputBuffer += num;
    showToast('頻道: ' + numInputBuffer);
    if (numInputTimer) clearTimeout(numInputTimer);
    numInputTimer = setTimeout(() => {
      const n = parseInt(numInputBuffer);
      numInputBuffer = '';
      const ch = allChannels.find(c => c.number === n);
      if (ch) { playChannel(ch.index); showToast('切換至 CH' + n + ': ' + ch.name); }
      else showToast('找不到頻道 ' + n);
    }, 1500);
  }

  // ---- Channel Navigate (from player view) ----
  function navChannel(dir) {
    if (filteredChannels.length === 0) return;
    let i = filteredChannels.findIndex(c => c.index === currentChannelIndex);
    if (i < 0) i = 0;
    i += dir;
    if (i < 0) i = filteredChannels.length - 1;
    if (i >= filteredChannels.length) i = 0;
    chIdx = i; playChannel(filteredChannels[i].index);
  }

  // ---- Splash ----
  function hideSplash() {
    splash.classList.add('fade-out'); app.classList.remove('hidden'); app.classList.add('sidebar-open');
    setTimeout(() => splash.classList.add('hidden'), 500);
  }

  // ---- Init ----
  async function init() {
    try {
      allChannels = await fetchAllChannels();
      console.log('Loaded ' + allChannels.length + ' channels');
      filteredChannels = [...allChannels];
      buildCategories(); renderChannelList(); hideSplash();
      // Resume last channel or play first
      const startIdx = (lastChannel >= 0 && lastChannel < allChannels.length) ? lastChannel : 0;
      if (allChannels.length > 0) { chIdx = 0; playChannel(startIdx); focusCh(chIdx); }
    } catch (err) {
      console.error('Init failed:', err);
      document.querySelector('.splash-subtitle').textContent = '載入失敗，請檢查網絡連線';
    }
  }

  // ---- Event Listeners ----
  document.addEventListener('keydown', handleKey);
  regionTabs.addEventListener('click', e => {
    const t = e.target.closest('.region-tab'); if (!t) return;
    currentRegion = t.dataset.region; currentCategory = 'all';
    regionTabs.querySelectorAll('.region-tab').forEach(x => x.classList.remove('active'));
    t.classList.add('active'); applyFilters();
  });
  video.addEventListener('waiting', () => showStatus('⏳', '正在緩衝...'));
  video.addEventListener('playing', () => hideStatus());
  video.addEventListener('error', () => {
    if (currentChannelIndex >= 0) scheduleRetry(allChannels[currentChannelIndex]);
  });

  // ---- Boot ----
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
