/* Inventory operations. Pure rules, shared by the browser and Node tests. */
(function(root){
  'use strict';
  const C=typeof module==='object'&&module.exports?require('./inventory-core.js'):root.InventoryCore;
  const basicProduct=C.product,basicMovement=C.movement,basicBackup=C.validateBackup;
  const clone=value=>JSON.parse(JSON.stringify(value));
  const num=C.number,round=C.round;
  function str(value,label,max=160){if(typeof value!=='string'||value.length>max)throw new Error(label+' invalide.');return value.trim()}
  function identifier(value){if(!/^[a-zA-Z0-9_-]{1,160}$/.test(value||''))throw new Error('Identifiant invalide.');return value}
  function day(value){if(!value)return '';if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value+'T12:00:00Z'))||new Date(value+'T12:00:00Z').toISOString().slice(0,10)!==value)throw new Error('Date invalide.');return value}
  const barcodeKey=value=>{const s=String(value||'').replace(/\D/g,'');return s.length===13&&s[0]==='0'?s.slice(1):s};
  const cleanName=value=>String(value||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim().toLowerCase().replace(/\s+/g,' ');
  function lot(value){const out={id:identifier(value.id),code:str(value.code||'','Numéro de lot',80),openedDate:day(value.openedDate||''),expiryDate:day(value.expiryDate||'')};if(!out.code)throw new Error('Le numéro de lot est obligatoire.');return out}
  function defaultPositions(p){return [{id:'reserve',location:p.location||'Réserve',bucket:'reserve',lotId:'',qty:p.reserveStock},{id:'hand',location:'En main',bucket:'hand',lotId:'',qty:p.inHandStock}]}
  function product(value){
    const p=basicProduct(value);
    p.leadDays=num(value.leadDays??0,'Délai fournisseur');p.safetyDays=num(value.safetyDays??2,'Marge de sécurité');
    if(p.leadDays>3650||p.safetyDays>365)throw new Error('Délai trop élevé.');
    if(value.lots!=null&&!Array.isArray(value.lots))throw new Error('Liste de lots invalide.');
    p.lots=(value.lots||[]).map(lot);if(new Set(p.lots.map(l=>l.id)).size!==p.lots.length)throw new Error('Lots en double.');
    if(value.positions!=null&&!Array.isArray(value.positions))throw new Error('Emplacements invalides.');
    p.positions=(value.positions||defaultPositions(p)).map(s=>{
      if(!['reserve','hand'].includes(s.bucket))throw new Error('Type de stock invalide.');
      const position={id:identifier(s.id),location:str(s.location,'Emplacement',60),bucket:s.bucket,lotId:s.lotId||'',qty:num(s.qty,'Stock par emplacement')};
      if(!position.location||position.lotId&&!p.lots.some(l=>l.id===position.lotId))throw new Error('Emplacement ou lot absent.');return position;
    });
    if(new Set(p.positions.map(s=>s.id)).size!==p.positions.length)throw new Error('Emplacements en double.');
    if(p.positions.length>2000||p.lots.length>2000)throw new Error('Trop de lots ou d’emplacements.');
    for(const [bucket,key] of [['reserve','reserveStock'],['hand','inHandStock']])if(Math.abs(round(p.positions.filter(s=>s.bucket===bucket).reduce((n,s)=>n+s.qty,0))-p[key])>1e-7)throw new Error('Les quantités par emplacement ne correspondent pas au stock.');
    return p;
  }
  const stock=p=>{const x=product(p);return clone({reserveStock:x.reserveStock,inHandStock:x.inHandStock,unitCost:x.unitCost,positions:x.positions,lots:x.lots})};
  function sumPositions(p){p.reserveStock=round(p.positions.filter(s=>s.bucket==='reserve').reduce((n,s)=>n+s.qty,0));p.inHandStock=round(p.positions.filter(s=>s.bucket==='hand').reduce((n,s)=>n+s.qty,0));return p}
  function reconcile(old,value){
    if(!old)return product(value);
    const p={...value,positions:clone(product(old).positions),lots:clone(product(old).lots)};
    for(const [bucket,key] of [['reserve','reserveStock'],['hand','inHandStock']]){
      const rows=p.positions.filter(s=>s.bucket===bucket),changed=Math.abs(old[key]-p[key])>1e-7;
      if(changed){if(rows.length>1||rows.some(s=>s.lotId))throw new Error('Utilise « Faire l’inventaire » pour corriger un stock réparti par lot ou emplacement.');if(rows.length)rows[0].qty=p[key];else p.positions.push({id:bucket,location:bucket==='reserve'?(p.location||'Réserve'):'En main',bucket,lotId:'',qty:p[key]})}
      if(bucket==='reserve'&&rows.length===1&&!rows[0].lotId&&old.location!==p.location)rows[0].location=p.location||'Réserve';
    }
    return product(p);
  }
  function addPosition(p,bucket,location,lotId,qty){
    location=str(location,'Emplacement',60);if(!location)throw new Error('Indique un emplacement.');
    const found=p.positions.find(s=>s.bucket===bucket&&s.location===location&&s.lotId===lotId);
    if(found)found.qty=round(found.qty+qty);else{let i=1;while(p.positions.some(s=>s.id==='position-'+i))i++;p.positions.push({id:'position-'+i,location,bucket,lotId,qty:round(qty)})}
  }
  function take(p,bucket,qty,positionId=''){
    const rows=p.positions.filter(s=>s.bucket===bucket&&(!positionId||s.id===positionId)).sort((a,b)=>{
      const date=s=>p.lots.find(l=>l.id===s.lotId)?.expiryDate||'9999-12-31';return date(a).localeCompare(date(b));
    });
    if(round(rows.reduce((n,s)=>n+s.qty,0))<qty)throw new Error('Quantité supérieure au stock disponible dans cet emplacement.');
    let remaining=qty;const used=[];
    for(const s of rows){const q=round(Math.min(s.qty,remaining));if(q>0){s.qty=round(s.qty-q);remaining=round(remaining-q);used.push({...s,qty:q})}if(remaining<=0)break}return used;
  }
  function apply(value,options){
    const p=product(value);if(p.archived)throw new Error('Restaure le produit avant de modifier son stock.');
    const next=clone(p),type=options.type,factor=C.quantityFactor(p,options.mode||'unit'),q=num(round(num(options.quantity,'Quantité',{positive:true})*factor),'Quantité convertie',{positive:true});
    const before=stock(p),meta={type,qty:q,before,unit:p.unit,unitCostAtTime:p.unitCost};let used=[];
    if(type==='receive'){
      const cost=num(options.cost??0,'Coût payé'),shipping=num(options.shipping??0,'Livraison'),discount=num(options.discount??0,'Rabais'),total=round(q*cost/factor+shipping-discount);
      if(total<0)throw new Error('Le rabais dépasse le montant de l’achat.');
      let lotId='';if(options.lot){const l=lot(options.lot),existing=next.lots.find(x=>x.id===l.id);if(existing&&JSON.stringify(existing)!==JSON.stringify(l))throw new Error('Ce lot existe déjà avec des dates différentes.');if(!existing)next.lots.push(l);lotId=l.id}
      addPosition(next,'reserve',options.toLocation||p.location||'Réserve',lotId,q);
      next.unitCost=((p.reserveStock+p.inHandStock)*p.unitCost+total)/(p.reserveStock+p.inHandStock+q);
      Object.assign(meta,{isPurchase:true,purchaseUnitCost:total/q,purchaseTotalCost:total,basePurchaseTotal:round(q*cost/factor),shipping,discount,previousUnitCost:p.unitCost,inventoryValueDelta:total});
    }else if(['reservePlus','handPlus'].includes(type))addPosition(next,type==='reservePlus'?'reserve':'hand',options.toLocation||(type==='reservePlus'?p.location||'Réserve':'En main'),'',q);
    else{
      const from=options.fromBucket||(['open','reserveMinus'].includes(type)?'reserve':'hand');
      if(!['reserve','hand'].includes(from))throw new Error('Source invalide.');
      if(!['open','return','consume','reserveMinus','handMinus','loss','supplierReturn','transfer','dilution'].includes(type))throw new Error('Action inconnue.');
      used=take(next,from,q,options.positionId||'');
      if(['open','return','transfer'].includes(type)){
        const bucket=type==='open'?'hand':type==='return'?'reserve':options.toBucket||from;
        if(!['reserve','hand'].includes(bucket))throw new Error('Destination invalide.');
        const location=options.toLocation||(bucket==='reserve'?p.location||'Réserve':'En main');
        if(type==='transfer'&&used.every(s=>s.location===location&&s.bucket===bucket))throw new Error('Choisis un autre emplacement.');
        for(const s of used)addPosition(next,bucket,location,s.lotId,s.qty);
      }
      if(type==='loss'){if(!['spilled','damaged','expired','other'].includes(options.reason))throw new Error('Choisis un motif de perte.');meta.reason=options.reason;meta.lossCost=round(q*p.unitCost)}
      if(type==='supplierReturn')meta.refund=num(options.refund??0,'Remboursement');
    }
    sumPositions(next);if(meta.inventoryValueDelta==null)meta.inventoryValueDelta=round((next.reserveStock+next.inHandStock-p.reserveStock-p.inHandStock)*p.unitCost);
    const stockDelta=round(next.reserveStock+next.inHandStock-p.reserveStock-p.inHandStock);
    Object.assign(meta,{allocations:used,after:stock(next),stockAfterTotal:round(next.reserveStock+next.inHandStock),sign:stockDelta<0?'−':stockDelta>0?'+':'↔'});
    return {product:product(next),movement:meta};
  }
  function countProduct(value,counts){
    const p=product(value),next=clone(p),seen=new Set();if(p.archived)throw new Error('Produit archivé.');
    for(const row of counts){if(seen.has(row.positionId))throw new Error('Emplacement compté deux fois.');seen.add(row.positionId);const s=next.positions.find(s=>s.id===row.positionId);if(!s)throw new Error('Emplacement introuvable.');s.qty=num(row.counted,'Quantité comptée')}
    sumPositions(next);const delta=round(next.reserveStock+next.inHandStock-p.reserveStock-p.inHandStock);
    return {product:product(next),movement:{type:'count',qty:Math.abs(delta),before:stock(p),after:stock(next),unit:p.unit,unitCostAtTime:p.unitCost,inventoryValueDelta:round(delta*p.unitCost),sign:delta<0?'−':'+',counts:clone(counts)}};
  }
  function assignLot(value,{positionId,quantity,lot:info}){
    const p=product(value),next=clone(p),l=lot(info),position=next.positions.find(s=>s.id===positionId);if(p.archived||!position)throw new Error('Emplacement indisponible.');
    if(next.lots.some(x=>x.id===l.id))throw new Error('Lot déjà présent.');
    const q=num(quantity,'Quantité du lot',{positive:true});if(q>position.qty)throw new Error('Quantité du lot supérieure au stock.');
    next.lots.push(l);position.qty=round(position.qty-q);addPosition(next,position.bucket,position.location,l.id,q);
    return {product:product(next),movement:{type:'lot',qty:q,before:stock(p),after:stock(next),inventoryValueDelta:0,unitCostAtTime:p.unitCost,unit:p.unit,sign:'↔'}};
  }
  function dilution(volume,ratio){num(volume,'Volume final',{positive:true});num(ratio,'Parts d’eau');if(volume>1e9||ratio>1e6)throw new Error('Volume ou ratio trop élevé.');const concentrate=round(volume/(ratio+1));if(concentrate<=0)throw new Error('Volume trop faible.');return {concentrate,water:round(volume-concentrate),volume,ratio}}
  function forecast(p,moves,orders,now=Date.now()){
    if(p.archived)return null;const since=now-30*86400000;
    const used=moves.filter(m=>m.productId===p.id&&!m.reversedBy&&(['consume','dilution'].includes(m.type)||(!m.type&&/Consommation depuis en main/i.test(m.label||'')))&&Date.parse(m.date)>=since&&Date.parse(m.date)<=now).reduce((n,m)=>n+m.qty,0);
    if(!used)return null;
    const first=Date.parse(p.createdAt||'')||since,days=Math.max(1,Math.min(30,(now-first)/86400000)),daily=used/days,available=p.reserveStock+p.inHandStock,coverage=available/daily;
    const expected=orders.filter(o=>o.productId===p.id&&['ordered','partial'].includes(o.status)&&o.expectedDate&&Date.parse(o.expectedDate+'T23:59:59')>=now&&Date.parse(o.expectedDate+'T23:59:59')<=now+coverage*86400000).reduce((n,o)=>n+o.quantity-o.received,0);
    const effectiveCoverage=(available+expected)/daily,threshold=p.leadDays+p.safetyDays;
    return {daily,coverage,effectiveCoverage,days,expected,atRisk:effectiveCoverage<threshold,orderIn:Math.floor(effectiveCoverage-threshold)};
  }
  function attachment(a){
    const name=str(a.name,'Nom du justificatif',160),type=a.type;
    if(!['image/jpeg','image/png','image/webp','application/pdf'].includes(type))throw new Error('Justificatif : utilise une image ou un PDF.');
    if(typeof a.data!=='string'||a.data.length>6000000||!a.data.startsWith('data:'+type+';base64,')||!/^[A-Za-z0-9+/=]+$/.test(a.data.split(',')[1]||''))throw new Error('Justificatif invalide ou trop volumineux.');
    return {name,type,data:a.data};
  }
  function movement(value){
    const m=basicMovement(value);
    for(const field of ['shipping','discount','refund','lossCost','basePurchaseTotal'])if(m[field]!=null)num(m[field],field);
    for(const field of ['reference','serviceName','serviceReference'])if(m[field]!=null)str(m[field],field,200);
    if(m.groupId)identifier(m.groupId);
    if(m.attachments!=null){if(!Array.isArray(m.attachments)||m.attachments.length>3)throw new Error('Maximum trois justificatifs par achat.');m.attachments=m.attachments.map(attachment)}
    for(const key of ['before','after'])if(m[key]?.positions)product({id:'snapshot',name:'État du stock',...m[key]});
    return m;
  }
  function activity(a){
    if(!a||!['count','service','template'].includes(a.kind))throw new Error('Opération invalide.');
    const out={...a,id:identifier(a.id),name:str(a.name||'','Nom de l’opération',100)};
    if(!out.name||typeof a.date!=='string'||!Number.isFinite(Date.parse(a.date)))throw new Error('Opération sans nom ou date.');
    if(!Array.isArray(a.lines)||a.lines.length>10000)throw new Error('Lignes d’opération invalides.');
    if(!a.lines.length)throw new Error('Opération sans lignes.');
    out.lines=a.lines.map(line=>{
      identifier(line.productId);if(line.movementId)identifier(line.movementId);
      if(a.kind==='count'){num(line.expected,'Quantité attendue');num(line.counted,'Quantité comptée');identifier(line.positionId)}
      else num(line.qty,'Quantité',{positive:true});
      if(a.kind==='service')num(line.cost,'Coût de ligne');
      if(line.positionId)identifier(line.positionId);for(const k of ['productName','location','unit'])if(line[k]!=null)str(line[k],k,160);
      return {...line};
    });
    if(a.kind==='service'){num(a.totalCost,'Coût prestation');if(Math.abs(round(out.lines.reduce((n,l)=>n+l.cost,0))-a.totalCost)>1e-7)throw new Error('Coût de prestation incohérent.');}
    if(a.reference!=null)str(a.reference,'Référence',200);return out;
  }
  function validateBackup(data){
    const result=basicBackup(data);result.products=result.products.map(product);result.movements=result.movements.map(movement);
    if(data.activities!=null&&!Array.isArray(data.activities))throw new Error('Liste des opérations invalide.');
    result.activities=(data.activities||[]).map(activity);if(new Set(result.activities.map(a=>a.id)).size!==result.activities.length)throw new Error('Opérations en double.');
    const ids=new Set(result.products.map(p=>p.id)),logs=new Map(result.movements.map(m=>[m.id,m])),groups=new Set(result.activities.map(a=>a.id));
    for(const a of result.activities)for(const l of a.lines){
      if(!ids.has(l.productId)||(l.movementId&&(!logs.has(l.movementId)||logs.get(l.movementId).productId!==l.productId)))throw new Error('Référence d’opération invalide.');
      if(a.kind!=='template'&&(!l.movementId||logs.get(l.movementId)?.groupId!==a.id))throw new Error('Mouvement d’opération absent ou incohérent.');
    }
    for(const m of result.movements)if(m.groupId&&!groups.has(m.groupId))throw new Error('Groupe de mouvements absent.');
    return result;
  }
  function parseCsv(text){
    text=String(text).replace(/^\uFEFF/,'');const first=text.split(/\r?\n/)[0];
    const delimiters=[',',';','\t'],delimiter=delimiters.sort((a,b)=>first.split(b).length-first.split(a).length)[0];
    const rows=[];let row=[],value='',quoted=false,closed=false;
    for(let i=0;i<text.length;i++){
      const ch=text[i];if(quoted){if(ch==='"'&&text[i+1]==='"'){value+='"';i++}else if(ch==='"'){quoted=false;closed=true}else value+=ch;continue}
      if(ch==='"'&&!value&&!closed){quoted=true;continue}
      if(ch===delimiter||ch==='\n'||ch==='\r'){row.push(value);value='';closed=false;if(ch!==delimiter){if(row.some(v=>v.trim()))rows.push(row);row=[];if(ch==='\r'&&text[i+1]==='\n')i++}continue}
      if(closed&&ch.trim())throw new Error('CSV : caractères après un guillemet fermant.');value+=ch;
    }
    if(quoted)throw new Error('CSV : guillemet non fermé.');row.push(value);if(row.some(v=>v.trim()))rows.push(row);return rows;
  }
  function decimal(value,label){if(typeof value==='number')return num(value,label);const s=String(value??'').trim().replace(/[\s\u00a0]/g,'').replace(',','.');if(!s)return 0;if(!/^\d+(\.\d+)?$/.test(s))throw new Error(label+' invalide.');return num(Number(s),label)}
  Object.assign(C,{product,stock,reconcile,apply,countProduct,assignLot,movement,activity,validateBackup,attachment,forecast,dilution,parseCsv,decimal,barcodeKey,cleanName,day});
  if(typeof module==='object'&&module.exports)module.exports=C;
})(typeof globalThis!=='undefined'?globalThis:this);
