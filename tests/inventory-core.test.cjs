const {test}=require('node:test');
const assert=require('node:assert/strict');
const Core=require('../inventory-core.js');
const p=overrides=>Core.product({id:'p1',name:'Bouteilles',unit:'bouteille',reserveStock:2,inHandStock:1,minReserve:4,targetReserve:10,unitCost:3,...overrides});
test('Recommendations respect minimum zero, whole packs and outstanding orders',()=>{
  assert.equal(Core.recommended(p({reserveStock:0,minReserve:0})),0);
  assert.equal(Core.recommended(p()),8);
  assert.equal(Core.recommended(p({packSize:6})),12);
  const orders=[{productId:'p1',status:'partial',quantity:12,received:2}];
  assert.equal(Core.recommended(p(),orders),0);
  assert.equal(Core.recommended(p({archived:true})),0);
  assert.equal(Core.recommended(p(),[{...orders[0],status:'cancelled'}]),8);
});
test('Purchase by box converts quantity and cost and uses weighted value',()=>{
  const product=p({packSize:12}),result=Core.apply(product,{type:'receive',quantity:2,mode:'pack',cost:24});
  assert.equal(result.product.reserveStock,26);assert.equal(result.movement.qty,24);
  assert.equal(result.movement.purchaseTotalCost,48);assert.equal(result.movement.purchaseUnitCost,2);
  assert.equal(result.product.unitCost,57/27);assert.equal(product.reserveStock,2,'Input remains untouched');
});
test('Volumes convert in both directions, with precise zero-cost accounting',()=>{
  let result=Core.apply(p({unit:'mL',packSize:4000,reserveStock:0,inHandStock:0}),{type:'receive',quantity:1,mode:'pack',cost:20});
  assert.equal(result.product.unitCost,.005);assert.equal(result.product.reserveStock,4000);
  result=Core.apply(result.product,{type:'open',quantity:1,mode:'litre'});assert.equal(result.product.inHandStock,1000);
  result=Core.apply(result.product,{type:'consume',quantity:250});assert.equal(result.product.inHandStock,750);assert.equal(result.movement.inventoryValueDelta,-1.25);
  assert.equal(Core.apply(p({unit:'litre',inHandStock:1}),{type:'consume',quantity:100,mode:'mL'}).product.inHandStock,.9);
  assert.equal(Core.apply(p({unitCost:0}),{type:'consume',quantity:1}).movement.inventoryValueDelta,0);
});
test('Invalid movements cannot modify stock',()=>{
  for(const options of [{type:'consume',quantity:2},{type:'open',quantity:3},{type:'receive',quantity:1,cost:-1},{type:'handPlus',quantity:Infinity},{type:'consume',quantity:0},{type:'oops',quantity:1},{type:'receive',quantity:1,mode:'mL'}])assert.throws(()=>Core.apply(p(),options));
  assert.throws(()=>Core.apply(p({archived:true}),{type:'receive',quantity:1}));
});
test('Backup validation rejects corrupted data and unsafe URLs without changing the input',()=>{
  const valid={app:'Inventaire Pro',schemaVersion:4,products:[p()],movements:[],orders:[]};
  const errors=[{products:[p(),p()]},{schemaVersion:5},{products:[{...p(),reserveStock:-1}]},{products:[{...p(),productUrl:'javascript:alert(1)'}]},{products:[{...p(),photoData:'data:image/svg+xml;base64,xxx'}]},{products:[{...p(),id:'x" onclick="oops'}]},{movements:[{id:'m1',productId:'missing',qty:1,date:new Date().toISOString()}]},{orders:[{id:'o1',productId:'p1',quantity:2,received:1,createdAt:new Date().toISOString(),status:'received'}]}];
  for(const change of errors)assert.throws(()=>Core.validateBackup({...valid,...change}));
  const original=JSON.stringify(valid);Core.validateBackup(valid);assert.equal(JSON.stringify(valid),original);
});
test('Legacy backups retain deleted products as archived identities',()=>{
  const backup={app:'Inventaire Pro',version:3.2,products:[],movements:[{id:'m1',productId:'gone',productName:'Ancien produit',qty:2,date:new Date().toISOString()}]};
  const migrated=Core.validateBackup(backup);assert.equal(migrated.products[0].archived,true);assert.equal(migrated.products[0].id,'gone');assert.equal(migrated.movements.length,1);
});
