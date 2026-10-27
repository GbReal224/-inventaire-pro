// Run with Node's test runner and Playwright + WebKit installed:
// node --test tests/scanner-business.test.cjs
const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const {webkit}=require('playwright');

const fixtures=[
  {format:'UPCA',code:'012345678905',bits:'10100011010011001001001101111010100011011000101010101000010001001001000111010011100101001110101'},
  {format:'EAN13',code:'5901234123457',bits:'10100010110100111011001100100110111101001110101010110011011011001000010101110010011101000100101'},
  {format:'EAN8',code:'96385074',bits:'1010001011010111101111010110111010101001110111001010001001011100101'},
  {format:'UPCE',code:'01234565',bits:'101011001100100110111101001110101110010101111010101'}
];
let browser,server,base,networkAvailable=true;
before(async()=>{
  const root=path.resolve(__dirname,'..');
  server=http.createServer((req,res)=>{
    if(!networkAvailable){res.destroy();return}
    const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
    const file=path.join(root,pathname==='/'?'index.html':pathname);
    if(!file.startsWith(root+path.sep)){res.writeHead(403).end();return}
    try{
      const types={'.js':'text/javascript','.wasm':'application/wasm','.css':'text/css','.png':'image/png','.webmanifest':'application/manifest+json'};
      res.setHeader('Content-Type',types[path.extname(file)]||'text/html');res.end(fs.readFileSync(file));
    }catch{res.writeHead(404).end()}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  base=`http://127.0.0.1:${server.address().port}`;
  browser=await webkit.launch({headless:true});
});
after(async()=>{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve))});

async function openApp(t){
  const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  t.after(()=>context.close());
  const page=await context.newPage();
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  t.after(()=>assert.deepEqual(errors,[],'No uncaught browser errors'));
  await page.goto(base);await page.waitForFunction(()=>typeof db!=='undefined'&&db&&document.getElementById('lastSavedText').textContent.includes('Sauvegardé'));
  return {page,context};
}

async function installCameraMock(page){
  await page.evaluate(()=>{
    window.cameraTest={requests:[],stops:0,mode:'ready',code:'',hidden:false};
    if(!navigator.mediaDevices)Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{}});
    Object.defineProperty(document,'hidden',{configurable:true,get:()=>cameraTest.hidden});
    const sources=new WeakMap();
    Object.defineProperty(HTMLMediaElement.prototype,'srcObject',{configurable:true,get(){return sources.get(this)||null},set(value){sources.set(this,value)}});
    Object.defineProperty(HTMLMediaElement.prototype,'readyState',{configurable:true,get(){return 2}});
    HTMLMediaElement.prototype.play=async()=>{};HTMLMediaElement.prototype.pause=()=>{};
    const stream=()=>{
      const track={stop(){cameraTest.stops++},getSettings:()=>({deviceId:'back',zoom:1}),getCapabilities:()=>({focusMode:['continuous'],zoom:{min:1,max:4,step:0.1}}),applyConstraints:async c=>{cameraTest.constraints=c}};
      return {getTracks:()=>[track],getVideoTracks:()=>[track]};
    };
    Object.defineProperty(navigator.mediaDevices,'getUserMedia',{configurable:true,value:async constraints=>{
      cameraTest.requests.push(constraints);
      if(cameraTest.mode==='denied')throw new DOMException('Denied','NotAllowedError');
      if(cameraTest.mode==='pending')return new Promise(resolve=>{cameraTest.release=()=>resolve(stream())});
      return stream();
    }});
    Object.defineProperty(navigator.mediaDevices,'enumerateDevices',{configurable:true,value:async()=>[
      {kind:'videoinput',deviceId:'back',label:'Caméra arrière'},
      {kind:'videoinput',deviceId:'wide',label:'Caméra ultra grand-angle'}
    ]});
    const realDecode=decodeBarcodeFrame;
    decodeBarcodeFrame=async(source,crop)=>source===$('scannerVideo')?cameraTest.code:realDecode(source,crop);
  });
}

async function createFixtureCanvas(page,fixture,variation='normal'){
  return page.evaluate(({fixture,variation})=>{
    const barcode=document.createElement('canvas');barcode.width=fixture.bits.length*3+48;barcode.height=168;
    const ink=barcode.getContext('2d');ink.fillStyle='white';ink.fillRect(0,0,barcode.width,barcode.height);ink.fillStyle='black';
    [...fixture.bits].forEach((bit,i)=>{if(bit==='1')ink.fillRect(24+i*3,24,3,120)});
    const canvas=document.createElement('canvas');canvas.width=variation==='portrait'?1080:1280;canvas.height=variation==='portrait'?1920:720;
    const ctx=canvas.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,canvas.width,canvas.height);
    if(variation==='blur')ctx.filter='blur(0.7px)';
    if(variation==='rotated'){ctx.translate(640,360);ctx.rotate(Math.PI/2);ctx.drawImage(barcode,-barcode.width/2,-barcode.height/2)}
    else ctx.drawImage(barcode,(canvas.width-barcode.width)/2,variation==='off-center'?50:(canvas.height-barcode.height)/2);
    window.barcodeFixture=canvas;return canvas.toDataURL('image/png');
  },{fixture,variation});
}

test('WebKit decodes UPC-A, UPC-E, EAN-8 and EAN-13 in five image conditions',async t=>{
  const {page}=await openApp(t);assert.equal(await page.evaluate(()=>ensureZXing()),true);
  for(const fixture of fixtures)for(const variation of ['normal','off-center','portrait','rotated','blur']){
    await createFixtureCanvas(page,fixture,variation);
    assert.equal(await page.evaluate(()=>decodeBarcodeFrame(barcodeFixture)),fixture.code,`${fixture.format}: ${variation}`);
  }
  const invalid={...fixtures[2],bits:fixtures[2].bits.slice(0,10)+'0001101'+fixtures[2].bits.slice(17)};
  await createFixtureCanvas(page,invalid);
  assert.equal(await page.evaluate(()=>decodeBarcodeFrame(barcodeFixture)),'','Reject incorrect checksum');
});

test('Camera selection, zoom, recognition and close release the camera',async t=>{
  const {page}=await openApp(t);await installCameraMock(page);await page.click('#scanTopBtn');
  await page.waitForFunction(()=>cameraTest.requests.length===1&&$('scannerStatus').textContent.includes('Caméra active'));
  await page.selectOption('#scannerCamera','wide');
  await page.waitForFunction(()=>cameraTest.requests.length===2);
  assert.equal(await page.evaluate(()=>cameraTest.requests[1].video.deviceId.exact),'wide');
  await page.locator('#scannerZoom').fill('2');await page.locator('#scannerZoom').dispatchEvent('input');
  await page.waitForFunction(()=>$('scannerZoomValue').textContent==='2.0×');
  await page.evaluate(()=>cameraTest.code='012345678905');
  await page.waitForFunction(()=>$('scanCodeText').textContent==='012345678905');
  assert.equal(await page.evaluate(()=>$('scannerVideo').srcObject),null);
  assert.ok(await page.evaluate(()=>cameraTest.stops>=2));
  await page.click('#scannerCloseBtn');assert.equal(await page.evaluate(()=>$('scannerDialog').open),false);
});

test('Closing during pending camera permission stops the late stream',async t=>{
  const {page}=await openApp(t);await installCameraMock(page);await page.evaluate(()=>cameraTest.mode='pending');
  await page.click('#scanTopBtn');await page.waitForFunction(()=>Boolean(cameraTest.release));
  await page.click('#scannerCloseBtn');await page.evaluate(()=>cameraTest.release());
  await page.waitForFunction(()=>cameraTest.stops===1);
  assert.equal(await page.evaluate(()=>$('scannerVideo').srcObject),null);
});

test('Denied camera permission has an actionable message and can be retried',async t=>{
  const {page}=await openApp(t);await installCameraMock(page);await page.evaluate(()=>cameraTest.mode='denied');
  await page.click('#scanTopBtn');await page.waitForFunction(()=>$('scannerStatus').textContent.includes('refusé'));
  await page.evaluate(()=>cameraTest.mode='ready');await page.click('#retryScannerBtn');
  await page.waitForFunction(()=>$('scannerStatus').textContent.includes('Caméra active'));
});

test('Installed-app backgrounding stops the stream and returning restarts it',async t=>{
  const {page}=await openApp(t);await installCameraMock(page);await page.click('#scanTopBtn');
  await page.waitForFunction(()=>cameraTest.requests.length===1&&$('scannerVideo').srcObject);
  await page.evaluate(()=>{cameraTest.hidden=true;document.dispatchEvent(new Event('visibilitychange'))});
  assert.equal(await page.evaluate(()=>$('scannerVideo').srcObject),null);
  await page.evaluate(()=>{cameraTest.hidden=false;document.dispatchEvent(new Event('visibilitychange'))});
  await page.waitForFunction(()=>cameraTest.requests.length===2&&$('scannerVideo').srcObject);
  await page.evaluate(()=>handleScanDetected('96385074'));
  await page.evaluate(()=>{cameraTest.hidden=true;document.dispatchEvent(new Event('visibilitychange'));cameraTest.hidden=false;document.dispatchEvent(new Event('visibilitychange'))});
  assert.equal(await page.evaluate(()=>cameraTest.requests.length),2,'Keep the detected code on return');
});

test('Photo fallback reads an actual image and finds the existing inventory product',async t=>{
  const {page}=await openApp(t);await installCameraMock(page);
  const image=await createFixtureCanvas(page,fixtures[1],'rotated');
  await page.evaluate(()=>products=[{id:'test-product',name:'Produit test',barcode:'5901234123457',unit:'unité'}]);
  await page.click('#scanTopBtn');
  await page.locator('#barcodeImageInput').setInputFiles({name:'barcode.png',mimeType:'image/png',buffer:Buffer.from(image.split(',')[1],'base64')});
  await page.waitForFunction(()=>$('scanCodeText').textContent==='5901234123457');
  await page.click('#scanUseBtn');assert.equal(await page.inputValue('#productId'),'test-product');
});

test('Amazon links offer the official Business login and preserve the exact product',async t=>{
  const {page,context}=await openApp(t);await installCameraMock(page);
  const productUrl='https://www.amazon.ca/dp/B012345678?th=1&psc=1';
  await page.evaluate(productUrl=>{products=[{id:'test',name:'Produit test',barcode:'012345678905',productUrl}];renderInventory();navigate('inventory')},productUrl);
  await page.click('#inventoryList [data-amazon]');
  assert.equal(await page.getAttribute('#amazonBusinessLoginLink','href'),'https://business.amazon.ca/fr/login');
  assert.equal(await page.getAttribute('#amazonProductLink','href'),productUrl);
  await context.route('https://business.amazon.ca/**',route=>route.fulfill({contentType:'text/html',body:'Business login test'}));
  const popupPromise=page.waitForEvent('popup');await page.click('#amazonBusinessLoginLink');const popup=await popupPromise;
  await popup.waitForLoadState();assert.equal(popup.url(),'https://business.amazon.ca/fr/login');await popup.close();
  assert.equal(await page.getAttribute('#amazonProductLink','href'),productUrl);
  await page.click('[data-close="amazonDialog"]');
  await page.click('#scanTopBtn');await page.fill('#manualBarcode','012345678905');await page.click('#manualCodeBtn');await page.click('#scanAmazonBtn');
  assert.equal(await page.getAttribute('#amazonProductLink','href'),productUrl,'Scan reuses the saved exact link');
  assert.equal(await page.evaluate(()=>$('scannerVideo').srcObject),null);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'No horizontal page overflow');
  await page.evaluate(()=>{openAmazonBusiness({name:'Nettoyant & cire'});});
  assert.equal(new URL(await page.getAttribute('#amazonProductLink','href')).searchParams.get('k'),'Nettoyant & cire');
  await context.route('https://supplier.example/**',route=>route.fulfill({contentType:'text/html',body:'Supplier test'}));
  const supplierPopup=page.waitForEvent('popup');await page.evaluate(()=>openAmazonBusiness({productUrl:'https://supplier.example/product'}));
  const supplier=await supplierPopup;await supplier.waitForLoadState();assert.equal(supplier.url(),'https://supplier.example/product');await supplier.close();
});

test('An installed copy reloads and decodes fully offline without CDN requests',async t=>{
  const {page,context}=await openApp(t);
  await page.evaluate(()=>navigator.serviceWorker.ready);
  await page.waitForFunction(()=>Boolean(navigator.serviceWorker.controller));
  networkAvailable=false;t.after(()=>{networkAvailable=true});
  await page.reload();await page.waitForFunction(()=>typeof db!=='undefined'&&db);
  assert.equal(await page.evaluate(()=>ensureZXing()),true);
  await createFixtureCanvas(page,fixtures[3]);assert.equal(await page.evaluate(()=>decodeBarcodeFrame(barcodeFixture)),fixtures[3].code);
});
