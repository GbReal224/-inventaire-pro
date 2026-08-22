const DB_NAME = 'InventaireProDB';
const DB_VERSION = 1;
const PRODUCTS = 'products';
const MOVEMENTS = 'movements';
let db;
let products = [];
let movements = [];
let toastTimer;
let tempPhotoData = '';
let scannerStream = null;
let scannerTimer = null;
let scannerTarget = 'standalone';
let scanLastCode = '';
let barcodeDetector = null;

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
  $('historyList').innerHTML=movements.length?movements.slice(0,300).map(m=>{const p=products.find(x=>x.id===m.productId);return `<article class="history-item"><div><div class="name">${escapeHtml(m.productName||p?.name||'Produit')}</div><div class="detail">${escapeHtml(m.label)}${m.note?' • '+escapeHtml(m.note):''}</div></div><div class="qty">${m.sign||''}${fmtQty(m.qty)}</div><div class="time">${new Date(m.date).toLocaleString('fr-CA',{dateStyle:'medium',timeStyle:'short'})}</div></article>`}).join(''):'<div class="empty">Aucun mouvement enregistré.</div>';
}
function renderCategories(){const select=$('categoryFilter'),current=select.value;const cats=[...new Set(products.map(p=>p.category).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'fr'));select.innerHTML='<option value="">Toutes catégories</option>'+cats.map(c=>`<option ${c===current?'selected':''}>${escapeHtml(c)}</option>`).join('')}
function bindCardActions(root){
  root.querySelectorAll('[data-edit]').forEach(b=>b.onclick=()=>openProduct(products.find(p=>p.id===b.dataset.edit)));
  root.querySelectorAll('[data-move]').forEach(b=>b.onclick=()=>openMovement(products.find(p=>p.id===b.dataset.move)));
  root.querySelectorAll('[data-amazon]').forEach(b=>b.onclick=()=>{const p=products.find(p=>p.id===b.dataset.amazon);openExternal(productAmazonUrl(p))});
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
function openMovement(p){$('movementForm').reset();$('movementProductId').value=p.id;$('movementProductName').textContent=p.name;$('movementQty').value=1;$('movementDialog').showModal()}

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
  await put(PRODUCTS,p);if(!old){await recordMovement(p,'Création du produit',0,'','')}
  $('productDialog').close();showToast('Produit enregistré');await loadData();
}
async function deleteCurrentProduct(){const id=$('productId').value;if(!id)return;const p=products.find(x=>x.id===id);if(!confirm(`Supprimer « ${p?.name||'ce produit'} » ?`))return;await del(PRODUCTS,id);$('productDialog').close();showToast('Produit supprimé');await loadData()}
const movementLabels={receive:'Réception en réserve',open:'Réserve → en main',consume:'Consommation depuis en main',return:'En main → réserve',reservePlus:'Ajustement réserve +',reserveMinus:'Ajustement réserve −',handPlus:'Ajustement en main +',handMinus:'Ajustement en main −'};
async function applyMovement(e){
  e.preventDefault();const p=products.find(x=>x.id===$('movementProductId').value);if(!p)return;
  const type=$('movementType').value,q=Number($('movementQty').value||0),note=$('movementNote').value.trim();if(q<=0)return;
  let reserve=Number(p.reserveStock||0),hand=Number(p.inHandStock||0),sign='';
  if(type==='receive'||type==='reservePlus'){reserve+=q;sign='+'}
  if(type==='reserveMinus'){if(q>reserve)return showToast('Quantité supérieure à la réserve');reserve-=q;sign='−'}
  if(type==='open'){if(q>reserve)return showToast('Pas assez en réserve');reserve-=q;hand+=q;sign='↔'}
  if(type==='consume'){if(q>hand)return showToast('Pas assez de produit “en main”');hand-=q;sign='−'}
  if(type==='return'){if(q>hand)return showToast('Pas assez de produit “en main”');hand-=q;reserve+=q;sign='↔'}
  if(type==='handPlus'){hand+=q;sign='+'}
  if(type==='handMinus'){if(q>hand)return showToast('Quantité supérieure au stock en main');hand-=q;sign='−'}
  p.reserveStock=reserve;p.inHandStock=hand;p.updatedAt=nowIso();await put(PRODUCTS,p);await recordMovement(p,movementLabels[type],q,note,sign);$('movementDialog').close();showToast('Stock mis à jour');await loadData();
}
async function recordMovement(p,label,qty,note,sign){await put(MOVEMENTS,{id:uid(),productId:p.id,productName:p.name,label,qty:Number(qty||0),note:note||'',sign:sign||'',unitCostAtTime:Number(p.unitCost||0),date:nowIso()})}

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
function amazonSearchFromForm(){const term=normalizeBarcode($('barcode').value)||$('productName').value.trim();if(!term)return showToast('Scanne un code ou entre un nom de produit');openExternal(amazonSearchUrl(term))}

/* ---------- Statistiques ---------- */
function movesWithin(days){const since=Date.now()-Number(days)*86400000;return movements.filter(m=>new Date(m.date).getTime()>=since)}
function isConsumption(m){return /Consommation depuis en main/i.test(String(m.label||''))}
function consumptionMap(days){const map=new Map();for(const m of movesWithin(days).filter(isConsumption))map.set(m.productId,(map.get(m.productId)||0)+Number(m.qty||0));return map}
function consumptionCostMap(days){const map=new Map();for(const m of movesWithin(days).filter(isConsumption)){const p=products.find(x=>x.id===m.productId);const cost=m.unitCostAtTime!=null?Number(m.unitCostAtTime||0):Number(p?.unitCost||0);map.set(m.productId,(map.get(m.productId)||0)+Number(m.qty||0)*cost)}return map}
function renderStats(){
  if(!$('statsPeriod'))return;
  const days=Number($('statsPeriod').value||30),periodMoves=movesWithin(days),usage=consumptionMap(days),usageCosts=consumptionCostMap(days);
  const reserveCost=products.reduce((s,p)=>s+Number(p.reserveStock||0)*Number(p.unitCost||0),0);
  const inHandCost=products.reduce((s,p)=>s+Number(p.inHandStock||0)*Number(p.unitCost||0),0);
  const totalValue=reserveCost+inHandCost;
  const orderBudget=products.reduce((s,p)=>s+toOrder(p)*Number(p.unitCost||0),0);
  const pricedProducts=products.filter(p=>Number(p.unitCost||0)>0);
  const avgUnitCost=pricedProducts.length?pricedProducts.reduce((s,p)=>s+Number(p.unitCost||0),0)/pricedProducts.length:0;
  const consumedCost=[...usageCosts.values()].reduce((sum,cost)=>sum+Number(cost||0),0);
  const healthy=products.length?Math.round(products.filter(p=>statusOf(p).key==='ok').length/products.length*100):0;
  $('statTotalValue').textContent=fmtMoney(totalValue);
  $('statReserveCost').textContent=fmtMoney(reserveCost);
  $('statInHandCost').textContent=fmtMoney(inHandCost);
  $('statConsumedCost').textContent=fmtMoney(consumedCost);
  $('statOrderBudget').textContent=fmtMoney(orderBudget);
  $('statAvgUnitCost').textContent=fmtMoney(avgUnitCost);
  $('statHealth').textContent=`${healthy} %`;
  $('statMoves').textContent=periodMoves.length;
  $('usagePeriodLabel').textContent=`${days} jours`;
  $('costPeriodLabel').textContent=`${days} jours`;

  const usageRows=[...usage.entries()].map(([id,qty])=>({p:products.find(p=>p.id===id),qty})).filter(x=>x.p).sort((a,b)=>b.qty-a.qty).slice(0,8);
  const maxUsage=Math.max(1,...usageRows.map(x=>x.qty));
  $('usageChart').innerHTML=usageRows.length?usageRows.map(x=>`<div class="bar-row"><div class="bar-label">${escapeHtml(x.p.name)}</div><div class="bar-track"><div class="bar-fill" style="width:${Math.max(2,x.qty/maxUsage*100)}%"></div></div><div class="bar-value">${fmtQty(x.qty)} ${escapeHtml(x.p.unit)}</div></div>`).join(''):'<div class="empty">Aucune consommation enregistrée pendant cette période.</div>';

  const costRows=[...usageCosts.entries()].map(([id,cost])=>({p:products.find(p=>p.id===id),cost:Number(cost||0)})).filter(x=>x.p&&x.cost>0).sort((a,b)=>b.cost-a.cost).slice(0,8);
  const maxCost=Math.max(1,...costRows.map(x=>x.cost));
  $('consumptionCostChart').innerHTML=costRows.length?costRows.map(x=>`<div class="bar-row"><div class="bar-label">${escapeHtml(x.p.name)}</div><div class="bar-track"><div class="bar-fill cost-bar" style="width:${Math.max(2,x.cost/maxCost*100)}%"></div></div><div class="bar-value">${fmtMoney(x.cost)}</div></div>`).join(''):'<div class="empty">Ajoute le coût unitaire de tes produits et enregistre les consommations pour voir leur coût réel.</div>';

  const byCat=new Map();for(const p of products){const cat=p.category||'Sans catégorie';byCat.set(cat,(byCat.get(cat)||0)+Number(p.reserveStock||0)*Number(p.unitCost||0))}
  const catRows=[...byCat.entries()].map(([name,value])=>({name,value})).sort((a,b)=>b.value-a.value).slice(0,10),maxCat=Math.max(1,...catRows.map(x=>x.value));
  $('categoryChart').innerHTML=catRows.length?catRows.map(x=>`<div class="bar-row"><div class="bar-label">${escapeHtml(x.name)}</div><div class="bar-track"><div class="bar-fill" style="width:${Math.max(2,x.value/maxCat*100)}%"></div></div><div class="bar-value">${fmtMoney(x.value)}</div></div>`).join(''):'<div class="empty">Ajoute des produits et leurs coûts pour voir cette statistique.</div>';

  const coverage=products.map(p=>{const used=usage.get(p.id)||0;const daily=used/days;const cover=daily>0?totalAvailable(p)/daily:null;return {p,used,cover}}).filter(x=>x.used>0).sort((a,b)=>(a.cover??99999)-(b.cover??99999)).slice(0,15);
  $('coverageList').innerHTML=coverage.length?coverage.map(x=>{const d=Math.round(x.cover);const cls=d<14?'low':d<30?'mid':'good';return `<div class="coverage-row"><div><b>${escapeHtml(x.p.name)}</b><small>${fmtQty(x.used)} ${escapeHtml(x.p.unit)} consommé(s) en ${days} jours • ${fmtQty(totalAvailable(x.p))} disponible(s)</small></div><div class="coverage-days ${cls}">≈ ${d} j</div></div>`}).join(''):'<div class="empty">Pas encore assez de mouvements de consommation pour estimer la couverture.</div>';
}

/* ---------- Scanner UPC / EAN ---------- */
const EAN_L=['0001101','0011001','0010011','0111101','0100011','0110001','0101111','0111011','0110111','0001011'];
const EAN_G=['0100111','0110011','0011011','0100001','0011101','0111001','0000101','0010001','0001001','0010111'];
const EAN_R=['1110010','1100110','1101100','1000010','1011100','1001110','1010000','1000100','1001000','1110100'];
const EAN_PARITY=['LLLLLL','LLGLGG','LLGGLG','LLGGGL','LGLLGG','LGGLLG','LGGGLL','LGLGLG','LGLGGL','LGGLGL'];

function hamming(a,b){let d=0;for(let i=0;i<a.length;i++)if(a[i]!==b[i])d++;return d}
function nearestPattern(bits,patterns,maxErr=1){let best=-1,err=99;for(let i=0;i<patterns.length;i++){const e=hamming(bits,patterns[i]);if(e<err){err=e;best=i}}return err<=maxErr?{digit:best,err}:null}
function validEan(code){
  if(!/^\d+$/.test(code)||![8,12,13].includes(code.length))return false;
  const digits=code.split('').map(Number),check=digits.pop();let sum=0;
  for(let i=digits.length-1,pos=1;i>=0;i--,pos++)sum+=digits[i]*(pos%2?3:1);
  return (10-(sum%10))%10===check;
}
function decodeModules(mod){
  if(mod.length===95){
    if(mod.slice(0,3).join('')!=='101'||mod.slice(45,50).join('')!=='01010'||mod.slice(92).join('')!=='101')return null;
    let parity='',left='',right='',errors=0;
    for(let i=0;i<6;i++){
      const bits=mod.slice(3+i*7,10+i*7).join('');const l=nearestPattern(bits,EAN_L,1),g=nearestPattern(bits,EAN_G,1);let pick=null,type='';
      if(l&&(!g||l.err<=g.err)){pick=l;type='L'}else if(g){pick=g;type='G'}else return null;
      left+=pick.digit;parity+=type;errors+=pick.err;
    }
    const first=EAN_PARITY.indexOf(parity);if(first<0)return null;
    for(let i=0;i<6;i++){const bits=mod.slice(50+i*7,57+i*7).join('');const r=nearestPattern(bits,EAN_R,1);if(!r)return null;right+=r.digit;errors+=r.err}
    const code=String(first)+left+right;return errors<=5&&validEan(code)?code:null;
  }
  if(mod.length===67){
    if(mod.slice(0,3).join('')!=='101'||mod.slice(31,36).join('')!=='01010'||mod.slice(64).join('')!=='101')return null;
    let code='',errors=0;
    for(let i=0;i<4;i++){const r=nearestPattern(mod.slice(3+i*7,10+i*7).join(''),EAN_L,1);if(!r)return null;code+=r.digit;errors+=r.err}
    for(let i=0;i<4;i++){const r=nearestPattern(mod.slice(36+i*7,43+i*7).join(''),EAN_R,1);if(!r)return null;code+=r.digit;errors+=r.err}
    return errors<=4&&validEan(code)?code:null;
  }
  return null;
}
function runsFromBits(bits){const runs=[];let color=bits[0],start=0;for(let i=1;i<=bits.length;i++){if(i===bits.length||bits[i]!==color){runs.push({color,start,end:i-1,len:i-start});if(i<bits.length){color=bits[i];start=i}}}return runs}
function sampleModules(bits,start,end,count){const out=[];const width=end-start+1;for(let k=0;k<count;k++){const center=start+(k+.5)*width/count;let ones=0,total=0;const rad=Math.max(1,Math.floor(width/count*.18));for(let x=Math.max(start,Math.floor(center-rad));x<=Math.min(end,Math.ceil(center+rad));x++){ones+=bits[x];total++}out.push(ones>=total/2?1:0)}return out}
function decodeBinaryLine(bits){
  const runs=runsFromBits(bits);if(runs.length<30)return null;
  for(const moduleCount of [95,67]){
    for(let i=1;i<runs.length-6;i++){
      const a=runs[i],b=runs[i+1],c=runs[i+2],quietL=runs[i-1];
      if(a.color!==1||b.color!==0||c.color!==1||quietL.color!==0)continue;
      const sm=(a.len+b.len+c.len)/3;if(sm<1.2||quietL.len<sm*2.5)continue;
      if(Math.max(a.len,b.len,c.len)>Math.min(a.len,b.len,c.len)*2.4)continue;
      const expectedRuns=moduleCount===95?50:34;
      for(let j=Math.max(i+expectedRuns-14,i+8);j<Math.min(runs.length-3,i+expectedRuns+18);j++){
        const x=runs[j],y=runs[j+1],z=runs[j+2],quietR=runs[j+3];
        if(x.color!==1||y.color!==0||z.color!==1||quietR.color!==0)continue;
        const totalWidth=z.end-a.start+1,module=totalWidth/moduleCount;if(module<1)continue;
        const guardLens=[a.len,b.len,c.len,x.len,y.len,z.len];if(guardLens.some(v=>v<module*.35||v>module*2.2))continue;
        if(quietR.len<module*2)continue;
        const mod=sampleModules(bits,a.start,z.end,moduleCount);const code=decodeModules(mod);if(code)return code;
      }
    }
  }
  return null;
}
function decodeVideoFrame(video){
  const canvas=$('scannerCanvas'),ctx=canvas.getContext('2d',{willReadFrequently:true});
  const vw=video.videoWidth||0,vh=video.videoHeight||0;if(!vw||!vh)return null;
  const w=Math.min(720,vw),h=Math.max(1,Math.round(vh*(w/vw)));canvas.width=w;canvas.height=h;ctx.drawImage(video,0,0,w,h);
  for(const ratio of [.38,.44,.5,.56,.62]){
    const y=Math.max(0,Math.min(h-1,Math.round(h*ratio))),data=ctx.getImageData(0,y,w,1).data,gray=new Array(w);let min=255,max=0;
    for(let x=0;x<w;x++){const o=x*4,g=Math.round(data[o]*.299+data[o+1]*.587+data[o+2]*.114);gray[x]=g;if(g<min)min=g;if(g>max)max=g}
    if(max-min<55)continue;const threshold=min+(max-min)*.48,bits=gray.map(g=>g<threshold?1:0);
    // Petit filtre majoritaire pour réduire le bruit caméra.
    const clean=bits.slice();for(let x=2;x<w-2;x++){const s=bits[x-2]+bits[x-1]+bits[x]+bits[x+1]+bits[x+2];clean[x]=s>=3?1:0}
    const code=decodeBinaryLine(clean);if(code)return code;
  }
  return null;
}
async function getNativeBarcode(video){
  if(!('BarcodeDetector' in window))return null;
  try{
    if(!barcodeDetector){const supported=await BarcodeDetector.getSupportedFormats?.()||[];const wanted=['ean_13','ean_8','upc_a','upc_e'].filter(f=>supported.includes(f));if(!wanted.length)return null;barcodeDetector=new BarcodeDetector({formats:wanted})}
    const result=await barcodeDetector.detect(video);if(result?.length){const code=normalizeBarcode(result[0].rawValue);if(code.length>=8)return code}
  }catch(e){}
  return null;
}
async function scanFrame(){
  if(!scannerStream||!$('scannerDialog').open)return;
  try{
    const video=$('scannerVideo');let code=await getNativeBarcode(video);if(!code)code=decodeVideoFrame(video);if(code){handleScanDetected(code);return}
  }catch(e){console.debug('scan frame',e)}
  scannerTimer=setTimeout(scanFrame,190);
}
async function startScanner(){
  stopScanner();scanLastCode='';$('scanResult').classList.add('hidden');$('scannerStatus').textContent='Place le code-barres horizontalement dans le cadre.';
  if(!navigator.mediaDevices?.getUserMedia){$('scannerStatus').textContent='La caméra web n’est pas disponible. Entre le code manuellement ci-dessous.';return}
  try{
    scannerStream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'},width:{ideal:1280},height:{ideal:720}},audio:false});
    const video=$('scannerVideo');video.srcObject=scannerStream;await video.play();$('scannerStatus').textContent='Caméra active — garde le code immobile et bien éclairé.';scannerTimer=setTimeout(scanFrame,250);
  }catch(e){console.error(e);$('scannerStatus').textContent='Accès caméra refusé ou indisponible. Autorise la caméra dans Safari ou entre le code manuellement.'}
}
function stopScanner(){if(scannerTimer){clearTimeout(scannerTimer);scannerTimer=null}if(scannerStream){scannerStream.getTracks().forEach(t=>t.stop());scannerStream=null}const video=$('scannerVideo');if(video)video.srcObject=null}
function handleScanDetected(code){scanLastCode=normalizeBarcode(code);if(!scanLastCode)return;stopScanner();$('scanCodeText').textContent=scanLastCode;$('scanResult').classList.remove('hidden');$('scannerStatus').textContent='Code détecté ✓';if(navigator.vibrate)navigator.vibrate(80)}
function openScanner(target='standalone'){
  scannerTarget=target;scanLastCode='';$('manualBarcode').value='';$('scanResult').classList.add('hidden');
  if(!$('scannerDialog').open)$('scannerDialog').showModal();startScanner();
}
function closeScanner(){stopScanner();if($('scannerDialog').open)$('scannerDialog').close()}
function useManualCode(){const code=normalizeBarcode($('manualBarcode').value);if(code.length<8)return showToast('Entre au moins 8 chiffres');handleScanDetected(code)}
function useScannedCode(){
  const code=scanLastCode||normalizeBarcode($('manualBarcode').value);if(!code)return;
  closeScanner();
  if(scannerTarget==='form'){$('barcode').value=code;if(!$('supplier').value)$('supplier').value='Amazon Business';showToast('Code ajouté à la fiche');return}
  const existing=products.find(p=>normalizeBarcode(p.barcode)===code);if(existing){openProduct(existing);showToast('Produit trouvé dans ton inventaire');return}
  openProduct();$('barcode').value=code;$('supplier').value='Amazon Business';$('productName').placeholder='Nom du produit trouvé sur Amazon';showToast('Nouveau code ajouté');
}
function searchScannedOnAmazon(){const code=scanLastCode||normalizeBarcode($('manualBarcode').value);if(!code)return showToast('Aucun code détecté');openExternal(amazonSearchUrl(code))}

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
  const date=new Date(),orderList=products.filter(p=>toOrder(p)>0).sort(prioritySort),reserveValue=products.reduce((s,p)=>s+Number(p.reserveStock||0)*Number(p.unitCost||0),0),totalValue=products.reduce((s,p)=>s+totalAvailable(p)*Number(p.unitCost||0),0),budget=orderList.reduce((s,p)=>s+toOrder(p)*Number(p.unitCost||0),0);
  const lines=[];lines.push('INVENTAIRE PRO - RAPPORT',`Genere le ${date.toLocaleString('fr-CA')}`,'='.repeat(82),'RESUME',`Produits: ${products.length}`,`Valeur reserve: ${fmtMoney(reserveValue)}   Valeur totale reserve + en main: ${fmtMoney(totalValue)}`,`Articles a commander: ${orderList.length}   Budget estime: ${fmtMoney(budget)}`,'');
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
async function exportBackup(){const data={app:'Inventaire Pro',version:2,exportedAt:nowIso(),products,movements};downloadBlob(`inventaire-backup-${new Date().toISOString().slice(0,10)}.json`,JSON.stringify(data,null,2),'application/json');showToast('Sauvegarde exportée')}
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
  ['reserveStock','inHandStock','minReserve','targetReserve'].forEach(id=>$(id).addEventListener('input',updateFormulaPreview));
  document.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>$(b.dataset.close).close());
  $('searchInput').addEventListener('input',renderInventory);$('categoryFilter').addEventListener('change',renderInventory);$('statsPeriod').addEventListener('change',renderStats);
  $('exportBtn').onclick=exportBackup;$('exportCsvBtn').onclick=exportCsv;$('seedBtn').onclick=seedExamples;$('clearBtn').onclick=clearEverything;
  $('importInput').addEventListener('change',e=>{if(e.target.files[0])importBackup(e.target.files[0]);e.target.value=''});
  $('productPhotoInput').addEventListener('change',e=>{if(e.target.files[0])handlePhoto(e.target.files[0]);e.target.value=''});$('removePhotoBtn').onclick=()=>{tempPhotoData='';updatePhotoPreview()};
  $('barcode').addEventListener('input',e=>e.target.value=normalizeBarcode(e.target.value));$('scanFromFormBtn').onclick=()=>openScanner('form');$('amazonSearchFormBtn').onclick=amazonSearchFromForm;
  $('scannerCloseBtn').onclick=closeScanner;$('scannerDialog').addEventListener('close',stopScanner);$('manualCodeBtn').onclick=useManualCode;$('scanUseBtn').onclick=useScannedCode;$('scanAmazonBtn').onclick=searchScannedOnAmazon;
  $('manualBarcode').addEventListener('input',e=>e.target.value=normalizeBarcode(e.target.value));$('manualBarcode').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();useManualCode()}});
  document.addEventListener('visibilitychange',()=>{if(document.hidden)stopScanner()});
}

(async function init(){
  try{db=await openDB();setupEvents();await loadData();if('serviceWorker'in navigator)navigator.serviceWorker.register('sw.js').catch(()=>{});}catch(e){console.error(e);alert('Impossible d’ouvrir la base de données locale sur cet appareil.')}
})();
