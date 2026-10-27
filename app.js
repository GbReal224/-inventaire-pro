const DB_NAME = 'InventaireProDB';
const DB_VERSION = 1;
const PRODUCTS = 'products';
const MOVEMENTS = 'movements';
let db;
let products = [];
let movements = [];
let toastTimer;
let tempPhotoData = '';
let scannerTarget = 'standalone';
let scanLastCode = '';
let scannerSession = 0;
let scannerTimer;
let scannerStream = null;
let scannerCameraId = '';
let scannerLibraryPromise = null;

const $ = (id) => document.getElementById(id);
const fmtQty = (n) => Number(n || 0).toLocaleString('fr-CA', { maximumFractionDigits: 2 });
const fmtMoney = (n) => Number(n || 0).toLocaleString('fr-CA', { style: 'currency', currency: 'CAD' });
const nowIso = () => new Date().toISOString();
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

function openDB(){
  return new Promise((resolve,reject)=>{
    const req=indexedDB.open(DB_NAME,DB_VERSION);
    req.onupgradeneeded=()=>{
      const d=req.result;
      if(!d.objectStoreNames.contains(PRODUCTS)) d.createObjectStore(PRODUCTS,{keyPath:'id'});
      if(!d.objectStoreNames.contains(MOVEMENTS)){
        const s=d.createObjectStore(MOVEMENTS,{keyPath:'id'});s.createIndex('date','date');
      }
    };
    req.onsuccess=()=>resolve(req.result); req.onerror=()=>reject(req.error);
  });
}
function tx(store,mode='readonly'){return db.transaction(store,mode).objectStore(store)}
function getAll(store){return new Promise((res,rej)=>{const r=tx(store).getAll();r.onsuccess=()=>res(r.result||[]);r.onerror=()=>rej(r.error)})}
function put(store,obj){return new Promise((res,rej)=>{const r=tx(store,'readwrite').put(obj);r.onsuccess=()=>res(obj);r.onerror=()=>rej(r.error)})}
function del(store,id){return new Promise((res,rej)=>{const r=tx(store,'readwrite').delete(id);r.onsuccess=()=>res();r.onerror=()=>rej(r.error)})}
function clearStore(store){return new Promise((res,rej)=>{const r=tx(store,'readwrite').clear();r.onsuccess=()=>res();r.onerror=()=>rej(r.error)})}

function statusOf(p){
  const reserve=Number(p.reserveStock||0), hand=Number(p.inHandStock||0), min=Number(p.minReserve||0);
  if(reserve<=0 && hand<=0) return {key:'out',label:'RUPTURE'};
  if(reserve<min) return {key:'order',label:'COMMANDER'};
  if(min>0 && reserve<=min*1.25) return {key:'watch',label:'À SURVEILLER'};
  return {key:'ok',label:'OK'};
}
function targetOf(p){const min=Number(p.minReserve||0);const target=Number(p.targetReserve||0);return target>=min?target:min}
function toOrder(p){return Number(p.reserveStock||0)<Number(p.minReserve||0)?Math.max(0,targetOf(p)-Number(p.reserveStock||0)):0}
function totalAvailable(p){return Number(p.reserveStock||0)+Number(p.inHandStock||0)}
function escapeHtml(v=''){return String(v).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]))}
function normalizeBarcode(v=''){return String(v).replace(/\D/g,'').slice(0,18)}
function amazonSearchUrl(term){return `https://www.amazon.ca/s?k=${encodeURIComponent(String(term||'').trim())}`}
function productAmazonUrl(p){return p?.productUrl?.trim() || amazonSearchUrl(p?.barcode || p?.name || '')}
function openExternal(url){if(!url)return;window.open(url,'_blank','noopener,noreferrer')}
function isPurchaseMovement(m){return m?.type==='receive' && m?.isPurchase===true}
function isSameLocalMonth(dateValue,ref=new Date()){const d=new Date(dateValue);return !Number.isNaN(d.getTime())&&d.getFullYear()===ref.getFullYear()&&d.getMonth()===ref.getMonth()}
function purchaseTotals(days=null){
  const list=movements.filter(isPurchaseMovement);
  const filtered=days==null?list:list.filter(m=>new Date(m.date).getTime()>=Date.now()-Number(days)*86400000);
  return {total:filtered.reduce((s,m)=>s+Number(m.purchaseTotalCost||0),0),count:filtered.length,list:filtered};
}
function purchaseMonthTotals(){const list=movements.filter(m=>isPurchaseMovement(m)&&isSameLocalMonth(m.date));return {total:list.reduce((s,m)=>s+Number(m.purchaseTotalCost||0),0),count:list.length,list};}

async function loadData(){
  products=(await getAll(PRODUCTS)).sort((a,b)=>String(a.name||'').localeCompare(String(b.name||''),'fr'));
  movements=(await getAll(MOVEMENTS)).sort((a,b)=>new Date(b.date)-new Date(a.date));
  renderAll();
}
function renderAll(){renderDashboard();renderInventory();renderOrders();renderHistory();renderCategories();renderStats();$('lastSavedText').textContent=`Sauvegardé localement • ${new Date().toLocaleTimeString('fr-CA',{hour:'2-digit',minute:'2-digit'})}`}
function renderDashboard(){
  $('kpiProducts').textContent=products.length;
  $('kpiOrder').textContent=products.filter(p=>['order','out'].includes(statusOf(p).key)).length;
  $('kpiOut').textContent=products.filter(p=>statusOf(p).key==='out').length;
  $('kpiValue').textContent=fmtMoney(products.reduce((s,p)=>s+Number(p.reserveStock||0)*Number(p.unitCost||0),0));
  $('kpiPurchaseMonth').textContent=fmtMoney(purchaseMonthTotals().total);
  $('kpiPurchaseTotal').textContent=fmtMoney(purchaseTotals().total);
  const priorities=products.filter(p=>statusOf(p).key!=='ok').sort(prioritySort).slice(0,5);
  $('priorityList').innerHTML=priorities.length?priorities.map(priorityCard).join(''):'<div class="empty">Aucune priorité pour le moment.</div>';
  bindCardActions($('priorityList'));
}
function prioritySort(a,b){const r={out:0,order:1,watch:2,ok:3};return r[statusOf(a).key]-r[statusOf(b).key] || String(a.name||'').localeCompare(String(b.name||''),'fr')}
function productIdentityHtml(p){
  const thumb=p.photoData?`<img class="product-thumb" src="${p.photoData}" alt="">`:'';
  const barcode=p.barcode?`<div class="product-meta barcode-meta">UPC/EAN ${escapeHtml(p.barcode)}</div>`:'';
  return `<div class="product-ident">${thumb}<div><div class="product-name">${escapeHtml(p.name)}</div>${barcode}</div></div>`;
}
function priorityCard(p){
  const s=statusOf(p),q=toOrder(p);
  return `<article class="priority-card"><div class="product-top"><div>${productIdentityHtml(p)}<div class="product-meta">Réserve ${fmtQty(p.reserveStock)} • En main ${fmtQty(p.inHandStock)} • Minimum ${fmtQty(p.minReserve)}</div></div><span class="status ${s.key}">${s.label}</span></div>${q>0?`<div class="order-line"><span>Quantité recommandée</span><strong>+ ${fmtQty(q)} ${escapeHtml(p.unit)}</strong></div>`:''}<div class="product-actions"><button class="action-btn primary-action" data-move="${p.id}">Mouvement</button><button class="action-btn" data-edit="${p.id}">Détails</button>${p.productUrl||p.barcode?`<button class="action-btn amazon-action" data-amazon="${p.id}">Amazon</button>`:''}</div></article>`
}
function renderInventory(){
  const query=$('searchInput').value.trim().toLowerCase(); const cat=$('categoryFilter').value;
  const list=products.filter(p=>(!query||[p.name,p.category,p.supplier,p.location,p.barcode].join(' ').toLowerCase().includes(query))&&(!cat||p.category===cat));
  $('inventoryList').innerHTML=list.length?list.map(productCard).join(''):'<div class="empty">Aucun produit trouvé.</div>';
  bindCardActions($('inventoryList'));
}
function productCard(p){
  const s=statusOf(p),q=toOrder(p);
  return `<article class="product-card ${p.photoData?'has-photo':''}"><div class="product-top"><div>${productIdentityHtml(p)}<div class="product-meta">${escapeHtml(p.category||'Sans catégorie')} • ${escapeHtml(p.supplier||'Fournisseur non défini')}</div></div><span class="status ${s.key}">${s.label}</span></div><div class="stock-grid"><div class="stock-cell"><span>En inventaire</span><strong>${fmtQty(p.reserveStock)}</strong></div><div class="stock-cell"><span>En main</span><strong>${fmtQty(p.inHandStock)}</strong></div><div class="stock-cell"><span>Minimum réserve</span><strong>${fmtQty(p.minReserve)}</strong></div><div class="stock-cell"><span>Total disponible</span><strong>${fmtQty(totalAvailable(p))}</strong></div></div>${q>0?`<div class="order-line"><span>À commander pour atteindre ${fmtQty(targetOf(p))}</span><strong>+ ${fmtQty(q)}</strong></div>`:''}<div class="product-actions"><button class="action-btn primary-action" data-move="${p.id}">Mouvement</button><button class="action-btn" data-edit="${p.id}">Modifier</button><button class="action-btn amazon-action" data-amazon="${p.id}">Amazon Business</button></div></article>`
}
function renderOrders(){
  const list=products.filter(p=>toOrder(p)>0).sort(prioritySort);
  $('orderItemsCount').textContent=list.length;
  $('orderUnitsCount').textContent=fmtQty(list.reduce((s,p)=>s+toOrder(p),0));
  $('orderBudget').textContent=fmtMoney(list.reduce((s,p)=>s+toOrder(p)*Number(p.unitCost||0),0));
  $('ordersList').innerHTML=list.length?list.map(orderCard).join(''):'<div class="empty">Rien à commander. Tous les minimums sont respectés.</div>';
  bindCardActions($('ordersList'));
}
function orderCard(p){
  const s=statusOf(p),q=toOrder(p);
  return `<article class="order-card"><div class="product-top"><div>${productIdentityHtml(p)}<div class="product-meta">${escapeHtml(p.supplier||'Fournisseur non défini')} • réserve ${fmtQty(p.reserveStock)} / min. ${fmtQty(p.minReserve)}</div></div><span class="status ${s.key}">${s.label}</span></div><div class="order-line"><span>Commander</span><strong>${fmtQty(q)} ${escapeHtml(p.unit)}</strong></div><div class="product-meta" style="margin-top:8px">Coût estimé : ${fmtMoney(q*Number(p.unitCost||0))}</div><div class="product-actions"><button class="action-btn amazon-action" data-amazon="${p.id}">Commander Amazon Business</button><button class="action-btn primary-action" data-move="${p.id}">Réception / mouvement</button><button class="action-btn" data-edit="${p.id}">Modifier</button></div></article>`
}
function renderHistory(){
  const allPurchases=purchaseTotals(),month=purchaseMonthTotals();
  $('historyPurchaseMonth').textContent=fmtMoney(month.total);
  $('historyPurchaseTotal').textContent=fmtMoney(allPurchases.total);
  $('historyPurchaseCount').textContent=allPurchases.count;
  $('purchaseHistoryList').innerHTML=allPurchases.list.length?allPurchases.list.slice(0,200).map(m=>{
    const p=products.find(x=>x.id===m.productId),unitCost=Number(m.purchaseUnitCost||0),total=Number(m.purchaseTotalCost||0);
    return `<article class="history-item purchase-history-item"><div><div class="name">${escapeHtml(m.productName||p?.name||'Produit')}</div><div class="detail">${fmtQty(m.qty)} ${escapeHtml(p?.unit||'unité')} × ${fmtMoney(unitCost)}${m.note?' • '+escapeHtml(m.note):''}</div></div><div class="qty purchase-total">${fmtMoney(total)}</div><div class="time">${new Date(m.date).toLocaleString('fr-CA',{dateStyle:'medium',timeStyle:'short'})}</div></article>`;
  }).join(''):'<div class="empty">Aucun achat enregistré avec cette version.</div>';
  $('historyList').innerHTML=movements.length?movements.slice(0,300).map(m=>{const p=products.find(x=>x.id===m.productId);const purchase=isPurchaseMovement(m)?` • achat ${fmtMoney(m.purchaseTotalCost||0)}`:'';return `<article class="history-item"><div><div class="name">${escapeHtml(m.productName||p?.name||'Produit')}</div><div class="detail">${escapeHtml(m.label)}${m.note?' • '+escapeHtml(m.note):''}${purchase}</div></div><div class="qty">${m.sign||''}${fmtQty(m.qty)}</div><div class="time">${new Date(m.date).toLocaleString('fr-CA',{dateStyle:'medium',timeStyle:'short'})}</div></article>`}).join(''):'<div class="empty">Aucun mouvement enregistré.</div>';
}
function renderCategories(){const select=$('categoryFilter'),current=select.value;const cats=[...new Set(products.map(p=>p.category).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'fr'));select.innerHTML='<option value="">Toutes catégories</option>'+cats.map(c=>`<option ${c===current?'selected':''}>${escapeHtml(c)}</option>`).join('')}
function bindCardActions(root){
  root.querySelectorAll('[data-edit]').forEach(b=>b.onclick=()=>openProduct(products.find(p=>p.id===b.dataset.edit)));
  root.querySelectorAll('[data-move]').forEach(b=>b.onclick=()=>openMovement(products.find(p=>p.id===b.dataset.move)));
  root.querySelectorAll('[data-amazon]').forEach(b=>b.onclick=()=>openAmazonBusiness(products.find(p=>p.id===b.dataset.amazon)));
}

function updatePhotoPreview(){
  const img=$('productPhotoPreview'),placeholder=$('photoPlaceholder'),remove=$('removePhotoBtn');
  if(tempPhotoData){img.src=tempPhotoData;img.classList.remove('hidden');placeholder.classList.add('hidden');remove.classList.remove('hidden')}
  else{img.removeAttribute('src');img.classList.add('hidden');placeholder.classList.remove('hidden');remove.classList.add('hidden')}
}
function openProduct(p=null){
  $('productForm').reset();
  $('productId').value=p?.id||'';
  $('productDialogTitle').textContent=p?'Modifier le produit':'Ajouter un produit';
  $('productName').value=p?.name||'';$('productCategory').value=p?.category||'';$('productUnit').value=p?.unit||'unité';$('barcode').value=p?.barcode||'';$('reserveStock').value=p?.reserveStock??0;$('inHandStock').value=p?.inHandStock??0;$('minReserve').value=p?.minReserve??0;$('targetReserve').value=p?.targetReserve??0;$('unitCost').value=p?.unitCost??0;$('supplier').value=p?.supplier||'';$('location').value=p?.location||'';$('productUrl').value=p?.productUrl||'';$('notes').value=p?.notes||'';
  tempPhotoData=p?.photoData||'';updatePhotoPreview();
  $('deleteProductBtn').classList.toggle('hidden',!p); updateFormulaPreview(); $('productDialog').showModal();
}
function updateFormulaPreview(){
  const reserve=Number($('reserveStock').value||0),hand=Number($('inHandStock').value||0),min=Number($('minReserve').value||0),target=Math.max(min,Number($('targetReserve').value||0));
  const missing=reserve<min?Math.max(0,target-reserve):0;
  $('formulaPreview').innerHTML=`<b>Calcul :</b> ${fmtQty(reserve)} en réserve + ${fmtQty(hand)} en main = ${fmtQty(reserve+hand)} disponibles.<br>Minimum réserve : ${fmtQty(min)}. ${missing>0?`À commander : <b>${fmtQty(missing)}</b> pour remonter la réserve à ${fmtQty(target)}.`:'Aucune commande requise.'}`;
}
function openMovement(p,defaultType='receive'){$('movementForm').reset();$('movementProductId').value=p.id;$('movementProductName').textContent=p.name;$('movementType').value=defaultType;$('movementQty').value=1;$('movementUnitCost').value=Number(p.unitCost||0).toFixed(2);updateMovementPurchaseFields();$('movementDialog').showModal()}
function updateMovementPurchaseFields(){const isPurchase=$('movementType').value==='receive';$('movementPurchaseFields').classList.toggle('hidden',!isPurchase);if(isPurchase){const q=Number($('movementQty').value||0),c=Number($('movementUnitCost').value||0);$('movementPurchasePreview').textContent=`Coût de cet achat : ${fmtMoney(q*c)}`}}

async function saveProduct(e){
  e.preventDefault();
  const id=$('productId').value||uid();const old=products.find(p=>p.id===id);
  let min=Number($('minReserve').value||0);let target=Number($('targetReserve').value||0);if(target<min)target=min;
  const p={
    ...(old||{}),id,name:$('productName').value.trim(),category:$('productCategory').value.trim(),unit:$('productUnit').value,
    barcode:normalizeBarcode($('barcode').value),reserveStock:Number($('reserveStock').value||0),inHandStock:Number($('inHandStock').value||0),minReserve:min,targetReserve:target,
    unitCost:Number($('unitCost').value||0),supplier:$('supplier').value.trim(),location:$('location').value.trim(),productUrl:$('productUrl').value.trim(),notes:$('notes').value.trim(),photoData:tempPhotoData||'',
    createdAt:old?.createdAt||nowIso(),updatedAt:nowIso()
  };
  await put(PRODUCTS,p);
  if(!old){
    const initialTotal=totalAvailable(p);
    await recordMovement(p,'Création du produit',initialTotal,'','',{
      type:'initial',sign:initialTotal>0?'+':'',unitCostAtTime:Number(p.unitCost||0),inventoryValueDelta:initialTotal*Number(p.unitCost||0),stockAfterTotal:initialTotal
    });
  }else{
    const oldCost=Number(old.unitCost||0),newCost=Number(p.unitCost||0);
    const reserveDelta=Number(p.reserveStock||0)-Number(old.reserveStock||0);
    const handDelta=Number(p.inHandStock||0)-Number(old.inHandStock||0);
    if(reserveDelta!==0)await recordMovement(p,reserveDelta>0?'Ajustement réserve + via modification':'Ajustement réserve − via modification',Math.abs(reserveDelta),'',reserveDelta>0?'+':'−',{
      type:reserveDelta>0?'reservePlus':'reserveMinus',unitCostAtTime:oldCost,inventoryValueDelta:reserveDelta*oldCost,stockAfterTotal:totalAvailable(p)
    });
    if(handDelta!==0)await recordMovement(p,handDelta>0?'Ajustement en main + via modification':'Ajustement en main − via modification',Math.abs(handDelta),'',handDelta>0?'+':'−',{
      type:handDelta>0?'handPlus':'handMinus',unitCostAtTime:oldCost,inventoryValueDelta:handDelta*oldCost,stockAfterTotal:totalAvailable(p)
    });
    if(newCost!==oldCost){
      const qtyNow=totalAvailable(p),valueDelta=qtyNow*(newCost-oldCost);
      await recordMovement(p,'Mise à jour du coût unitaire',0,`${fmtMoney(oldCost)} → ${fmtMoney(newCost)}`,'↕',{
        type:'costChange',unitCostAtTime:newCost,previousUnitCost:oldCost,inventoryValueDelta:valueDelta,stockAfterTotal:qtyNow
      });
    }
  }
  $('productDialog').close();showToast('Produit enregistré');await loadData();
}
async function deleteCurrentProduct(){const id=$('productId').value;if(!id)return;const p=products.find(x=>x.id===id);if(!confirm(`Supprimer « ${p?.name||'ce produit'} » ?`))return;await del(PRODUCTS,id);$('productDialog').close();showToast('Produit supprimé');await loadData()}
const movementLabels={receive:'Réception / Achat en réserve',open:'Réserve → en main',consume:'Consommation depuis en main',return:'En main → réserve',reservePlus:'Ajustement réserve +',reserveMinus:'Ajustement réserve −',handPlus:'Ajustement en main +',handMinus:'Ajustement en main −'};
async function applyMovement(e){
  e.preventDefault();const p=products.find(x=>x.id===$('movementProductId').value);if(!p)return;
  const type=$('movementType').value,q=Number($('movementQty').value||0),note=$('movementNote').value.trim();if(q<=0)return;
  let reserve=Number(p.reserveStock||0),hand=Number(p.inHandStock||0),sign='',meta={type};
  const unitCostBefore=Number(p.unitCost||0);
  if(type==='receive'){
    const purchaseUnitCost=Number($('movementUnitCost').value||0);if(purchaseUnitCost<0)return showToast('Le coût ne peut pas être négatif');
    const currentQty=reserve+hand,currentValue=currentQty*unitCostBefore,purchaseTotalCost=q*purchaseUnitCost,newQty=currentQty+q;
    reserve+=q;sign='+';if(newQty>0)p.unitCost=(currentValue+purchaseTotalCost)/newQty;
    meta={type:'receive',isPurchase:true,purchaseUnitCost,purchaseTotalCost,previousUnitCost:unitCostBefore,inventoryValueDelta:purchaseTotalCost};
  }
  if(type==='reservePlus'){reserve+=q;sign='+';meta.inventoryValueDelta=q*unitCostBefore}
  if(type==='reserveMinus'){if(q>reserve)return showToast('Quantité supérieure à la réserve');reserve-=q;sign='−';meta.inventoryValueDelta=-q*unitCostBefore}
  if(type==='open'){if(q>reserve)return showToast('Pas assez en réserve');reserve-=q;hand+=q;sign='↔';meta.inventoryValueDelta=0}
  if(type==='consume'){if(q>hand)return showToast('Pas assez de produit “en main”');hand-=q;sign='−';meta.inventoryValueDelta=-q*unitCostBefore}
  if(type==='return'){if(q>hand)return showToast('Pas assez de produit “en main”');hand-=q;reserve+=q;sign='↔';meta.inventoryValueDelta=0}
  if(type==='handPlus'){hand+=q;sign='+';meta.inventoryValueDelta=q*unitCostBefore}
  if(type==='handMinus'){if(q>hand)return showToast('Quantité supérieure au stock en main');hand-=q;sign='−';meta.inventoryValueDelta=-q*unitCostBefore}
  p.reserveStock=reserve;p.inHandStock=hand;p.updatedAt=nowIso();meta.stockAfterTotal=reserve+hand;
  await put(PRODUCTS,p);await recordMovement(p,movementLabels[type],q,note,sign,meta);$('movementDialog').close();showToast(type==='receive'?`Achat enregistré : ${fmtMoney(meta.purchaseTotalCost)}`:'Stock mis à jour');await loadData();
}
async function recordMovement(p,label,qty,note,sign,meta={}){await put(MOVEMENTS,{id:uid(),productId:p.id,productName:p.name,label,qty:Number(qty||0),note:note||'',sign:sign||'',unitCostAtTime:Number(p.unitCost||0),date:nowIso(),...meta})}


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
  const destination=productAmazonUrl(p);
  // Keep existing supplier links intact. Amazon's Business account shares amazon.ca.
  if(!isAmazonDestination(destination)){openExternal(destination);return}
  stopScanner();
  $('amazonProductName').textContent=p.name||p.barcode||'Recherche de produit';
  $('amazonProductLink').href=amazonBusinessProductUrl(p);
  $('amazonBrowserLink').href=amazonBrowserProductUrl(p);
  $('amazonBusinessLoginLink').href=AMAZON_BUSINESS_LOGIN;
  if(!$('amazonDialog').open)$('amazonDialog').showModal();
}
function amazonSearchFromForm(){const term=normalizeBarcode($('barcode').value)||$('productName').value.trim();if(!term)return showToast('Scanne un code ou entre un nom de produit');openAmazonBusiness({name:$('productName').value.trim(),barcode:term})}

/* ---------- Statistiques & graphiques ---------- */
function statsDays(){return Number($('statsPeriod')?.value||30)}
function statsTopLimit(){return Number($('statsTopLimit')?.value||10)}
function periodStart(days){
  if(days>0)return new Date(Date.now()-days*86400000);
  const dated=movements.map(m=>new Date(m.date)).filter(d=>!Number.isNaN(d.getTime())).sort((a,b)=>a-b);
  return dated[0]||new Date(Date.now()-30*86400000);
}
function periodLabel(days){return days===0?'Tout l’historique':days===7?'7 jours':days===30?'30 jours':days===90?'3 mois':days===180?'6 mois':days===365?'1 an':`${days} jours`}
function movesWithin(days){if(Number(days)===0)return [...movements];const since=Date.now()-Number(days)*86400000;return movements.filter(m=>new Date(m.date).getTime()>=since)}
function isConsumption(m){return m?.type==='consume'||/Consommation depuis en main/i.test(String(m.label||''))}
function consumptionMap(days){const map=new Map();for(const m of movesWithin(days).filter(isConsumption))map.set(m.productId,(map.get(m.productId)||0)+Number(m.qty||0));return map}
function consumptionCostMap(days){const map=new Map();for(const m of movesWithin(days).filter(isConsumption)){const p=products.find(x=>x.id===m.productId);const cost=m.unitCostAtTime!=null?Number(m.unitCostAtTime||0):Number(p?.unitCost||0);map.set(m.productId,(map.get(m.productId)||0)+Number(m.qty||0)*cost)}return map}
function movementDirection(m){
  const t=String(m.type||'');if(['receive','reservePlus','handPlus','initial'].includes(t))return 'add';if(['reserveMinus','handMinus','consume'].includes(t))return 'remove';if(['open','return','costChange'].includes(t))return 'neutral';
  const l=String(m.label||'');if(/Réception|Ajustement réserve \+|Ajustement en main \+|Stock initial/i.test(l))return 'add';if(/Consommation|Ajustement réserve [−-]|Ajustement en main [−-]/i.test(l))return 'remove';return 'neutral';
}
function movementInventoryDelta(m){
  if(Number.isFinite(Number(m.inventoryValueDelta)))return Number(m.inventoryValueDelta);
  if(isPurchaseMovement(m))return Number(m.purchaseTotalCost||0);
  const dir=movementDirection(m),cost=Number(m.unitCostAtTime||0),qty=Number(m.qty||0);return dir==='add'?qty*cost:dir==='remove'?-qty*cost:0;
}
function bucketMode(days,start){const span=days===0?Math.max(1,(Date.now()-start.getTime())/86400000):days;return span<=45?'day':span<=210?'week':'month'}
function bucketKey(date,mode){
  const d=new Date(date);if(mode==='month')return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
  if(mode==='week'){const x=new Date(d.getFullYear(),d.getMonth(),d.getDate());const dow=(x.getDay()+6)%7;x.setDate(x.getDate()-dow);return `${x.getFullYear()}-${String(x.getMonth()+1).padStart(2,'0')}-${String(x.getDate()).padStart(2,'0')}`}
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function bucketDateFromKey(key){const [y,m,d='1']=key.split('-').map(Number);return new Date(y,m-1,d)}
function formatBucketLabel(key,mode){const d=bucketDateFromKey(key);return mode==='month'?d.toLocaleDateString('fr-CA',{month:'short',year:'2-digit'}):mode==='week'?d.toLocaleDateString('fr-CA',{day:'numeric',month:'short'}):d.toLocaleDateString('fr-CA',{day:'numeric',month:'short'})}
function bucketRange(days){
  const start=periodStart(days),mode=bucketMode(days,start),end=new Date(),keys=[];let d=new Date(start.getFullYear(),start.getMonth(),start.getDate());
  if(mode==='week'){const dow=(d.getDay()+6)%7;d.setDate(d.getDate()-dow)}if(mode==='month')d=new Date(d.getFullYear(),d.getMonth(),1);
  let guard=0;while(d<=end&&guard<1000){keys.push(bucketKey(d,mode));d=mode==='day'?new Date(d.getFullYear(),d.getMonth(),d.getDate()+1):mode==='week'?new Date(d.getFullYear(),d.getMonth(),d.getDate()+7):new Date(d.getFullYear(),d.getMonth()+1,1);guard++}
  if(!keys.length)keys.push(bucketKey(end,mode));return {start,mode,keys};
}
function aggregateSeries(days,extractor){const range=bucketRange(days),map=new Map(range.keys.map(k=>[k,{}]));for(const m of movesWithin(days)){const k=bucketKey(new Date(m.date),range.mode);if(!map.has(k))continue;extractor(m,map.get(k))}return {mode:range.mode,start:range.start,rows:range.keys.map(k=>({key:k,label:formatBucketLabel(k,range.mode),...map.get(k)}))}}
function compactNumber(v,money=false){return new Intl.NumberFormat('fr-CA',{notation:'compact',maximumFractionDigits:1,style:money?'currency':'decimal',currency:money?'CAD':undefined}).format(Number(v||0))}
function svgEscape(v=''){return escapeHtml(v)}
function renderLineChart(id,rows,series,{money=false,integer=false}={}){
  const el=$(id);if(!el)return;const hasData=rows.some(r=>series.some(s=>Number(r[s.key]||0)!==0));if(!rows.length||!hasData){el.innerHTML='<div class="empty chart-empty">Pas encore assez de données pour afficher ce graphique.</div>';return}
  const W=760,H=250,L=58,R=18,T=22,B=48,plotW=W-L-R,plotH=H-T-B;
  const vals=rows.flatMap(r=>series.map(s=>Number(r[s.key]||0)));let min=0,max=Math.max(...vals,0);if(max<=0)max=1;
  const y=v=>T+plotH-(Number(v||0)-min)/(max-min||1)*plotH;const x=i=>L+(rows.length===1?plotW/2:i*plotW/Math.max(1,rows.length-1));
  const grid=[0,.25,.5,.75,1].map(fr=>{const val=max*(1-fr),yy=T+plotH*fr;return `<line x1="${L}" y1="${yy}" x2="${W-R}" y2="${yy}" class="chart-grid-line"/><text x="${L-8}" y="${yy+4}" text-anchor="end" class="chart-axis-text">${svgEscape(money?compactNumber(val,true):integer?Math.round(val):compactNumber(val))}</text>`}).join('');
  const maxLabels=5,labelIdx=new Set();for(let i=0;i<Math.min(maxLabels,rows.length);i++)labelIdx.add(Math.round(i*(rows.length-1)/Math.max(1,Math.min(maxLabels,rows.length)-1)));const xlabels=[...labelIdx].map(i=>`<text x="${x(i)}" y="${H-16}" text-anchor="middle" class="chart-axis-text">${svgEscape(rows[i].label)}</text>`).join('');
  const paths=series.map((s,si)=>{const pts=rows.map((r,i)=>`${x(i)},${y(r[s.key])}`).join(' ');const circles=rows.map((r,i)=>`<circle cx="${x(i)}" cy="${y(r[s.key])}" r="3" class="chart-dot series-${si+1}"><title>${svgEscape(r.label)} — ${svgEscape(s.label)}: ${svgEscape(money?fmtMoney(r[s.key]):integer?fmtQty(r[s.key]):String(r[s.key]||0))}</title></circle>`).join('');return `<polyline points="${pts}" class="chart-line series-${si+1}"/>${circles}`}).join('');
  const legend=series.map((s,si)=>`<span><i class="legend-line series-${si+1}"></i>${escapeHtml(s.label)}</span>`).join('');
  el.innerHTML=`<div class="chart-legend">${legend}</div><div class="chart-scroll"><svg class="trend-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${escapeHtml(series.map(s=>s.label).join(' et '))}">${grid}${xlabels}${paths}</svg></div>`;
}
function renderBars(id,rows,valueKey,{money=false,unitKey='unit'}={}){
  const el=$(id);if(!el)return;const max=Math.max(1,...rows.map(r=>Number(r[valueKey]||0)));el.innerHTML=rows.length?rows.map(r=>`<div class="bar-row"><div class="bar-label" title="${escapeHtml(r.name)}">${escapeHtml(r.name)}</div><div class="bar-track"><div class="bar-fill" style="width:${Math.max(2,Number(r[valueKey]||0)/max*100)}%"></div></div><div class="bar-value">${money?fmtMoney(r[valueKey]):`${fmtQty(r[valueKey])}${r[unitKey]?' '+escapeHtml(r[unitKey]):''}`}</div></div>`).join(''):'<div class="empty">Aucune donnée pendant cette période.</div>';
}
function renderHealthChart(){
  const counts={ok:0,watch:0,order:0,out:0};for(const p of products)counts[statusOf(p).key]=(counts[statusOf(p).key]||0)+1;const total=Math.max(1,products.length);
  const parts=[['ok','OK'],['watch','À surveiller'],['order','Commander'],['out','Rupture']];$('stockHealthChart').innerHTML=products.length?`<div class="health-stack">${parts.map(([k])=>counts[k]?`<span class="health-segment ${k}" style="width:${counts[k]/total*100}%" title="${counts[k]} produit(s)"></span>`:'').join('')}</div><div class="health-legend">${parts.map(([k,l])=>`<span><i class="dot ${k}"></i>${l}<b>${counts[k]}</b></span>`).join('')}</div>`:'<div class="empty">Aucun produit.</div>';
}
function renderStats(){
  if(!$('statsPeriod'))return;
  const days=statsDays(),label=periodLabel(days),periodMoves=movesWithin(days),usage=consumptionMap(days),usageCosts=consumptionCostMap(days),top=statsTopLimit();
  const reserveCost=products.reduce((s,p)=>s+Number(p.reserveStock||0)*Number(p.unitCost||0),0),inHandCost=products.reduce((s,p)=>s+Number(p.inHandStock||0)*Number(p.unitCost||0),0),totalValue=reserveCost+inHandCost;
  const orderBudget=products.reduce((s,p)=>s+toOrder(p)*Number(p.unitCost||0),0),pricedProducts=products.filter(p=>Number(p.unitCost||0)>0),avgUnitCost=pricedProducts.length?pricedProducts.reduce((s,p)=>s+Number(p.unitCost||0),0)/pricedProducts.length:0;
  const consumedCost=[...usageCosts.values()].reduce((sum,cost)=>sum+Number(cost||0),0),healthy=products.length?Math.round(products.filter(p=>statusOf(p).key==='ok').length/products.length*100):0;
  $('statTotalValue').textContent=fmtMoney(totalValue);$('statReserveCost').textContent=fmtMoney(reserveCost);$('statInHandCost').textContent=fmtMoney(inHandCost);$('statConsumedCost').textContent=fmtMoney(consumedCost);$('statOrderBudget').textContent=fmtMoney(orderBudget);$('statAvgUnitCost').textContent=fmtMoney(avgUnitCost);$('statHealth').textContent=`${healthy} %`;$('statMoves').textContent=periodMoves.length;$('statPurchasesPeriod').textContent=fmtMoney(purchaseTotals(days===0?null:days).total);$('statPurchasesMonth').textContent=fmtMoney(purchaseMonthTotals().total);$('statPurchasesTotal').textContent=fmtMoney(purchaseTotals().total);
  ['usagePeriodLabel','costPeriodLabel','purchaseChartPeriodLabel','movementChartPeriodLabel','inventoryValuePeriodLabel','purchaseVsConsumptionPeriodLabel'].forEach(id=>$(id).textContent=label);

  let usageRows=[...usage.entries()].map(([id,qty])=>({p:products.find(p=>p.id===id),qty})).filter(x=>x.p).sort((a,b)=>b.qty-a.qty);if(top>0)usageRows=usageRows.slice(0,top);renderBars('usageChart',usageRows.map(x=>({name:x.p.name,qty:x.qty,unit:x.p.unit})),'qty');
  let costRows=[...usageCosts.entries()].map(([id,cost])=>({p:products.find(p=>p.id===id),cost:Number(cost||0)})).filter(x=>x.p&&x.cost>0).sort((a,b)=>b.cost-a.cost);if(top>0)costRows=costRows.slice(0,top);renderBars('consumptionCostChart',costRows.map(x=>({name:x.p.name,cost:x.cost})),'cost',{money:true});

  const purchases=aggregateSeries(days,(m,o)=>{o.amount=(o.amount||0)+(isPurchaseMovement(m)?Number(m.purchaseTotalCost||0):0)});renderLineChart('purchaseTrendChart',purchases.rows,[{key:'amount',label:'Achats'}],{money:true});
  const stockMoves=aggregateSeries(days,(m,o)=>{const dir=movementDirection(m),q=Number(m.qty||0);if(dir==='add')o.added=(o.added||0)+q;if(dir==='remove')o.removed=(o.removed||0)+q});renderLineChart('movementTrendChart',stockMoves.rows,[{key:'added',label:'Ajouts'},{key:'removed',label:'Retraits'}],{integer:false});
  const moneyFlow=aggregateSeries(days,(m,o)=>{if(isPurchaseMovement(m))o.purchases=(o.purchases||0)+Number(m.purchaseTotalCost||0);if(isConsumption(m))o.consumed=(o.consumed||0)+Number(m.qty||0)*Number(m.unitCostAtTime||products.find(p=>p.id===m.productId)?.unitCost||0)});renderLineChart('purchaseVsConsumptionChart',moneyFlow.rows,[{key:'purchases',label:'Achats'},{key:'consumed',label:'Consommation'}],{money:true});

  const range=bucketRange(days),deltaByBucket=new Map(range.keys.map(k=>[k,0]));for(const m of movesWithin(days)){const k=bucketKey(new Date(m.date),range.mode);if(deltaByBucket.has(k))deltaByBucket.set(k,deltaByBucket.get(k)+movementInventoryDelta(m))}
  const startValue=totalValue-[...deltaByBucket.values()].reduce((s,v)=>s+v,0);let running=startValue;const valueRows=range.keys.map(k=>{running+=deltaByBucket.get(k)||0;return {label:formatBucketLabel(k,range.mode),value:Math.max(0,running)}});renderLineChart('inventoryValueTrendChart',valueRows,[{key:'value',label:'Valeur inventaire'}],{money:true});

  const byCat=new Map();for(const p of products){const cat=p.category||'Sans catégorie';byCat.set(cat,(byCat.get(cat)||0)+totalAvailable(p)*Number(p.unitCost||0))}const catRows=[...byCat.entries()].map(([name,value])=>({name,value})).filter(x=>x.value>0).sort((a,b)=>b.value-a.value);renderBars('categoryChart',catRows,'value',{money:true});renderHealthChart();

  const coverageDays=days===0?Math.max(1,Math.round((Date.now()-periodStart(0).getTime())/86400000)):days;const coverage=products.map(p=>{const used=usage.get(p.id)||0,daily=used/coverageDays,cover=daily>0?totalAvailable(p)/daily:null;return {p,used,cover}}).filter(x=>x.used>0).sort((a,b)=>(a.cover??99999)-(b.cover??99999)).slice(0,15);$('coverageList').innerHTML=coverage.length?coverage.map(x=>{const d=Math.round(x.cover),cls=d<14?'low':d<30?'mid':'good';return `<div class="coverage-row"><div><b>${escapeHtml(x.p.name)}</b><small>${fmtQty(x.used)} ${escapeHtml(x.p.unit)} consommé(s) • ${fmtQty(totalAvailable(x.p))} disponible(s)</small></div><div class="coverage-days ${cls}">≈ ${d} j</div></div>`}).join(''):'<div class="empty">Pas encore assez de mouvements de consommation pour estimer la couverture.</div>';
}

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
function handleScanDetected(code){scanLastCode=normalizeBarcode(code);if(!scanLastCode)return;stopScanner();$('scanCodeText').textContent=scanLastCode;$('scanResult').classList.remove('hidden');$('scannerStatus').textContent='Code détecté ✓';if(navigator.vibrate)navigator.vibrate(80)}
function openScanner(target='standalone'){scannerTarget=target;scanLastCode='';$('manualBarcode').value='';$('scanResult').classList.add('hidden');if(!$('scannerDialog').open)$('scannerDialog').showModal();startScanner()}
function closeScanner(){stopScanner();if($('scannerDialog').open)$('scannerDialog').close()}
function useManualCode(){const code=normalizeBarcode($('manualBarcode').value);if(code.length<8)return showToast('Entre au moins 8 chiffres');handleScanDetected(code)}
function useScannedCode(){
  const code=scanLastCode||normalizeBarcode($('manualBarcode').value);if(!code)return;
  closeScanner();
  if(scannerTarget==='form'){$('barcode').value=code;if(!$('supplier').value)$('supplier').value='Amazon Business';showToast('Code ajouté à la fiche');return}
  const existing=products.find(p=>normalizeBarcode(p.barcode)===code);if(existing){openProduct(existing);showToast('Produit trouvé dans ton inventaire');return}
  openProduct();$('barcode').value=code;$('supplier').value='Amazon Business';$('productName').placeholder='Nom du produit trouvé sur Amazon';showToast('Nouveau code ajouté');
}
function searchScannedOnAmazon(){const code=scanLastCode||normalizeBarcode($('manualBarcode').value);if(!code)return showToast('Aucun code détecté');openAmazonBusiness(products.find(p=>normalizeBarcode(p.barcode)===code)||{barcode:code})}
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
  const date=new Date(),orderList=products.filter(p=>toOrder(p)>0).sort(prioritySort),reserveValue=products.reduce((s,p)=>s+Number(p.reserveStock||0)*Number(p.unitCost||0),0),totalValue=products.reduce((s,p)=>s+totalAvailable(p)*Number(p.unitCost||0),0),budget=orderList.reduce((s,p)=>s+toOrder(p)*Number(p.unitCost||0),0),pMonth=purchaseMonthTotals(),pAll=purchaseTotals();
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

function navigate(view){document.querySelectorAll('.view').forEach(v=>v.classList.toggle('active',v.id===`${view}View`));document.querySelectorAll('.nav-btn').forEach(b=>b.classList.toggle('active',b.dataset.view===view));if(view==='stats')renderStats();window.scrollTo({top:0,behavior:'smooth'})}
function showToast(msg){const t=$('toast');t.textContent=msg;t.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>t.classList.remove('show'),2200)}
function downloadBlob(name,content,type){const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([content],{type}));a.download=name;document.body.appendChild(a);a.click();setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove()},1200)}
function downloadBytes(name,bytes,type){const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([bytes],{type}));a.download=name;document.body.appendChild(a);a.click();setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove()},1500)}
async function exportBackup(){const data={app:'Inventaire Pro',version:3.2,exportedAt:nowIso(),products,movements};downloadBlob(`inventaire-backup-${new Date().toISOString().slice(0,10)}.json`,JSON.stringify(data,null,2),'application/json');showToast('Sauvegarde exportée')}
async function importBackup(file){try{const data=JSON.parse(await file.text());if(!Array.isArray(data.products)||!Array.isArray(data.movements))throw new Error();if(!confirm(`Importer ${data.products.length} produits ? Les données actuelles seront remplacées.`))return;await clearStore(PRODUCTS);await clearStore(MOVEMENTS);for(const p of data.products)await put(PRODUCTS,p);for(const m of data.movements)await put(MOVEMENTS,m);await loadData();showToast('Sauvegarde importée')}catch(e){console.error(e);showToast('Fichier de sauvegarde invalide')}}
function exportCsv(){const header=['Produit','Code-barres','Catégorie','Unité','Réserve','En main','Minimum réserve','Stock cible','À commander','Coût unitaire','Fournisseur','Emplacement','Lien produit','Notes'];const rows=products.map(p=>[p.name,p.barcode||'',p.category,p.unit,p.reserveStock,p.inHandStock,p.minReserve,targetOf(p),toOrder(p),p.unitCost,p.supplier,p.location,p.productUrl,p.notes]);const csv=[header,...rows].map(r=>r.map(v=>`"${String(v??'').replace(/"/g,'""')}"`).join(',')).join('\n');downloadBlob(`inventaire-${new Date().toISOString().slice(0,10)}.csv`,`\ufeff${csv}`,'text/csv;charset=utf-8');showToast('CSV exporté')}
async function seedExamples(){if(products.length&&!confirm('Ajouter les exemples à ton inventaire actuel ?'))return;const samples=[
{name:'Nettoyant intérieur / APC',barcode:'',category:'Intérieur',unit:'bouteille',reserveStock:4,inHandStock:1,minReserve:6,targetReserve:6,unitCost:22.99,supplier:'Amazon Business',location:'Étagère produits',notes:'Exemple : 4 en réserve, minimum 6, 1 en main : commander 2.'},
{name:'Shampoing automobile',barcode:'',category:'Lavage extérieur',unit:'bouteille',reserveStock:7,inHandStock:1,minReserve:4,targetReserve:8,unitCost:24.99,supplier:'Amazon Business',location:'Étagère produits',notes:''},
{name:'Gants nitrile',barcode:'',category:'Consommables',unit:'boîte',reserveStock:1,inHandStock:1,minReserve:2,targetReserve:5,unitCost:18.99,supplier:'Amazon Business',location:'Bac consommables',notes:''},
{name:'Shampoing tissus / tapis',barcode:'',category:'Tissus & tapis',unit:'bouteille',reserveStock:0,inHandStock:0,minReserve:2,targetReserve:5,unitCost:29.99,supplier:'Distributeur detailing',location:'Étagère produits',notes:''}
];for(const s of samples){const p={...s,id:uid(),productUrl:'',photoData:'',createdAt:nowIso(),updatedAt:nowIso()};await put(PRODUCTS,p);await recordMovement(p,'Création exemple',0,'','')}await loadData();showToast('Exemples ajoutés')}
async function clearEverything(){if(!confirm('Effacer TOUS les produits, photos et l’historique sur cet appareil ?'))return;await clearStore(PRODUCTS);await clearStore(MOVEMENTS);await loadData();showToast('Données effacées')}

function setupEvents(){
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
  try{db=await openDB();setupEvents();await loadData();if('serviceWorker'in navigator)navigator.serviceWorker.register('sw.js').catch(()=>{});}catch(e){console.error(e);alert('Impossible d’ouvrir la base de données locale sur cet appareil.')}
})();
