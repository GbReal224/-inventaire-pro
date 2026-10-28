const CACHE='inventaire-pro-v5-0-0';
const ASSETS=["./","index.html","app.css?v=5.0.0","inventory-core.js?v=5.0.0","inventory.js?v=5.0.0","statistics.js?v=5.0.0","operations-core.js?v=5.0.0","operations.js?v=5.0.0","vendor/xlsx-0.20.3.min.js","app.js?v=5.0.0","vendor/zxing-wasm-reader-3.1.6.js","vendor/zxing_reader-3.1.6.wasm","manifest.webmanifest","icon-180.png","icon-192.png","icon-512.png","icon-512-maskable.png"];
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)).then(()=>self.skipWaiting())));
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('inventaire-pro-')&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',e=>{
  if(e.request.method!=='GET'||new URL(e.request.url).origin!==location.origin)return;
  if(e.request.mode==='navigate'){e.respondWith(fetch(e.request).then(response=>{if(!response.ok)throw new Error('Offline');const copy=response.clone();e.waitUntil(caches.open(CACHE).then(c=>c.put('index.html',copy)));return response}).catch(()=>caches.match('index.html')));return}
  e.respondWith(caches.match(e.request).then(cached=>cached||fetch(e.request).then(response=>{if(response.ok){const copy=response.clone();e.waitUntil(caches.open(CACHE).then(c=>c.put(e.request,copy)))}return response})));
});
