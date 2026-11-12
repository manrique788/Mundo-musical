const CACHE_NAME = 'mundo-musical-radio-v24';
const APP_SHELL = ['./','./index.html','./style.css?v=50','./app.js?v=50','./manifest.webmanifest','./icons/user-logo-192.png','./icons/user-logo-512.png'];
self.addEventListener('install',event=>{
 event.waitUntil(caches.open(CACHE_NAME).then(cache=>cache.addAll(APP_SHELL)).then(()=>self.skipWaiting()));
});
self.addEventListener('activate',event=>{
 event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key!==CACHE_NAME).map(key=>caches.delete(key)))).then(()=>self.clients.claim()));
});
self.addEventListener('fetch',event=>{
 const req=event.request;
 if(req.method!=='GET') return;
 const url=new URL(req.url);
 if(url.origin!==self.location.origin) return;
 const isAppFile=url.pathname.endsWith('/')||/\\.(html|css|js|webmanifest)$/.test(url.pathname);
 if(isAppFile){
  event.respondWith(fetch(req,{cache:'no-store'}).then(response=>{
   if(response.ok){const copy=response.clone();caches.open(CACHE_NAME).then(cache=>cache.put(req,copy));}
   return response;
  }).catch(()=>caches.match(req).then(cached=>cached||caches.match('./index.html'))));
  return;
 }
 event.respondWith(caches.match(req).then(cached=>cached||fetch(req).then(response=>{
  if(response.ok&&response.type==='basic'){const copy=response.clone();caches.open(CACHE_NAME).then(cache=>cache.put(req,copy));}
  return response;
 }).catch(()=>caches.match('./index.html'))));
});
