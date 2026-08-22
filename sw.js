const CACHE='inventaire-pro-v3-cost-stats';
const ASSETS=['./','index.html','app.css','app.js','manifest.webmanifest','icon-180.png','icon-192.png','icon-512.png','icon-512-maskable.png'];
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)).then(()=>self.skipWaiting())));
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',e=>{
  if(e.request.method!=='GET')return;
  if(e.request.mode==='navigate'){
    e.respondWith(fetch(e.request).then(resp=>{const copy=resp.clone();caches.open(CACHE).then(c=>c.put('index.html',copy));return resp}).catch(()=>caches.match('index.html')));
    return;
  }
  e.respondWith(caches.match(e.request).then(r=>r||fetch(e.request).then(resp=>{if(resp&&resp.ok&&new URL(e.request.url).origin===location.origin){const copy=resp.clone();caches.open(CACHE).then(c=>c.put(e.request,copy))}return resp})));
});
