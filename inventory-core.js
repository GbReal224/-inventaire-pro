/* Domain rules shared by the app and its tests. No network or storage access. */
(function(root){
  'use strict';
  const VERSION='4.0.0', SCHEMA=4;
  const round=n=>Math.round((n+Number.EPSILON)*1e8)/1e8;
  function number(value,label,{min=0,positive=false}={}){
    if(typeof value!=='number'||!Number.isFinite(value)||Math.abs(value)>1e12||value<min||(positive&&value===0))throw new Error(`${label} : nombre invalide.`);
    return value;
  }
  function text(value,label,max=500){if(typeof value!=='string'||value.length>max)throw new Error(`${label} : texte invalide.`);return value}
  function id(value){text(value,'Identifiant',160);if(!/^[a-zA-Z0-9_-]+$/.test(value))throw new Error('Identifiant invalide.');return value}
  function date(value,label){if(typeof value!=='string'||!Number.isFinite(Date.parse(value)))throw new Error(`${label} : date invalide.`);return value}
  function httpUrl(value){if(!value)return '';const u=new URL(value);if(!['https:','http:'].includes(u.protocol)||u.username||u.password)throw new Error('Le lien doit commencer par https:// ou http://.');return u.href}
  function product(p){
    if(!p||typeof p!=='object')throw new Error('Produit invalide.');
    const out={...p,id:id(p.id),name:text(p.name,'Nom',100),unit:text(p.unit||'unité','Unité',40)};
    if(!out.name.trim())throw new Error('Le nom du produit est obligatoire.');
    for(const k of ['reserveStock','inHandStock','minReserve','targetReserve','unitCost'])out[k]=number(p[k]??0,k);
    for(const k of ['category','supplier','location','barcode','notes'])out[k]=text(p[k]||'',k,k==='notes'?400:100);
    out.productUrl=httpUrl(p.productUrl||'');
    out.photoData=p.photoData||'';
    if(typeof out.photoData!=='string'||out.photoData.length>6000000||(out.photoData&&!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(out.photoData)))throw new Error('Photo invalide.');
    out.packSize=number(p.packSize??1,'Contenu du conditionnement',{positive:true});
    out.packLabel=text(p.packLabel||'lot','Nom du conditionnement',40);
    if(p.archived!=null&&typeof p.archived!=='boolean')throw new Error('État d’archivage invalide.');
    out.archived=!!p.archived;
    out.revision=number(p.revision??0,'Révision');
    for(const k of ['createdAt','updatedAt'])if(p[k])date(p[k],k);
    return out;
  }
  const stock=p=>({reserveStock:p.reserveStock,inHandStock:p.inHandStock,unitCost:p.unitCost});
  function movement(m){
    if(!m||typeof m!=='object')throw new Error('Mouvement invalide.');
    const out={...m,id:id(m.id),productId:id(m.productId),date:date(m.date,'Mouvement'),qty:number(m.qty,'Quantité')};
    for(const k of ['label','productName','note','sign','unit','type'])if(m[k]!=null)text(m[k],k,500);
    for(const k of ['unitCostAtTime','purchaseUnitCost','purchaseTotalCost','previousUnitCost','stockAfterTotal'])if(m[k]!=null)number(m[k],k);
    if(m.inventoryValueDelta!=null)number(m.inventoryValueDelta,'Variation de valeur',{min:-1e12});
    for(const k of ['before','after'])if(m[k])for(const field of ['reserveStock','inHandStock','unitCost'])number(m[k][field],field);
    for(const k of ['reversedBy','reverses','orderId'])if(m[k])id(m[k]);
    return out;
  }
  function order(o){
    if(!o||typeof o!=='object')throw new Error('Commande invalide.');
    const out={...o,id:id(o.id),productId:id(o.productId),quantity:number(o.quantity,'Quantité commandée',{positive:true}),received:number(o.received??0,'Quantité reçue'),unitCost:number(o.unitCost??0,'Coût'),createdAt:date(o.createdAt,'Commande')};
    if(o.received>o.quantity)throw new Error('La réception dépasse la commande.');
    for(const k of ['note','reference','supplier','unit','productName'])if(o[k]!=null)text(o[k],k,500);
    if(o.expectedDate&&!/^\d{4}-\d{2}-\d{2}$/.test(o.expectedDate))throw new Error('Date de livraison invalide.');
    if(o.expectedDate)date(o.expectedDate,'Livraison');
    if(!['ordered','partial','received','cancelled'].includes(o.status))throw new Error('État de commande invalide.');
    if(o.status!==orderStatus(out)&&o.status!=='cancelled')throw new Error('État de réception incohérent.');
    return out;
  }
  function orderStatus(o){return o.received>=o.quantity?'received':o.received>0?'partial':'ordered'}
  function outstanding(p,orders){return orders.filter(o=>o.productId===p.id&&['ordered','partial'].includes(o.status)).reduce((s,o)=>s+o.quantity-o.received,0)}
  function recommended(p,orders=[]){
    if(p.archived||p.reserveStock>=p.minReserve)return 0;
    const missing=Math.max(0,Math.max(p.minReserve,p.targetReserve)-p.reserveStock-outstanding(p,orders));
    const pack=p.packSize||1;
    return round(Math.ceil(round(missing/pack))*pack);
  }
  function quantityFactor(p,mode){
    if(mode==='pack')return p.packSize||1;
    if(mode==='mL'&&p.unit==='litre')return .001;
    if(mode==='litre'&&p.unit==='mL')return 1000;
    if(mode==='unit'||mode===p.unit)return 1;
    throw new Error('Unité incompatible.');
  }
  function apply(p,{type,quantity,mode='unit',cost=0}){
    if(p.archived)throw new Error('Restaure le produit avant de modifier son stock.');
    const q=number(round(number(quantity,'Quantité',{positive:true})*quantityFactor(p,mode)),'Quantité convertie',{positive:true});
    if(q<=0)throw new Error('Quantité trop petite.');
    const before=stock(p),next={...p},meta={type,qty:q,before,unit:p.unit,unitCostAtTime:p.unitCost};
    let r=p.reserveStock,h=p.inHandStock;
    switch(type){
      case 'receive': {
        const paid=number(cost,'Coût payé')/quantityFactor(p,mode),total=round(q*paid);
        next.unitCost=(r+h)*p.unitCost+total;next.unitCost/=r+h+q;r+=q;
        Object.assign(meta,{isPurchase:true,purchaseUnitCost:paid,purchaseTotalCost:total,previousUnitCost:p.unitCost,inventoryValueDelta:total});break;
      }
      case 'open':r-=q;h+=q;break;
      case 'return':h-=q;r+=q;break;
      case 'consume':case 'handMinus':h-=q;break;
      case 'reserveMinus':r-=q;break;
      case 'reservePlus':r+=q;break;
      case 'handPlus':h+=q;break;
      default:throw new Error('Action inconnue.');
    }
    if(round(r)<0||round(h)<0)throw new Error('Quantité supérieure au stock disponible.');
    next.reserveStock=round(r);next.inHandStock=round(h);
    if(meta.inventoryValueDelta==null)meta.inventoryValueDelta=round((r+h-before.reserveStock-before.inHandStock)*p.unitCost);
    Object.assign(meta,{after:stock(next),stockAfterTotal:round(r+h),sign:r+h>before.reserveStock+before.inHandStock?'+':r+h<before.reserveStock+before.inHandStock?'−':'↔'});
    product(next);movement({...meta,id:'validation',productId:p.id,date:new Date().toISOString()});
    return {product:next,movement:meta};
  }
  function validateBackup(data){
    if(!data||data.app!=='Inventaire Pro'||!Array.isArray(data.products)||!Array.isArray(data.movements))throw new Error('Ce fichier n’est pas une sauvegarde Inventaire Pro.');
    if(data.schemaVersion!=null&&data.schemaVersion!==SCHEMA)throw new Error('Version de sauvegarde incompatible. Mets à jour l’application.');
    if(!data.schemaVersion&&Number.parseFloat(data.version)>=4)throw new Error('Format de sauvegarde manquant.');
    if(data.products.length>50000||data.movements.length>500000)throw new Error('Sauvegarde trop volumineuse.');
    if(data.orders!=null&&!Array.isArray(data.orders))throw new Error('Liste de commandes invalide.');
    const result={products:data.products.map(product),movements:data.movements.map(movement),orders:(data.orders||[]).map(order),datasetId:data.datasetId? id(data.datasetId):null};
    for(const list of [result.products,result.movements,result.orders])if(new Set(list.map(x=>x.id)).size!==list.length)throw new Error('Identifiants en double dans la sauvegarde.');
    const productIds=new Set(result.products.map(p=>p.id));
    for(const m of result.movements)if(!productIds.has(m.productId)){
      // Old versions allowed permanent deletion. Retain their historical identity.
      if(data.schemaVersion)throw new Error('Un mouvement fait référence à un produit absent.');
      result.products.push(product({id:m.productId,name:(m.productName||'Ancien produit').slice(0,100),unit:m.unit||'unité',archived:true}));productIds.add(m.productId);
    }
    const moveIds=new Set(result.movements.map(m=>m.id)),orderIds=new Set(result.orders.map(o=>o.id)),moveMap=new Map(result.movements.map(m=>[m.id,m]));
    for(const m of result.movements){
      if((m.reversedBy&&!moveIds.has(m.reversedBy))||(m.reverses&&!moveIds.has(m.reverses))||(m.orderId&&!orderIds.has(m.orderId)))throw new Error('Référence de mouvement invalide.');
      if(m.reversedBy){const reverse=moveMap.get(m.reversedBy);if(reverse.reverses!==m.id||reverse.productId!==m.productId)throw new Error('Correction de mouvement incohérente.');}
    }
    for(const o of result.orders)if(!productIds.has(o.productId))throw new Error('Produit de commande absent.');
    return result;
  }
  const api={VERSION,SCHEMA,round,number,httpUrl,product,movement,order,orderStatus,stock,outstanding,recommended,quantityFactor,apply,validateBackup};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.InventoryCore=api;
})(typeof globalThis!=='undefined'?globalThis:this);
