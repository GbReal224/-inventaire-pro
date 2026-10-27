/* ---------- Photos ---------- */
function fileToDataUrl(file){return new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=()=>reject(r.error);r.readAsDataURL(file)})}
async function compressImage(file){
  if(!file||!file.type.startsWith('image/'))throw new Error('invalid image');
  const src=await fileToDataUrl(file);
  const img=await new Promise((resolve,reject)=>{const i=new Image();i.onload=()=>resolve(i);i.onerror=reject;i.src=src});
  const max=900,scale=Math.min(1,max/Math.max(img.naturalWidth||1,img.naturalHeight||1));
  const w=Math.max(1,Math.round(img.naturalWidth*scale)),h=Math.max(1,Math.round(img.naturalHeight*scale));
  const c=document.createElement('canvas');c.width=w;c.height=h;const ctx=c.getContext('2d');ctx.drawImage(img,0,0,w,h);
  return c.toDataURL('image/jpeg',0.78);
}
async function handlePhoto(file){try{showToast('Préparation de la photo…');tempPhotoData=await compressImage(file);updatePhotoPreview();showToast('Photo ajoutée')}catch(e){console.error(e);showToast('Impossible de lire cette photo')}}

/* ---------- Amazon ---------- */
const AMAZON_BUSINESS_LOGIN = 'https://business.amazon.ca/fr/login';
function isAmazonDestination(value){
  try{const host=new URL(value).hostname.toLowerCase();return /(^|\.)amazon\.(ca|com)$/.test(host)||['amzn.to','a.co'].includes(host)}catch{return false}
}
function amazonBusinessProductUrl(p){
  let url=new URL(productAmazonUrl(p));
  // Amazon publishes /abredir/* for its Business iOS app on this domain:
  // https://business.amazon.ca/.well-known/apple-app-site-association
  // The endpoint preserves the product path and query when falling back to the web.
  if(/^business\.amazon\.(ca|com)$/.test(url.hostname))return url.href;
  if(['amzn.to','a.co'].includes(url.hostname)){
    // Short links belong to the Shopping app. Use the item's identifier instead.
    const term=p?.barcode||p?.name||'';
    url=new URL(term?amazonSearchUrl(term):'https://www.amazon.ca/');
  }
  const market=url.hostname.match(/(?:^|\.)(amazon\.(?:ca|com))$/)?.[1];
  if(!market)return url.href;
  url.protocol='https:';url.hostname=`business.${market}`;url.port='';
  url.pathname=`/abredir${url.pathname}`;
  return url.href;
}
function amazonBrowserProductUrl(p){
  const url=new URL(amazonBusinessProductUrl(p));
  if(/^business\.amazon\.(ca|com)$/.test(url.hostname)&&url.pathname.startsWith('/abredir/')){
    url.hostname=url.hostname.replace(/^business\./,'www.');url.pathname=url.pathname.slice('/abredir'.length);
  }
  // Amazon's association file explicitly excludes nodl=1 from native app handoff.
  url.searchParams.set('nodl','1');
  return url.href;
}
function openAmazonBusiness(p){
  if(!p)return;
  let destination;try{destination=Core.httpUrl(productAmazonUrl(p))}catch(e){return showToast(e.message)}
  // Keep existing supplier links intact. Amazon's Business account shares amazon.ca.
  if(!isAmazonDestination(destination)){openExternal(destination);return}
  stopScanner();
  $('amazonProductName').textContent=p.name||p.barcode||'Recherche de produit';
  $('amazonProductLink').href=amazonAppProductUrl(p);
  $('amazonBrowserLink').href=amazonBrowserProductUrl(p);
  $('amazonBusinessLoginLink').href=AMAZON_BUSINESS_LOGIN;
  if(!$('amazonDialog').open)$('amazonDialog').showModal();
}
function amazonAppProductUrl(p){
  const destination=amazonBusinessProductUrl(p);
  if(!/Android/i.test(navigator.userAgent))return destination;
  // Amazon's Digital Asset Links declares this separate Android Business package.
  // https://business.amazon.ca/.well-known/assetlinks.json
  const url=new URL(destination);url.hash='';
  return `intent://${url.host}${url.pathname}${url.search}#Intent;scheme=https;package=com.amazon.mShop.android.business.shopping;S.browser_fallback_url=${encodeURIComponent(amazonBrowserProductUrl(p))};end`;
}
function amazonSearchFromForm(){const term=normalizeBarcode($('barcode').value)||$('productName').value.trim();if(!term)return showToast('Scanne un code ou entre un nom de produit');openAmazonBusiness({name:$('productName').value.trim(),barcode:term})}

/* ---------- Scanner UPC / EAN ---------- */
async function ensureZXing(){
  if(scannerLibraryPromise)return scannerLibraryPromise;
  scannerLibraryPromise=(async()=>{
    if(!window.ZXingWASM)await new Promise((resolve,reject)=>{
      const script=document.createElement('script');
      const finish=error=>{clearTimeout(timer);script.onload=script.onerror=null;if(error){script.remove();reject(error)}else resolve()};
      const timer=setTimeout(()=>finish(new Error('Scanner loading timeout')),10000);
      script.src='vendor/zxing-wasm-reader-3.1.6.js';
      script.onload=()=>finish();script.onerror=()=>finish(new Error('Scanner script unavailable'));
      document.head.appendChild(script);
    });
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
    try{
      // Both files are shipped and cached with the app; no CDN is needed on iPhone.
      const response=await fetch('vendor/zxing_reader-3.1.6.wasm',{signal:controller.signal});
      if(!response.ok)throw new Error('Scanner binary unavailable');
      await ZXingWASM.prepareZXingModule({overrides:{wasmBinary:await response.arrayBuffer()},fireImmediately:true});
    }finally{clearTimeout(timer)}
    return true;
  })().catch(error=>{console.error(error);scannerLibraryPromise=null;return false});
  return scannerLibraryPromise;
}
function stopScanner(){
  scannerSession++;clearTimeout(scannerTimer);
  const video=$('scannerVideo');
  for(const stream of new Set([scannerStream,video?.srcObject]))stream?.getTracks().forEach(t=>t.stop());
  scannerStream=null;
  if(video){video.pause();video.srcObject=null}
}
function scannerIsCurrent(session){return session===scannerSession&&$('scannerDialog').open&&!document.hidden}
function scannerErrorMessage(error){
  if(['NotAllowedError','PermissionDeniedError'].includes(error?.name))return 'Accès à la caméra refusé. Autorise la caméra pour ce site, puis touche « Relancer la caméra ». Tu peux aussi utiliser « Photo du code ».';
  if(['NotFoundError','DevicesNotFoundError'].includes(error?.name))return 'Aucune caméra disponible. Utilise « Photo du code » ou entre les chiffres.';
  if(['NotReadableError','TrackStartError'].includes(error?.name))return 'La caméra est occupée. Ferme les autres apps qui l’utilisent, puis relance la caméra.';
  return 'La caméra n’a pas pu démarrer. Touche « Relancer la caméra » ou utilise « Photo du code ».';
}
async function updateScannerCameras(session,stream){
  try{
    const devices=await navigator.mediaDevices.enumerateDevices();
    if(!scannerIsCurrent(session))return;
    const cameras=devices.filter(d=>d.kind==='videoinput'&&d.deviceId),select=$('scannerCamera');
    select.replaceChildren();
    cameras.forEach((camera,i)=>{const option=document.createElement('option');option.value=camera.deviceId;option.textContent=camera.label||`Caméra ${i+1}`;select.appendChild(option)});
    const current=stream.getVideoTracks()[0]?.getSettings?.().deviceId;
    if(current)select.value=current;
    $('scannerCameraField').classList.toggle('hidden',cameras.length<2);
  }catch{/* Camera selection is optional; decoding continues. */}
}
async function configureScannerFocus(track,session){
  try{
    const capabilities=track.getCapabilities?.();
    if(capabilities?.focusMode?.includes('continuous'))await track.applyConstraints({advanced:[{focusMode:'continuous'}]});
    if(!scannerIsCurrent(session))return;
    const zoom=capabilities?.zoom;
    if(zoom&&zoom.max>zoom.min){
      const input=$('scannerZoom');input.min=zoom.min;input.max=Math.min(zoom.max,Math.max(4,zoom.min));input.step=zoom.step||0.1;
      input.value=track.getSettings?.().zoom??zoom.min;
      $('scannerZoomValue').textContent=`${Number(input.value).toFixed(1)}×`;
      $('scannerZoomField').classList.remove('hidden');
    }
  }catch{/* Unsupported focus controls must not prevent scanning. */}
}
function scannedBarcodeText(result){
  if(!result||!result.isValid)return '';
  const text=normalizeBarcode(result.text);
  // ZXing-C++ normalizes UPCs to EAN-13. Preserve the digits printed on the product.
  try{const original=normalizeBarcode(JSON.parse(result.extra||'{}').UPCE);if(original.length===8)return original}catch{}
  return text.length===13&&text.startsWith('0')?text.slice(1):text;
}
async function decodeBarcodeFrame(source,crop=false){
  const width=source.videoWidth||source.naturalWidth||source.width,height=source.videoHeight||source.naturalHeight||source.height;
  if(!width||!height)return '';
  const canvas=$('scannerCanvas'),sy=crop?Math.floor(height*0.25):0,sh=crop?Math.floor(height*0.5):height;
  const scale=Math.min(1,1600/Math.max(width,sh));canvas.width=Math.max(1,Math.round(width*scale));canvas.height=Math.max(1,Math.round(sh*scale));
  const context=canvas.getContext('2d',{willReadFrequently:true});
  context.drawImage(source,0,sy,width,sh,0,0,canvas.width,canvas.height);
  const results=await ZXingWASM.readBarcodes(context.getImageData(0,0,canvas.width,canvas.height),{
    formats:['EAN13','EAN8','UPCA','UPCE'],tryHarder:true,tryRotate:true,tryInvert:true,
    tryDownscale:true,maxNumberOfSymbols:1,returnErrors:false
  });
  return scannedBarcodeText(results[0]);
}
async function scanVideoFrame(session,attempt=0){
  if(!scannerIsCurrent(session))return;
  const video=$('scannerVideo');
  try{
    if(video.readyState>=2){
      const code=await decodeBarcodeFrame(video,attempt%2===0);
      if(!scannerIsCurrent(session))return;
      if(code){handleScanDetected(code);return}
    }
  }catch(error){
    if(!scannerIsCurrent(session))return;
    stopScanner();console.error(error);$('scannerStatus').textContent='La lecture a été interrompue. Relance la caméra ou utilise « Photo du code ».';return;
  }
  if(scannerIsCurrent(session))scannerTimer=setTimeout(()=>scanVideoFrame(session,attempt+1),180);
}
async function startScanner(){
  stopScanner();scanLastCode='';$('scanResult').classList.add('hidden');$('scannerStatus').textContent='Démarrage de la caméra…';
  const session=scannerSession;
  $('scannerCameraField').classList.add('hidden');$('scannerZoomField').classList.add('hidden');
  if(!window.isSecureContext){$('scannerStatus').textContent='La caméra nécessite une adresse HTTPS. Ouvre l’app depuis son adresse sécurisée.';return}
  if(!navigator.mediaDevices?.getUserMedia){$('scannerStatus').textContent='Caméra non disponible. Utilise « Photo du code » ou entre le code manuellement.';return}
  if(!(await ensureZXing())){if(scannerIsCurrent(session))$('scannerStatus').textContent='Le lecteur de codes est indisponible. Rouvre l’app avec Internet pour terminer sa mise à jour.';return}
  if(!scannerIsCurrent(session))return;
  let stream;
  try{
    const videoConstraints=scannerCameraId?{deviceId:{exact:scannerCameraId}}:{facingMode:{ideal:'environment'}};
    try{stream=await navigator.mediaDevices.getUserMedia({audio:false,video:{...videoConstraints,width:{ideal:1920},height:{ideal:1080}}})}
    catch(error){
      if(!scannerIsCurrent(session))return;
      if(!['OverconstrainedError','NotFoundError'].includes(error?.name))throw error;
      scannerCameraId='';stream=await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:{ideal:'environment'}}});
    }
    if(!scannerIsCurrent(session)){stream.getTracks().forEach(t=>t.stop());return}
    scannerStream=stream;
    const video=$('scannerVideo');video.muted=true;video.autoplay=true;video.playsInline=true;video.srcObject=stream;
    await video.play();
    if(!scannerIsCurrent(session)){stream.getTracks().forEach(t=>t.stop());return}
    $('scannerStatus').textContent='Caméra active — garde le code net, à environ 15–25 cm. Change de caméra si l’image reste floue.';
    updateScannerCameras(session,stream);configureScannerFocus(stream.getVideoTracks()[0],session);
    scanVideoFrame(session);
  }catch(e){
    stream?.getTracks().forEach(t=>t.stop());
    if(!scannerIsCurrent(session))return;
    stopScanner();console.error(e);$('scannerStatus').textContent=scannerErrorMessage(e);
  }
}
function handleScanDetected(code){scanLastCode=normalizeBarcode(code);if(!scanLastCode)return;stopScanner();$('scanCodeText').textContent=scanLastCode;$('scanResult').classList.remove('hidden');$('scannerStatus').textContent='Code détecté ✓';updateScanActions();if(navigator.vibrate)navigator.vibrate(80)}
function openScanner(target='standalone'){scannerTarget=target;scanLastCode='';$('manualBarcode').value='';$('scanResult').classList.add('hidden');if(!$('scannerDialog').open)$('scannerDialog').showModal();startScanner()}
function closeScanner(){stopScanner();if($('scannerDialog').open)$('scannerDialog').close()}
function useManualCode(){const code=normalizeBarcode($('manualBarcode').value);if(code.length<8)return showToast('Entre au moins 8 chiffres');handleScanDetected(code)}
function useScannedCode(){
  const code=scanLastCode||normalizeBarcode($('manualBarcode').value);if(!code)return;
  closeScanner();
  if(scannerTarget==='form'){$('barcode').value=code;if(!$('supplier').value)$('supplier').value='Amazon Business';showToast('Code ajouté à la fiche');return}
  const existing=products.find(p=>!p.archived&&normalizeBarcode(p.barcode)===code)||products.find(p=>normalizeBarcode(p.barcode)===code);if(existing){openProduct(existing);showToast('Produit trouvé dans ton inventaire');return}
  openProduct();$('barcode').value=code;$('supplier').value='Amazon Business';$('productName').placeholder='Nom du produit trouvé sur Amazon';showToast('Nouveau code ajouté');
}
function searchScannedOnAmazon(){const code=scanLastCode||normalizeBarcode($('manualBarcode').value);if(!code)return showToast('Aucun code détecté');openAmazonBusiness(products.find(p=>!p.archived&&normalizeBarcode(p.barcode)===code)||products.find(p=>normalizeBarcode(p.barcode)===code)||{barcode:code})}
async function decodeBarcodePhoto(file){
  if(!file)return;stopScanner();const session=scannerSession;
  scanLastCode='';$('scanResult').classList.add('hidden');$('scannerStatus').textContent='Lecture de la photo…';
  if(!(await ensureZXing())){if(scannerIsCurrent(session))$('scannerStatus').textContent='Lecteur indisponible. Rouvre l’app avec Internet pour terminer sa mise à jour.';return}
  if(!scannerIsCurrent(session))return;
  const url=URL.createObjectURL(file);
  try{
    const img=new Image();await new Promise((resolve,reject)=>{img.onload=resolve;img.onerror=reject;img.src=url});
    if(!scannerIsCurrent(session))return;
    const code=await decodeBarcodeFrame(img)||await decodeBarcodeFrame(img,true);
    if(!scannerIsCurrent(session))return;
    if(code)handleScanDetected(code);
    else $('scannerStatus').textContent='Aucun code lisible sur cette photo. Garde le code net et entier, avec un peu de blanc de chaque côté.';
  }catch(e){if(scannerIsCurrent(session))$('scannerStatus').textContent='Impossible de lire cette photo. Essaie une autre photo ou entre le code manuellement.'}
  finally{URL.revokeObjectURL(url)}
}

/* ---------- PDF local sans service externe ---------- */
function padText(value,width){let s=String(value??'');if(s.length>width)s=s.slice(0,Math.max(1,width-1))+'…';return s.padEnd(width,' ')}
function pdfClean(s){return String(s??'').replace(/[’‘]/g,"'").replace(/[“”]/g,'"').replace(/[–—]/g,'-').replace(/œ/g,'oe').replace(/Œ/g,'OE').replace(/…/g,'...').replace(/[^\x20-\xFF]/g,'?')}
function pdfEscape(s){return pdfClean(s).replace(/\\/g,'\\\\').replace(/\(/g,'\\(').replace(/\)/g,'\\)')}
function chunkLines(lines,max=72){const pages=[];for(let i=0;i<lines.length;i+=max)pages.push(lines.slice(i,i+max));return pages.length?pages:[['Inventaire Pro']]}
function buildPdfBytes(pages){
  const pageCount=pages.length,fontNum=3+pageCount*2,objs=[];
  objs[1]='<< /Type /Catalog /Pages 2 0 R >>';
  const kids=[];for(let i=0;i<pageCount;i++)kids.push(`${3+i*2} 0 R`);
  objs[2]=`<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pageCount} >>`;
  for(let i=0;i<pageCount;i++){
    const pageNum=3+i*2,contentNum=pageNum+1;let content='BT\n/F1 8.2 Tf\n34 810 Td\n10.5 TL\n';
    for(const line of pages[i])content+=`(${pdfEscape(line)}) Tj\nT*\n`;content+='ET\n';
    objs[pageNum]=`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${fontNum} 0 R >> >> /Contents ${contentNum} 0 R >>`;
    objs[contentNum]=`<< /Length ${content.length} >>\nstream\n${content}endstream`;
  }
  objs[fontNum]='<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>';
  let pdf='%PDF-1.4\n%\xE2\xE3\xCF\xD3\n',offsets=[0];
  for(let i=1;i<=fontNum;i++){offsets[i]=pdf.length;pdf+=`${i} 0 obj\n${objs[i]}\nendobj\n`}
  const xref=pdf.length;pdf+=`xref\n0 ${fontNum+1}\n0000000000 65535 f \n`;for(let i=1;i<=fontNum;i++)pdf+=`${String(offsets[i]).padStart(10,'0')} 00000 n \n`;
  pdf+=`trailer\n<< /Size ${fontNum+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  const bytes=new Uint8Array(pdf.length);for(let i=0;i<pdf.length;i++)bytes[i]=pdf.charCodeAt(i)&255;return bytes;
}
function exportPdf(ordersOnly=false){
  const date=new Date(),orderList=activeProducts().filter(p=>toOrder(p)>0).sort(prioritySort),reserveValue=products.reduce((s,p)=>s+Number(p.reserveStock||0)*Number(p.unitCost||0),0),totalValue=products.reduce((s,p)=>s+totalAvailable(p)*Number(p.unitCost||0),0),budget=orderList.reduce((s,p)=>s+toOrder(p)*Number(p.unitCost||0),0),pMonth=purchaseMonthTotals(),pAll=purchaseTotals();
  const lines=[];lines.push('INVENTAIRE PRO - RAPPORT',`Genere le ${date.toLocaleString('fr-CA')}`,'='.repeat(82),'RESUME',`Produits: ${products.length}`,`Valeur reserve: ${fmtMoney(reserveValue)}   Valeur totale reserve + en main: ${fmtMoney(totalValue)}`,`Articles a commander: ${orderList.length}   Budget estime: ${fmtMoney(budget)}`,`Achats ce mois: ${fmtMoney(pMonth.total)}   Achats enregistres: ${fmtMoney(pAll.total)}`,'');
  lines.push('A COMMANDER','-'.repeat(82),`${padText('Produit',31)} ${padText('Res.',7)} ${padText('Min.',7)} ${padText('Cible',7)} ${padText('Qte',7)} ${padText('Cout',14)}`);
  if(!orderList.length)lines.push('Aucun produit a commander.');
  for(const p of orderList)lines.push(`${padText(p.name,31)} ${padText(fmtQty(p.reserveStock),7)} ${padText(fmtQty(p.minReserve),7)} ${padText(fmtQty(targetOf(p)),7)} ${padText(fmtQty(toOrder(p)),7)} ${padText(fmtMoney(toOrder(p)*Number(p.unitCost||0)),14)}`);
  if(!ordersOnly){
    lines.push('','INVENTAIRE COMPLET','-'.repeat(82),`${padText('Produit',27)} ${padText('Reserve',8)} ${padText('Main',7)} ${padText('Min',7)} ${padText('Cible',7)} ${padText('Statut',12)} ${padText('Cout/u',10)}`);
    for(const p of [...products].sort((a,b)=>String(a.name).localeCompare(String(b.name),'fr')))lines.push(`${padText(p.name,27)} ${padText(fmtQty(p.reserveStock),8)} ${padText(fmtQty(p.inHandStock),7)} ${padText(fmtQty(p.minReserve),7)} ${padText(fmtQty(targetOf(p)),7)} ${padText(statusOf(p).label,12)} ${padText(fmtMoney(p.unitCost),10)}`);
    lines.push('','DETAILS FOURNISSEURS / CODES','-'.repeat(82));
    for(const p of products)lines.push(`${padText(p.name,32)} | ${padText(p.barcode||'-',14)} | ${padText(p.supplier||'-',30)}`);
  }
  const bytes=buildPdfBytes(chunkLines(lines));downloadBytes(`inventaire-${ordersOnly?'commandes-':'rapport-'}${date.toISOString().slice(0,10)}.pdf`,bytes,'application/pdf');showToast('PDF généré');
}

function navigate(view){document.querySelectorAll('.view').forEach(v=>v.classList.toggle('active',v.id===`${view}View`));document.querySelectorAll('.nav-btn').forEach(b=>b.classList.toggle('active',b.dataset.view===view));document.querySelectorAll('.nav-btn').forEach(b=>{if(b.dataset.view===view)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current')});if(view==='stats')renderStats();window.scrollTo({top:0,behavior:'instant'})}
function showToast(msg){const t=$('toast');t.textContent=msg;t.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>t.classList.remove('show'),2200)}
function downloadBlob(name,content,type){const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([content],{type}));a.download=name;document.body.appendChild(a);a.click();setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove()},1200)}
function downloadBytes(name,bytes,type){const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([bytes],{type}));a.download=name;document.body.appendChild(a);a.click();setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove()},1500)}
function setupEvents(){
  setupInventoryEvents();
  document.querySelectorAll('.nav-btn').forEach(b=>b.addEventListener('click',()=>navigate(b.dataset.view)));
  document.querySelectorAll('[data-nav]').forEach(b=>b.addEventListener('click',()=>navigate(b.dataset.nav)));
  $('quickAddBtn').onclick=()=>openProduct();$('addProductBtn').onclick=()=>openProduct();
  $('scanTopBtn').onclick=()=>openScanner('standalone');$('dashboardScanBtn').onclick=()=>openScanner('standalone');$('inventoryScanBtn').onclick=()=>openScanner('standalone');
  $('dashboardPdfBtn').onclick=()=>exportPdf(false);$('ordersPdfBtn').onclick=()=>exportPdf(true);$('exportPdfBtn').onclick=()=>exportPdf(false);
  $('productForm').addEventListener('submit',saveProduct);$('movementForm').addEventListener('submit',applyMovement);$('deleteProductBtn').onclick=deleteCurrentProduct;
  $('movementType').addEventListener('change',updateMovementPurchaseFields);$('movementQty').addEventListener('input',updateMovementPurchaseFields);$('movementUnitCost').addEventListener('input',updateMovementPurchaseFields);
  ['reserveStock','inHandStock','minReserve','targetReserve','unitCost'].forEach(id=>$(id).addEventListener('input',updateFormulaPreview));
  document.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>$(b.dataset.close).close());
  $('searchInput').addEventListener('input',renderInventory);$('categoryFilter').addEventListener('change',renderInventory);$('statsPeriod').addEventListener('change',renderStats);$('statsTopLimit').addEventListener('change',renderStats);
  $('exportBtn').onclick=exportBackup;$('exportCsvBtn').onclick=exportCsv;$('seedBtn').onclick=seedExamples;$('clearBtn').onclick=clearEverything;
  $('importInput').addEventListener('change',e=>{if(e.target.files[0])importBackup(e.target.files[0]);e.target.value=''});
  $('photoLibraryInput').addEventListener('change',e=>{if(e.target.files[0])handlePhoto(e.target.files[0]);e.target.value=''});$('photoCameraInput').addEventListener('change',e=>{if(e.target.files[0])handlePhoto(e.target.files[0]);e.target.value=''});$('removePhotoBtn').onclick=()=>{tempPhotoData='';updatePhotoPreview()};
  $('barcode').addEventListener('input',e=>e.target.value=normalizeBarcode(e.target.value));$('scanFromFormBtn').onclick=()=>openScanner('form');$('amazonSearchFormBtn').onclick=amazonSearchFromForm;
  $('scannerCamera').addEventListener('change',e=>{scannerCameraId=e.target.value;startScanner()});
  $('scannerZoom').addEventListener('input',async e=>{
    const zoom=Number(e.target.value),track=scannerStream?.getVideoTracks()[0];
    if(!track)return;
    try{await track.applyConstraints({advanced:[{zoom}]});$('scannerZoomValue').textContent=`${zoom.toFixed(1)}×`}catch{showToast('Ce zoom n’est pas disponible sur cette caméra')}
  });
  $('amazonDialog').addEventListener('close',()=>{if($('scannerDialog').open&&!scanLastCode&&!document.hidden)startScanner()});
  $('scannerCloseBtn').onclick=closeScanner;$('scannerDialog').addEventListener('close',stopScanner);$('manualCodeBtn').onclick=useManualCode;$('scanUseBtn').onclick=useScannedCode;$('scanAmazonBtn').onclick=searchScannedOnAmazon;$('retryScannerBtn').onclick=startScanner;$('barcodeImageInput').addEventListener('change',e=>{if(e.target.files[0])decodeBarcodePhoto(e.target.files[0]);e.target.value=''});
  $('manualBarcode').addEventListener('input',e=>e.target.value=normalizeBarcode(e.target.value));$('manualBarcode').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();useManualCode()}});
  document.addEventListener('visibilitychange',()=>{if(document.hidden)stopScanner();else if($('scannerDialog').open&&!scanLastCode&&!$('amazonDialog').open)startScanner()});
}

(async function init(){
  try{db=await openDB();setupEvents();await loadData();await prepareLocalData();if('serviceWorker'in navigator)navigator.serviceWorker.register('sw.js').catch(()=>{});}catch(e){console.error(e);alert('Impossible d’ouvrir la base de données locale sur cet appareil.')}
})();
