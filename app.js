/* ============================================================
   IPTV Player for webOS — v3 (Fully Independent)
   Features: Embedded proxy health-check, direct-play fallback,
   hierarchical nav, OSD, subtitles, auto-retry,
   favorites, last-channel memory, watch history,
   webOS remote keycodes
   ============================================================ */
(function () {
  'use strict';

  // ---- Config ----
  var PROXY_PORT = 8889;
  var PROXY_BASE = 'http://127.0.0.1:' + PROXY_PORT;
  var M3U_SOURCES = [
    { region: 'hk', label: '香港', url: 'https://iptv-org.github.io/iptv/countries/hk.m3u' },
    { region: 'cn', label: '中國', url: 'https://iptv-org.github.io/iptv/countries/cn.m3u' },
  ];
  var MAX_RETRIES = 5;
  var RETRY_DELAYS = [3000, 5000, 8000, 12000, 20000];
  var PROXY_HEALTH_TIMEOUT = 30000; // max ms to wait for proxy
  var PROXY_HEALTH_INTERVAL = 500;  // poll interval

  var proxyAvailable = false;

  function proxyUrl(u) { return PROXY_BASE + '/proxy?url=' + encodeURIComponent(u); }

  var CAT = {
    'all':'全部','General':'綜合','News':'新聞','Entertainment':'娛樂','Movies':'電影',
    'Sports':'體育','Kids':'少兒','Education':'教育','Music':'音樂','Documentary':'紀錄',
    'Business':'財經','Lifestyle':'生活','Culture':'文化','Religious':'宗教','Science':'科學',
    'Shop':'購物','Animation':'動畫','Weather':'天氣','Comedy':'喜劇','Family':'家庭',
    'Outdoor':'戶外','Legislative':'法治','Undefined':'其他',
  };

  // ---- webOS Remote Keycodes ----
  var KEY = {
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
  var allChannels = [], filteredChannels = [];
  var currentChannelIndex = -1, currentRegion = 'all', currentCategory = 'all';
  var hlsInstance = null, osdTimeout = null, sidebarOpen = true;
  var favorites = JSON.parse(localStorage.getItem('iptv_favs') || '[]');
  var watchHistory = JSON.parse(localStorage.getItem('iptv_history') || '[]');
  var lastChannel = parseInt(localStorage.getItem('iptv_last') || '-1');
  var subtitlesOn = true, retryCount = 0, retryTimer = null;
  var channelHistory = [];

  // Hierarchy: 'tabs' -> 'categories' -> 'channels'
  var navZone = 'channels';
  var tabIdx = 0, catIdx = 0, chIdx = 0;
  var numInputBuffer = '', numInputTimer = null;

  // ---- DOM ----
  var $ = function(id) { return document.getElementById(id); };
  var splash = $('splash-screen'), app = $('app'), video = $('video-player');
  var chListEl = $('channel-list'), chCount = $('channel-count');
  var osd = $('channel-osd'), osdLogo = $('osd-logo'), osdNum = $('osd-number');
  var osdName = $('osd-name'), osdQual = $('osd-quality');
  var osdProg = $('osd-programme'), osdTime = $('osd-time');
  var osdProgBar = $('osd-progress-bar');
  var playerStatus = $('player-status'), statusIcon = $('status-icon');
  var statusText = $('status-text'), retryInfo = $('retry-info');
  var subIndicator = $('subtitle-indicator'), subLabel = $('subtitle-label');
  var regionTabs = $('region-tabs'), catFilter = $('category-filter');
  var chListContainer = $('channel-list-container');
  var toast = $('toast');
  var splashSubtitle = document.querySelector('.splash-subtitle');

  // ---- M3U Parser ----
  function parseM3U(text, region) {
    var lines = text.split('\n'), chs = [];
    var cur = null;
    for (var li = 0; li < lines.length; li++) {
      var line = lines[li].trim();
      if (line.indexOf('#EXTINF:') === 0) {
        cur = { region: region };
        var logo = line.match(/tvg-logo="([^"]*)"/);
        cur.logo = logo ? logo[1] : '';
        var grp = line.match(/group-title="([^"]*)"/);
        cur.group = grp ? grp[1].split(';')[0] : 'Undefined';
        var nm = line.match(/,(.+)$/);
        cur.name = nm ? nm[1].trim() : 'Unknown';
        var q = cur.name.match(/\((\d+[pi]|4K|8K)\)/i);
        cur.quality = q ? q[1] : '';
        cur.geoBlocked = /\[Geo-blocked\]/i.test(cur.name);
      } else if (line && line.indexOf('#') !== 0 && cur) {
        cur.url = line;
        chs.push(cur);
        cur = null;
      }
    }
    return chs;
  }

  // ---- Proxy Health Check ----
  function waitForProxy() {
    return new Promise(function(resolve) {
      var elapsed = 0;

      // First, try to start the proxy via Luna service
      if (window.webOS && window.webOS.service) {
        splashSubtitle.textContent = '正在啟動代理服務...';
        window.webOS.service.request('luna://com.wilson.iptvplayer.proxy', {
          method: 'start',
          parameters: {},
          onSuccess: function(args) {
            console.log('Proxy service start response:', JSON.stringify(args));
          },
          onFailure: function(args) {
            console.warn('Proxy service start failed:', JSON.stringify(args));
          }
        });
      }

      function check() {
        var xhr = new XMLHttpRequest();
        xhr.open('GET', PROXY_BASE + '/health', true);
        xhr.timeout = 2000;
        xhr.onload = function() {
          if (xhr.status === 200) {
            console.log('Proxy is ready!');
            proxyAvailable = true;
            resolve(true);
          } else {
            retry();
          }
        };
        xhr.onerror = function() { retry(); };
        xhr.ontimeout = function() { retry(); };
        xhr.send();
      }

      function retry() {
        elapsed += PROXY_HEALTH_INTERVAL;
        if (elapsed >= PROXY_HEALTH_TIMEOUT) {
          console.warn('Proxy health check timed out after ' + PROXY_HEALTH_TIMEOUT + 'ms. Will try direct playback.');
          proxyAvailable = false;
          resolve(false);
          return;
        }
        splashSubtitle.textContent = '正在等待代理服務啟動... (' + Math.floor(elapsed / 1000) + 's)';
        setTimeout(check, PROXY_HEALTH_INTERVAL);
      }

      check();
    });
  }

  // ---- Fetch Channels ----
  function fetchM3USource(source) {
    return new Promise(function(resolve, reject) {
      // Try fetching directly first (M3U list URLs are typically CORS-friendly)
      var xhr = new XMLHttpRequest();
      xhr.open('GET', source.url, true);
      xhr.timeout = 15000;
      xhr.onload = function() {
        if (xhr.status === 200) {
          resolve(parseM3U(xhr.responseText, source.region));
        } else {
          reject(new Error('HTTP ' + xhr.status));
        }
      };
      xhr.onerror = function() {
        // If direct fetch fails and proxy is available, try via proxy
        if (proxyAvailable) {
          console.log('Direct fetch failed for ' + source.label + ', trying via proxy...');
          var xhr2 = new XMLHttpRequest();
          xhr2.open('GET', proxyUrl(source.url), true);
          xhr2.timeout = 20000;
          xhr2.onload = function() {
            if (xhr2.status === 200) {
              resolve(parseM3U(xhr2.responseText, source.region));
            } else {
              reject(new Error('Proxy HTTP ' + xhr2.status));
            }
          };
          xhr2.onerror = function() { reject(new Error('Proxy fetch failed')); };
          xhr2.ontimeout = function() { reject(new Error('Proxy timeout')); };
          xhr2.send();
        } else {
          reject(new Error('Direct fetch failed, no proxy'));
        }
      };
      xhr.ontimeout = function() { reject(new Error('Timeout')); };
      xhr.send();
    });
  }

  function fetchAllChannels() {
    var promises = M3U_SOURCES.map(function(s) {
      return fetchM3USource(s).catch(function(err) {
        console.warn('Failed to fetch ' + s.label + ':', err.message);
        return []; // Return empty array on failure
      });
    });

    return Promise.all(promises).then(function(results) {
      var chs = [];
      for (var i = 0; i < results.length; i++) {
        chs = chs.concat(results[i]);
      }
      for (var j = 0; j < chs.length; j++) {
        chs[j].index = j;
        chs[j].number = j + 1;
      }
      return chs;
    });
  }

  // ---- Favorites ----
  function isFav(ch) { return favorites.indexOf(ch.name) >= 0; }
  function toggleFav(ch) {
    var i = favorites.indexOf(ch.name);
    if (i >= 0) { favorites.splice(i, 1); showToast('已取消收藏: ' + ch.name); }
    else { favorites.push(ch.name); showToast('⭐ 已收藏: ' + ch.name); }
    localStorage.setItem('iptv_favs', JSON.stringify(favorites));
    if (currentRegion === 'fav') applyFilters();
    else renderChannelList(); // refresh star icons
  }

  // ---- Watch History ----
  function addToHistory(ch) {
    // Remove existing entry if present, then add to front
    var idx = watchHistory.indexOf(ch.name);
    if (idx >= 0) watchHistory.splice(idx, 1);
    watchHistory.unshift(ch.name);
    // Keep only last 50
    if (watchHistory.length > 50) watchHistory = watchHistory.slice(0, 50);
    localStorage.setItem('iptv_history', JSON.stringify(watchHistory));
  }

  // ---- Toast ----
  function showToast(msg) {
    toast.textContent = msg;
    toast.classList.remove('hidden');
    toast.style.animation = 'none'; toast.offsetHeight; toast.style.animation = '';
    setTimeout(function() { toast.classList.add('hidden'); }, 2500);
  }

  // ---- Build Categories ----
  function buildCategories() {
    var cats = {};
    for (var i = 0; i < filteredChannels.length; i++) {
      cats[filteredChannels[i].group] = true;
    }
    catFilter.innerHTML = '';
    function mk(cat, label) {
      var b = document.createElement('button');
      b.className = 'category-btn' + (currentCategory === cat ? ' active' : '');
      b.dataset.category = cat; b.textContent = label;
      b.setAttribute('tabindex', '-1');
      b.addEventListener('click', function() { currentCategory = cat; applyFilters(); });
      return b;
    }
    catFilter.appendChild(mk('all', '全部'));
    var sortedCats = Object.keys(cats).sort();
    for (var j = 0; j < sortedCats.length; j++) {
      var c = sortedCats[j];
      catFilter.appendChild(mk(c, CAT[c] || c));
    }
  }

  // ---- Render Channel List ----
  function renderChannelList() {
    chListEl.innerHTML = '';
    for (var i = 0; i < filteredChannels.length; i++) {
      var ch = filteredChannels[i];
      var li = document.createElement('li');
      li.className = 'channel-item' + (ch.index === currentChannelIndex ? ' active' : '');
      li.dataset.channelIndex = ch.index; li.dataset.filteredIndex = i;
      li.setAttribute('tabindex', '-1'); li.id = 'channel-' + ch.index;
      var logoH = ch.logo
        ? '<img class="channel-logo" src="'+ch.logo+'" alt="" loading="lazy" onerror="this.parentElement.innerHTML=\'<span class=channel-logo-placeholder>📺</span>\'">'
        : '<span class="channel-logo-placeholder">📺</span>';
      var favStar = isFav(ch) ? '<span class="channel-fav">⭐</span>' : '';
      li.innerHTML =
        '<span class="channel-number">' + ch.number + '</span>' +
        '<div class="channel-logo-wrapper">' + logoH + '</div>' +
        '<div class="channel-info"><div class="channel-name">' + ch.name + '</div>' +
        '<div class="channel-meta"><span class="channel-group">' + (CAT[ch.group]||ch.group) + '</span>' +
        (ch.quality ? '<span class="channel-quality">'+ch.quality+'</span>' : '') +
        '</div></div>' + favStar +
        (ch.index === currentChannelIndex ? '<div class="channel-status-dot"></div>' : '');
      (function(chRef) {
        li.addEventListener('click', function() { playChannel(chRef.index); });
      })(ch);
      chListEl.appendChild(li);
    }
    chCount.textContent = filteredChannels.length + ' 個頻道';
  }

  // ---- Filters ----
  function applyFilters() {
    filteredChannels = [];
    for (var i = 0; i < allChannels.length; i++) {
      var ch = allChannels[i];
      if (currentRegion === 'fav') { if (!isFav(ch)) continue; }
      else if (currentRegion === 'hist') { if (watchHistory.indexOf(ch.name) < 0) continue; }
      else {
        if (currentRegion !== 'all' && ch.region !== currentRegion) continue;
        if (currentCategory !== 'all' && ch.group !== currentCategory) continue;
      }
      filteredChannels.push(ch);
    }
    if (currentRegion === 'hist') {
      filteredChannels.sort(function(a, b) {
        return watchHistory.indexOf(a.name) - watchHistory.indexOf(b.name);
      });
    }
    buildCategories(); renderChannelList();
    if (filteredChannels.length > 0) {
      chIdx = 0;
      for (var j = 0; j < filteredChannels.length; j++) {
        if (filteredChannels[j].index === currentChannelIndex) { chIdx = j; break; }
      }
    }
    if (navZone === 'channels') focusCh(chIdx);
  }

  // ---- HLS Player with Auto-Retry ----
  function playChannel(idx) {
    var ch = allChannels[idx]; if (!ch) return;
    clearRetry();
    // Push history
    if (currentChannelIndex >= 0 && currentChannelIndex !== idx)
      channelHistory.push(currentChannelIndex);
    if (channelHistory.length > 50) channelHistory.shift();

    currentChannelIndex = idx;
    localStorage.setItem('iptv_last', idx);
    addToHistory(ch);

    // Update active states
    var items = document.querySelectorAll('.channel-item');
    for (var i = 0; i < items.length; i++) {
      var ci = parseInt(items[i].dataset.channelIndex);
      if (ci === idx) {
        items[i].classList.add('active');
        if (!items[i].querySelector('.channel-status-dot')) {
          var d = document.createElement('div'); d.className='channel-status-dot'; items[i].appendChild(d);
        }
      } else {
        items[i].classList.remove('active');
        var dot = items[i].querySelector('.channel-status-dot');
        if (dot) dot.remove();
      }
    }

    showOSD(ch); showStatus('⏳', '正在載入...'); retryCount = 0;
    loadStream(ch);
  }

  function getStreamUrl(ch) {
    // Always use proxy for stream playback
    // The proxy handles: CORS, M3U8 URL rewriting, geo-block bypass
    if (proxyAvailable) {
      return proxyUrl(ch.url);
    }
    // If proxy is not available, try direct (will fail for CORS-blocked streams)
    console.warn('Proxy not available, attempting direct play: ' + ch.url);
    return ch.url;
  }

  function loadStream(ch) {
    if (hlsInstance) { hlsInstance.destroy(); hlsInstance = null; }
    var url = getStreamUrl(ch);

    if (typeof Hls !== 'undefined' && Hls.isSupported()) {
      hlsInstance = new Hls({
        enableWorker: true,
        lowLatencyMode: false,
        maxBufferLength: 30,
        maxMaxBufferLength: 60,
        startLevel: -1,
        fragLoadingTimeOut: 25000,
        manifestLoadingTimeOut: 25000,
        levelLoadingTimeOut: 25000,
        maxLoadingDelay: 10,
        maxBufferHole: 1.5,
        fragLoadingMaxRetry: 6,
        manifestLoadingMaxRetry: 4,
        levelLoadingMaxRetry: 4,
        fragLoadingRetryDelay: 2000,
        manifestLoadingRetryDelay: 2000,
        levelLoadingRetryDelay: 2000,
      });
      hlsInstance.loadSource(url);
      hlsInstance.attachMedia(video);
      hlsInstance.on(Hls.Events.MANIFEST_PARSED, function() {
        video.play().catch(function(){});
        hideStatus();
      });
      hlsInstance.on(Hls.Events.FRAG_BUFFERED, function() { hideStatus(); });
      hlsInstance.on(Hls.Events.ERROR, function(_, d) {
        if (!d.fatal) return;
        console.warn('HLS Fatal:', d.type, d.details);
        if (d.type === Hls.ErrorTypes.MEDIA_ERROR) {
          hlsInstance.recoverMediaError();
          return;
        }
        scheduleRetry(ch);
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = url;
      video.addEventListener('loadedmetadata', function() {
        video.play().catch(function(){});
        hideStatus();
      }, { once: true });
      video.addEventListener('error', function() { scheduleRetry(ch); }, { once: true });
    } else {
      showStatus('❌', '不支援 HLS 播放');
    }
  }

  function scheduleRetry(ch) {
    if (retryCount >= MAX_RETRIES) {
      showStatus('❌', '無法播放: ' + ch.name);
      retryInfo.textContent = '已重試 ' + MAX_RETRIES + ' 次。按 OK 重試或換台';
      retryInfo.classList.remove('hidden');
      return;
    }
    retryCount++;
    var delay = RETRY_DELAYS[Math.min(retryCount - 1, RETRY_DELAYS.length - 1)];
    showStatus('🔄', '連線中斷，' + (delay/1000) + '秒後重試 (' + retryCount + '/' + MAX_RETRIES + ')');
    retryInfo.classList.add('hidden');
    retryTimer = setTimeout(function() { loadStream(ch); }, delay);
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
    var now = new Date();
    osdProg.textContent = (CAT[ch.group] || ch.group) + ' · 直播中';
    osdTime.textContent = now.getHours().toString().padStart(2,'0') + ':' + now.getMinutes().toString().padStart(2,'0');
    osdProgBar.style.width = Math.round((now.getMinutes()/60)*100) + '%';
    osd.classList.remove('hidden');
    osdTimeout = setTimeout(function() { osd.classList.add('hidden'); }, 5000);
  }

  // ---- Status ----
  function showStatus(icon, text) { statusIcon.textContent = icon; statusText.textContent = text; playerStatus.classList.remove('hidden'); }
  function hideStatus() { playerStatus.classList.add('hidden'); }

  // ---- Subtitles ----
  function toggleSubtitles() {
    subtitlesOn = !subtitlesOn;
    if (video.textTracks) {
      for (var i = 0; i < video.textTracks.length; i++)
        video.textTracks[i].mode = subtitlesOn ? 'showing' : 'hidden';
    }
    subLabel.textContent = '字幕: ' + (subtitlesOn ? '開啟' : '關閉');
    subIndicator.classList.remove('hidden');
    subIndicator.style.animation = 'none'; subIndicator.offsetHeight; subIndicator.style.animation = '';
    setTimeout(function() { subIndicator.classList.add('hidden'); }, 2000);
    showToast('字幕 ' + (subtitlesOn ? '已開啟' : '已關閉'));
  }

  // ---- Sidebar ----
  function openSidebar() { sidebarOpen = true; app.classList.add('sidebar-open'); navZone = 'channels'; focusCh(chIdx); }
  function closeSidebar() { sidebarOpen = false; app.classList.remove('sidebar-open'); navZone = 'player'; clearFocus(); }

  // ---- Focus ----
  function clearFocus() {
    var focused = document.querySelectorAll('.focused');
    for (var i = 0; i < focused.length; i++) focused[i].classList.remove('focused');
  }
  function focusCh(i) {
    clearFocus();
    var items = chListEl.querySelectorAll('.channel-item');
    if (i < 0 || i >= items.length) return;
    chIdx = i; items[i].classList.add('focused'); scrollTo(items[i]);
  }
  function focusTab(i) {
    clearFocus();
    var t = regionTabs.querySelectorAll('.region-tab');
    if (i>=0&&i<t.length) { tabIdx=i; t[i].classList.add('focused'); }
  }
  function focusCat(i) {
    clearFocus();
    var b = catFilter.querySelectorAll('.category-btn');
    if (i>=0&&i<b.length) { catIdx=i; b[i].classList.add('focused'); }
  }
  function scrollTo(el) {
    var c = chListContainer, cr = c.getBoundingClientRect(), er = el.getBoundingClientRect();
    if (er.top < cr.top) c.scrollTop -= (cr.top - er.top + 20);
    else if (er.bottom > cr.bottom) c.scrollTop += (er.bottom - cr.bottom + 20);
  }

  // ---- Hierarchical Navigation ----
  function handleKey(e) {
    var kc = e.keyCode;
    if ([KEY.UP,KEY.DOWN,KEY.LEFT,KEY.RIGHT,KEY.ENTER,KEY.BACK,KEY.BACKSPACE,
         KEY.RED,KEY.GREEN,KEY.YELLOW,KEY.BLUE,KEY.CH_UP,KEY.CH_DOWN,KEY.INFO].indexOf(kc) >= 0
        || (kc >= KEY.NUM0 && kc <= KEY.NUM9)) {
      e.preventDefault();
    }

    // Number input for direct channel jump
    if (kc >= KEY.NUM0 && kc <= KEY.NUM9) { handleNumInput(kc - KEY.NUM0); return; }

    // Global keys
    if (kc === KEY.YELLOW) {
      var ch = allChannels[currentChannelIndex]; if (ch) toggleFav(ch); return;
    }
    if (kc === KEY.BLUE || kc === 67) { toggleSubtitles(); return; }
    if (kc === KEY.RED) {
      if (channelHistory.length > 0) { playChannel(channelHistory.pop()); } return;
    }
    if (kc === KEY.GREEN || kc === KEY.INFO || kc === 73) {
      var ch2 = allChannels[currentChannelIndex]; if (ch2) showOSD(ch2); return;
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
    var tabs = regionTabs.querySelectorAll('.region-tab');
    switch (kc) {
      case KEY.LEFT: if (tabIdx > 0) focusTab(--tabIdx); break;
      case KEY.RIGHT: if (tabIdx < tabs.length-1) focusTab(++tabIdx); break;
      case KEY.ENTER:
        currentRegion = tabs[tabIdx].dataset.region; currentCategory = 'all';
        for (var i = 0; i < tabs.length; i++) tabs[i].classList.remove('active');
        tabs[tabIdx].classList.add('active');
        applyFilters(); navZone = 'categories'; catIdx = 0; focusCat(0); break;
      case KEY.DOWN: navZone = 'categories'; focusCat(catIdx); break;
      case KEY.BACK: case KEY.BACKSPACE: closeSidebar(); break;
    }
  }

  function navCats(kc) {
    var btns = catFilter.querySelectorAll('.category-btn');
    switch (kc) {
      case KEY.LEFT: if (catIdx > 0) focusCat(--catIdx); break;
      case KEY.RIGHT: if (catIdx < btns.length-1) focusCat(++catIdx); break;
      case KEY.ENTER:
        currentCategory = btns[catIdx].dataset.category;
        for (var i = 0; i < btns.length; i++) btns[i].classList.remove('active');
        btns[catIdx].classList.add('active');
        applyFilters(); navZone = 'channels'; chIdx = 0; focusCh(0); break;
      case KEY.UP: navZone = 'tabs'; focusTab(tabIdx); break;
      case KEY.DOWN: navZone = 'channels'; focusCh(chIdx); break;
      case KEY.BACK: case KEY.BACKSPACE: navZone = 'tabs'; focusTab(tabIdx); break;
    }
  }

  function navChs(kc) {
    var items = chListEl.querySelectorAll('.channel-item');
    if (items.length === 0) return;
    switch (kc) {
      case KEY.UP:
        if (chIdx > 0) focusCh(--chIdx);
        else { navZone = 'categories'; focusCat(catIdx); }
        break;
      case KEY.DOWN: if (chIdx < items.length-1) focusCh(++chIdx); break;
      case KEY.ENTER:
        var ci = parseInt(items[chIdx].dataset.channelIndex);
        playChannel(ci); setTimeout(function() { closeSidebar(); }, 300); break;
      case KEY.BACK: case KEY.BACKSPACE:
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
    numInputTimer = setTimeout(function() {
      var n = parseInt(numInputBuffer);
      numInputBuffer = '';
      var ch = null;
      for (var i = 0; i < allChannels.length; i++) {
        if (allChannels[i].number === n) { ch = allChannels[i]; break; }
      }
      if (ch) { playChannel(ch.index); showToast('切換至 CH' + n + ': ' + ch.name); }
      else showToast('找不到頻道 ' + n);
    }, 1500);
  }

  // ---- Channel Navigate (from player view) ----
  function navChannel(dir) {
    if (filteredChannels.length === 0) return;
    var i = -1;
    for (var j = 0; j < filteredChannels.length; j++) {
      if (filteredChannels[j].index === currentChannelIndex) { i = j; break; }
    }
    if (i < 0) i = 0;
    i += dir;
    if (i < 0) i = filteredChannels.length - 1;
    if (i >= filteredChannels.length) i = 0;
    chIdx = i; playChannel(filteredChannels[i].index);
  }

  // ---- Splash ----
  function hideSplash() {
    splash.classList.add('fade-out'); app.classList.remove('hidden'); app.classList.add('sidebar-open');
    setTimeout(function() { splash.classList.add('hidden'); }, 500);
  }

  // ---- Init ----
  function init() {
    splashSubtitle.textContent = '正在初始化...';

    // Step 1: Wait for proxy service to be ready
    waitForProxy().then(function(ready) {
      if (ready) {
        splashSubtitle.textContent = '代理服務已就緒，正在載入頻道...';
        console.log('Proxy is available, proceeding with channel load');
      } else {
        splashSubtitle.textContent = '代理服務未就緒，嘗試直接載入頻道...';
        console.warn('Proxy not available, will attempt direct playback');
      }

      // Step 2: Fetch channels
      return fetchAllChannels();
    }).then(function(chs) {
      allChannels = chs;
      console.log('Loaded ' + allChannels.length + ' channels');

      if (allChannels.length === 0) {
        splashSubtitle.textContent = '未找到任何頻道，請檢查網絡連線';
        return;
      }

      filteredChannels = allChannels.slice();
      buildCategories();
      renderChannelList();
      hideSplash();

      // Resume last channel or play first
      var startIdx = (lastChannel >= 0 && lastChannel < allChannels.length) ? lastChannel : 0;
      chIdx = 0;
      playChannel(startIdx);
      focusCh(chIdx);
    }).catch(function(err) {
      console.error('Init failed:', err);
      splashSubtitle.textContent = '載入失敗: ' + (err.message || '請檢查網絡連線');
    });
  }

  // ---- Event Listeners ----
  document.addEventListener('keydown', handleKey);
  regionTabs.addEventListener('click', function(e) {
    var t = e.target;
    while (t && !t.classList.contains('region-tab')) t = t.parentElement;
    if (!t) return;
    currentRegion = t.dataset.region; currentCategory = 'all';
    var allTabs = regionTabs.querySelectorAll('.region-tab');
    for (var i = 0; i < allTabs.length; i++) allTabs[i].classList.remove('active');
    t.classList.add('active'); applyFilters();
  });
  video.addEventListener('waiting', function() { showStatus('⏳', '正在緩衝...'); });
  video.addEventListener('playing', function() { hideStatus(); });
  video.addEventListener('error', function() {
    if (currentChannelIndex >= 0) scheduleRetry(allChannels[currentChannelIndex]);
  });

  // ---- Boot ----
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
