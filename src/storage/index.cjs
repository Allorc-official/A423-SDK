'use strict';
const { DatabaseSync } = require('node:sqlite');
const { randomUUID } = require('node:crypto');
const { mkdirSync, chmodSync } = require('node:fs');
const { dirname } = require('node:path');
const json=JSON.stringify, parse=JSON.parse;
/** Single-host durable SQLite drivers. All writers must use this file on local disk. */
function createSqliteStorage({filename,busyTimeoutMs=5000}={}) {
  if(typeof filename!=='string'||!filename||!Number.isSafeInteger(busyTimeoutMs)||busyTimeoutMs<0||busyTimeoutMs>60000)throw new TypeError('Supply filename and valid busy timeout');
  if(filename!==':memory:')mkdirSync(dirname(filename),{recursive:true,mode:0o700});
  const db=new DatabaseSync(filename);
  if(filename!==':memory:')chmodSync(filename,0o600);
  db.exec(`PRAGMA busy_timeout=${busyTimeoutMs}; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS a423_jobs(id TEXT PRIMARY KEY,version INTEGER NOT NULL,payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS a423_events(cursor INTEGER PRIMARY KEY AUTOINCREMENT,job_id TEXT NOT NULL,sequence INTEGER NOT NULL,payload TEXT NOT NULL,UNIQUE(job_id,sequence));
    CREATE TABLE IF NOT EXISTS a423_transactions(id TEXT PRIMARY KEY,payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS a423_nonces(scope TEXT PRIMARY KEY,next_nonce INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS a423_nonce_reservations(scope TEXT NOT NULL,operation_id TEXT NOT NULL,nonce INTEGER NOT NULL,PRIMARY KEY(scope,operation_id),UNIQUE(scope,nonce));
    CREATE TABLE IF NOT EXISTS a423_kv(namespace TEXT NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(namespace,id));
    CREATE TABLE IF NOT EXISTS a423_queue(id TEXT PRIMARY KEY,kind TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL,available_at INTEGER NOT NULL,lease TEXT,lease_until INTEGER NOT NULL DEFAULT 0,attempts INTEGER NOT NULL DEFAULT 0,result TEXT);
    CREATE INDEX IF NOT EXISTS a423_queue_ready ON a423_queue(status,available_at,lease_until);
    CREATE TABLE IF NOT EXISTS a423_spend(id TEXT PRIMARY KEY,scope TEXT NOT NULL,amount TEXT NOT NULL,day TEXT NOT NULL,at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS a423_spend_scope ON a423_spend(scope,day);`);
  const atomic=fn=>{db.exec('BEGIN IMMEDIATE');try{const out=fn();db.exec('COMMIT');return out;}catch(e){db.exec('ROLLBACK');throw e;}};
  const kv={
    async get(namespace,id){const row=db.prepare('SELECT payload FROM a423_kv WHERE namespace=? AND id=?').get(namespace,id);return row?parse(row.payload):null;},
    async put(namespace,id,value){db.prepare('INSERT INTO a423_kv VALUES(?,?,?) ON CONFLICT(namespace,id) DO UPDATE SET payload=excluded.payload').run(namespace,id,json(value));},
    async create(namespace,id,value){return !!db.prepare('INSERT OR IGNORE INTO a423_kv VALUES(?,?,?)').run(namespace,id,json(value)).changes;},
    async take(namespace,id){return atomic(()=>{const row=db.prepare('SELECT payload FROM a423_kv WHERE namespace=? AND id=?').get(namespace,id);db.prepare('DELETE FROM a423_kv WHERE namespace=? AND id=?').run(namespace,id);return row?parse(row.payload):null;});},
    async list(namespace){return db.prepare('SELECT id,payload FROM a423_kv WHERE namespace=? ORDER BY id').all(namespace).map(r=>({id:r.id,value:parse(r.payload)}));}
  };
  const project=job=>{
    for(const event of job.events)db.prepare('INSERT OR IGNORE INTO a423_events(job_id,sequence,payload) VALUES(?,?,?)').run(job.id,event.sequence,json({...event,job_id:job.id}));
  };
  const jobs={
    async get(id){const r=db.prepare('SELECT payload FROM a423_jobs WHERE id=?').get(id);return r?parse(r.payload):null;},
    async create(job){return atomic(()=>{const r=db.prepare('INSERT OR IGNORE INTO a423_jobs VALUES(?,?,?)').run(job.id,job.version,json(job));if(r.changes)project(job);return !!r.changes;});},
    async compareAndSet(id,version,job){if(job.id!==id||job.version!==version+1)throw new Error('Invalid CAS record');return atomic(()=>{const r=db.prepare('UPDATE a423_jobs SET version=?,payload=? WHERE id=? AND version=?').run(job.version,json(job),id,version);if(r.changes)project(job);return !!r.changes;});},
    async list({actor,limit=100,after=''}={}){if(!Number.isInteger(limit)||limit<1||limit>1000)throw new TypeError('Invalid limit');const rows=db.prepare('SELECT payload FROM a423_jobs WHERE id>? ORDER BY id').all(after).map(r=>parse(r.payload));return rows.filter(j=>!actor||Object.values(j.participants).includes(actor)).slice(0,limit);},
    async events({actor,after=0,limit=100}={}){if(!actor||!Number.isSafeInteger(after)||after<0||!Number.isSafeInteger(limit)||limit<1||limit>1000)throw new TypeError('Invalid event query');return db.prepare('SELECT cursor,job_id,payload FROM a423_events WHERE cursor>? ORDER BY cursor').all(after).filter(r=>{const j=db.prepare('SELECT payload FROM a423_jobs WHERE id=?').get(r.job_id);return j&&Object.values(parse(j.payload).participants).includes(actor);}).slice(0,limit).map(r=>({cursor:r.cursor,...parse(r.payload)}));},
    async getSafety(id){return kv.get('safety',id);},
    async setSafety(id,value){return kv.put('safety',id,value);}
  };
  const transactions={
    async get(id){const r=db.prepare('SELECT payload FROM a423_transactions WHERE id=?').get(id);return r?parse(r.payload):null;},
    async create(id,record){return !!db.prepare('INSERT OR IGNORE INTO a423_transactions VALUES(?,?)').run(id,json(record)).changes;},
    async list(){return db.prepare('SELECT id,payload FROM a423_transactions ORDER BY id').all().map(r=>({id:r.id,...parse(r.payload)}));},
    async appendReplacement(id,expectedHash,replacement){return atomic(()=>{const row=db.prepare('SELECT payload FROM a423_transactions WHERE id=?').get(id);if(!row)throw Error('Unknown transaction');const record=parse(row.payload);if((record.replacements?.at(-1)?.hash||record.hash)!==expectedHash)throw Error('Replacement conflict');record.replacements=[...(record.replacements||[]),replacement];db.prepare('UPDATE a423_transactions SET payload=? WHERE id=?').run(json(record),id);});},
    async reserveNonce(scope,minimum,operationId){if(!Number.isSafeInteger(minimum)||minimum<0)throw new TypeError('Invalid nonce');return atomic(()=>{const old=db.prepare('SELECT nonce FROM a423_nonce_reservations WHERE scope=? AND operation_id=?').get(scope,operationId);if(old)return old.nonce;const row=db.prepare('SELECT next_nonce FROM a423_nonces WHERE scope=?').get(scope);const nonce=Math.max(minimum,row?.next_nonce||0);db.prepare('INSERT INTO a423_nonces VALUES(?,?) ON CONFLICT(scope) DO UPDATE SET next_nonce=excluded.next_nonce').run(scope,nonce+1);db.prepare('INSERT INTO a423_nonce_reservations VALUES(?,?,?)').run(scope,operationId,nonce);return nonce;});}
  };
  const queue={
    async enqueue({id,kind,payload,availableAt=Date.now()}){if(!id||!kind||!Number.isSafeInteger(availableAt))throw new TypeError('Invalid queue item');return !!db.prepare("INSERT OR IGNORE INTO a423_queue(id,kind,payload,status,available_at) VALUES(?,?,?,'ready',?)").run(id,kind,json(payload),availableAt).changes;},
    async claim({kind,leaseMs=30000,now=Date.now()}={}){if(!Number.isSafeInteger(leaseMs)||leaseMs<1||!Number.isSafeInteger(now))throw new TypeError('Invalid lease');return atomic(()=>{const row=db.prepare("SELECT * FROM a423_queue WHERE kind=? AND ((status='ready' AND available_at<=?) OR (status='leased' AND lease_until<=?)) ORDER BY available_at,id LIMIT 1").get(kind,now,now);if(!row)return null;const lease=randomUUID();db.prepare("UPDATE a423_queue SET status='leased',lease=?,lease_until=?,attempts=attempts+1 WHERE id=?").run(lease,now+leaseMs,row.id);return {id:row.id,kind:row.kind,payload:parse(row.payload),lease,attempts:row.attempts+1,result:row.result?parse(row.result):null};});},
    async heartbeat(id,lease,{leaseMs=30000,now=Date.now()}={}){return !!db.prepare("UPDATE a423_queue SET lease_until=? WHERE id=? AND lease=? AND status='leased' AND lease_until>?").run(now+leaseMs,id,lease,now).changes;},
    async checkpoint(id,lease,result,{now=Date.now()}={}){return !!db.prepare("UPDATE a423_queue SET result=? WHERE id=? AND lease=? AND status='leased' AND lease_until>?").run(json(result),id,lease,now).changes;},
    async complete(id,lease,result,{now=Date.now()}={}){return !!db.prepare("UPDATE a423_queue SET status='done',result=? WHERE id=? AND lease=? AND status='leased' AND lease_until>?").run(json(result),id,lease,now).changes;},
    async retry(id,lease,{delayMs=1000,now=Date.now(),maxAttempts=10}={}){return !!db.prepare("UPDATE a423_queue SET status=CASE WHEN attempts>=? THEN 'failed' ELSE 'ready' END, available_at=?,lease=NULL,lease_until=0 WHERE id=? AND lease=? AND status='leased' AND lease_until>?").run(maxAttempts,now+delayMs,id,lease,now).changes;},
    async get(id){const r=db.prepare('SELECT * FROM a423_queue WHERE id=?').get(id);return r?{id:r.id,kind:r.kind,payload:parse(r.payload),status:r.status,attempts:r.attempts,result:r.result?parse(r.result):null}:null;}
  };
  const spending={
    async reserve({id,scope,amount,perTransaction,daily,total,now=Date.now()}){
      const value=x=>{if(typeof x!=='string'||!/^(0|[1-9][0-9]*)$/.test(x))throw new TypeError('Use raw decimal amount strings');return BigInt(x);};
      const n=value(amount),day=new Date(now).toISOString().slice(0,10);if(!id||!scope)throw new TypeError('Spend identity/scope required');
      return atomic(()=>{const old=db.prepare('SELECT * FROM a423_spend WHERE id=?').get(id);if(old){if(old.scope!==scope||old.amount!==amount)throw Error('Spending idempotency conflict');}
        const rows=db.prepare('SELECT amount,day FROM a423_spend WHERE scope=? AND id<>?').all(scope,id);const all=rows.reduce((a,r)=>a+BigInt(r.amount),0n),today=rows.filter(r=>r.day===day).reduce((a,r)=>a+BigInt(r.amount),0n);
        if(perTransaction===undefined||daily===undefined||total===undefined)throw Error('Explicit per-transaction, daily and total caps required');
        if(n>value(perTransaction)||n+today>value(daily)||n+all>value(total)){const error=Error('Spending limit exceeded');error.code='SPENDING_LIMIT_EXCEEDED';throw error;}
        db.prepare('INSERT INTO a423_spend VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET day=excluded.day,at=excluded.at').run(id,scope,amount,day,now);return true;});
    },
    // Conservative reservations persist after approvals and uncertain outcomes. Release only after external reconciliation.
    async list(scope){return db.prepare('SELECT * FROM a423_spend WHERE scope=? ORDER BY at,id').all(scope);},
    async release(id){db.prepare('DELETE FROM a423_spend WHERE id=?').run(id);}
  };
  return {jobs,transactions,queue,spending,kv,
    async resetDevelopmentData({chainId,confirm,assertChainReset,includeAuthority=false,dryRun=true}={}){
      if(![1337,31337].includes(chainId)||confirm!=='RESET_LOCAL_A423'||typeof assertChainReset!=='function'||await assertChainReset()!==true)throw Error('Reset requires confirmed local chain reset');
      const tables=['a423_jobs','a423_events','a423_transactions','a423_nonces','a423_nonce_reservations','a423_queue','a423_spend'];
      const counts=Object.fromEntries(tables.map(name=>[name,db.prepare('SELECT COUNT(*) AS n FROM '+name).get().n]));
      if(!dryRun)atomic(()=>{for(const name of tables)db.exec('DELETE FROM '+name);if(includeAuthority)db.exec('DELETE FROM a423_kv');else db.exec("DELETE FROM a423_kv WHERE namespace NOT LIKE 'authority:%'");});
      return {dryRun,counts,includeAuthority};
    },close(){db.close();}};
}
module.exports={createSqliteStorage};
