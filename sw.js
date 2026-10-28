/* 错题集 · Service Worker —— 离线可用 */
const CACHE = 'cuotiji-v17';
const SHELL = [
  './', './index.html', './styles.css', './app.js', './manifest.json',
  './vendor/workbuddy-cloud-sdk.js',
  './assets/hero-fuji.jpg', './assets/hero-night.jpg',
  './assets/band-sakura.jpg', './assets/band-sakura-night.jpg',
  './assets/band-torii.jpg', './assets/band-torii-night.jpg',
  './assets/band-bamboo.jpg', './assets/band-bamboo-night.jpg',
  /* 每日一图 24 天 × 白天/夜里，一共 48 张，小图（720 宽）能压得住 */
  ...Array.from({length:24}, (_,i)=> {
    const n = String(i+1).padStart(2,'0');
    return [`./assets/daily/d${n}.jpg`, `./assets/daily/d${n}n.jpg`];
  }).flat(),
  './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png'
];
/* 代码类资源走「网络优先」：改版后用户第一次打开就是新版，断网再回退缓存 */
const CODE = ['/', '/index.html', '/styles.css', '/app.js', '/manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.all(SHELL.map(u => c.add(u).catch(() => null))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch (err) { return; }

  // 云服务接口一律走网络，不缓存
  if (url.pathname.startsWith('/.cloud/')) return;

  const isCode = req.mode === 'navigate' || CODE.includes(url.pathname);

  // 代码类：网络优先，失败回退缓存
  if (isCode) {
    e.respondWith(
      fetch(req).then(res => {
        if (res && res.ok && url.origin === location.origin) {
          const cp = res.clone();
          caches.open(CACHE).then(c => c.put(req, cp));
        }
        return res;
      }).catch(() => caches.match(req).then(hit => hit || caches.match('./index.html')))
    );
    return;
  }

  // 静态资源（图片等）：缓存优先 + 后台更新
  e.respondWith(
    caches.match(req).then(hit => {
      const net = fetch(req).then(res => {
        if (res && res.ok && url.origin === location.origin) {
          const cp = res.clone();
          caches.open(CACHE).then(c => c.put(req, cp));
        }
        return res;
      }).catch(() => hit);
      return hit || net;
    })
  );
});

/* ---------- 每日提醒兜底（装了 PWA 才有的 Periodic Background Sync） ---------- */
function idbCountDue(){
  return new Promise(resolve => {
    let rq;
    try { rq = indexedDB.open('cuotiji', 3); } catch (e) { return resolve(0); }
    rq.onerror = () => resolve(0);
    rq.onupgradeneeded = () => { try { rq.transaction.abort(); } catch (e) {} resolve(0); };
    rq.onsuccess = () => {
      const db = rq.result;
      if (!db.objectStoreNames.contains('q')) return resolve(0);
      const t = db.transaction('q', 'readonly');
      const g = t.objectStore('q').getAll();
      g.onerror = () => resolve(0);
      g.onsuccess = () => {
        const now = Date.now();
        resolve((g.result || []).filter(q => !q.reviews || (q.due || 0) <= now).length);
      };
    };
  });
}

self.addEventListener('periodicsync', e => {
  if (e.tag !== 'cuotiji-daily') return;
  e.waitUntil((async () => {
    const n = await idbCountDue();
    if (!n) return;
    try {
      await self.registration.showNotification('该复习错题了', {
        body: `今天还有 ${n} 道待复习，几分钟就能做完`,
        tag: 'cuotiji-daily',
        icon: 'icons/icon-192.png',
      });
    } catch (err) { /* 忽略 */ }
  })());
});
