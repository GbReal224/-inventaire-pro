const DB_NAME='InventaireProDB', DB_VERSION=3;
const PRODUCTS='products', MOVEMENTS='movements', ORDERS='orders', ACTIVITIES='activities', META='meta', SAFETY='safety';
const Core=InventoryCore;
let db,products=[],movements=[],orders=[],activities=[],settings={},dbRevision=0,toastTimer,tempPhotoData='';
let scannerTarget='standalone',scanLastCode='',scannerSession=0,scannerTimer,scannerStream=null,scannerCameraId='',scannerLibraryPromise=null;
let mutationBusy=false,historyLimit=50,orderHistoryLimit=25,installPrompt=null;
let productFormRevision=0,movementFormRevision=0;
const $=id=>document.getElementById(id);
const fmtQty=n=>Number(n||0).toLocaleString('fr-CA',{maximumFractionDigits:3});
const fmtMoney=n=>Number(n||0).toLocaleString('fr-CA',{style:'currency',currency:'CAD'});
const nowIso=()=>new Date().toISOString();
const uid=()=>crypto.randomUUID?crypto.randomUUID():`${Date.now()}-${Math.random().toString(16).slice(2)}`;
const activeProducts=()=>products.filter(p=>!p.archived);
const escapeHtml=(v='')=>String(v).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
const normalizeBarcode=(v='')=>String(v).replace(/\D/g,'').slice(0,18);
const amazonSearchUrl=term=>`https://www.amazon.ca/s?k=${encodeURIComponent(String(term||'').trim())}`;
const productAmazonUrl=p=>p?.productUrl?.trim()||amazonSearchUrl(p?.barcode||p?.name||'');
function openExternal(url){try{window.open(Core.httpUrl(url),'_blank','noopener,noreferrer')}catch(e){showToast(e.message)}}
const totalAvailable=p=>Number(p.reserveStock||0)+Number(p.inHandStock||0);
const targetOf=p=>Math.max(Number(p.minReserve||0),Number(p.targetReserve||0));
const toOrder=p=>Core.recommended(p,orders);
const isPurchaseMovement=m=>m?.type==='receive'&&m.isPurchase===true&&!m.reversedBy;
const isSameLocalMonth=(value,ref=new Date())=>{const d=new Date(value);return d.getFullYear()===ref.getFullYear()&&d.getMonth()===ref.getMonth()};
function purchaseTotals(days=null){const list=(days==null?movements:movesWithin(days)).filter(isPurchaseMovement);return {total:list.reduce((s,m)=>s+Number(m.purchaseTotalCost||0),0),count:list.length,list}}
function purchaseMonthTotals(){const list=movements.filter(m=>isPurchaseMovement(m)&&isSameLocalMonth(m.date));return {total:list.reduce((s,m)=>s+Number(m.purchaseTotalCost||0),0),count:list.length,list}}
function statusOf(p){
  if(p.archived)return {key:'archived',label:'ARCHIVÉ'};
  if(totalAvailable(p)<=0)return {key:'out',label:'RUPTURE'};
  if(toOrder(p)>0)return {key:'order',label:'COMMANDER'};
  if(Core.outstanding(p,orders)>0&&p.reserveStock<p.minReserve)return {key:'pending',label:'EN COMMANDE'};
  if(p.minReserve>0&&p.reserveStock<=p.minReserve*1.25)return {key:'watch',label:'À SURVEILLER'};
  return {key:'ok',label:'OK'};
}
function openDB(){return new Promise((resolve,reject)=>{
  const req=indexedDB.open(DB_NAME,DB_VERSION);
  req.onupgradeneeded=()=>{for(const name of [PRODUCTS,MOVEMENTS,ORDERS,ACTIVITIES,META,SAFETY])if(!req.result.objectStoreNames.contains(name)){const s=req.result.createObjectStore(name,{keyPath:'id'});if(name===MOVEMENTS)s.createIndex('date','date')}};
  req.onsuccess=()=>{req.result.onversionchange=()=>{req.result.close();showToast('Une mise à jour est prête. Ferme puis rouvre l’application.')};resolve(req.result)};
  req.onerror=()=>reject(req.error);req.onblocked=()=>showToast('Ferme les autres onglets Inventaire Pro pour terminer la mise à jour.');
})}
function tx(store,mode='readonly'){return db.transaction(store,mode).objectStore(store)}
function getAll(store){return new Promise((resolve,reject)=>{const r=tx(store).getAll();r.onsuccess=()=>resolve(r.result||[]);r.onerror=()=>reject(r.error)})}
function getOne(store,id){return new Promise((resolve,reject)=>{const r=tx(store).get(id);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)})}
// Every write includes a revision check and commits metadata, stock and audit trail together.
function commitData(changes={}, {replace=false,safety=false,config={}}={}){
  return new Promise((resolve,reject)=>{
    const transaction=db.transaction([PRODUCTS,MOVEMENTS,ORDERS,ACTIVITIES,META,SAFETY],'readwrite');let failure;
    transaction.oncomplete=()=>resolve();transaction.onerror=()=>{};
    transaction.onabort=()=>reject(failure||transaction.error||new Error('Enregistrement annulé. Les données ont été conservées.'));
    const request=transaction.objectStore(META).get('config');
    request.onsuccess=()=>{
      const current=request.result||{};
      if((current.revision||0)!==dbRevision){failure=new Error('Les données ont changé dans une autre fenêtre. Elles sont rechargées ; recommence ton action.');transaction.abort();return}
      try{
        if(safety)transaction.objectStore(SAFETY).put({id:'previous',savedAt:nowIso(),data:backupData()});
        for(const name of [PRODUCTS,MOVEMENTS,ORDERS,ACTIVITIES]){
          const store=transaction.objectStore(name);if(replace)store.clear();
          for(const item of changes[name]||[])store.put(item);
        }
        const hasData=replace||[PRODUCTS,MOVEMENTS,ORDERS,ACTIVITIES].some(k=>changes[k]?.length);
        transaction.objectStore(META).put({...current,id:'config',datasetId:current.datasetId||uid(),...config,revision:dbRevision+1,...(hasData?{lastMutationAt:nowIso()}:{}),syncEnabled:false});
      }catch(e){failure=e;transaction.abort()}
    };
  });
}
// Kept for scripts and diagnostics; user-facing stock writes always use commitData with movements.
async function put(store,item){await commitData({[store]:[item]});await loadData();return item}
async function loadData(){
  // A single readonly transaction gives all views the same consistent snapshot.
  const values=await new Promise((resolve,reject)=>{
    const t=db.transaction([PRODUCTS,MOVEMENTS,ORDERS,ACTIVITIES,META],'readonly'),out={};
    for(const name of [PRODUCTS,MOVEMENTS,ORDERS,ACTIVITIES,META]){const r=t.objectStore(name).getAll();r.onsuccess=()=>out[name]=r.result}
    t.oncomplete=()=>resolve(out);t.onabort=()=>reject(t.error);
  });
  products=values.products.map(p=>Core.product({...p,packSize:p.packSize||1,packLabel:p.packLabel||'lot',archived:!!p.archived})).sort((a,b)=>String(a.name).localeCompare(String(b.name),'fr'));
  activities=values.activities.sort((a,b)=>new Date(b.date)-new Date(a.date));
  movements=values.movements.sort((a,b)=>new Date(b.date)-new Date(a.date)||(b.sequence||0)-(a.sequence||0));orders=values.orders.sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));settings=values.meta.find(x=>x.id==='config')||{};dbRevision=settings.revision||0;
  renderAll();
}
async function mutate(action){
  if(mutationBusy)return;mutationBusy=true;
  document.querySelectorAll('button[type=submit]').forEach(b=>b.disabled=true);
  try{await action();await loadData();dataChannel?.postMessage('changed')}
  catch(e){console.error(e);await loadData();showToast(e.name==='QuotaExceededError'?'Espace insuffisant. Exporte une sauvegarde et libère de l’espace.':e.message||'Enregistrement impossible. Aucune modification appliquée.')}
  finally{mutationBusy=false;document.querySelectorAll('button[type=submit]').forEach(b=>b.disabled=false)}
}
const dataChannel=typeof BroadcastChannel==='function'?new BroadcastChannel('inventaire-pro-data'):null;
if(dataChannel)dataChannel.onmessage=()=>{if(!mutationBusy)loadData().catch(console.error)};
function renderAll(){renderCategories();renderDashboard();renderInventory();renderOrders();renderHistory();renderStats();renderDataStatus();renderOperations()}
function prioritySort(a,b){const r={out:0,order:1,pending:2,watch:3,ok:4,archived:5};return r[statusOf(a).key]-r[statusOf(b).key]||a.name.localeCompare(b.name,'fr')}
function productIdentityHtml(p){return `<div class="product-ident">${p.photoData?`<img class="product-thumb" src="${escapeHtml(p.photoData)}" alt="" loading="lazy">`:''}<div><div class="product-name">${escapeHtml(p.name)}</div>${p.barcode?`<div class="product-meta">UPC/EAN ${escapeHtml(p.barcode)}</div>`:''}</div></div>`}
function supplierLabel(p){try{return p.productUrl?(isAmazonDestination(p.productUrl)?'Amazon Business':p.supplier||new URL(p.productUrl).hostname):(!p.supplier||/amazon/i.test(p.supplier)?'Amazon Business':'')}catch{return ''}}
function supplierButton(p){const label=supplierLabel(p);return label?`<button class="action-btn amazon-action" data-amazon="${p.id}">Ouvrir ${escapeHtml(label)}</button>`:`<button class="action-btn" data-edit="${p.id}">Ajouter le lien fournisseur</button>`}
function quickActions(p){return `<div class="product-actions"><button class="action-btn primary-action" data-quick="consume" data-product="${p.id}">Consommer</button><button class="action-btn" data-quick="open" data-product="${p.id}">Sortir de réserve</button><button class="action-btn" data-quick="receive" data-product="${p.id}">Recevoir</button></div>`}
function productCard(p){
  const s=statusOf(p),q=toOrder(p),incoming=Core.outstanding(p,orders);
  return `<article class="product-card"><div class="product-top">${productIdentityHtml(p)}<span class="status ${s.key}">${s.label}</span></div><div class="product-meta">${escapeHtml(p.category||'Sans catégorie')} · ${escapeHtml(p.supplier||'Fournisseur non défini')} · ${escapeHtml(p.location||'Emplacement non défini')}</div><div class="stock-grid">${[['Réserve',p.reserveStock],['En main',p.inHandStock],['Minimum',p.minReserve],['Total',totalAvailable(p)]].map(([l,v])=>`<div class="stock-cell"><span>${l}</span><strong>${fmtQty(v)}</strong></div>`).join('')}</div><p class="product-meta">Stock en ${escapeHtml(p.unit)} · ${fmtMoney(p.unitCost)} / ${escapeHtml(p.unit)}${p.packSize!==1?` · ${escapeHtml(p.packLabel)} de ${fmtQty(p.packSize)} ${escapeHtml(p.unit)}`:''}</p>${q>0?`<div class="order-line"><span>À commander</span><strong>${fmtQty(q)} ${escapeHtml(p.unit)}</strong></div>`:''}${incoming?`<p class="helper">${fmtQty(incoming)} ${escapeHtml(p.unit)} attendus</p>`:''}${!p.archived?quickActions(p):''}<div class="product-actions"><button class="action-btn" data-edit="${p.id}">Détails / modifier</button>${p.archived?`<button class="action-btn" data-restore="${p.id}">Restaurer</button>`:`<button class="action-btn" data-move="${p.id}">Autre mouvement</button><button class="action-btn" data-stock="${p.id}">Emplacements / lots</button>${supplierButton(p)}`}</div></article>`;
}
function renderDashboard(){
  const list=activeProducts();$('kpiProducts').textContent=list.length;$('kpiOrder').textContent=list.filter(p=>toOrder(p)>0).length;$('kpiOut').textContent=list.filter(p=>statusOf(p).key==='out').length;$('kpiValue').textContent=fmtMoney(list.reduce((s,p)=>s+p.reserveStock*p.unitCost,0));$('kpiPurchaseMonth').textContent=fmtMoney(purchaseMonthTotals().total);$('kpiPurchaseTotal').textContent=fmtMoney(purchaseTotals().total);
  const priorities=list.filter(p=>statusOf(p).key!=='ok').sort(prioritySort).slice(0,5);$('priorityList').innerHTML=priorities.length?priorities.map(productCard).join(''):'<div class="empty">Aucune priorité pour le moment.</div>';bindCardActions($('priorityList'));
}
function renderInventory(){
  const query=$('searchInput').value.trim().toLocaleLowerCase('fr'),cat=$('categoryFilter').value,state=$('stockFilter').value,supplier=$('supplierFilter').value,location=$('locationFilter').value;
  let list=products.filter(p=>(state==='archived'?p.archived:!p.archived)&&(!query||[p.name,p.category,p.supplier,p.location,p.barcode,...p.positions.map(s=>s.location)].join(' ').toLocaleLowerCase('fr').includes(query))&&(!cat||cat===p.category)&&(!supplier||supplier===p.supplier)&&(!location||p.positions.some(s=>s.location===location&&s.qty>0)||location===p.location)&&(!state||state==='archived'||(state==='order'?toOrder(p)>0:statusOf(p).key===state)));
  const sort=$('inventorySort').value;list.sort(sort==='quantity'?(a,b)=>totalAvailable(a)-totalAvailable(b):sort==='value'?(a,b)=>totalAvailable(b)*b.unitCost-totalAvailable(a)*a.unitCost:sort==='urgency'?prioritySort:(a,b)=>a.name.localeCompare(b.name,'fr'));
  $('inventoryCount').textContent=`${list.length} produit(s)`;$('inventoryList').innerHTML=list.length?list.map(productCard).join(''):'<div class="empty">Aucun produit pour ces filtres.</div>';bindCardActions($('inventoryList'));
}
function fillOptions(id,items,empty){const select=$(id),current=select.value;select.innerHTML=`<option value="">${empty}</option>`+items.map(([v,l])=>`<option value="${escapeHtml(v)}">${escapeHtml(l)}</option>`).join('');select.value=current}
function renderCategories(){
  for(const [id,key,label] of [['categoryFilter','category','Toutes catégories'],['supplierFilter','supplier','Tous fournisseurs'],['locationFilter','location','Tous emplacements']])fillOptions(id,[...new Set(products.flatMap(p=>key==='location'?[p.location,...p.positions.map(s=>s.location)]:[p[key]]).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'fr')).map(x=>[x,x]),label);
  for(const id of ['historyProduct','statsProduct'])fillOptions(id,products.map(p=>[p.id,p.name+(p.archived?' (archivé)':'')]),'Tous les produits');
}
function bindCardActions(root){
  bindStockButtons(root);
  root.querySelectorAll('[data-edit]').forEach(b=>b.onclick=()=>openProduct(products.find(p=>p.id===b.dataset.edit)));
  root.querySelectorAll('[data-move]').forEach(b=>b.onclick=()=>openMovement(products.find(p=>p.id===b.dataset.move)));
  root.querySelectorAll('[data-amazon]').forEach(b=>b.onclick=()=>openAmazonBusiness(products.find(p=>p.id===b.dataset.amazon)));
  root.querySelectorAll('[data-quick]').forEach(b=>b.onclick=()=>{if($('scannerDialog').open)closeScanner();openMovement(products.find(p=>p.id===b.dataset.product),b.dataset.quick)});
  root.querySelectorAll('[data-restore]').forEach(b=>b.onclick=()=>archiveProduct(b.dataset.restore,false));
  root.querySelectorAll('[data-order]').forEach(b=>b.onclick=()=>openOrder(products.find(p=>p.id===b.dataset.order)));
  root.querySelectorAll('[data-receive-order]').forEach(b=>b.onclick=()=>{const o=orders.find(o=>o.id===b.dataset.receiveOrder);openMovement(products.find(p=>p.id===o.productId),'receive',o.id)});
  root.querySelectorAll('[data-cancel-order]').forEach(b=>b.onclick=()=>cancelOrder(b.dataset.cancelOrder));
}
function updatePhotoPreview(){const img=$('productPhotoPreview');if(tempPhotoData)img.src=tempPhotoData;else img.removeAttribute('src');img.classList.toggle('hidden',!tempPhotoData);$('photoPlaceholder').classList.toggle('hidden',!!tempPhotoData);$('removePhotoBtn').classList.toggle('hidden',!tempPhotoData)}
function openProduct(p=null){
  productFormRevision=p?.revision||0;
  $('productForm').reset();$('productId').value=p?.id||'';$('productDialogTitle').textContent=p?(p.archived?'Produit archivé':'Modifier le produit'):'Ajouter un produit';
  const fields={productName:'name',productCategory:'category',productUnit:'unit',barcode:'barcode',reserveStock:'reserveStock',inHandStock:'inHandStock',minReserve:'minReserve',targetReserve:'targetReserve',unitCost:'unitCost',supplier:'supplier',location:'location',productUrl:'productUrl',notes:'notes',packSize:'packSize',packLabel:'packLabel'};
  for(const [field,key] of Object.entries(fields))if(p?.[key]!=null)$(field).value=p[key];
  $('productUnit').disabled=!!p&&movements.some(m=>m.productId===p.id);$('unitHelp').textContent=$('productUnit').disabled?'L’unité de stock est conservée pour garder l’historique cohérent. Les réceptions peuvent utiliser un conditionnement différent.':'Choisis l’unité consommée : bouteille, mL, etc. Un bidon peut contenir 4 000 mL.';
  tempPhotoData=p?.photoData||'';updatePhotoPreview();$('deleteProductBtn').classList.toggle('hidden',!p);$('deleteProductBtn').textContent=p?.archived?'Restaurer':'Archiver';updateFormulaPreview();$('productDialog').showModal();
  $('leadDays').value=p?.leadDays||0;$('safetyDays').value=p?.safetyDays??2;updateDuplicateHint();
}
function updateFormulaPreview(){const p={reserveStock:Number($('reserveStock').value),inHandStock:Number($('inHandStock').value),minReserve:Number($('minReserve').value),targetReserve:Number($('targetReserve').value),packSize:Number($('packSize').value)||1};$('formulaPreview').textContent=`${fmtQty(totalAvailable(p))} disponibles. Minimum de réserve : ${fmtQty(p.minReserve)}. Besoin avant commandes en cours : ${fmtQty(Core.recommended(p))}. Un minimum de 0 désactive le réapprovisionnement automatique.`}
function newMovement(p,label,qty,note,sign,meta={}){return {id:uid(),productId:p.id,productName:p.name,label,qty,note:note||'',sign:sign||'',unit:p.unit,unitCostAtTime:p.unitCost,date:nowIso(),sequence:dbRevision+1,...meta}}
async function saveProduct(e){e.preventDefault();if(!$('productForm').reportValidity())return;await mutate(async()=>{
  const old=products.find(p=>p.id===$('productId').value),id=old?.id||uid();let p={...old,id,createdAt:old?.createdAt||nowIso(),updatedAt:nowIso(),revision:(old?.revision||0)+1,photoData:tempPhotoData};
  if(old&&(old.revision||0)!==productFormRevision)throw new Error('Ce produit a changé dans une autre fenêtre. Ferme puis rouvre sa fiche avant de l’enregistrer.');
  for(const [field,key] of Object.entries({productName:'name',productCategory:'category',productUnit:'unit',barcode:'barcode',supplier:'supplier',location:'location',productUrl:'productUrl',notes:'notes',packLabel:'packLabel'}))p[key]=$(field).value.trim();
  for(const field of ['reserveStock','inHandStock','minReserve','targetReserve','unitCost','packSize','leadDays','safetyDays'])p[field]=Number($(field).value);
  p.targetReserve=Math.max(p.minReserve,p.targetReserve);p=Core.reconcile(old,p);
  if(p.barcode&&products.some(x=>x.id!==id&&Core.barcodeKey(x.barcode)===Core.barcodeKey(p.barcode)&&!x.archived))throw new Error('Ce code-barres appartient déjà à un produit actif. Ouvre sa fiche depuis l’avertissement.');
  if(old&&p.unit!==old.unit&&movements.some(m=>m.productId===id))throw new Error('L’unité de stock ne peut plus changer après un mouvement.');
  const before=old?Core.stock(old):null,delta=totalAvailable(p)*p.unitCost-(old?totalAvailable(old)*old.unitCost:0),changed=!old||JSON.stringify(before)!==JSON.stringify(Core.stock(p));
  if(old?.archived&&changed)throw new Error('Restaure le produit avant de modifier le stock.');
  const logs=changed?[newMovement(p,old?'Correction de stock / coût dans la fiche':'Création du produit',old?Math.abs(totalAvailable(p)-totalAvailable(old)):totalAvailable(p),'',delta>=0?'+':'−',{type:old?'edit':'initial',before,after:Core.stock(p),inventoryValueDelta:delta,stockAfterTotal:totalAvailable(p)})]:[];
  await commitData({products:[p],movements:logs});$('productDialog').close();showToast('Produit enregistré');
})}
async function archiveProduct(id,archived){const p=products.find(x=>x.id===id);if(!p)return;if(!archived&&p.barcode&&products.some(x=>x.id!==p.id&&!x.archived&&Core.barcodeKey(x.barcode)===Core.barcodeKey(p.barcode)))return showToast('Un produit actif possède déjà ce code-barres. Corrige sa fiche avant de restaurer celle-ci.');if(archived&&Core.outstanding(p,orders)>0)return showToast('Termine ou annule les commandes de ce produit avant de l’archiver.');if(archived&&!confirm(`Archiver « ${p.name} » ? Son stock et son historique seront conservés.`))return;await mutate(async()=>{await commitData({products:[{...p,archived,updatedAt:nowIso(),revision:(p.revision||0)+1}],movements:[newMovement(p,archived?'Produit archivé':'Produit restauré',0,'','',{type:archived?'archive':'restore',inventoryValueDelta:0})]});$('productDialog').close();showToast(archived?'Produit archivé, disponible dans le filtre Archives.':'Produit restauré')})}
function deleteCurrentProduct(){const p=products.find(p=>p.id===$('productId').value);if(p)return archiveProduct(p.id,!p.archived)}
const movementLabels={receive:'Réception / Achat en réserve',open:'Réserve → en main',consume:'Consommation depuis en main',return:'En main → réserve',reservePlus:'Ajustement réserve +',reserveMinus:'Ajustement réserve −',handPlus:'Ajustement en main +',handMinus:'Ajustement en main −'};
function quantityOptions(p,select){select.innerHTML=`<option value="unit">${escapeHtml(p.unit)}</option>`+(p.packSize!==1?`<option value="pack">${escapeHtml(p.packLabel)} (${fmtQty(p.packSize)} ${escapeHtml(p.unit)})</option>`:'')+(p.unit==='mL'?'<option value="litre">litre (1 000 mL)</option>':p.unit==='litre'?'<option value="mL">mL (0,001 litre)</option>':'')}
function openMovement(p,type='receive',orderId=''){
  movementFormRevision=p?.revision||0;
  if(!p||p.archived)return showToast('Restaure d’abord ce produit.');$('movementForm').reset();$('movementProductId').value=p.id;$('movementProductName').textContent=p.name;$('movementType').value=type;quantityOptions(p,$('movementUnit'));$('movementQty').value=1;$('movementUnitCost').value=p.unitCost;
  $('movementOrder').innerHTML='<option value="">Réception sans commande</option>'+orders.filter(o=>o.productId===p.id&&['ordered','partial'].includes(o.status)).map(o=>`<option value="${o.id}">${escapeHtml(o.reference||o.createdAt.slice(0,10))} · ${fmtQty(o.quantity-o.received)} ${escapeHtml(p.unit)} attendus</option>`).join('');$('movementOrder').value=orderId;
  if(orderId){const o=orders.find(o=>o.id===orderId);$('movementQty').value=Core.round(o.quantity-o.received);$('movementUnitCost').value=o.unitCost}
  updateMovementPurchaseFields();$('movementDialog').showModal();
  openMovementDetails(p,type);
}
function updateMovementPurchaseFields(){
  const p=products.find(p=>p.id===$('movementProductId').value);if(!p)return;
  const receive=$('movementType').value==='receive',factor=Core.quantityFactor(p,$('movementUnit').value),q=Number($('movementQty').value)||0,c=Number($('movementUnitCost').value)||0;
  $('movementPurchaseFields').classList.toggle('hidden',!receive);$('movementStockPreview').textContent=`Réserve : ${fmtQty(p.reserveStock)} · En main : ${fmtQty(p.inHandStock)} ${p.unit}. Quantité appliquée : ${fmtQty(q*factor)} ${p.unit}.`;
  $('movementCostLabel').textContent=`Coût payé par ${$('movementUnit').selectedOptions[0].textContent} (CAD)`;$('movementPurchasePreview').textContent=`Coût de cet achat : ${fmtMoney(q*c)}`;
  updateMovementDetails();
}
async function applyMovement(e){e.preventDefault();if(!$('movementForm').reportValidity())return;await mutate(async()=>{
  const p=products.find(p=>p.id===$('movementProductId').value);if(!p)throw new Error('Produit introuvable.');
  if((p.revision||0)!==movementFormRevision)throw new Error('Le stock a changé dans une autre fenêtre. Ferme puis rouvre ce mouvement.');
  const type=$('movementType').value,result=Core.apply(p,{type,quantity:Number($('movementQty').value),mode:$('movementUnit').value,cost:Number($('movementUnitCost').value),...movementDetails(p,type)}),o=type==='receive'?orders.find(o=>o.id===$('movementOrder').value):null;
  let updates=[];
  if(o){if(!['ordered','partial'].includes(o.status)||o.productId!==p.id||result.movement.qty>Core.round(o.quantity-o.received))throw new Error('La réception dépasse le reste de cette commande.');const next={...o,received:Core.round(o.received+result.movement.qty),updatedAt:nowIso()};next.status=Core.orderStatus(next);updates=[next];result.movement.orderId=o.id}
  result.product.updatedAt=nowIso();result.product.revision=(p.revision||0)+1;
  const log=newMovement(p,movementLabels[type],result.movement.qty,$('movementNote').value.trim(),result.movement.sign,result.movement);
  if(type==='receive'){log.reference=$('receiptReference').value.trim();log.attachments=await receiptFiles($('receiptFiles').files);Core.movement(log)}
  await commitData({products:[result.product],movements:[log],orders:updates});$('movementDialog').close();showToast(type==='receive'?`Réception enregistrée : ${fmtMoney(log.purchaseTotalCost)}`:'Stock mis à jour');
})}
function latestStockMovement(productId){return movements.filter(m=>m.productId===productId&&m.after&&!m.reversedBy&&m.type!=='undo')[0]}
function canUndoSingle(m){const p=products.find(p=>p.id===m.productId);return !!(p&&!p.archived&&m.before&&m.after&&!m.reversedBy&&m.type!=='undo'&&latestStockMovement(p.id)?.id===m.id&&['reserveStock','inHandStock','unitCost'].every(k=>Math.abs(p[k]-m.after[k])<1e-7))}
function canUndo(m){return canUndoSingle(m)&&(!m.groupId||movements.filter(x=>x.groupId===m.groupId&&x.type!=='undo').every(canUndoSingle))}
async function undoMovement(id){const m=movements.find(m=>m.id===id);if(m?.groupId)return undoOperation(m.groupId);if(!m||!canUndo(m))return showToast('Annule d’abord le dernier mouvement de stock de ce produit. Pour un ancien mouvement, utilise un ajustement avec une note.');if(!confirm(`Annuler « ${m.label} » pour ${m.productName} ? Une correction sera ajoutée à l’historique.`))return;await mutate(async()=>{
  const p=products.find(p=>p.id===m.productId),restored=restoreStock(p,m.before);
  const correction=newMovement(p,`Annulation : ${m.label}`,m.qty,'Correction du mouvement '+m.id,'↶',{type:'undo',reverses:m.id,before:Core.stock(p),after:Core.stock(restored),inventoryValueDelta:-Number(m.inventoryValueDelta||0)});
  let updatedOrders=[];if(m.orderId){const o=orders.find(o=>o.id===m.orderId);if(!o||o.received<m.qty)throw new Error('Impossible de corriger cette commande.');const next={...o,received:Core.round(o.received-m.qty),updatedAt:nowIso()};if(o.status!=='cancelled')next.status=Core.orderStatus(next);updatedOrders=[next]}
  await commitData({products:[restored],movements:[{...m,reversedBy:correction.id},correction],orders:updatedOrders});showToast('Mouvement annulé ; la correction reste dans l’historique.');
})}
function historyCard(m){const p=products.find(p=>p.id===m.productId);return `<article data-movement="${m.id}" class="history-item${m.reversedBy?' reversed':''}"><div><div class="name">${escapeHtml(m.productName||p?.name||'Ancien produit')}</div><div class="detail">${escapeHtml(m.label)}${m.reversedBy?' · ANNULÉ':''}${m.note?' · '+escapeHtml(m.note):''}${isPurchaseMovement(m)?' · '+fmtMoney(m.purchaseTotalCost):''}</div></div><div class="qty">${escapeHtml(m.sign||'')}${fmtQty(m.qty)} ${escapeHtml(m.unit||p?.unit||'')}</div><div class="time">${new Date(m.date).toLocaleString('fr-CA')}</div>${canUndo(m)?`<button class="text-btn" data-undo="${m.id}">Annuler ce mouvement</button>`:''}</article>`}
function renderHistory(){
  const all=purchaseTotals();$('historyPurchaseMonth').textContent=fmtMoney(purchaseMonthTotals().total);$('historyPurchaseTotal').textContent=fmtMoney(all.total);$('historyPurchaseCount').textContent=all.count;
  const query=$('historySearch').value.trim().toLowerCase(),product=$('historyProduct').value,type=$('historyType').value,from=$('historyFrom').value,to=$('historyTo').value;
  const list=movements.filter(m=>(!product||m.productId===product)&&(!type||(type==='correction'?['edit','undo','reservePlus','reserveMinus','handPlus','handMinus'].includes(m.type):m.type===type))&&(!query||[m.productName,m.note,m.label].join(' ').toLowerCase().includes(query))&&(!from||new Date(m.date)>=new Date(from+'T00:00:00'))&&(!to||new Date(m.date)<=new Date(to+'T23:59:59.999')));
  $('historyCount').textContent=`${list.length} mouvement(s) · ${Math.min(historyLimit,list.length)} affiché(s)`;
  $('historyList').innerHTML=list.length?list.slice(0,historyLimit).map(historyCard).join(''):'<div class="empty">Aucun mouvement pour ces filtres.</div>';
  const purchases=list.filter(isPurchaseMovement);$('purchaseHistoryList').innerHTML=purchases.length?purchases.slice(0,historyLimit).map(historyCard).join(''):'<div class="empty">Aucun achat pour ces filtres.</div>';
  $('historyMore').hidden=historyLimit>=list.length;document.querySelectorAll('[data-undo]').forEach(b=>b.onclick=()=>undoMovement(b.dataset.undo));decorateHistory();
}
const orderLabels={ordered:'Commandé',partial:'Partiellement reçu',received:'Reçu',cancelled:'Annulé'};
function renderOrders(){
  const list=activeProducts().filter(p=>toOrder(p)>0).sort(prioritySort);$('orderItemsCount').textContent=list.length;$('orderUnitsCount').textContent=fmtQty(list.reduce((s,p)=>s+toOrder(p),0));$('orderBudget').textContent=fmtMoney(list.reduce((s,p)=>s+toOrder(p)*p.unitCost,0));
  $('ordersList').innerHTML=list.length?list.map(p=>`<article class="order-card">${productIdentityHtml(p)}<div class="order-line"><span>À commander</span><strong>${fmtQty(toOrder(p))} ${escapeHtml(p.unit)}</strong></div><p class="helper">${fmtMoney(toOrder(p)*p.unitCost)} estimés · ${fmtQty(Core.outstanding(p,orders))} déjà attendus</p><div class="product-actions"><button class="action-btn primary-action" data-order="${p.id}">Enregistrer la commande</button>${supplierButton(p)}</div></article>`).join(''):'<div class="empty">Aucun réapprovisionnement requis. Les commandes en cours sont prises en compte.</div>';
  const state=$('orderFilter').value,visible=orders.filter(o=>!state||(state==='open'?['ordered','partial'].includes(o.status):o.status===state));
  $('orderTrackingList').innerHTML=visible.length?visible.slice(0,orderHistoryLimit).map(o=>`<article class="order-card"><div class="product-top"><b>${escapeHtml(o.productName)}</b><span class="status ${o.status==='received'?'ok':'pending'}">${orderLabels[o.status]}</span></div><p class="helper">${escapeHtml(o.supplier||'Fournisseur non défini')}${o.reference?' · '+escapeHtml(o.reference):''}<br>${fmtQty(o.received)} / ${fmtQty(o.quantity)} ${escapeHtml(o.unit)} reçus · ${fmtMoney(o.quantity*o.unitCost)} estimés<br>Créée le ${new Date(o.createdAt).toLocaleDateString('fr-CA')}${o.expectedDate?' · Livraison prévue : '+escapeHtml(o.expectedDate):''}${o.note?'<br>'+escapeHtml(o.note):''}</p>${['ordered','partial'].includes(o.status)?`<div class="product-actions"><button class="action-btn primary-action" data-receive-order="${o.id}">Recevoir tout ou partie</button><button class="action-btn" data-cancel-order="${o.id}">Annuler le restant</button></div>`:''}</article>`).join(''):'<div class="empty">Aucune commande dans cette catégorie.</div>';
  $('ordersMore').hidden=visible.length<=orderHistoryLimit;bindCardActions($('ordersView'));
}
function openOrder(p=null){if(!activeProducts().length)return showToast('Ajoute un produit avant une commande.');$('orderForm').reset();$('orderProduct').innerHTML=activeProducts().map(p=>`<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');if(p)$('orderProduct').value=p.id;updateOrderFields();$('orderDialog').showModal()}
function updateOrderFields(){const p=products.find(p=>p.id===$('orderProduct').value);quantityOptions(p,$('orderUnit'));$('orderQty').value=toOrder(p)||p.packSize||1;$('orderCost').value=p.unitCost;updateOrderPreview()}
function updateOrderPreview(){const p=products.find(p=>p.id===$('orderProduct').value);if(p)$('orderPreview').textContent=`${fmtQty(Number($('orderQty').value)*Core.quantityFactor(p,$('orderUnit').value))} ${p.unit} commandés · ${fmtMoney(Number($('orderQty').value)*Number($('orderCost').value))}. Déjà attendus : ${fmtQty(Core.outstanding(p,orders))} ${p.unit}.`}
async function saveOrder(e){e.preventDefault();if(!$('orderForm').reportValidity())return;await mutate(async()=>{const p=products.find(p=>p.id===$('orderProduct').value),factor=Core.quantityFactor(p,$('orderUnit').value),o=Core.order({id:uid(),productId:p.id,productName:p.name,unit:p.unit,supplier:p.supplier,quantity:Core.round(Number($('orderQty').value)*factor),received:0,unitCost:Number($('orderCost').value)/factor,expectedDate:$('orderDate').value,reference:$('orderReference').value.trim(),note:$('orderNote').value.trim(),status:'ordered',createdAt:nowIso(),updatedAt:nowIso()});await commitData({orders:[o]});$('orderDialog').close();showToast('Commande enregistrée. Le stock changera à la réception.')})}
async function cancelOrder(id){const o=orders.find(o=>o.id===id);if(!o||!confirm('Annuler les quantités encore attendues de cette commande ?'))return;await mutate(async()=>{await commitData({orders:[{...o,status:'cancelled',updatedAt:nowIso()}]});showToast('Reste de la commande annulé. Les réceptions sont conservées.')})}

function backupData(){return {app:'Inventaire Pro',version:Core.VERSION,schemaVersion:Core.SCHEMA,exportedAt:nowIso(),datasetId:settings.datasetId||uid(),revision:dbRevision,sync:{enabled:false},products,movements,orders,activities}}
async function exportBackup(){await mutate(async()=>{const data=backupData();downloadBlob(`inventaire-backup-${data.exportedAt.slice(0,10)}.json`,JSON.stringify(data,null,2),'application/json');await commitData({}, {config:{lastExportAt:data.exportedAt,lastExportRevision:dbRevision,datasetId:data.datasetId}});showToast('Export lancé. Vérifie que le fichier est enregistré.')})}
async function importBackup(file){
  if(!file)return;
  if(file.size>100*1024*1024)return showToast('La sauvegarde dépasse 100 Mo.');
  let data;try{data=Core.validateBackup(JSON.parse(await file.text()))}catch(e){showToast('Import refusé : '+e.message);return}
  if(!confirm(`Importer ${data.products.length} produits, ${data.movements.length} mouvements et ${data.orders.length} commandes ? Les données actuelles seront remplacées. Une copie de récupération locale sera conservée.`))return;
  await mutate(async()=>{await commitData(data,{replace:true,safety:true,config:{datasetId:data.datasetId||uid(),lastImportAt:nowIso()}});showToast('Sauvegarde vérifiée et importée.')});
}
async function restoreSafety(){const snapshot=await getOne(SAFETY,'previous');if(!snapshot)return showToast('Aucune copie de récupération.');let data;try{data=Core.validateBackup(snapshot.data)}catch(e){return showToast('Copie illisible : '+e.message)}if(!confirm(`Revenir aux données conservées le ${new Date(snapshot.savedAt).toLocaleString('fr-CA')} ? Les données actuelles deviendront la copie de récupération.`))return;await mutate(async()=>{await commitData(data,{replace:true,safety:true,config:{datasetId:data.datasetId||settings.datasetId}});showToast('Données précédentes restaurées.')})}
async function clearEverything(){if(!confirm('Effacer tous les produits, photos, mouvements et commandes sur cet appareil ? Une copie de récupération locale sera conservée.'))return;await mutate(async()=>{await commitData({products:[],movements:[],orders:[]},{replace:true,safety:true,config:{datasetId:uid()}});showToast('Inventaire vidé. Une copie reste disponible dans Réglages.')})}
function renderDataStatus(){
  $('appVersion').textContent=`Inventaire Pro ${Core.VERSION}`;
  const saved=settings.lastMutationAt;$('lastSavedText').textContent=saved?`Sauvegardé localement · ${new Date(saved).toLocaleString('fr-CA')}`:'Sauvegardé sur cet appareil · aucune modification récente';
  $('backupStatus').textContent=settings.lastExportAt?`Dernier export demandé : ${new Date(settings.lastExportAt).toLocaleString('fr-CA')}. Vérifie sa présence dans tes fichiers.`:'Aucune sauvegarde exportée depuis cet appareil.';
  const due=products.length>0&&(!settings.lastExportAt||Date.now()-Date.parse(settings.lastExportAt)>7*86400000);
  $('backupReminder').classList.toggle('hidden',!due);
  $('syncStatus').textContent='Service à choisir · synchronisation désactivée. Les données restent sur cet appareil. Une sauvegarde complète permet de transférer l’inventaire en attendant.';
  $('offlineStatus').textContent=navigator.onLine?'Connexion disponible · données conservées localement':'Hors connexion · inventaire et scanner disponibles après le premier chargement';
  getOne(SAFETY,'previous').then(snapshot=>{$('restoreBackupBtn').disabled=!snapshot;$('recoveryStatus').textContent=snapshot?`Copie de récupération : ${new Date(snapshot.savedAt).toLocaleString('fr-CA')}`:'Une copie sera créée avant un import ou un effacement.'}).catch(console.error);
}
async function seedExamples(){if(products.length&&!confirm('Ajouter les exemples à ton inventaire actuel ?'))return;await mutate(async()=>{
  const samples=[{name:'Nettoyant intérieur / APC',category:'Intérieur',unit:'bouteille',reserveStock:4,inHandStock:1,minReserve:6,targetReserve:12,packSize:6,packLabel:'boîte',unitCost:22.99,supplier:'Amazon Business'},{name:'Shampoing automobile',category:'Lavage extérieur',unit:'mL',reserveStock:4000,inHandStock:500,minReserve:4000,targetReserve:8000,packSize:4000,packLabel:'bidon',unitCost:.00625,supplier:'Distributeur detailing'}];
  const rows=samples.map(s=>Core.product({...s,id:uid(),createdAt:nowIso(),updatedAt:nowIso(),location:'Étagère produits'}));
  await commitData({products:rows,movements:rows.map(p=>newMovement(p,'Création exemple',totalAvailable(p),'','+',{type:'initial',after:Core.stock(p),inventoryValueDelta:totalAvailable(p)*p.unitCost}))});showToast('Exemples ajoutés');
})}
function exportCsv(){const header=['Produit','Archivé','Code-barres','Catégorie','Unité','Réserve','En main','Minimum','Cible','À commander','En commande','Coût unitaire','Conditionnement','Contenu','Fournisseur','Emplacement','Lien','Notes'];const rows=products.map(p=>[p.name,p.archived?'Oui':'Non',p.barcode,p.category,p.unit,p.reserveStock,p.inHandStock,p.minReserve,targetOf(p),toOrder(p),Core.outstanding(p,orders),p.unitCost,p.packLabel,p.packSize,p.supplier,p.location,p.productUrl,p.notes]);const csv=[header,...rows].map(row=>row.map(value=>{let s=String(value??'');if(/^[=+@\-\t\r]/.test(s))s="'"+s;return '"'+s.replace(/"/g,'""')+'"'}).join(',')).join('\n');downloadBlob(`inventaire-${nowIso().slice(0,10)}.csv`,'\ufeff'+csv,'text/csv;charset=utf-8');showToast('CSV exporté')}
function updateScanActions(){const p=products.find(p=>Core.barcodeKey(p.barcode)===Core.barcodeKey(scanLastCode)&&!p.archived);$('scanQuickActions').innerHTML=p?`<p class="product-name">${escapeHtml(p.name)}</p>${quickActions(p)}`:'';bindCardActions($('scanQuickActions'))}
function setupInventoryEvents(){
  for(const id of ['stockFilter','supplierFilter','locationFilter','inventorySort'])$(id).onchange=renderInventory;
  for(const id of ['historySearch','historyProduct','historyType','historyFrom','historyTo'])$(id).addEventListener(id==='historySearch'?'input':'change',()=>{historyLimit=50;renderHistory()});
  $('historyMore').onclick=()=>{historyLimit+=100;renderHistory()};$('ordersMore').onclick=()=>{orderHistoryLimit+=50;renderOrders()};$('orderFilter').onchange=()=>{orderHistoryLimit=25;renderOrders()};
  $('newOrderBtn').onclick=()=>openOrder();$('orderForm').onsubmit=saveOrder;$('orderProduct').onchange=updateOrderFields;
  for(const id of ['orderQty','orderCost'])$(id).oninput=updateOrderPreview;
  $('orderUnit').onchange=()=>{const p=products.find(p=>p.id===$('orderProduct').value);$('orderCost').value=Core.round(p.unitCost*Core.quantityFactor(p,$('orderUnit').value));updateOrderPreview()};
  $('movementUnit').onchange=()=>{const p=products.find(p=>p.id===$('movementProductId').value);$('movementUnitCost').value=Core.round(p.unitCost*Core.quantityFactor(p,$('movementUnit').value));updateMovementPurchaseFields()};
  $('movementOrder').onchange=()=>{const o=orders.find(o=>o.id===$('movementOrder').value);if(o){$('movementUnit').value='unit';$('movementQty').value=Core.round(o.quantity-o.received);$('movementUnitCost').value=o.unitCost}updateMovementPurchaseFields()};
  $('packSize').oninput=updateFormulaPreview;$('restoreBackupBtn').onclick=restoreSafety;$('backupNowBtn').onclick=exportBackup;
  for(const id of ['statsProduct','statsFrom','statsTo'])$(id).onchange=renderStats;
  $('installBtn').onclick=async()=>{if(!installPrompt)return;const event=installPrompt;installPrompt=null;$('installBtn').hidden=true;try{await event.prompt();await event.userChoice}catch{showToast('Utilise le menu du navigateur pour installer l’application.')}};
  window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();installPrompt=e;$('installBtn').hidden=false});
  window.addEventListener('appinstalled',()=>{$('installBtn').hidden=true;showToast('Inventaire Pro installé.')});
  window.addEventListener('online',renderDataStatus);window.addEventListener('offline',renderDataStatus);
  // Refresh after another tab changed IndexedDB, without overwriting a form in progress.
  window.addEventListener('focus',async()=>{if(db&&!mutationBusy){try{const current=await getOne(META,'config');if(!mutationBusy&&(current?.revision||0)!==dbRevision)await loadData()}catch(e){console.error(e)}}});
  document.querySelectorAll('.close-btn').forEach(b=>{if(!b.hasAttribute('aria-label'))b.setAttribute('aria-label','Fermer la fenêtre')});
  document.querySelectorAll('dialog').forEach(dialog=>{const title=dialog.querySelector('h2');if(title?.id)dialog.setAttribute('aria-labelledby',title.id)});
}
async function prepareLocalData(){
  if(settings.schemaVersion===Core.SCHEMA)return;
  // Recover historical identities left by deletions in v3 without discarding any movement.
  const missing=[],ids=new Set(products.map(p=>p.id));
  for(const m of movements)if(!ids.has(m.productId)){missing.push(Core.product({id:m.productId,name:(m.productName||'Ancien produit').slice(0,100),unit:m.unit||'unité',archived:true}));ids.add(m.productId)}
  await commitData({products:missing},{config:{schemaVersion:Core.SCHEMA}});await loadData();
}
