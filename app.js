const DB_NAME = 'InventaireProDB';
const DB_VERSION = 1;
const PRODUCTS = 'products';
const MOVEMENTS = 'movements';
let db;
let products = [];
let movements = [];
let toastTimer;

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

async function loadData(){
  products=(await getAll(PRODUCTS)).sort((a,b)=>a.name.localeCompare(b.name,'fr'));
  movements=(await getAll(MOVEMENTS)).sort((a,b)=>new Date(b.date)-new Date(a.date));
  renderAll();
}
function renderAll(){renderDashboard();renderInventory();renderOrders();renderHistory();renderCategories();$('lastSavedText').textContent=`Sauvegardé localement • ${new Date().toLocaleTimeString('fr-CA',{hour:'2-digit',minute:'2-digit'})}`}
function renderDashboard(){
  $('kpiProducts').textContent=products.length;
  $('kpiOrder').textContent=products.filter(p=>['order','out'].includes(statusOf(p).key)).length;
  $('kpiOut').textContent=products.filter(p=>statusOf(p).key==='out').length;
  $('kpiValue').textContent=fmtMoney(products.reduce((s,p)=>s+Number(p.reserveStock||0)*Number(p.unitCost||0),0));
  const priorities=products.filter(p=>statusOf(p).key!=='ok').sort(prioritySort).slice(0,5);
  $('priorityList').innerHTML=priorities.length?priorities.map(priorityCard).join(''):'<div class="empty">Aucune priorité pour le moment.</div>';
  bindCardActions($('priorityList'));
}
function prioritySort(a,b){const r={out:0,order:1,watch:2,ok:3};return r[statusOf(a).key]-r[statusOf(b).key] || a.name.localeCompare(b.name,'fr')}
function priorityCard(p){const s=statusOf(p),q=toOrder(p);return `<article class="priority-card"><div class="product-top"><div><div class="product-name">${escapeHtml(p.name)}</div><div class="product-meta">Réserve ${fmtQty(p.reserveStock)} • En main ${fmtQty(p.inHandStock)} • Minimum ${fmtQty(p.minReserve)}</div></div><span class="status ${s.key}">${s.label}</span></div>${q>0?`<div class="order-line"><span>Quantité recommandée</span><strong>+ ${fmtQty(q)} ${escapeHtml(p.unit)}</strong></div>`:''}<div class="product-actions"><button class="action-btn primary-action" data-move="${p.id}">Mouvement</button><button class="action-btn" data-edit="${p.id}">Détails</button></div></article>`}
function renderInventory(){
  const query=$('searchInput').value.trim().toLowerCase(); const cat=$('categoryFilter').value;
  const list=products.filter(p=>(!query||[p.name,p.category,p.supplier,p.location].join(' ').toLowerCase().includes(query))&&(!cat||p.category===cat));
  $('inventoryList').innerHTML=list.length?list.map(productCard).join(''):'<div class="empty">Aucun produit trouvé.</div>';
  bindCardActions($('inventoryList'));
}
function productCard(p){const s=statusOf(p),q=toOrder(p);return `<article class="product-card"><div class="product-top"><div><div class="product-name">${escapeHtml(p.name)}</div><div class="product-meta">${escapeHtml(p.category||'Sans catégorie')} • ${escapeHtml(p.supplier||'Fournisseur non défini')}</div></div><span class="status ${s.key}">${s.label}</span></div><div class="stock-grid"><div class="stock-cell"><span>En inventaire</span><strong>${fmtQty(p.reserveStock)}</strong></div><div class="stock-cell"><span>En main</span><strong>${fmtQty(p.inHandStock)}</strong></div><div class="stock-cell"><span>Minimum réserve</span><strong>${fmtQty(p.minReserve)}</strong></div><div class="stock-cell"><span>Total disponible</span><strong>${fmtQty(totalAvailable(p))}</strong></div></div>${q>0?`<div class="order-line"><span>À commander pour atteindre ${fmtQty(targetOf(p))}</span><strong>+ ${fmtQty(q)}</strong></div>`:''}<div class="product-actions"><button class="action-btn primary-action" data-move="${p.id}">Mouvement</button><button class="action-btn" data-edit="${p.id}">Modifier</button></div></article>`}
function renderOrders(){const list=products.filter(p=>toOrder(p)>0).sort(prioritySort);$('orderItemsCount').textContent=list.length;$('orderUnitsCount').textContent=fmtQty(list.reduce((s,p)=>s+toOrder(p),0));$('orderBudget').textContent=fmtMoney(list.reduce((s,p)=>s+toOrder(p)*Number(p.unitCost||0),0));$('ordersList').innerHTML=list.length?list.map(orderCard).join(''):'<div class="empty">Rien à commander. Tous les minimums sont respectés.</div>';bindCardActions($('ordersList'))}
function orderCard(p){const s=statusOf(p),q=toOrder(p);return `<article class="order-card"><div class="product-top"><div><div class="product-name">${escapeHtml(p.name)}</div><div class="product-meta">${escapeHtml(p.supplier||'Fournisseur non défini')} • réserve ${fmtQty(p.reserveStock)} / min. ${fmtQty(p.minReserve)}</div></div><span class="status ${s.key}">${s.label}</span></div><div class="order-line"><span>Commander</span><strong>${fmtQty(q)} ${escapeHtml(p.unit)}</strong></div><div class="product-meta" style="margin-top:8px">Coût estimé : ${fmtMoney(q*Number(p.unitCost||0))}${p.productUrl?` • <a href="${escapeHtml(p.productUrl)}" target="_blank" rel="noopener">ouvrir le produit</a>`:''}</div><div class="product-actions"><button class="action-btn primary-action" data-move="${p.id}">Réception / mouvement</button><button class="action-btn" data-edit="${p.id}">Modifier</button></div></article>`}
function renderHistory(){
  $('historyList').innerHTML=movements.length?movements.slice(0,250).map(m=>{const p=products.find(x=>x.id===m.productId);return `<article class="history-item"><div><div class="name">${escapeHtml(m.productName||p?.name||'Produit')}</div><div class="detail">${escapeHtml(m.label)}${m.note?' • '+escapeHtml(m.note):''}</div></div><div class="qty">${m.sign||''}${fmtQty(m.qty)}</div><div class="time">${new Date(m.date).toLocaleString('fr-CA',{dateStyle:'medium',timeStyle:'short'})}</div></article>`}).join(''):'<div class="empty">Aucun mouvement enregistré.</div>';
}
function renderCategories(){const select=$('categoryFilter'),current=select.value;const cats=[...new Set(products.map(p=>p.category).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'fr'));select.innerHTML='<option value="">Toutes catégories</option>'+cats.map(c=>`<option ${c===current?'selected':''}>${escapeHtml(c)}</option>`).join('')}
function bindCardActions(root){root.querySelectorAll('[data-edit]').forEach(b=>b.onclick=()=>openProduct(products.find(p=>p.id===b.dataset.edit)));root.querySelectorAll('[data-move]').forEach(b=>b.onclick=()=>openMovement(products.find(p=>p.id===b.dataset.move)))}

function openProduct(p=null){
  $('productForm').reset(); $('productId').value=p?.id||''; $('productDialogTitle').textContent=p?'Modifier le produit':'Ajouter un produit';
  $('productName').value=p?.name||'';$('productCategory').value=p?.category||'';$('productUnit').value=p?.unit||'unité';$('reserveStock').value=p?.reserveStock??0;$('inHandStock').value=p?.inHandStock??0;$('minReserve').value=p?.minReserve??0;$('targetReserve').value=p?.targetReserve??0;$('unitCost').value=p?.unitCost??0;$('supplier').value=p?.supplier||'';$('location').value=p?.location||'';$('productUrl').value=p?.productUrl||'';$('notes').value=p?.notes||'';
  $('deleteProductBtn').classList.toggle('hidden',!p); updateFormulaPreview(); $('productDialog').showModal();
}
function updateFormulaPreview(){const reserve=Number($('reserveStock').value||0),hand=Number($('inHandStock').value||0),min=Number($('minReserve').value||0),target=Math.max(min,Number($('targetReserve').value||0));const missing=reserve<min?Math.max(0,target-reserve):0;$('formulaPreview').innerHTML=`<b>Calcul :</b> ${fmtQty(reserve)} en réserve + ${fmtQty(hand)} en main = ${fmtQty(reserve+hand)} disponibles.<br>Minimum réserve : ${fmtQty(min)}. ${missing>0?`À commander : <b>${fmtQty(missing)}</b> pour remonter la réserve à ${fmtQty(target)}.`:'Aucune commande requise.'}`}
function openMovement(p){$('movementForm').reset();$('movementProductId').value=p.id;$('movementProductName').textContent=p.name;$('movementQty').value=1;$('movementDialog').showModal()}

async function saveProduct(e){e.preventDefault();const id=$('productId').value||uid();const old=products.find(p=>p.id===id);let min=Number($('minReserve').value||0);let target=Number($('targetReserve').value||0);if(target<min)target=min;const p={id,name:$('productName').value.trim(),category:$('productCategory').value.trim(),unit:$('productUnit').value,reserveStock:Number($('reserveStock').value||0),inHandStock:Number($('inHandStock').value||0),minReserve:min,targetReserve:target,unitCost:Number($('unitCost').value||0),supplier:$('supplier').value.trim(),location:$('location').value.trim(),productUrl:$('productUrl').value.trim(),notes:$('notes').value.trim(),createdAt:old?.createdAt||nowIso(),updatedAt:nowIso()};await put(PRODUCTS,p);if(!old){await recordMovement(p,'Création du produit',0,'', '')} $('productDialog').close();showToast('Produit enregistré');await loadData()}
async function deleteCurrentProduct(){const id=$('productId').value;if(!id)return;const p=products.find(x=>x.id===id);if(!confirm(`Supprimer « ${p?.name||'ce produit'} » ?`))return;await del(PRODUCTS,id);$('productDialog').close();showToast('Produit supprimé');await loadData()}
const movementLabels={receive:'Réception en réserve',open:'Réserve → en main',consume:'Consommation depuis en main',return:'En main → réserve',reservePlus:'Ajustement réserve +',reserveMinus:'Ajustement réserve −',handPlus:'Ajustement en main +',handMinus:'Ajustement en main −'};
async function applyMovement(e){e.preventDefault();const p=products.find(x=>x.id===$('movementProductId').value);if(!p)return;const type=$('movementType').value,q=Number($('movementQty').value||0),note=$('movementNote').value.trim();if(q<=0)return;let reserve=Number(p.reserveStock||0),hand=Number(p.inHandStock||0),sign='';
  if(type==='receive'||type==='reservePlus'){reserve+=q;sign='+'}
  if(type==='reserveMinus'){if(q>reserve)return showToast('Quantité supérieure à la réserve');reserve-=q;sign='−'}
  if(type==='open'){if(q>reserve)return showToast('Pas assez en réserve');reserve-=q;hand+=q;sign='↔'}
  if(type==='consume'){if(q>hand)return showToast('Pas assez de produit “en main”');hand-=q;sign='−'}
  if(type==='return'){if(q>hand)return showToast('Pas assez de produit “en main”');hand-=q;reserve+=q;sign='↔'}
  if(type==='handPlus'){hand+=q;sign='+'}
  if(type==='handMinus'){if(q>hand)return showToast('Quantité supérieure au stock en main');hand-=q;sign='−'}
  p.reserveStock=reserve;p.inHandStock=hand;p.updatedAt=nowIso();await put(PRODUCTS,p);await recordMovement(p,movementLabels[type],q,note,sign);$('movementDialog').close();showToast('Stock mis à jour');await loadData();
}
async function recordMovement(p,label,qty,note,sign){await put(MOVEMENTS,{id:uid(),productId:p.id,productName:p.name,label,qty:Number(qty||0),note:note||'',sign:sign||'',date:nowIso()})}

function navigate(view){document.querySelectorAll('.view').forEach(v=>v.classList.toggle('active',v.id===`${view}View`));document.querySelectorAll('.nav-btn').forEach(b=>b.classList.toggle('active',b.dataset.view===view));window.scrollTo({top:0,behavior:'smooth'})}
function showToast(msg){const t=$('toast');t.textContent=msg;t.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>t.classList.remove('show'),2200)}
function downloadBlob(name,content,type){const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([content],{type}));a.download=name;document.body.appendChild(a);a.click();setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove()},500)}
async function exportBackup(){const data={app:'Inventaire Pro',version:1,exportedAt:nowIso(),products,movements};downloadBlob(`inventaire-backup-${new Date().toISOString().slice(0,10)}.json`,JSON.stringify(data,null,2),'application/json');showToast('Sauvegarde exportée')}
async function importBackup(file){try{const data=JSON.parse(await file.text());if(!Array.isArray(data.products)||!Array.isArray(data.movements))throw new Error();if(!confirm(`Importer ${data.products.length} produits ? Les données actuelles seront remplacées.`))return;await clearStore(PRODUCTS);await clearStore(MOVEMENTS);for(const p of data.products)await put(PRODUCTS,p);for(const m of data.movements)await put(MOVEMENTS,m);await loadData();showToast('Sauvegarde importée')}catch{showToast('Fichier de sauvegarde invalide')}}
function exportCsv(){const header=['Produit','Catégorie','Unité','Réserve','En main','Minimum réserve','Stock cible','À commander','Coût unitaire','Fournisseur','Emplacement','Notes'];const rows=products.map(p=>[p.name,p.category,p.unit,p.reserveStock,p.inHandStock,p.minReserve,targetOf(p),toOrder(p),p.unitCost,p.supplier,p.location,p.notes]);const csv=[header,...rows].map(r=>r.map(v=>`"${String(v??'').replace(/"/g,'""')}"`).join(',')).join('\n');downloadBlob(`inventaire-${new Date().toISOString().slice(0,10)}.csv`,`\ufeff${csv}`,'text/csv;charset=utf-8');showToast('CSV exporté')}
async function seedExamples(){if(products.length&&!confirm('Ajouter les exemples à ton inventaire actuel ?'))return;const samples=[
{name:'Nettoyant intérieur / APC',category:'Intérieur',unit:'bouteille',reserveStock:4,inHandStock:1,minReserve:6,targetReserve:6,unitCost:22.99,supplier:'Amazon Business',location:'Étagère produits',notes:'Exemple : 4 en réserve, minimum 6, 1 en main : commander 2.'},
{name:'Shampoing automobile',category:'Lavage extérieur',unit:'bouteille',reserveStock:7,inHandStock:1,minReserve:4,targetReserve:8,unitCost:24.99,supplier:'Amazon Business',location:'Étagère produits',notes:''},
{name:'Gants nitrile',category:'Consommables',unit:'boîte',reserveStock:1,inHandStock:1,minReserve:2,targetReserve:5,unitCost:18.99,supplier:'Amazon Business',location:'Bac consommables',notes:''},
{name:'Shampoing tissus / tapis',category:'Tissus & tapis',unit:'bouteille',reserveStock:0,inHandStock:0,minReserve:2,targetReserve:5,unitCost:29.99,supplier:'Distributeur detailing',location:'Étagère produits',notes:''}
];for(const s of samples){const p={...s,id:uid(),productUrl:'',createdAt:nowIso(),updatedAt:nowIso()};await put(PRODUCTS,p);await recordMovement(p,'Création exemple',0,'','')}await loadData();showToast('Exemples ajoutés')}
async function clearEverything(){if(!confirm('Effacer TOUS les produits et l’historique sur cet appareil ?'))return;await clearStore(PRODUCTS);await clearStore(MOVEMENTS);await loadData();showToast('Données effacées')}

function setupEvents(){
  document.querySelectorAll('.nav-btn').forEach(b=>b.addEventListener('click',()=>navigate(b.dataset.view)));
  document.querySelectorAll('[data-nav]').forEach(b=>b.addEventListener('click',()=>navigate(b.dataset.nav)));
  $('quickAddBtn').onclick=()=>openProduct();$('addProductBtn').onclick=()=>openProduct();
  $('productForm').addEventListener('submit',saveProduct);$('movementForm').addEventListener('submit',applyMovement);$('deleteProductBtn').onclick=deleteCurrentProduct;
  ['reserveStock','inHandStock','minReserve','targetReserve'].forEach(id=>$(id).addEventListener('input',updateFormulaPreview));
  document.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>$(b.dataset.close).close());
  $('searchInput').addEventListener('input',renderInventory);$('categoryFilter').addEventListener('change',renderInventory);
  $('exportBtn').onclick=exportBackup;$('exportCsvBtn').onclick=exportCsv;$('seedBtn').onclick=seedExamples;$('clearBtn').onclick=clearEverything;
  $('importInput').addEventListener('change',e=>{if(e.target.files[0])importBackup(e.target.files[0]);e.target.value=''})
}

(async function init(){
  try{db=await openDB();setupEvents();await loadData();if('serviceWorker'in navigator)navigator.serviceWorker.register('sw.js').catch(()=>{});}catch(e){console.error(e);alert('Impossible d’ouvrir la base de données locale sur cet appareil.')}
})();
