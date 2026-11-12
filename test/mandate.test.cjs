const {test}=require('node:test');const assert=require('node:assert/strict');
const {createMandateRegistry,normalizeMandate,SDK_ACTIONS}=require('../src/mandate/index.cjs');
const {createSqliteStorage}=require('../src/storage/index.cjs');
const {mkdtempSync,rmSync}=require('node:fs'),{join}=require('node:path'),{tmpdir}=require('node:os');
const token='0x'+'1'.repeat(40),other='0x'+'2'.repeat(40);
const budget={chainId:31337,tokenAddress:token,total:'100'};
function registry(s,mandates=[],now){return createMandateRegistry({mandates,kv:s.kv,spending:s.spending,now});}
const request=(id,amount='30',extra={})=>({actor:'agent',requestId:id,amount,chainId:31337,tokenAddress:token,...extra});
test('mandate defaults are all actions, unlimited budget and lifetime without a hierarchy',async()=>{
 const s=createSqliteStorage({filename:':memory:'});try{
 const r=registry(s,[{agentId:'agent'}]);await r.ready();const p=await r.get('agent');assert.equal(p.actions,'all');assert.equal(p.budget,null);assert.equal(p.expiresAt,null);assert.equal(Object.hasOwn(p,'grantedBy'),false);
 for(const action of SDK_ACTIONS)assert.equal(await r.authorize({actor:'agent',action}),true);
 assert.equal(await r.authorize({actor:'agent',action:'invented'}),false);
 assert.equal((await r.get('another-agent')).expiresAt,null);assert.equal(await r.reserveBudget(request('one',(1n<<255n).toString())),true);
 assert.equal(normalizeMandate({agentId:'agent',expiresAt:Infinity}).lifetime.kind,'lifetime');
 }finally{s.close();}
});
test('flat allowlist and empty action list constrain mutations; expired mandates still allow observations',async()=>{
 const s=createSqliteStorage({filename:':memory:'});let now=1000000;try{
 const r=registry(s,[{agentId:'agent',actions:['quote','accept'],duration:{seconds:10}},{agentId:'blocked',actions:[]}],()=>now);
 assert.equal(await r.authorize({actor:'agent',action:'quote'}),true);assert.equal(await r.authorize({actor:'agent',action:'fund'}),false);assert.equal(await r.authorize({actor:'blocked',action:'create'}),false);
 now+=10000;assert.equal(await r.authorize({actor:'agent',action:'quote'}),false);assert.equal(await r.authorize({actor:'agent',action:'fund',phase:'reconcile'}),true);
 }finally{s.close();}
});
test('four-week duration persists across SQLite restart and cannot be silently extended or changed',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'a423-mandate-')),filename=join(dir,'state.sqlite');let s=createSqliteStorage({filename}),now=1000000;
 try{
 let r=registry(s,[{agentId:'agent',duration:{weeks:4},budget}],()=>now);await r.ready();const first=await r.get('agent');assert.equal(first.expiresAt,1000+4*7*86400);
 await r.reserveBudget(request('one','70'));s.close();now+=86400000;s=createSqliteStorage({filename});r=registry(s,[{agentId:'agent',duration:{weeks:4},budget}],()=>now);await r.ready();assert.equal((await r.get('agent')).expiresAt,first.expiresAt);assert.equal(await r.reserveBudget(request('two','40')),false);
 const conflict=registry(s,[{agentId:'agent',duration:{weeks:5},budget}],()=>now);await assert.rejects(conflict.ready(),/configuration changed/);
 now=first.expiresAt*1000;assert.equal(await r.authorize({actor:'agent',action:'fund'}),false);
 const renewed=registry(s,[{id:'renewed',agentId:'agent',duration:{weeks:4},budget}],()=>now);assert.equal(await renewed.authorize({actor:'agent',action:'fund'}),true);
 }finally{s.close();rmSync(dir,{recursive:true,force:true});}
});
test('shared budget is atomic, scoped to currency, deduplicated, and shared across any jobs',async()=>{
 const s=createSqliteStorage({filename:':memory:'});try{
 const a=registry(s,[{agentId:'agent',budget}]),b=registry(s,[{agentId:'agent',budget}]);await Promise.all([a.ready(),b.ready()]);
 const results=await Promise.all([a.reserveBudget(request('job-a','60')),b.reserveBudget(request('job-b','60'))]);assert.equal(results.filter(Boolean).length,1);
 const winner=results[0]?'job-a':'job-b';assert.equal(await a.reserveBudget(request(winner,'60')),true);assert.equal(await a.reserveBudget(request('job-c','40')),true);assert.equal(await a.reserveBudget(request('job-d','1')),false);
 assert.equal(await a.reserveBudget(request('other-token','1',{tokenAddress:other})),false);assert.equal(await a.reserveBudget(request('other-chain','1',{chainId:1})),false);
 await assert.rejects(a.reserveBudget(request(winner,'1')),/idempotency conflict/);
 }finally{s.close();}
});
test('daily and transaction caps can be finite while total remains unlimited',async()=>{
 const s=createSqliteStorage({filename:':memory:'});let now=Date.UTC(2026,0,1);try{
 const r=registry(s,[{agentId:'agent',budget:{...budget,total:null,perTransaction:'40',daily:'60'}}],()=>now);
 assert.equal(await r.reserveBudget(request('one','41')),false);assert.equal(await r.reserveBudget(request('two','40')),true);assert.equal(await r.reserveBudget(request('three','21')),false);assert.equal(await r.reserveBudget(request('four','20')),true);
 now+=86400000;assert.equal(await r.reserveBudget(request('five','40')),true);
 }finally{s.close();}
});
test('funding approval, zeroing, broadcast and funding all charge the same economic intent only once',async()=>{
 const s=createSqliteStorage({filename:':memory:'});let now=1000000;try{
 const r=registry(s,[{agentId:'agent',budget:{...budget,total:'30'},expiresAt:1010}],()=>now);
 const job={id:'job',agreement:{hash:'agreement',terms:{escrow:{chain_id:'31337',contract:other,token,amount:'30'}}}};
 const c={actor:'agent',operation:{action:'fund'},job};for(const step of ['approve_zero','approve','fund','fund'])assert.equal(await r.authorizeTransaction({...c,step}),true);
 assert.equal(await r.authorizeTransaction({...c,job:{...job,id:'other-job'},step:'fund'}),false);
 now=1010000;assert.equal(await r.authorizeTransaction({...c,step:'fund',phase:'broadcast'}),false);
 }finally{s.close();}
});
test('initialization rejects typos, owner hierarchy fields, invalid budgets, ambiguous durations and duplicate agents',()=>{
 for(const input of [{agentId:'a',grantedBy:'owner'},{agentId:'a',actions:['spend']},{agentId:'a',duration:{weeks:4},expiresAt:123},{agentId:'a',duration:{days:0}},{agentId:'a',duration:{weeks:4,days:2}},{agentId:'a',budget:{total:'10'}},{agentId:'a',budget:{...budget,total:10}}])assert.throws(()=>normalizeMandate(input));
 const s=createSqliteStorage({filename:':memory:'});try{assert.throws(()=>registry(s,[{agentId:'a'},{agentId:'a'}]),/Only one flat/);}finally{s.close();}
});
test('mandate module exports ESM and captures caller configuration',async()=>{
 const esm=await import('../src/mandate/index.mjs');assert.equal(esm.SDK_ACTIONS.includes('execute_cancellation'),true);
 const s=createSqliteStorage({filename:':memory:'});try{const input={agentId:'agent',actions:['quote'],budget:{...budget}};const r=registry(s,[input]);input.actions.push('fund');input.budget.total='9999';assert.equal(await r.authorize({actor:'agent',action:'fund'}),false);assert.equal((await r.get('agent')).budget.total,'100');}finally{s.close();}
});
