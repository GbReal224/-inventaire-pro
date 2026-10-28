const {test}=require('node:test');
const assert=require('node:assert/strict');
const C=require('../operations-core.js');
const p=(extra={})=>C.product({id:'p1',name:'Concentré',unit:'mL',reserveStock:4000,inHandStock:1000,unitCost:.01,location:'Garage',...extra});
test('Legacy stock is allocated without altering totals; malformed distribution is rejected',()=>{
  const product=p();assert.equal(product.positions.length,2);assert.equal(product.positions[0].location,'Garage');
  assert.throws(()=>p({positions:[{id:'x',bucket:'reserve',location:'Garage',lotId:'',qty:2}]}));
  const next=C.reconcile(product,{...product,reserveStock:3500,location:'Atelier'});assert.equal(next.positions[0].qty,3500);assert.equal(next.positions[0].location,'Atelier');
});
test('Partial transfers preserve lots, aggregate totals and value, and reject overselling',()=>{
  const initial=p(),tagged=C.assignLot(initial,{positionId:'reserve',quantity:2000,lot:{id:'l1',code:'LOT1',expiryDate:'2027-01-01'}}).product;
  const s=tagged.positions.find(s=>s.lotId==='l1');
  const result=C.apply(tagged,{type:'transfer',positionId:s.id,fromBucket:'reserve',toBucket:'hand',toLocation:'Camion',quantity:500});
  assert.equal(result.product.reserveStock,3500);assert.equal(result.product.inHandStock,1500);assert.equal(result.movement.inventoryValueDelta,0);
  assert.equal(result.product.positions.find(s=>s.location==='Camion').lotId,'l1');assert.equal(initial.reserveStock,4000);
  assert.throws(()=>C.apply(tagged,{type:'transfer',positionId:s.id,fromBucket:'reserve',toBucket:'hand',toLocation:'Camion',quantity:3000}));
  assert.throws(()=>C.reconcile(tagged,{...tagged,reserveStock:5}));
});
test('Consumption chooses earliest expiry and a physical count corrects a specific location only',()=>{
  let product=C.assignLot(p(),{positionId:'hand',quantity:500,lot:{id:'l2',code:'B',expiryDate:'2027-03-01'}}).product;
  product=C.assignLot(product,{positionId:'hand',quantity:500,lot:{id:'l1',code:'A',expiryDate:'2027-01-01'}}).product;
  const consumed=C.apply(product,{type:'consume',quantity:600});assert.equal(consumed.movement.allocations[0].lotId,'l1');
  const b=consumed.product.positions.find(s=>s.lotId==='l2');const counted=C.countProduct(consumed.product,[{positionId:b.id,counted:300}]);
  assert.equal(counted.product.inHandStock,300);assert.equal(counted.product.reserveStock,4000);assert.equal(counted.movement.inventoryValueDelta,-1);
  assert.throws(()=>C.countProduct(product,[{positionId:'missing',counted:3}]));
});
test('Loss, supplier refunds and fees remain distinct from consumption and purchase value',()=>{
  const lost=C.apply(p(),{type:'loss',reason:'spilled',quantity:100,fromBucket:'hand'});assert.equal(lost.movement.lossCost,1);assert.equal(lost.movement.type,'loss');
  const returned=C.apply(p(),{type:'supplierReturn',quantity:100,fromBucket:'reserve',refund:2});assert.equal(returned.product.reserveStock,3900);assert.equal(returned.movement.inventoryValueDelta,-1);assert.equal(returned.movement.refund,2);
  const received=C.apply(p(),{type:'receive',quantity:1000,cost:.02,shipping:5,discount:2});assert.equal(received.movement.purchaseTotalCost,23);assert.equal(received.product.unitCost,73/6000);
  assert.throws(()=>C.apply(p(),{type:'receive',quantity:1,cost:1,discount:2}));assert.throws(()=>C.apply(p(),{type:'loss',quantity:1,reason:'unknown'}));
});
test('Dilution uses explicit concentrate:water convention and converts litres',()=>{
  assert.deepEqual(C.dilution(1000,9),{concentrate:100,water:900,volume:1000,ratio:9});assert.equal(C.dilution(500,0).concentrate,500);
  const r=C.apply(p({unit:'litre',reserveStock:4,inHandStock:1}),{type:'dilution',quantity:100,mode:'mL'});assert.equal(r.product.inHandStock,.9);
  assert.throws(()=>C.dilution(0,9));assert.throws(()=>C.dilution(100,-1));
});
test('Forecast uses reliable dated deliveries and does not count late or undated orders',()=>{
  const now=Date.parse('2026-10-28T12:00:00Z'),product=p({reserveStock:4,inHandStock:0,leadDays:7,safetyDays:2,createdAt:'2026-09-01T00:00:00Z'}),moves=[{productId:'p1',type:'consume',qty:30,date:'2026-10-20T12:00:00Z'}];
  assert.equal(C.forecast(product,moves,[],now).atRisk,true);
  const order={productId:'p1',quantity:20,received:0,status:'ordered'};
  assert.equal(C.forecast(product,moves,[order],now).atRisk,true);
  assert.equal(C.forecast(product,moves,[{...order,expectedDate:'2026-11-20'}],now).atRisk,true);
  assert.equal(C.forecast(product,moves,[{...order,expectedDate:'2026-10-20'}],now).atRisk,true,'Overdue unreceived orders are not assumed to arrive');
  assert.equal(C.forecast(product,moves,[{...order,expectedDate:'2026-10-30'}],now).atRisk,false);
  assert.equal(C.forecast(product,[],[],now),null);
});
test('Backup round trip preserves receipts, lots and grouped operation references',()=>{
  const product=p(),m={id:'m1',productId:'p1',productName:'Concentré',qty:1,type:'consume',date:'2026-10-28T12:00:00Z',groupId:'a1',before:C.stock(product),after:C.stock(product),attachments:[{name:'facture.pdf',type:'application/pdf',data:'data:application/pdf;base64,JVBERi0xLjQ='}]};
  const a={id:'a1',kind:'service',name:'Lavage',date:m.date,lines:[{productId:'p1',movementId:'m1',qty:1,cost:.01}],totalCost:.01};
  const data={app:'Inventaire Pro',schemaVersion:5,products:[product],movements:[m],orders:[],activities:[a]};const out=C.validateBackup(data);
  assert.equal(out.movements[0].attachments[0].name,'facture.pdf');assert.equal(out.activities[0].totalCost,.01);assert.equal(out.products[0].positions.length,2);
  assert.throws(()=>C.validateBackup({...data,activities:[]}));assert.throws(()=>C.validateBackup({...data,movements:[{...m,attachments:[{type:'text/html',name:'bad',data:'data:text/html;base64,YQ=='}]}]}));
  assert.deepEqual(C.validateBackup({app:'Inventaire Pro',schemaVersion:4,products:[product],movements:[]}).activities,[]);
});
test('CSV parser preserves quoted separators, zero-leading barcodes and decimal comma',()=>{
  const rows=C.parseCsv('\ufeffProduit;Code-barres;Prix\r\n"Nettoyant; spécial";001234567890;"1,25"\r\n"Deux\n lignes";;2');
  assert.equal(rows[1][0],'Nettoyant; spécial');assert.equal(rows[1][1],'001234567890');assert.equal(C.decimal(rows[1][2],'Prix'),1.25);assert.equal(rows[2][0],'Deux\n lignes');
  assert.throws(()=>C.parseCsv('Name,Qty\n"Unclosed,2'));assert.throws(()=>C.decimal('12abc','prix'));
  assert.equal(C.barcodeKey('0012345678905'),C.barcodeKey('012345678905'));
});
