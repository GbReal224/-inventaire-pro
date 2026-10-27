function statsDays(){return Number($('statsPeriod').value)}
function statsRange(){
  const days=statsDays(),now=new Date(),first=movements.reduce((min,m)=>Math.min(min,Date.parse(m.date)||min),now.getTime());
  let start=days===0?new Date(first):new Date(now.getTime()-Math.max(1,days)*86400000),end=now;
  if(days===-1){start=$('statsFrom').value?new Date($('statsFrom').value+'T00:00:00'):new Date(now.getTime()-30*86400000);end=$('statsTo').value?new Date(Math.min(now.getTime(),new Date($('statsTo').value+'T23:59:59.999').getTime())):now}
  return {start,end,days:Math.max(1,(end-start)/86400000),valid:start<=end};
}
function movesWithin(days){const range=statsRange(),product=$('statsProduct').value;return movements.filter(m=>(!product||m.productId===product)&&new Date(m.date)>=range.start&&new Date(m.date)<=range.end)}
function isConsumption(m){return !m.reversedBy&&(m.type?m.type==='consume':/Consommation depuis en main/i.test(m.label||''))}
function movementInventoryDelta(m){if(Number.isFinite(m.inventoryValueDelta))return m.inventoryValueDelta;const direction=movementDirection(m);return (direction==='add'?1:direction==='remove'?-1:0)*Number(m.qty||0)*Number(m.unitCostAtTime||0)}
function movementDirection(m){
  if(m.type==='undo'||m.reversedBy)return 'neutral';
  if(m.before&&m.after){const delta=m.after.reserveStock+m.after.inHandStock-m.before.reserveStock-m.before.inHandStock;return delta>0?'add':delta<0?'remove':'neutral'}
  if(['receive','reservePlus','handPlus','initial'].includes(m.type))return 'add';if(['consume','reserveMinus','handMinus'].includes(m.type))return 'remove';return 'neutral';
}
function buckets(range){
  const mode=range.days<=45?'day':range.days<=210?'week':'month';
  const key=value=>{const d=new Date(value);if(mode==='week')d.setDate(d.getDate()-(d.getDay()+6)%7);return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`+(mode==='month'?'':`-${String(d.getDate()).padStart(2,'0')}`)};
  const rows=[],map=new Map();let d=new Date(range.start);d.setHours(0,0,0,0);if(mode==='week')d.setDate(d.getDate()-(d.getDay()+6)%7);if(mode==='month')d.setDate(1);
  while(d<=range.end&&rows.length<1000){const k=key(d),row={key:k,label:d.toLocaleDateString('fr-CA',mode==='month'?{month:'short',year:'numeric'}:{month:'short',day:'numeric'}),purchases:0,consumed:0,added:0,removed:0,delta:0};rows.push(row);map.set(k,row);if(mode==='month')d.setMonth(d.getMonth()+1);else d.setDate(d.getDate()+(mode==='week'?7:1))}
  return {rows,map,key};
}
function renderLineChart(id,rows,series,{money=false}={}){
  const el=$(id),format=money?fmtMoney:fmtQty;if(!rows.length){el.innerHTML='<div class="empty">Aucune donnée dans cette période.</div>';return}
  const W=Math.max(300,Math.min(760,(document.querySelector('.app-shell')?.clientWidth||390)-64)),H=240,L=53,R=20,T=20,B=45,width=W-L-R,height=H-T-B;
  const vals=rows.flatMap(r=>series.map(s=>Number(r[s.key]||0))),max=Math.max(1,...vals),min=Math.min(0,...vals),y=v=>T+height-(Number(v||0)-min)/(max-min)*height,x=i=>L+(rows.length===1?width/2:i*width/(rows.length-1));
  const compact=v=>new Intl.NumberFormat('fr-CA',{notation:'compact',maximumFractionDigits:1}).format(v);
  const grid=[0,.5,1].map(fr=>{const v=max-(max-min)*fr,yy=T+height*fr;return `<line x1="${L}" y1="${yy}" x2="${W-R}" y2="${yy}" class="chart-grid-line"/><text x="${L-6}" y="${yy+4}" text-anchor="end" class="chart-axis-text">${escapeHtml(compact(v))}</text>`}).join('');
  const labels=[...new Set([0,Math.floor((rows.length-1)/2),rows.length-1])].map(i=>`<text x="${x(i)}" y="${H-12}" text-anchor="${i===0?'start':i===rows.length-1?'end':'middle'}" class="chart-axis-text">${escapeHtml(rows[i].label)}</text>`).join('');
  const paths=series.map((s,j)=>`<polyline points="${rows.map((r,i)=>`${x(i)},${y(r[s.key])}`).join(' ')}" class="chart-line series-${j+1}"/>`).join('');
  const hits=rows.map((r,i)=>{const label=r.label+' · '+series.map(s=>s.label+' : '+format(r[s.key])).join(' · ');return `<circle cx="${x(i)}" cy="${y(r[series[0].key])}" r="7" class="chart-dot series-1" tabindex="0" role="button" aria-label="${escapeHtml(label)}" data-value="${escapeHtml(label)}"><title>${escapeHtml(label)}</title></circle>`}).join('');
  el.innerHTML=`<div class="chart-legend">${series.map((s,j)=>`<span><i class="legend-line series-${j+1}"></i>${escapeHtml(s.label)}${money?' ($)':''}</span>`).join('')}</div><svg class="trend-svg" viewBox="0 0 ${W} ${H}" aria-label="${escapeHtml(series.map(s=>s.label).join(', '))}" role="group">${grid}${labels}${paths}${hits}</svg><p class="chart-readout helper" aria-live="polite">Touche un point pour lire les valeurs.</p><details><summary>Voir les valeurs du graphique</summary><div class="table-scroll"><table><thead><tr><th>Période</th>${series.map(s=>`<th>${escapeHtml(s.label)}</th>`).join('')}</tr></thead><tbody>${rows.map(r=>`<tr><th>${escapeHtml(r.label)}</th>${series.map(s=>`<td>${format(r[s.key])}</td>`).join('')}</tr>`).join('')}</tbody></table></div></details>`;
  el.querySelectorAll('[data-value]').forEach(dot=>{const show=()=>{el.querySelector('.chart-readout').textContent=dot.dataset.value};dot.addEventListener('click',show);dot.addEventListener('pointerup',show);dot.addEventListener('focus',show);dot.addEventListener('keydown',e=>{if(['Enter',' '].includes(e.key)){e.preventDefault();show()}})});
}
function renderBars(id,rows,key,{money=false}={}){const max=Math.max(1,...rows.map(r=>r[key]));$(id).innerHTML=rows.length?rows.map(r=>`<div class="bar-row"><div class="bar-label">${escapeHtml(r.name)}</div><div class="bar-track"><div class="bar-fill" style="width:${Math.max(1,r[key]/max*100)}%"></div></div><div class="bar-value">${money?fmtMoney(r[key]):fmtQty(r[key])+' '+escapeHtml(r.unit||'')}</div></div>`).join(''):'<div class="empty">Aucune donnée pendant cette période.</div>'}
function renderStats(){
  if(!$('statsProduct'))return;
  const range=statsRange(),selected=$('statsProduct').value,chosen=products.filter(p=>!selected||p.id===selected),live=chosen.filter(p=>!p.archived),period=movesWithin(statsDays()),top=Number($('statsTopLimit').value),take=rows=>top?rows.slice(0,top):rows;
  $('statsDates').classList.toggle('hidden',statsDays()!==-1);$('statsRangeError').textContent=range.valid?'':'La date de début doit précéder la date de fin et ne pas être dans le futur.';
  const label=statsDays()===0?'Tout l’historique':`${range.start.toLocaleDateString('fr-CA')} au ${range.end.toLocaleDateString('fr-CA')}`;
  for(const id of ['usagePeriodLabel','costPeriodLabel','purchaseChartPeriodLabel','movementChartPeriodLabel','inventoryValuePeriodLabel','purchaseVsConsumptionPeriodLabel'])$(id).textContent=label;
  const reserve=chosen.reduce((s,p)=>s+p.reserveStock*p.unitCost,0),hand=chosen.reduce((s,p)=>s+p.inHandStock*p.unitCost,0),usage=new Map(),costs=new Map();
  for(const m of period.filter(isConsumption)){usage.set(m.productId,(usage.get(m.productId)||0)+m.qty);const p=products.find(p=>p.id===m.productId);costs.set(m.productId,(costs.get(m.productId)||0)+m.qty*(m.unitCostAtTime??p?.unitCost??0))}
  const allPurchases=movements.filter(m=>isPurchaseMovement(m)&&(!selected||m.productId===selected)),sum=list=>list.reduce((s,m)=>s+Number(m.purchaseTotalCost||0),0);
  for(const [id,value] of Object.entries({statTotalValue:reserve+hand,statReserveCost:reserve,statInHandCost:hand,statConsumedCost:[...costs.values()].reduce((s,v)=>s+v,0),statOrderBudget:live.reduce((s,p)=>s+toOrder(p)*p.unitCost,0),statPurchasesPeriod:sum(period.filter(isPurchaseMovement)),statPurchasesMonth:sum(allPurchases.filter(m=>isSameLocalMonth(m.date))),statPurchasesTotal:sum(allPurchases)}))$(id).textContent=fmtMoney(value);
  const unitSet=new Set(chosen.map(p=>p.unit)),qty=chosen.reduce((s,p)=>s+totalAvailable(p),0);$('statAvgUnitCost').textContent=unitSet.size<=1&&qty>0?fmtMoney((reserve+hand)/qty):'Unités variées';
  $('statHealth').textContent=live.length?`${Math.round(live.filter(p=>statusOf(p).key==='ok').length/live.length*100)} %`:'—';$('statMoves').textContent=period.length;
  const row=(id,value)=>{const p=products.find(p=>p.id===id),m=movements.find(m=>m.productId===id);return {name:(p?.name||m?.productName||'Ancien produit')+(p?.archived?' (archivé)':''),unit:p?.unit||m?.unit||'',value}};
  renderBars('usageChart',take([...usage].map(([id,v])=>row(id,v)).sort((a,b)=>b.value-a.value)),'value');renderBars('consumptionCostChart',take([...costs].map(([id,v])=>row(id,v)).sort((a,b)=>b.value-a.value)),'value',{money:true});
  const grouped=buckets(range);for(const m of period){const r=grouped.map.get(grouped.key(m.date));if(!r)continue;if(isPurchaseMovement(m))r.purchases+=m.purchaseTotalCost||0;if(isConsumption(m))r.consumed+=m.qty*(m.unitCostAtTime??products.find(p=>p.id===m.productId)?.unitCost??0);const direction=movementDirection(m);if(direction==='add')r.added+=m.qty;if(direction==='remove')r.removed+=m.qty;r.delta+=movementInventoryDelta(m)}
  // Reconstruct the selected period from present value, including later movements and reversals.
  const after=movements.filter(m=>(!selected||m.productId===selected)&&new Date(m.date)>range.end).reduce((s,m)=>s+movementInventoryDelta(m),0);
  let value=reserve+hand-after-grouped.rows.reduce((s,r)=>s+r.delta,0);for(const r of grouped.rows){value+=r.delta;r.value=value}
  renderLineChart('purchaseTrendChart',grouped.rows,[{key:'purchases',label:'Achats'}],{money:true});renderLineChart('purchaseVsConsumptionChart',grouped.rows,[{key:'purchases',label:'Achats'},{key:'consumed',label:'Consommation'}],{money:true});renderLineChart('inventoryValueTrendChart',grouped.rows,[{key:'value',label:'Valeur du stock'}],{money:true});
  if(unitSet.size>1)$('movementTrendChart').innerHTML='<div class="empty">Sélectionne un produit pour comparer ses ajouts et retraits dans la même unité.</div>';else renderLineChart('movementTrendChart',grouped.rows,[{key:'added',label:'Ajouts'},{key:'removed',label:'Retraits'}]);
  const categories=new Map();for(const p of chosen)categories.set(p.category||'Sans catégorie',(categories.get(p.category||'Sans catégorie')||0)+totalAvailable(p)*p.unitCost);renderBars('categoryChart',[...categories].map(([name,value])=>({name,value})).sort((a,b)=>b.value-a.value),'value',{money:true});
  const states=[['ok','OK'],['watch','À surveiller'],['order','À commander'],['out','Rupture'],['pending','En commande']];$('stockHealthChart').innerHTML=`<div class="health-legend">${states.map(([key,label])=>`<span><i class="dot ${key}"></i>${label}<b>${live.filter(p=>statusOf(p).key===key).length}</b></span>`).join('')}</div>`;
  const coverage=live.map(p=>({p,used:usage.get(p.id)||0})).filter(x=>x.used>0).map(x=>({...x,days:totalAvailable(x.p)/(x.used/range.days)})).sort((a,b)=>a.days-b.days);$('coverageList').innerHTML=coverage.length?coverage.map(x=>`<div class="coverage-row"><div><b>${escapeHtml(x.p.name)}</b><small>${fmtQty(x.used)} ${escapeHtml(x.p.unit)} consommés · ${fmtQty(totalAvailable(x.p))} disponibles</small></div><span class="coverage-days ${x.days<14?'low':'good'}">≈ ${Math.round(x.days)} j</span></div>`).join(''):'<div class="empty">Enregistre des consommations pour estimer la couverture.</div>';
}
