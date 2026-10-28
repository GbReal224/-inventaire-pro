const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const {webkit,chromium}=require('playwright');
const XLSX=require('../vendor/xlsx-0.20.3.min.js');
let server,base,networkAvailable=true;const browsers={};
before(async()=>{
  const root=path.resolve(__dirname,'..');server=http.createServer((req,res)=>{if(req.url==='/blank'){res.setHeader('Content-Type','text/html');res.end('<html><body></body></html>');return}if(!networkAvailable){req.socket.destroy();return}const file=path.join(root,decodeURIComponent(new URL(req.url,'http://localhost').pathname).replace(/^\/$/,'/index.html'));if(!file.startsWith(root+path.sep)){res.writeHead(403).end();return}try{res.setHeader('Content-Type',({'.js':'text/javascript','.css':'text/css','.wasm':'application/wasm','.png':'image/png','.webmanifest':'application/manifest+json'})[path.extname(file)]||'text/html');res.end(fs.readFileSync(file))}catch{res.writeHead(404).end()}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${server.address().port}`;
  browsers.webkit=await webkit.launch();browsers.chromium=await chromium.launch();
});
after(async()=>{for(const b of Object.values(browsers))await b.close();if(server)await new Promise(resolve=>server.close(resolve))});
async function app(t,engine){const context=await browsers[engine].newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});t.after(()=>context.close());const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());t.after(()=>assert.deepEqual(errors,[]));await page.goto(base);await page.waitForFunction(()=>typeof settings!=='undefined'&&settings.schemaVersion===5);return {page,context}}
async function seed(page){await page.evaluate(async()=>{const data=[Core.product({id:'cleaner',name:'Concentré APC',unit:'mL',reserveStock:4000,inHandStock:1000,unitCost:.01,location:'Garage',barcode:'012345678905',leadDays:7}),Core.product({id:'cloth',name:'Chiffons',unit:'unité',reserveStock:10,inHandStock:5,unitCost:2,location:'Garage'})];await commitData({products:data,movements:data.map(p=>newMovement(p,'Stock initial',totalAvailable(p),'','+',{type:'initial',after:Core.stock(p),inventoryValueDelta:totalAvailable(p)*p.unitCost}))});await loadData()})}
async function settled(page,dialog){await page.waitForFunction(dialog=>!mutationBusy&&!$(dialog).open,dialog)}
const pdf={name:'facture.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-1.4\n%%EOF')};
for(const engine of ['webkit','chromium']){
  test(`${engine}: v4 database upgrade preserves orders and supports undo of old stock snapshots`,{timeout:30000},async t=>{
    const context=await browsers[engine].newContext();t.after(()=>context.close());const page=await context.newPage();page.on('dialog',d=>d.accept());await page.goto(base+'/blank');
    await page.evaluate(()=>new Promise((resolve,reject)=>{
      const request=indexedDB.open('InventaireProDB',2);request.onupgradeneeded=()=>{for(const name of ['products','movements','orders','meta','safety'])request.result.createObjectStore(name,{keyPath:'id'})};
      request.onsuccess=()=>{const db=request.result,t=db.transaction(['products','movements','orders','meta'],'readwrite'),date='2026-10-20T12:00:00Z';
        t.objectStore('products').put({id:'legacy',name:'Produit v4',unit:'bouteille',reserveStock:3,inHandStock:0,minReserve:1,targetReserve:5,unitCost:5,location:'Garage',revision:2});
        t.objectStore('orders').put({id:'order4',productId:'legacy',productName:'Produit v4',quantity:4,received:2,unitCost:5,status:'partial',createdAt:date});
        t.objectStore('movements').put({id:'purchase4',productId:'legacy',productName:'Produit v4',type:'receive',label:'Réception / Achat',date,qty:2,orderId:'order4',isPurchase:true,purchaseUnitCost:5,purchaseTotalCost:10,unitCostAtTime:5,inventoryValueDelta:10,before:{reserveStock:1,inHandStock:0,unitCost:5},after:{reserveStock:3,inHandStock:0,unitCost:5}});
        t.objectStore('meta').put({id:'config',revision:7,schemaVersion:4,datasetId:'dataset4'});t.oncomplete=()=>{db.close();resolve()};t.onerror=()=>reject(t.error);
      };request.onerror=()=>reject(request.error);
    }));
    await page.goto(base);await page.waitForFunction(()=>settings.schemaVersion===5);
    assert.deepEqual(await page.evaluate(()=>[products[0].reserveStock,orders[0].received,settings.datasetId,activities.length]),[3,2,'dataset4',0]);
    await page.evaluate(()=>undoMovement('purchase4'));
    assert.deepEqual(await page.evaluate(()=>[products[0].reserveStock,products[0].positions[0].qty,orders[0].received,orders[0].status]),[1,1,0,'ordered']);
    assert.equal(await page.evaluate(()=>Core.validateBackup(backupData()).products.length),1);
  });
  test(`${engine}: multi-location lots, count, loss, return and receipt backup`,{timeout:60000},async t=>{
    const {page}=await app(t,engine);await seed(page);
    await page.evaluate(()=>openStock('cleaner'));await page.selectOption('#lotSource','reserve');await page.fill('#lotQty','2000');await page.fill('#lotCode','APC-A');await page.fill('#lotExpiry','2027-01-01');await page.click('#lotForm button[type=submit]');await settled(page,'stockDialog');
    const tagged=await page.evaluate(()=>products.find(p=>p.id==='cleaner').positions.find(s=>s.lotId).id);
    await page.evaluate(()=>openStock('cleaner'));await page.selectOption('#transferSource',tagged);await page.selectOption('#transferBucket','hand');await page.fill('#transferLocation','Véhicule');await page.fill('#transferQty','500');await page.click('#transferForm button[type=submit]');await settled(page,'stockDialog');
    const vehicle=await page.evaluate(()=>products.find(p=>p.id==='cleaner').positions.find(s=>s.location==='Véhicule').id);
    assert.deepEqual(await page.evaluate(()=>{const p=products.find(p=>p.id==='cleaner');return [p.reserveStock,p.inHandStock]}),[3500,1500]);
    await page.evaluate(()=>openCount());await page.selectOption('#countLocation','Véhicule');await page.fill(`[data-count="cleaner/${vehicle}"]`,'450');await page.selectOption('#countLocation','Garage');assert.match(await page.textContent('#countPreview'),/1 emplacement/);await page.click('#countForm button[type=submit]');await settled(page,'countDialog');
    assert.equal(await page.evaluate(()=>products.find(p=>p.id==='cleaner').inHandStock),1450);
    await page.evaluate(()=>undoOperation(activities.find(a=>a.kind==='count').id));assert.equal(await page.evaluate(()=>products.find(p=>p.id==='cleaner').inHandStock),1500);
    await page.evaluate(()=>openMovement(products.find(p=>p.id==='cleaner'),'loss'));await page.selectOption('#movementPosition',vehicle);await page.fill('#movementQty','100');await page.selectOption('#lossReason','spilled');await page.click('#movementForm button[type=submit]');await settled(page,'movementDialog');
    assert.equal(await page.evaluate(()=>movements.find(m=>m.type==='loss').lossCost),1);
    await page.evaluate(()=>openMovement(products.find(p=>p.id==='cleaner'),'supplierReturn'));await page.selectOption('#movementBucket','reserve');await page.fill('#movementQty','100');await page.fill('#refundAmount','1.50');await page.click('#movementForm button[type=submit]');await settled(page,'movementDialog');
    assert.equal(await page.evaluate(()=>movements.find(m=>m.type==='supplierReturn').refund),1.5);
    await page.evaluate(()=>openMovement(products.find(p=>p.id==='cleaner'),'receive'));await page.fill('#movementQty','100');await page.fill('#movementUnitCost','.02');await page.fill('#receiptShipping','2');await page.fill('#receiptDiscount','1');await page.fill('#receiptReference','INV-12');await page.setInputFiles('#receiptFiles',pdf);await page.fill('#receiveLotCode','APC-B');await page.fill('#receiveLotExpiry','2028-02-01');await page.click('#movementForm button[type=submit]');await settled(page,'movementDialog');
    assert.deepEqual(await page.evaluate(()=>{const p=products.find(p=>p.id==='cleaner');return p.positions.filter(s=>s.qty>0).map(s=>[s.location,s.bucket,s.qty])}),[['Garage','reserve',2000],['En main','hand',1000],['Garage','reserve',1400],['Véhicule','hand',400],['Garage','reserve',100]]);
    const backup=await page.evaluate(()=>{const data=Core.validateBackup(backupData()),m=data.movements.find(m=>m.type==='receive');return {amount:m.purchaseTotalCost,receipt:m.attachments[0].name,reference:m.reference,lot:data.products.find(p=>p.id==='cleaner').lots.length,operations:data.activities.length}});
    assert.deepEqual(backup,{amount:3,receipt:'facture.pdf',reference:'INV-12',lot:2,operations:1});
    const saved=await page.evaluate(()=>JSON.stringify({products,movements,orders,activities}));await page.evaluate(async()=>{await clearEverything();await restoreSafety()});assert.equal(await page.evaluate(()=>JSON.stringify({products,movements,orders,activities})),saved);
    await page.evaluate(()=>navigate('history'));assert.ok(await page.getByRole('button',{name:'Facture / reçus (1)'}).count());
    await page.evaluate(()=>navigate('operations'));await page.screenshot({path:path.join(os.tmpdir(),`inventaire-v5-operations-${engine}.png`),fullPage:true});
  });
  test(`${engine}: service templates, atomic failure, grouped undo and dilution`,{timeout:60000},async t=>{
    const {page}=await app(t,engine);await seed(page);await page.evaluate(()=>openService());await page.fill('#serviceName','Nettoyage intérieur');await page.fill('#serviceReference','Client 12');
    await page.selectOption('#serviceProduct','cleaner');await page.selectOption('#servicePosition','hand');await page.fill('#serviceQty','100');await page.click('#serviceAddLine');
    await page.selectOption('#serviceProduct','cloth');await page.selectOption('#servicePosition','hand');await page.fill('#serviceQty','2');await page.click('#serviceAddLine');assert.match(await page.textContent('#servicePreview'),/5,00/);await page.screenshot({path:path.join(os.tmpdir(),`inventaire-v5-service-${engine}.png`)});
    await page.click('#saveServiceTemplate');await page.waitForFunction(()=>activities.some(a=>a.kind==='template')&&!mutationBusy);
    await page.click('#serviceForm button[type=submit]');await settled(page,'serviceDialog');
    assert.deepEqual(await page.evaluate(()=>[products.find(p=>p.id==='cleaner').inHandStock,products.find(p=>p.id==='cloth').inHandStock,activities.find(a=>a.kind==='service').totalCost]),[900,3,5]);
    await page.evaluate(()=>undoMovement(movements.find(m=>m.groupId&&m.type==='consume').id));assert.deepEqual(await page.evaluate(()=>[products.find(p=>p.id==='cleaner').inHandStock,products.find(p=>p.id==='cloth').inHandStock]),[1000,5]);
    await page.evaluate(()=>openService());const template=await page.evaluate(()=>activities.find(a=>a.kind==='template').id);await page.selectOption('#serviceTemplate',template);assert.equal(await page.locator('#serviceLines .service-row').count(),2);
    await page.evaluate(()=>{serviceDraft[1].qty=999;renderService()});const previous=await page.evaluate(()=>JSON.stringify(products));await page.click('#serviceForm button[type=submit]');await page.waitForFunction(()=>!mutationBusy);assert.equal(await page.evaluate(()=>JSON.stringify(products)),previous);assert.match(await page.textContent('#toast'),/Quantité supérieure/);
    await page.evaluate(()=>{$('serviceDialog').close();openDilution()});await page.selectOption('#dilutionProduct','cleaner');await page.selectOption('#dilutionPosition','hand');assert.match(await page.textContent('#dilutionPreview'),/100 mL.*900 mL/);await page.click('#recordDilution');await settled(page,'dilutionDialog');
    assert.equal(await page.evaluate(()=>products.find(p=>p.id==='cleaner').inHandStock),900);
    await page.reload();await page.waitForFunction(()=>settings.schemaVersion===5);assert.equal(await page.evaluate(()=>activities.filter(a=>a.kind==='template').length),1);
  });
  test(`${engine}: CSV and Excel preview, duplicate blocking and recovery include new records`,{timeout:60000},async t=>{
    const {page}=await app(t,engine);await seed(page);await page.evaluate(()=>openCatalog());
    const csv='Produit;Code-barres;Unité;Réserve;Coût unitaire\nDoublon;0012345678905;mL;1;1\nNouveau;000123456789;unité;12;1,25\nInvalide;;unité;-3;1';
    await page.setInputFiles('#catalogFile',{name:'catalog.csv',mimeType:'text/csv',buffer:Buffer.from(csv)});await page.waitForFunction(()=>catalogDraft.length===3);
    assert.equal(await page.locator('[data-catalog-row]:checked').count(),1);assert.match(await page.textContent('#catalogStatus'),/1 doublon/);assert.match(await page.textContent('#catalogStatus'),/1 ligne\(s\) invalide/);await page.screenshot({path:path.join(os.tmpdir(),`inventaire-v5-catalog-${engine}.png`)});
    await page.click('#catalogImportBtn');await settled(page,'catalogDialog');assert.equal(await page.evaluate(()=>products.length),3);assert.equal(await page.evaluate(()=>products.find(p=>p.name==='Nouveau').unitCost),1.25);
    await page.evaluate(()=>restoreSafety());assert.equal(await page.evaluate(()=>products.length),2);
    const book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([['Produit','Code-barres','Réserve','Coût unitaire'],['Produit Excel','000000012345',7,3.5]]),'Catalogue');
    await page.evaluate(()=>openCatalog());await page.setInputFiles('#catalogFile',{name:'catalog.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:Buffer.from(XLSX.write(book,{type:'buffer',bookType:'xlsx'}))});await page.waitForFunction(()=>catalogDraft.length===1);
    await page.click('#catalogImportBtn');await settled(page,'catalogDialog');assert.equal(await page.evaluate(()=>products.find(p=>p.name==='Produit Excel').barcode),'000000012345');
    await page.click('#quickAddBtn');await page.fill('#productName','Doublon manuel');await page.fill('#barcode','0012345678905');assert.match(await page.textContent('#duplicateHint'),/Concentré APC/);await page.click('#productForm button[type=submit]');await page.waitForFunction(()=>!mutationBusy);assert.equal(await page.evaluate(()=>products.length),3);
  });
  test(`${engine}: narrow screens, stale counts and new tools work offline`,{timeout:45000},async t=>{
    const {page,context}=await app(t,engine);await seed(page);await page.setViewportSize({width:360,height:800});
    await page.evaluate(()=>openCount());await page.fill('[data-count="cleaner/hand"]','700');
    await page.evaluate(async()=>{const p=products.find(p=>p.id==='cleaner'),r=Core.apply(p,{type:'consume',quantity:10});r.product.revision=1;await commitData({products:[r.product],movements:[newMovement(p,'Autre fenêtre',10,'','−',r.movement)]});await loadData()});
    await page.click('#countForm button[type=submit]');await page.waitForFunction(()=>!mutationBusy);assert.equal(await page.evaluate(()=>products.find(p=>p.id==='cleaner').inHandStock),990);assert.match(await page.textContent('#toast'),/changé pendant le comptage/);
    await page.evaluate(()=>{$('countDialog').close();navigate('operations')});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    for(const action of ['openCount','openService','openDilution','openCatalog']){await page.evaluate(fn=>window[fn](),action);const width=await page.evaluate(()=>{const d=document.querySelector('dialog[open]');return {width:d.getBoundingClientRect().width,scroll:d.scrollWidth,client:d.clientWidth}});assert.ok(width.width<=360);assert.ok(width.scroll<=width.client+1,action+' must not overflow');await page.evaluate(()=>document.querySelector('dialog[open]').close())}
    await page.evaluate(async()=>{await navigator.serviceWorker.ready});await page.waitForFunction(()=>navigator.serviceWorker.controller);networkAvailable=false;t.after(()=>{networkAvailable=true});await page.reload();await page.waitForFunction(()=>settings.schemaVersion===5);await page.evaluate(()=>openDilution());assert.match(await page.textContent('#dilutionPreview'),/100 mL/);
    await page.evaluate(()=>{$('dilutionDialog').close();openCatalog()});await page.setInputFiles('#catalogFile',{name:'offline.csv',mimeType:'text/csv',buffer:Buffer.from('Produit;Réserve\nHors ligne;3')});await page.waitForFunction(()=>catalogDraft.length===1);assert.equal(await page.isEnabled('#catalogImportBtn'),true);
  });
}
