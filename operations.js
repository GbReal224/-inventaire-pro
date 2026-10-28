/* User workflows for physical counts, locations, lots and service consumption. */
let countSession=null,stockProductId='',stockRevision=0,serviceDraft=[],serviceRevision=0;
let catalogWorkbook=null,catalogRows=[],catalogDraft=[],catalogRevision=0,catalogGeneration=0;
let receiptMovementId='',activityLimit=30;
const reasonLabels={spilled:'Renversé',damaged:'Endommagé',expired:'Périmé',other:'Autre perte'};
Object.assign(movementLabels,{loss:'Perte de produit',supplierReturn:'Retour au fournisseur',transfer:'Transfert entre emplacements',dilution:'Préparation d’une dilution',count:'Comptage physique',lot:'Identification de lot'});
const localDay=()=>{const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`};
const bucketLabel=bucket=>bucket==='reserve'?'Réserve':'En main';
function positionLabel(p,s){const lot=p.lots.find(l=>l.id===s.lotId);return `${s.location} · ${bucketLabel(s.bucket)}${lot?' · lot '+lot.code:''} · ${fmtQty(s.qty)} ${p.unit}`}
function positionOptions(p,{bucket='',automatic=false}={}){return (automatic?'<option value="">Automatique : lots à échéance la plus proche</option>':'')+p.positions.filter(s=>(!bucket||s.bucket===bucket)&&s.qty>0).map(s=>`<option value="${s.id}">${escapeHtml(positionLabel(p,s))}</option>`).join('')}
function restoreStock(p,snapshot){const next={...p,...snapshot,updatedAt:nowIso(),revision:(p.revision||0)+1};if(!snapshot.positions){delete next.positions;delete next.lots}return Core.product(next)}
function updateDuplicateHint(){
  const id=$('productId').value,code=Core.barcodeKey($('barcode').value),name=Core.cleanName($('productName').value);
  const matches=products.filter(p=>p.id!==id&&((code&&Core.barcodeKey(p.barcode)===code)||(!code&&name&&Core.cleanName(p.name)===name)));
  $('duplicateHint').classList.toggle('hidden',!matches.length);
  $('duplicateHint').innerHTML=matches.map(p=>`<span>${p.archived?'Fiche archivée existante':'Produit déjà présent'} : ${escapeHtml(p.name)}.</span><button type="button" class="text-btn" data-existing="${p.id}">Ouvrir la fiche</button>`).join('');
  $('duplicateHint').querySelectorAll('[data-existing]').forEach(b=>b.onclick=()=>openProduct(products.find(p=>p.id===b.dataset.existing)));
}
function openMovementDetails(p,type){
  $('movementBucket').value=['open','reserveMinus'].includes(type)?'reserve':'hand';
  $('movementDestination').value=['receive','return','reservePlus'].includes(type)?p.location||'Réserve':'En main';
  $('receiptFiles').value='';updateMovementDetails(true);
}
function updateMovementDetails(reset=false){
  const p=products.find(p=>p.id===$('movementProductId').value);if(!p)return;
  const type=$('movementType').value,extra=['loss','supplierReturn'].includes(type),source=['open','consume','return','reserveMinus','handMinus','loss','supplierReturn'].includes(type);
  const bucket=extra?$('movementBucket').value:['open','reserveMinus'].includes(type)?'reserve':'hand';
  $('movementBucketLabel').hidden=!extra;$('movementSourceFields').hidden=!source;$('lossFields').classList.toggle('hidden',type!=='loss');$('refundLabel').classList.toggle('hidden',type!=='supplierReturn');
  $('movementDestinationLabel').hidden=!['receive','open','return','reservePlus','handPlus'].includes(type);
  const select=$('movementPosition'),current=reset?'':select.value;select.innerHTML=positionOptions(p,{bucket,automatic:true});if([...select.options].some(o=>o.value===current))select.value=current;
  if(type==='receive')$('movementPurchasePreview').textContent=`Coût total : ${fmtMoney(Number($('movementQty').value)*Number($('movementUnitCost').value)+Number($('receiptShipping').value)-Number($('receiptDiscount').value))}`;
  // Hidden controls never prevent the submission of an unrelated movement.
  $('movementPurchaseFields').querySelectorAll('input,select').forEach(el=>el.disabled=type!=='receive');
  $('lossReason').disabled=type!=='loss';$('refundAmount').disabled=type!=='supplierReturn';
}
function movementDetails(p,type){
  const extra=['loss','supplierReturn'].includes(type),details={positionId:$('movementPosition').value,toLocation:$('movementDestination').value.trim(),fromBucket:extra?$('movementBucket').value:undefined};
  if(type==='loss')details.reason=$('lossReason').value;if(type==='supplierReturn')details.refund=Number($('refundAmount').value);
  if(type==='receive'){
    details.shipping=Number($('receiptShipping').value);details.discount=Number($('receiptDiscount').value);
    const code=$('receiveLotCode').value.trim(),expiryDate=$('receiveLotExpiry').value;
    if(!code&&expiryDate)throw new Error('Indique le numéro du lot associé à cette péremption.');
    if(code){const existing=p.lots.find(l=>l.code===code&&l.expiryDate===expiryDate);details.lot=existing||{id:uid(),code,expiryDate,openedDate:''}}
  }
  return details;
}
async function receiptFiles(files){
  const list=Array.from(files);if(list.length>3)throw new Error('Maximum trois justificatifs par achat.');
  const output=[];for(const file of list){if(file.size>4*1024*1024)throw new Error('Un justificatif dépasse 4 Mo.');if(!['image/jpeg','image/png','image/webp','application/pdf'].includes(file.type))throw new Error('Utilise une photo JPEG/PNG/WebP ou un PDF.');output.push(Core.attachment({name:file.name.slice(0,160),type:file.type,data:await fileToDataUrl(file)}))}return output;
}
function decorateHistory(){
  document.querySelectorAll('[data-movement]').forEach(card=>{
    const m=movements.find(m=>m.id===card.dataset.movement);if(!m)return;
    const details=[m.reason?reasonLabels[m.reason]:'',m.reference?'Réf. '+m.reference:'',m.serviceName?'Prestation : '+m.serviceName:'',m.type==='supplierReturn'?'Remboursement : '+fmtMoney(m.refund||0):''].filter(Boolean);
    if(details.length){const p=document.createElement('p');p.className='helper';p.textContent=details.join(' · ');card.append(p)}
    if(m.type==='receive'){const b=document.createElement('button');b.className='text-btn';b.textContent=`Facture / reçus (${m.attachments?.length||0})`;b.onclick=()=>openReceipt(m.id);card.append(b)}
  });
}
function openReceipt(id){
  const m=movements.find(m=>m.id===id);if(!m)return;receiptMovementId=id;
  $('receiptSummary').textContent=`${m.productName} · ${fmtMoney(m.purchaseTotalCost)}${m.reference?' · '+m.reference:''} · Livraison ${fmtMoney(m.shipping||0)} · Rabais ${fmtMoney(m.discount||0)}`;
  $('receiptList').innerHTML=(m.attachments||[]).map((a,i)=>`<button type="button" class="settings-row" data-receipt-file="${i}"><span>${escapeHtml(a.name)}</span><b>Ouvrir</b></button>`).join('')||'<p class="helper">Aucun justificatif ajouté.</p>';
  $('receiptList').querySelectorAll('[data-receipt-file]').forEach(b=>b.onclick=()=>{const a=m.attachments[Number(b.dataset.receiptFile)],raw=atob(a.data.split(',')[1]),bytes=Uint8Array.from(raw,c=>c.charCodeAt(0));downloadBytes(a.name,bytes,a.type)});
  $('extraReceiptFiles').value='';if(!$('receiptDialog').open)$('receiptDialog').showModal();
}
async function saveReceipt(e){e.preventDefault();await mutate(async()=>{const m=movements.find(m=>m.id===receiptMovementId);if(!m)throw new Error('Achat introuvable.');const added=await receiptFiles($('extraReceiptFiles').files);if(!added.length)throw new Error('Choisis un fichier.');const next=Core.movement({...m,attachments:[...(m.attachments||[]),...added]});await commitData({movements:[next]});$('receiptDialog').close();showToast('Justificatifs ajoutés à l’achat.')})}
function renderOperations(){
  if(!$('operationsSummary'))return;
  const live=movements.filter(m=>!m.reversedBy&&m.type!=='undo'),loss=live.filter(m=>m.type==='loss').reduce((n,m)=>n+(m.lossCost||0),0),refund=live.filter(m=>m.type==='supplierReturn').reduce((n,m)=>n+(m.refund||0),0);
  const services=activities.filter(a=>a.kind==='service'&&!operationReversed(a)),serviceCost=services.reduce((n,a)=>n+a.totalCost,0);
  $('operationsSummary').innerHTML=[['Pertes',fmtMoney(loss)],['Remboursements',fmtMoney(refund)],['Prestations',String(services.length)],['Produits utilisés en prestations',fmtMoney(serviceCost)]].map(([label,value])=>`<div><span>${label}</span><strong>${value}</strong></div>`).join('');
  const alerts=[];
  for(const p of activeProducts()){
    const f=Core.forecast(p,movements,orders);
    if(f?.atRisk)alerts.push(`<p><b>${escapeHtml(p.name)}</b> : ≈ ${Math.floor(f.coverage)} j de stock ; délai ${fmtQty(p.leadDays)} j + marge ${fmtQty(p.safetyDays)} j.${f.expected?' Livraison prévue prise en compte.':''} <button class="text-btn" data-edit="${p.id}">Voir le produit</button></p>`);
    for(const l of p.lots){const quantity=p.positions.filter(s=>s.lotId===l.id).reduce((n,s)=>n+s.qty,0);if(quantity>0&&l.expiryDate){const delta=Date.parse(l.expiryDate+'T23:59:59')-Date.now(),remaining=delta<0?-Math.max(1,Math.ceil(-delta/86400000)):Math.ceil(delta/86400000);if(remaining<=30)alerts.push(`<p><b>${escapeHtml(p.name)}</b> · lot ${escapeHtml(l.code)} : ${remaining<0?'périmé depuis '+Math.abs(remaining)+' j':'échéance dans '+remaining+' j'} (${fmtQty(quantity)} ${escapeHtml(p.unit)}). <button class="text-btn" data-stock="${p.id}">Voir le lot</button></p>`)}}
  }
  $('forecastAlerts').innerHTML=alerts.length?'<h3>À anticiper</h3>'+alerts.join(''):'';bindCardActions($('forecastAlerts'));bindStockButtons($('forecastAlerts'));
  $('knownLocations').innerHTML=[...new Set(products.flatMap(p=>p.positions.map(s=>s.location)))].sort().map(x=>`<option value="${escapeHtml(x)}"></option>`).join('');
  renderPositions();renderActivities();
  document.querySelectorAll('#inventoryList .product-card').forEach(card=>{const id=card.querySelector('[data-edit]')?.dataset.edit,p=products.find(p=>p.id===id);if(p&&!p.archived&&!card.querySelector('[data-stock]')){const b=document.createElement('button');b.className='text-btn';b.textContent='Emplacements et lots';b.dataset.stock=id;b.onclick=()=>openStock(id);card.append(b)}});
}
function bindStockButtons(root){root.querySelectorAll('[data-stock]').forEach(b=>b.onclick=()=>openStock(b.dataset.stock))}
function renderPositions(){
  const query=$('positionsSearch').value.trim().toLowerCase();
  const list=activeProducts().filter(p=>!query||[p.name,p.barcode,...p.positions.map(s=>s.location),...p.lots.map(l=>l.code)].join(' ').toLowerCase().includes(query));
  $('positionsList').innerHTML=list.map(p=>`<article class="operation-card"><b>${escapeHtml(p.name)}</b><div class="position-list">${p.positions.filter(s=>s.qty>0).map(s=>`<p>${escapeHtml(positionLabel(p,s))}</p>`).join('')||'<p>Aucun stock.</p>'}</div><button class="text-btn" data-stock="${p.id}">Gérer les emplacements et lots</button></article>`).join('')||'<div class="empty">Aucun produit.</div>';bindStockButtons($('positionsList'));
}
function operationReversed(a){return a.lines.some(l=>l.movementId&&movements.find(m=>m.id===l.movementId)?.reversedBy)}
function renderActivities(){
  const type=$('activityFilter').value,list=activities.filter(a=>a.kind!=='template'&&(!type||a.kind===type));
  $('activitiesList').innerHTML=list.slice(0,activityLimit).map(a=>{const reversed=operationReversed(a),logs=a.lines.map(l=>movements.find(m=>m.id===l.movementId)).filter(Boolean);return `<article class="operation-card${reversed?' reversed':''}"><b>${escapeHtml(a.name)}${reversed?' · ANNULÉ':''}</b><p class="helper">${a.kind==='service'?'Prestation':'Comptage'} · ${new Date(a.date).toLocaleString('fr-CA')}${a.reference?' · '+escapeHtml(a.reference):''}${a.kind==='service'?' · '+fmtMoney(a.totalCost):''}</p><details><summary>${a.lines.length} ligne(s)</summary>${a.lines.map(l=>`<p class="helper">${escapeHtml(l.productName||products.find(p=>p.id===l.productId)?.name||'Produit')}${l.location?' · '+escapeHtml(l.location):''} : ${a.kind==='count'?fmtQty(l.expected)+' → '+fmtQty(l.counted):fmtQty(l.qty)+' '+escapeHtml(l.unit||'')+' · '+fmtMoney(l.cost)}</p>`).join('')}</details>${!reversed&&logs.length&&logs.every(canUndoSingle)?`<button class="text-btn" data-undo-operation="${a.id}">Annuler toute l’opération</button>`:''}</article>`}).join('')||'<div class="empty">Tes comptages et prestations apparaîtront ici.</div>';
  $('activitiesMore').hidden=activityLimit>=list.length;$('activitiesList').querySelectorAll('[data-undo-operation]').forEach(b=>b.onclick=()=>undoOperation(b.dataset.undoOperation));
}
function openCount(){
  if(!activeProducts().length)return showToast('Ajoute d’abord un produit.');
  countSession={revision:dbRevision,products:JSON.parse(JSON.stringify(activeProducts())),values:new Map()};
  $('countForm').reset();$('countName').value='Inventaire du '+new Date().toLocaleDateString('fr-CA');
  $('countLocation').innerHTML='<option value="">Tous les emplacements</option>'+[...new Set(countSession.products.flatMap(p=>p.positions.map(s=>s.location)))].sort().map(x=>`<option>${escapeHtml(x)}</option>`).join('');
  renderCount();$('countDialog').showModal();
}
function renderCount(){
  const query=$('countSearch').value.trim().toLowerCase(),location=$('countLocation').value;
  $('countRows').innerHTML=countSession.products.filter(p=>!query||[p.name,p.barcode].join(' ').toLowerCase().includes(query)).flatMap(p=>p.positions.filter(s=>!location||s.location===location).map(s=>{
    const key=p.id+'/'+s.id,value=countSession.values.get(key)??'';
    return `<label class="count-row"><span><b>${escapeHtml(p.name)}</b><small>${escapeHtml(positionLabel(p,s))}</small></span><input type="number" min="0" step="any" inputmode="decimal" placeholder="Compté" aria-label="Quantité comptée de ${escapeHtml(p.name+' à '+s.location)}" data-count="${key}" value="${value}" /></label>`;
  })).join('');
  $('countRows').querySelectorAll('[data-count]').forEach(input=>input.oninput=()=>{countSession.values.set(input.dataset.count,input.value);renderCountPreview()});renderCountPreview();
}
function renderCountPreview(){let rows=0,differences=0,cost=0;for(const p of countSession.products)for(const s of p.positions){const value=countSession.values.get(p.id+'/'+s.id);if(value!=null&&value!==''){rows++;const delta=Number(value)-s.qty;if(delta!==0)differences++;cost+=delta*p.unitCost}}$('countPreview').textContent=`${rows} emplacement(s) compté(s), ${differences} écart(s). Variation de valeur : ${fmtMoney(cost)}.`}
async function saveCount(e){e.preventDefault();if(!$('countForm').reportValidity())return;await mutate(async()=>{
  if(countSession.revision!==dbRevision)throw new Error('Le stock a changé pendant le comptage. Ferme puis recommence pour comparer les bonnes quantités.');
  const id=uid(),updated=[],logs=[],lines=[];
  for(const p of countSession.products){const counts=p.positions.filter(s=>{const v=countSession.values.get(p.id+'/'+s.id);return v!=null&&v!==''}).map(s=>({positionId:s.id,counted:Number(countSession.values.get(p.id+'/'+s.id))}));if(!counts.length)continue;
    const result=Core.countProduct(p,counts),log=newMovement(p,'Comptage : '+$('countName').value,result.movement.qty,'',result.movement.sign,{...result.movement,groupId:id});
    result.product.revision=(p.revision||0)+1;result.product.updatedAt=nowIso();updated.push(result.product);logs.push(log);
    for(const c of counts){const s=p.positions.find(s=>s.id===c.positionId);lines.push({productId:p.id,productName:p.name,positionId:s.id,location:s.location,expected:s.qty,counted:c.counted,movementId:log.id})}
  }
  if(!lines.length)throw new Error('Saisis au moins une quantité comptée.');
  const operation=Core.activity({id,kind:'count',name:$('countName').value.trim(),date:nowIso(),lines});
  await commitData({products:updated,movements:logs,activities:[operation]});$('countDialog').close();showToast('Comptage enregistré avec tous ses écarts.');
})}
function openStock(id){const p=products.find(p=>p.id===id);if(!p||p.archived)return;stockProductId=id;stockRevision=p.revision||0;$('stockTitle').textContent=p.name;
  $('stockPositions').innerHTML=p.positions.filter(s=>s.qty>0).map(s=>{const l=p.lots.find(l=>l.id===s.lotId);return `<p class="position-row">${escapeHtml(positionLabel(p,s))}${l?`<small>Ouvert : ${escapeHtml(l.openedDate||'non renseigné')} · Péremption : ${escapeHtml(l.expiryDate||'non renseignée')}</small>`:''}</p>`}).join('')||'<p class="helper">Aucun stock disponible.</p>';
  $('transferForm').reset();$('lotForm').reset();$('transferSource').innerHTML=positionOptions(p);$('lotSource').innerHTML=positionOptions(p);
  $('lotEditSelect').innerHTML=p.lots.map(l=>`<option value="${l.id}">${escapeHtml(l.code)}</option>`).join('');$('lotDatesForm').hidden=!p.lots.length;updateLotDates();
  $('transferForm').hidden=!totalAvailable(p);$('lotForm').hidden=!totalAvailable(p);if(!$('stockDialog').open)$('stockDialog').showModal();
}
function stockForEdit(){const p=products.find(p=>p.id===stockProductId);if(!p||(p.revision||0)!==stockRevision)throw new Error('Ce stock a changé. Ferme puis rouvre les emplacements.');return p}
async function saveStockResult(p,result,label){result.product.revision=(p.revision||0)+1;result.product.updatedAt=nowIso();await commitData({products:[result.product],movements:[newMovement(p,label,result.movement.qty,'',result.movement.sign,result.movement)]});$('stockDialog').close();showToast(label+' enregistré.')}
async function saveTransfer(e){e.preventDefault();if(!$('transferForm').reportValidity())return;await mutate(async()=>{const p=stockForEdit(),s=p.positions.find(s=>s.id===$('transferSource').value);if(!s)throw new Error('Choisis le stock de départ.');const result=Core.apply(p,{type:'transfer',quantity:Number($('transferQty').value),positionId:s.id,fromBucket:s.bucket,toBucket:$('transferBucket').value,toLocation:$('transferLocation').value.trim()});await saveStockResult(p,result,'Transfert entre emplacements')})}
async function saveLot(e){e.preventDefault();if(!$('lotForm').reportValidity())return;await mutate(async()=>{const p=stockForEdit(),result=Core.assignLot(p,{positionId:$('lotSource').value,quantity:Number($('lotQty').value),lot:{id:uid(),code:$('lotCode').value.trim(),openedDate:$('lotOpened').value,expiryDate:$('lotExpiry').value}});await saveStockResult(p,result,'Identification du lot '+$('lotCode').value.trim())})}
function updateLotDates(){const p=products.find(p=>p.id===stockProductId),l=p?.lots.find(l=>l.id===$('lotEditSelect').value);$('lotEditOpened').value=l?.openedDate||'';$('lotEditExpiry').value=l?.expiryDate||''}
async function saveLotDates(e){e.preventDefault();await mutate(async()=>{const p=stockForEdit(),next=Core.product({...p,lots:p.lots.map(l=>l.id===$('lotEditSelect').value?{...l,openedDate:$('lotEditOpened').value,expiryDate:$('lotEditExpiry').value}:l)});await saveStockResult(p,{product:next,movement:{type:'lot',qty:0,before:Core.stock(p),after:Core.stock(next),inventoryValueDelta:0,sign:'↔'}},'Mise à jour des dates du lot')})}
function openService(){
  if(!activeProducts().length)return showToast('Ajoute d’abord un produit.');serviceDraft=[];serviceRevision=dbRevision;$('serviceForm').reset();
  $('serviceProduct').innerHTML=activeProducts().map(p=>`<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');
  $('serviceTemplate').innerHTML='<option value="">Sans modèle</option>'+activities.filter(a=>a.kind==='template').map(a=>`<option value="${a.id}">${escapeHtml(a.name)}</option>`).join('');updateServiceProduct();renderService();$('serviceDialog').showModal();
}
function updateServiceProduct(){const p=products.find(p=>p.id===$('serviceProduct').value);if(!p)return;quantityOptions(p,$('serviceUnit'));$('servicePosition').innerHTML=positionOptions(p)}
function serviceLine(){const p=products.find(p=>p.id===$('serviceProduct').value),position=p?.positions.find(s=>s.id===$('servicePosition').value);if(!p||!position)throw new Error('Ce produit n’a pas de stock disponible.');const qty=Core.round(Core.number(Number($('serviceQty').value),'Quantité',{positive:true})*Core.quantityFactor(p,$('serviceUnit').value));return {productId:p.id,positionId:position.id,qty}}
function buildService(){
  const work=new Map(),logs=new Map(),details=[];
  for(const line of serviceDraft){const original=products.find(p=>p.id===line.productId);if(!original)throw new Error('Un produit du modèle est absent.');const p=work.get(line.productId)||original;
    const s=p.positions.find(s=>s.id===line.positionId);if(!s)throw new Error('Choisis à nouveau l’emplacement de '+p.name+'.');
    const result=Core.apply(p,{type:'consume',quantity:line.qty,positionId:s.id,fromBucket:s.bucket});work.set(p.id,result.product);
    const existing=logs.get(p.id);logs.set(p.id,existing?{...existing,qty:Core.round(existing.qty+line.qty),after:result.movement.after,inventoryValueDelta:Core.round(existing.inventoryValueDelta+result.movement.inventoryValueDelta),allocations:[...existing.allocations,...result.movement.allocations]}:result.movement);
    details.push({...line,productName:p.name,unit:p.unit,cost:Core.round(line.qty*p.unitCost),location:s.location});
  }
  return {work,logs,details,total:Core.round(details.reduce((n,l)=>n+l.cost,0))};
}
function renderService(){
  $('serviceLines').innerHTML=serviceDraft.map((l,i)=>{const p=products.find(p=>p.id===l.productId),s=p?.positions.find(s=>s.id===l.positionId);return `<div class="service-row"><span><b>${escapeHtml(p?.name||'Produit absent')}</b><small>${escapeHtml(s?.location||'Emplacement à choisir')} · ${fmtQty(l.qty)} ${escapeHtml(p?.unit||'')}</small></span><input type="number" min="0.001" step="any" inputmode="decimal" aria-label="Quantité de ${escapeHtml(p?.name||'produit')}" data-service-qty="${i}" value="${l.qty}" /><button type="button" class="text-btn" data-remove-service="${i}">Retirer</button></div>`}).join('');
  $('serviceLines').querySelectorAll('[data-remove-service]').forEach(b=>b.onclick=()=>{serviceDraft.splice(Number(b.dataset.removeService),1);renderService()});
  $('serviceLines').querySelectorAll('[data-service-qty]').forEach(input=>input.oninput=()=>{serviceDraft[Number(input.dataset.serviceQty)].qty=Number(input.value);renderServiceCost()});renderServiceCost();
}
function renderServiceCost(){
  try{$('servicePreview').textContent=`${serviceDraft.length} ligne(s) · Coût en produits : ${fmtMoney(buildService().total)}`}catch(e){$('servicePreview').textContent=e.message}
}
function addServiceLine(){try{serviceDraft.push(serviceLine());renderService()}catch(e){showToast(e.message)}}
function useServiceTemplate(){const a=activities.find(a=>a.id===$('serviceTemplate').value);if(!a)return;serviceDraft=a.lines.map(l=>{const p=products.find(p=>p.id===l.productId),s=p?.positions.find(s=>s.id===l.positionId)||p?.positions.find(s=>s.qty>0);return {productId:l.productId,positionId:s?.id||l.positionId,qty:l.qty}});$('serviceName').value=a.name;renderService()}
async function saveTemplate(){await mutate(async()=>{if(!$('serviceName').value.trim()||!serviceDraft.length)throw new Error('Indique un nom et ajoute au moins un produit.');const template=Core.activity({id:uid(),kind:'template',name:$('serviceName').value.trim(),date:nowIso(),lines:serviceDraft});await commitData({activities:[template]});serviceRevision=dbRevision+1;showToast('Modèle enregistré.')})}
async function saveService(e){e.preventDefault();if(!$('serviceForm').reportValidity())return;await mutate(async()=>{
  if(serviceRevision!==dbRevision)throw new Error('L’inventaire a changé. Ferme puis rouvre la prestation pour recalculer le stock et son coût.');if(!serviceDraft.length)throw new Error('Ajoute au moins un produit.');
  const built=buildService(),id=uid(),name=$('serviceName').value.trim(),reference=$('serviceReference').value.trim(),logs=[],updated=[];
  for(const [productId,next] of built.work){const p=products.find(p=>p.id===productId),meta=built.logs.get(productId);next.revision=(p.revision||0)+1;next.updatedAt=nowIso();updated.push(next);logs.push(newMovement(p,'Prestation : '+name,meta.qty,reference,'−',{...meta,groupId:id,serviceName:name,serviceReference:reference}))}
  const operation=Core.activity({id,kind:'service',name,reference,date:nowIso(),totalCost:built.total,lines:built.details.map(l=>({...l,movementId:logs.find(m=>m.productId===l.productId).id}))});
  await commitData({products:updated,movements:logs,activities:[operation]});$('serviceDialog').close();showToast('Prestation enregistrée : '+fmtMoney(built.total)+' en produits.');
})}
async function undoOperation(id){
  const logs=movements.filter(m=>m.groupId===id&&m.type!=='undo');if(!logs.length||!logs.every(canUndoSingle))return showToast('Annule d’abord les mouvements plus récents des produits concernés.');
  if(!confirm('Annuler toute cette opération et restaurer le stock de chaque produit concerné ?'))return;
  await mutate(async()=>{const updated=[],changes=[];for(const m of logs){const p=products.find(p=>p.id===m.productId),next=restoreStock(p,m.before),correction=newMovement(p,'Annulation : '+m.label,m.qty,'Annulation de l’opération complète','↶',{type:'undo',reverses:m.id,before:Core.stock(p),after:Core.stock(next),inventoryValueDelta:-m.inventoryValueDelta});updated.push(next);changes.push({...m,reversedBy:correction.id},correction)}await commitData({products:updated,movements:changes});showToast('Opération annulée pour tous les produits.')});
}
function openDilution(){
  $('dilutionForm').reset();$('dilutionProduct').innerHTML='<option value="">Calcul seulement</option>'+activeProducts().filter(p=>['mL','litre'].includes(p.unit)).map(p=>`<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');updateDilutionProduct();$('dilutionDialog').showModal();
}
function updateDilutionProduct(){const p=products.find(p=>p.id===$('dilutionProduct').value);$('dilutionPosition').innerHTML=p?positionOptions(p):'';updateDilution()}
function updateDilution(){try{const d=Core.dilution(Number($('dilutionVolume').value),Number($('dilutionRatio').value));$('dilutionPreview').textContent=`${fmtQty(d.concentrate)} mL de concentré + ${fmtQty(d.water)} mL d’eau = ${fmtQty(d.volume)} mL.`;$('recordDilution').disabled=!$('dilutionProduct').value||!$('dilutionPosition').value}catch(e){$('dilutionPreview').textContent=e.message;$('recordDilution').disabled=true}}
async function saveDilution(e){e.preventDefault();if(!$('dilutionForm').reportValidity())return;await mutate(async()=>{const d=Core.dilution(Number($('dilutionVolume').value),Number($('dilutionRatio').value)),p=products.find(p=>p.id===$('dilutionProduct').value),s=p?.positions.find(s=>s.id===$('dilutionPosition').value);if(!p||!s)throw new Error('Choisis le concentré et son emplacement.');const result=Core.apply(p,{type:'dilution',quantity:d.concentrate,mode:'mL',positionId:s.id,fromBucket:s.bucket});result.product.revision=(p.revision||0)+1;result.product.updatedAt=nowIso();const log=newMovement(p,'Dilution 1:'+d.ratio,result.movement.qty,fmtQty(d.volume)+' mL préparés','−',{...result.movement,dilution:d});await commitData({products:[result.product],movements:[log]});$('dilutionDialog').close();showToast('Préparation enregistrée et concentré déduit.')})}

/* Catalogue import: preview is entirely local, selected rows commit atomically. */
const catalogFields=[['name','Nom du produit',['produit','nom','name']],['barcode','Code-barres',['code-barres','codebarres','upc','ean','barcode']],['unit','Unité',['unite','unit']],['reserveStock','Réserve',['reserve','stock','quantite']],['inHandStock','En main',['en main']],['unitCost','Coût unitaire',['cout unitaire','cout','prix']],['category','Catégorie',['categorie']],['supplier','Fournisseur',['fournisseur']],['location','Emplacement',['emplacement']],['minReserve','Minimum',['minimum','minimum reserve']],['targetReserve','Stock cible',['cible','stock cible']],['packSize','Contenu du conditionnement',['contenu','packsize']],['packLabel','Conditionnement',['conditionnement']],['productUrl','Lien du produit',['lien','lien produit','url']],['notes','Notes',['notes']],['leadDays','Délai fournisseur',['delai fournisseur']],['safetyDays','Marge de sécurité',['marge de securite']]];
function openCatalog(){catalogWorkbook=null;catalogRows=[];catalogDraft=[];catalogRevision=dbRevision;catalogGeneration++;$('catalogForm').reset();$('catalogMapping').innerHTML='';$('catalogPreview').innerHTML='';$('catalogSheetLabel').classList.add('hidden');$('catalogImportBtn').disabled=true;$('catalogStatus').textContent='Choisis un fichier pour afficher un aperçu.';$('catalogDialog').showModal()}
let sheetLibraryPromise;
function loadSheetLibrary(){if(window.XLSX)return Promise.resolve(window.XLSX);if(!sheetLibraryPromise)sheetLibraryPromise=new Promise((resolve,reject)=>{const script=document.createElement('script');script.src='vendor/xlsx-0.20.3.min.js';script.onload=()=>resolve(window.XLSX);script.onerror=()=>{sheetLibraryPromise=null;script.remove();reject(new Error('Lecteur Excel indisponible. Recharge l’application avec une connexion.'))};document.head.append(script)});return sheetLibraryPromise}
async function readCatalog(file){
  if(!file)return;const generation=++catalogGeneration;catalogDraft=[];$('catalogPreview').innerHTML='';$('catalogImportBtn').disabled=true;
  try{if(file.size>5*1024*1024)throw new Error('Fichier limité à 5 Mo.');$('catalogStatus').textContent='Lecture du fichier…';catalogRevision=dbRevision;
    if(/\.(csv|tsv)$/i.test(file.name)){const rows=Core.parseCsv(await file.text());if(generation!==catalogGeneration)return;catalogWorkbook=null;catalogRows=rows;$('catalogSheetLabel').classList.add('hidden');buildCatalogMapping()}
    else if(/\.xlsx?$/i.test(file.name)){const XLSX=await loadSheetLibrary(),bytes=await file.arrayBuffer();if(generation!==catalogGeneration)return;catalogWorkbook=XLSX.read(bytes,{type:'array',sheetRows:2002,cellFormula:false,cellHTML:false});$('catalogSheet').innerHTML=catalogWorkbook.SheetNames.map((n,i)=>`<option value="${i}">${escapeHtml(n)}</option>`).join('');$('catalogSheetLabel').classList.remove('hidden');selectCatalogSheet()}
    else throw new Error('Choisis un fichier CSV, XLSX ou XLS.');
  }catch(e){if(generation===catalogGeneration){catalogRows=[];catalogDraft=[];$('catalogMapping').innerHTML='';$('catalogImportBtn').disabled=true;$('catalogStatus').textContent='Import refusé : '+e.message}}
}
function selectCatalogSheet(){try{const name=catalogWorkbook.SheetNames[Number($('catalogSheet').value)],sheet=catalogWorkbook.Sheets[name],range=sheet['!fullref']||sheet['!ref'];if(range&&XLSX.utils.decode_range(range).e.r>2000)throw new Error('Maximum 2 000 lignes de produits.');catalogRows=XLSX.utils.sheet_to_json(sheet,{header:1,raw:false,defval:'',blankrows:false});buildCatalogMapping()}catch(e){catalogDraft=[];$('catalogImportBtn').disabled=true;$('catalogStatus').textContent=e.message}}
function buildCatalogMapping(){
  if(catalogRows.length<2||catalogRows.length>2001)throw new Error('Le fichier doit contenir une ligne de titres et de 1 à 2 000 produits.');
  const headers=catalogRows[0];if(headers.length>100)throw new Error('Le fichier contient trop de colonnes.');
  $('catalogMapping').innerHTML=catalogFields.map(([field,label,aliases])=>{const index=headers.findIndex(h=>aliases.includes(Core.cleanName(h)));return `<label>${label}${field==='name'?' *':''}<select data-map="${field}"><option value="">Non renseigné</option>${headers.map((h,i)=>`<option value="${i}" ${i===index?'selected':''}>${escapeHtml(h||'Colonne '+(i+1))}</option>`).join('')}</select></label>`}).join('');
  $('catalogColumns').open=$('catalogMapping').querySelector('[data-map="name"]').value==='';
  $('catalogMapping').querySelectorAll('[data-map]').forEach(select=>select.onchange=previewCatalog);previewCatalog();
}
function previewCatalog(){
  const mapping=Object.fromEntries([...$('catalogMapping').querySelectorAll('[data-map]')].map(s=>[s.dataset.map,s.value]));
  if(mapping.name===''){catalogDraft=[];$('catalogStatus').textContent='Associe une colonne au nom du produit.';$('catalogImportBtn').disabled=true;return}
  const seen=new Set(products.filter(p=>!p.archived&&p.barcode).map(p=>Core.barcodeKey(p.barcode)));
  catalogDraft=catalogRows.slice(1).map((row,i)=>{
    try{
      const p={id:uid(),name:'',unit:'unité',packSize:1,safetyDays:2,createdAt:nowIso(),updatedAt:nowIso(),revision:1};
      for(const [field,label] of catalogFields)if(mapping[field]!==''){const value=row[Number(mapping[field])]??'';if(['reserveStock','inHandStock','unitCost','minReserve','targetReserve','packSize','leadDays','safetyDays'].includes(field)){if(String(value).trim())p[field]=Core.decimal(value,label)}else p[field]=String(value).trim()}
      p.unit=p.unit||'unité';if(p.barcode&&!/^\d{8,18}$/.test(p.barcode))throw new Error('Code-barres : 8 à 18 chiffres attendus, à conserver en texte dans Excel.');
      const validated=Core.product(p),code=Core.barcodeKey(p.barcode),duplicate=!!code&&seen.has(code);if(code)seen.add(code);
      const nameMatch=products.some(x=>!x.archived&&Core.cleanName(x.name)===Core.cleanName(p.name));
      return {line:i+2,product:validated,duplicate,warning:duplicate?'Code-barres déjà présent : ligne exclue.':nameMatch?'Nom déjà présent : vérifie avant de sélectionner.':'Nouveau produit',selected:!duplicate&&!nameMatch};
    }catch(e){return {line:i+2,error:e.message,selected:false}}
  });
  $('catalogPreview').innerHTML=catalogDraft.map((row,i)=>`<label class="catalog-row"><input type="checkbox" data-catalog-row="${i}" ${row.selected?'checked':''} ${row.error||row.duplicate?'disabled':''} /><span><b>Ligne ${row.line} · ${escapeHtml(row.product?.name||'Erreur')}</b><small>${escapeHtml(row.error||row.warning)}${row.product?' · '+fmtQty(totalAvailable(row.product))+' '+escapeHtml(row.product.unit):''}</small></span></label>`).join('');
  $('catalogPreview').querySelectorAll('[data-catalog-row]').forEach(box=>box.onchange=()=>{catalogDraft[Number(box.dataset.catalogRow)].selected=box.checked;updateCatalogStatus()});updateCatalogStatus();
}
function updateCatalogStatus(){const selected=catalogDraft.filter(r=>r.selected).length,errors=catalogDraft.filter(r=>r.error).length,duplicates=catalogDraft.filter(r=>r.duplicate).length;$('catalogStatus').textContent=`${selected} produit(s) sélectionné(s), ${errors} ligne(s) invalide(s), ${duplicates} doublon(s) exclu(s). Aucune fiche existante ne sera remplacée.`;$('catalogImportBtn').disabled=!selected}
async function importCatalog(e){e.preventDefault();await mutate(async()=>{
  if(catalogRevision!==dbRevision)throw new Error('L’inventaire a changé depuis l’aperçu. Recharge le fichier pour vérifier les doublons.');
  const rows=catalogDraft.filter(r=>r.selected&&!r.error&&!r.duplicate).map(r=>r.product);if(!rows.length)throw new Error('Sélectionne au moins un produit valide.');
  for(const p of rows)if(p.barcode&&products.some(x=>!x.archived&&Core.barcodeKey(x.barcode)===Core.barcodeKey(p.barcode)))throw new Error('Un code-barres existe déjà. Recharge l’aperçu.');
  const logs=rows.map(p=>newMovement(p,'Import du catalogue',totalAvailable(p),'Stock initial importé, sans achat','+',{type:'initial',after:Core.stock(p),inventoryValueDelta:totalAvailable(p)*p.unitCost}));
  await commitData({products:rows,movements:logs},{safety:true});$('catalogDialog').close();showToast(rows.length+' produit(s) importé(s).');
})}
function setupOperationsEvents(){
  const actions={count:openCount,service:openService,dilution:openDilution,catalog:openCatalog};document.querySelectorAll('[data-tool]').forEach(b=>b.onclick=()=>actions[b.dataset.tool]());
  $('barcode').addEventListener('input',updateDuplicateHint);$('productName').addEventListener('input',updateDuplicateHint);
  $('movementType').addEventListener('change',()=>{const p=products.find(p=>p.id===$('movementProductId').value);if(p)openMovementDetails(p,$('movementType').value)});
  $('movementBucket').onchange=()=>updateMovementDetails(true);$('receiptShipping').oninput=updateMovementDetails;$('receiptDiscount').oninput=updateMovementDetails;
  $('countLocation').onchange=renderCount;$('countSearch').oninput=renderCount;$('countForm').onsubmit=saveCount;
  $('positionsSearch').oninput=renderPositions;$('activityFilter').onchange=()=>{activityLimit=30;renderActivities()};$('activitiesMore').onclick=()=>{activityLimit+=50;renderActivities()};
  $('transferForm').onsubmit=saveTransfer;$('lotForm').onsubmit=saveLot;$('lotDatesForm').onsubmit=saveLotDates;$('lotEditSelect').onchange=updateLotDates;
  $('serviceForm').onsubmit=saveService;$('serviceProduct').onchange=updateServiceProduct;$('serviceAddLine').onclick=addServiceLine;$('serviceTemplate').onchange=useServiceTemplate;$('saveServiceTemplate').onclick=saveTemplate;
  $('dilutionForm').onsubmit=saveDilution;$('dilutionProduct').onchange=updateDilutionProduct;for(const id of ['dilutionVolume','dilutionRatio','dilutionPosition'])$(id).addEventListener('input',updateDilution);
  $('catalogFile').onchange=e=>readCatalog(e.target.files[0]);$('catalogSheet').onchange=selectCatalogSheet;$('catalogForm').onsubmit=importCatalog;
  $('catalogExample').onclick=()=>downloadBlob('modele-catalogue.csv','\ufeffProduit;Code-barres;Unité;Réserve;En main;Coût unitaire;Catégorie;Fournisseur;Emplacement;Minimum;Cible;Contenu;Conditionnement\nNettoyant exemple;;mL;4000;500;0,005;Intérieur;Fournisseur;Garage;1000;4000;4000;bidon','text/csv;charset=utf-8');
  $('receiptForm').onsubmit=saveReceipt;
  for(const [value,label] of [['loss','Pertes'],['supplierReturn','Retours fournisseur'],['transfer','Transferts'],['count','Comptages'],['dilution','Dilutions'],['lot','Lots']])$('historyType').add(new Option(label,value));
}
