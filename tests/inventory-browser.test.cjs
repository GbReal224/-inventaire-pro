const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const http=require('node:http');
const {webkit,chromium}=require('playwright');
let server,base;const browsers={};
before(async()=>{
  const root=path.resolve(__dirname,'..');
  server=http.createServer((req,res)=>{const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);if(pathname==='/blank'){res.setHeader('Content-Type','text/html');res.end('<html><body>Test storage</body></html>');return}const file=path.join(root,pathname==='/'?'index.html':pathname);if(!file.startsWith(root+path.sep)){res.writeHead(403).end();return}try{res.setHeader('Content-Type',({'.js':'text/javascript','.wasm':'application/wasm','.css':'text/css','.webmanifest':'application/manifest+json','.png':'image/png'})[path.extname(file)]||'text/html');res.end(fs.readFileSync(file))}catch{res.writeHead(404).end()}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${server.address().port}`;
  browsers.webkit=await webkit.launch({headless:true});browsers.chromium=await chromium.launch({headless:true});
});
after(async()=>{for(const b of Object.values(browsers))await b.close();await new Promise(resolve=>server.close(resolve))});
async function ready(page){await page.waitForFunction(()=>typeof settings!=='undefined'&&settings.schemaVersion===5&&!mutationBusy)}
async function app(t,engine){const context=await browsers[engine].newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,...(engine==='chromium'?{userAgent:'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36'}:{})});t.after(()=>context.close());const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());t.after(()=>assert.deepEqual(errors,[]));await page.goto(base);await ready(page);return {page,context}}
async function createProduct(page,overrides={}){
  await page.click('#quickAddBtn');
  for(const [id,value] of Object.entries({productName:'Nettoyant test',reserveStock:'0',inHandStock:'0',minReserve:'4',targetReserve:'12',unitCost:'2',packSize:'6',packLabel:'boîte',supplier:'Fournisseur test',productUrl:'https://supplier.example/product',...overrides}))await page.fill('#'+id,value);
  await page.click('#productForm button[type=submit]');await page.waitForFunction(()=>!$('productDialog').open&&!mutationBusy);return page.evaluate(()=>products[0].id);
}
async function movement(page,id,type,quantity){await page.evaluate(({id,type})=>openMovement(products.find(p=>p.id===id),type),{id,type});await page.fill('#movementQty',String(quantity));await page.click('#movementForm button[type=submit]');await page.waitForFunction(()=>!$('movementDialog').open&&!mutationBusy)}
for(const engine of ['webkit','chromium']){
  test(`${engine}: purchase lifecycle, atomic double-submit, undo and archives`,{timeout:45000},async t=>{
    const {page}=await app(t,engine),id=await createProduct(page);
    assert.equal(await page.textContent('#kpiOrder'),'1');
    await page.evaluate(()=>navigate('orders'));await page.click('[data-order]');await page.selectOption('#orderUnit','pack');await page.fill('#orderQty','2');await page.fill('#orderCost','18');await page.fill('#orderReference','COM-100');await page.fill('#orderDate','2026-11-05');await page.click('#orderForm button[type=submit]');await page.waitForFunction(()=>!$('orderDialog').open&&!mutationBusy);
    assert.equal(await page.textContent('#kpiOrder'),'0');assert.equal(await page.textContent('#orderItemsCount'),'0');assert.equal(await page.evaluate(()=>orders[0].quantity),12);
    await page.click('[data-receive-order]');await page.fill('#movementQty','5');
    await page.evaluate(async()=>{const event={preventDefault(){}};await Promise.all([applyMovement(event),applyMovement(event)])});
    assert.deepEqual(await page.evaluate(()=>[products[0].reserveStock,orders[0].received,orders[0].status,purchaseTotals().total,movements.filter(isPurchaseMovement).length]),[5,5,'partial',15,1]);
    await page.evaluate(()=>undoMovement(movements.find(isPurchaseMovement).id));
    assert.deepEqual(await page.evaluate(()=>[products[0].reserveStock,orders[0].received,orders[0].status,purchaseTotals().total]),[0,0,'ordered',0]);
    await page.click('[data-receive-order]');await page.click('#movementForm button[type=submit]');await page.waitForFunction(()=>!$('movementDialog').open&&!mutationBusy);
    assert.deepEqual(await page.evaluate(()=>[products[0].reserveStock,products[0].unitCost,orders[0].status,purchaseTotals().total]),[12,3,'received',36]);
    await movement(page,id,'open',2);await movement(page,id,'consume',1);
    await page.evaluate(()=>undoMovement(movements.find(m=>m.type==='consume'&&!m.reversedBy).id));
    assert.equal(await page.evaluate(()=>movements.filter(isConsumption).length),0,'A correction is not another consumption');
    await movement(page,id,'consume',1);
    await page.evaluate(id=>archiveProduct(id,true),id);
    assert.equal(await page.evaluate(()=>products[0].archived),true);assert.equal(await page.textContent('#kpiProducts'),'0');
    await page.evaluate(()=>navigate('stats'));assert.match(await page.textContent('#usageChart'),/archivé/);assert.match(await page.textContent('#statPurchasesTotal'),/36/);
    await page.evaluate(()=>navigate('inventory'));await page.selectOption('#stockFilter','archived');await page.click('[data-restore]');await page.waitForFunction(()=>!mutationBusy&&!products[0].archived);
    assert.equal(await page.evaluate(()=>products[0].reserveStock+products[0].inHandStock),11);
  });
  test(`${engine}: failed import and transaction preserve data; valid import has recovery`,{timeout:30000},async t=>{
    const {page}=await app(t,engine);await createProduct(page);
    const original=await page.evaluate(()=>JSON.stringify({products,movements,orders}));
    await page.evaluate(async()=>{await importBackup(new File([JSON.stringify({app:'Inventaire Pro',version:3.2,products:[{id:'broken',name:'Broken',reserveStock:-2}],movements:[]})],'bad.json',{type:'application/json'}))});
    assert.equal(await page.evaluate(()=>JSON.stringify({products,movements,orders})),original);
    const rollback=await page.evaluate(async()=>{const before=settings.revision;let failed=false;try{await commitData({products:[{...products[0],reserveStock:999},{id:'bad',cannotClone(){}}]},{replace:true,safety:true})}catch{failed=true}await loadData();return {failed,sameRevision:settings.revision===before,data:JSON.stringify({products,movements,orders})}});
    assert.equal(rollback.failed,true);assert.equal(rollback.sameRevision,true);assert.equal(rollback.data,original);
    await page.evaluate(async()=>{const data={app:'Inventaire Pro',version:'4.0.0',schemaVersion:4,products:[Core.product({id:'replacement',name:'Importé',reserveStock:7})],movements:[],orders:[]};await importBackup(new File([JSON.stringify(data)],'good.json'))});
    assert.equal(await page.evaluate(()=>products[0].reserveStock),7);
    await page.evaluate(()=>restoreSafety());assert.equal(await page.evaluate(()=>JSON.stringify({products,movements,orders})),original);
    await page.evaluate(()=>exportBackup());const stamp=await page.evaluate(()=>settings.lastExportAt);assert.ok(stamp);await page.reload();await ready(page);assert.equal(await page.evaluate(()=>settings.lastExportAt),stamp);
  });
  test(`${engine}: filters, full history, custom stats and small-screen layout`,{timeout:30000},async t=>{
    const {page}=await app(t,engine);const id=await createProduct(page,{reserveStock:'3',inHandStock:'2',location:'Garage'});
    await page.evaluate(async id=>{const p=products.find(p=>p.id===id);const logs=Array.from({length:360},(_,i)=>newMovement(p,'Ancienne consommation',1,'archive '+i,'−',{id:'history-'+i,type:'consume',date:new Date(2025,0,1+i).toISOString(),inventoryValueDelta:0,unitCostAtTime:0}));await commitData({movements:logs});await loadData();navigate('history')},id);
    await page.selectOption('#historyType','consume');for(let i=0;i<4;i++)if(await page.isVisible('#historyMore'))await page.click('#historyMore');assert.equal(await page.locator('#historyList .history-item').count(),360);
    await page.fill('#historySearch','archive 359');assert.equal(await page.locator('#historyList .history-item').count(),1);
    await page.evaluate(()=>navigate('inventory'));await page.selectOption('#supplierFilter','Fournisseur test');await page.selectOption('#locationFilter','Garage');assert.equal(await page.locator('#inventoryList .product-card').count(),1);assert.match(await page.textContent('#inventoryList [data-amazon]'),/Fournisseur test/);
    await page.evaluate(()=>navigate('stats'));await page.selectOption('#statsPeriod','-1');await page.fill('#statsFrom','2025-01-01');await page.fill('#statsTo','2025-01-31');await page.selectOption('#statsProduct',id);assert.equal(await page.textContent('#statMoves'),'31');assert.match(await page.textContent('#statConsumedCost'),/^0/);
    const dot=page.locator('#purchaseTrendChart [data-value]').first();await dot.click();assert.match(await page.textContent('#purchaseTrendChart .chart-readout'),/Achats/);
    await page.setViewportSize({width:360,height:800});for(const view of ['dashboard','inventory','orders','stats','history','settings']){await page.evaluate(v=>navigate(v),view);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,view+' must fit mobile width')}
    await page.evaluate(()=>navigate('inventory'));await page.screenshot({path:path.join(os.tmpdir(),`inventaire-v4-${engine}.png`),fullPage:true});
    await page.evaluate(()=>navigate('stats'));await page.screenshot({path:path.join(os.tmpdir(),`inventaire-v4-stats-${engine}.png`),fullPage:true});
  });
  test(`${engine}: old database migration and stale edits in two windows`,{timeout:30000},async t=>{
    const {page,context}=await app(t,engine);const id=await createProduct(page,{inHandStock:'2'});const other=await context.newPage();other.on('dialog',d=>d.accept());await other.goto(base);await ready(other);await other.evaluate(id=>openProduct(products.find(p=>p.id===id)),id);await other.fill('#productName','Stale edit');
    await movement(page,id,'consume',1);await other.waitForFunction(()=>products[0].inHandStock===1);await other.click('#productForm button[type=submit]');await other.waitForFunction(()=>!mutationBusy);assert.equal(await other.evaluate(()=>products[0].name),'Nettoyant test');assert.equal(await other.evaluate(()=>products[0].inHandStock),1);
    const legacy=await browsers[engine].newContext();t.after(()=>legacy.close());const old=await legacy.newPage();await old.goto(base+'/blank');await old.evaluate(()=>new Promise((resolve,reject)=>{const r=indexedDB.open('InventaireProDB',1);r.onupgradeneeded=()=>{r.result.createObjectStore('products',{keyPath:'id'});r.result.createObjectStore('movements',{keyPath:'id'})};r.onsuccess=()=>{const db=r.result,t=db.transaction(['products','movements'],'readwrite');t.objectStore('products').put({id:'old',name:'Existant',unit:'unité',reserveStock:9,inHandStock:1,minReserve:2,targetReserve:4,unitCost:3});t.objectStore('movements').put({id:'old-move',productId:'deleted',productName:'Ancien supprimé',qty:2,date:'2025-01-01T00:00:00Z',type:'consume',unitCostAtTime:2});t.oncomplete=()=>{db.close();resolve()};t.onerror=()=>reject(t.error)}}));
    await old.goto(base);await ready(old);assert.deepEqual(await old.evaluate(()=>[products.find(p=>p.id==='old').reserveStock,products.find(p=>p.id==='deleted').archived,movements.length]),[9,true,1]);assert.equal(await old.evaluate(()=>Core.validateBackup(backupData()).products.length),2);
  });
}
test('Android installation affordance, Business intent and scanner module', {timeout:30000},async t=>{
  const {page}=await app(t,'chromium');
  const routing=await page.evaluate(()=>{openAmazonBusiness({productUrl:'https://www.amazon.ca/dp/B012345678?th=1'});return $('amazonProductLink').getAttribute('href')});assert.match(routing,/^intent:\/\/business.amazon.ca\/abredir\/dp\/B012345678\?th=1#Intent;/);assert.match(routing,/package=com.amazon.mShop.android.business.shopping/);assert.match(decodeURIComponent(routing),/S.browser_fallback_url=https:\/\/www.amazon.ca\/dp\/B012345678\?th=1&nodl=1/);
  assert.equal(await page.evaluate(()=>ensureZXing()),true);
  await page.evaluate(()=>{$('amazonDialog').close();navigate('settings');window.installCalls=0;const event=new Event('beforeinstallprompt',{cancelable:true});event.prompt=async()=>{installCalls++};event.userChoice=Promise.resolve({outcome:'accepted'});window.dispatchEvent(event)});assert.equal(await page.isVisible('#installBtn'),true);await page.click('#installBtn');assert.equal(await page.evaluate(()=>installCalls),1);
  const manifest=await page.evaluate(()=>fetch('manifest.webmanifest').then(r=>r.json()));assert.equal(manifest.display,'standalone');assert.ok(manifest.icons.some(i=>i.purpose==='maskable'));assert.equal(manifest.id,'./');
});
