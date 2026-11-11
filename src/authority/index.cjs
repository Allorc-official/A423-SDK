'use strict';
const {createPublicKey,sign,verify,randomBytes,createHash}=require('node:crypto');
const encode=x=>Buffer.from(JSON.stringify(x)).toString('base64url');
const fingerprint=key=>createHash('sha256').update(createPublicKey(key).export({type:'spki',format:'der'})).digest('hex');
function requireValue(ok,message){if(!ok)throw Error(message);}
function publicKey(pem){const key=createPublicKey(pem);requireValue(key.asymmetricKeyType==='ed25519','Ed25519 public key required');return key;}
function createAuthority({issuer,audience,privateKey,kv,credentialTtlSeconds=3600,challengeTtlSeconds=120,now=()=>Date.now()}={}){
 requireValue(issuer&&audience&&privateKey&&kv,'Authority configuration required');publicKey(createPublicKey(privateKey).export({type:'spki',format:'pem'}));
 requireValue(Number.isInteger(credentialTtlSeconds)&&credentialTtlSeconds>0&&credentialTtlSeconds<=86400,'Credential TTL must be 1..86400 seconds');
 requireValue(Number.isInteger(challengeTtlSeconds)&&challengeTtlSeconds>0&&challengeTtlSeconds<=600,'Challenge TTL must be 1..600 seconds');
 const ns='authority:'+issuer+':'+audience;
 const read=(kind,id)=>kv.get(ns+':'+kind,id),put=(kind,id,v)=>kv.put(ns+':'+kind,id,v);
 const safe=x=>requireValue(typeof x==='string'&&/^[A-Za-z0-9:_-]{1,256}$/.test(x),'Invalid identity');
 async function records(agentId){const agent=await read('agents',agentId);requireValue(agent&&!agent.revoked,'Unknown/revoked agent');const org=await read('organizations',agent.organization);requireValue(org&&!org.revoked,'Unknown/revoked organization');return {agent,org};}
 const registration=({organization,agentId,publicKey: key,scopes})=>({version:'a423.enrollment.v1',issuer,audience,organization,agent_id:agentId,key_fingerprint:fingerprint(key),scopes:[...scopes].sort()});
 return {
  publicKey:createPublicKey(privateKey).export({type:'spki',format:'pem'}),
  registration,
  async isActive(agentId){try{await records(agentId);return true;}catch{return false;}},
  /** Administrative capability: perform real-world approval outside this module before calling. */
  async registerOrganization({id,name,publicKey:key}){safe(id);requireValue(typeof name==='string'&&name.trim()&&name.length<=256,'Organization name required');publicKey(key);requireValue(await kv.create(ns+':organizations',id,{id,name,publicKey:key,revoked:false}),'Organization already registered');},
  async revokeOrganization(id){const org=await read('organizations',id);requireValue(org,'Unknown organization');await put('organizations',id,{...org,revoked:true});},
  async registerAgent({organization,agentId,publicKey:key,scopes=['workflow'],organizationSignature}){
   safe(agentId);const org=await read('organizations',organization);requireValue(org&&!org.revoked,'Organization not approved');publicKey(key);
   requireValue(Array.isArray(scopes)&&scopes.length>0&&scopes.length<=64&&scopes.every(s=>typeof s==='string'&&/^[a-z0-9:_-]{1,128}$/.test(s)),'Invalid scopes');
   const statement=registration({organization,agentId,publicKey:key,scopes});
   requireValue(verify(null,Buffer.from(JSON.stringify(statement)),publicKey(org.publicKey),Buffer.from(organizationSignature,'base64url')),'Invalid organization enrollment signature');
   requireValue(await kv.create(ns+':agents',agentId,{id:agentId,organization,publicKey:key,scopes:[...new Set(scopes)],revoked:false}),'Agent already registered');
  },
  async revokeAgent(agentId){const agent=await read('agents',agentId);requireValue(agent,'Unknown agent');await put('agents',agentId,{...agent,revoked:true});},
  async challenge(agentId){const {agent}=await records(agentId);const id=randomBytes(32).toString('base64url');const statement={version:'a423.challenge.v1',issuer,audience,id,agent_id:agentId,key_fingerprint:fingerprint(agent.publicKey),expires_at:Math.floor(now()/1000)+challengeTtlSeconds};await kv.create(ns+':challenges',id,statement);return statement;},
  async exchange({challengeId,signature}){
   safe(challengeId);const challenge=await kv.take(ns+':challenges',challengeId);requireValue(challenge&&challenge.expires_at>Math.floor(now()/1000),'Challenge expired, consumed or unknown');const {agent}=await records(challenge.agent_id);
   requireValue(verify(null,Buffer.from(JSON.stringify(challenge)),publicKey(agent.publicKey),Buffer.from(signature,'base64url')),'Invalid challenge signature');
   const issued=Math.floor(now()/1000);const payload={version:'a423.credential.v1',iss:issuer,aud:audience,sub:agent.id,org:agent.organization,key_fingerprint:fingerprint(agent.publicKey),scopes:agent.scopes,iat:issued,exp:issued+credentialTtlSeconds,jti:randomBytes(24).toString('base64url')};const content=encode(payload);return {credential:content+'.'+sign(null,Buffer.from(content),privateKey).toString('base64url'),expires_at:payload.exp};
  },
  async verifyCredential(credential,{scope='workflow'}={}){
   requireValue(typeof credential==='string'&&credential.length<=16000,'Invalid credential');const parts=credential.split('.');requireValue(parts.length===2,'Invalid credential encoding');
   requireValue(verify(null,Buffer.from(parts[0]),createPublicKey(privateKey),Buffer.from(parts[1],'base64url')),'Invalid authority signature');
   const p=JSON.parse(Buffer.from(parts[0],'base64url').toString('utf8'));const time=Math.floor(now()/1000);
   requireValue(p.version==='a423.credential.v1'&&p.iss===issuer&&p.aud===audience&&Number.isSafeInteger(p.exp)&&Number.isSafeInteger(p.iat)&&p.iat<=time&&p.exp>time&&p.exp-p.iat<=credentialTtlSeconds,'Expired or invalid credential');
   const {agent}=await records(p.sub);requireValue(p.org===agent.organization&&p.key_fingerprint===fingerprint(agent.publicKey)&&p.scopes.includes(scope)&&agent.scopes.includes(scope),'Credential binding/scope mismatch');return p;
  },
  async pruneChallenges(){let removed=0;for(const r of await kv.list(ns+':challenges'))if(r.value.expires_at<=Math.floor(now()/1000)){await kv.take(ns+':challenges',r.id);removed++;}return removed;}
 };
}
function createCredentialAuthenticator({authority,scope='workflow'}={}){return async request=>{const h=request.headers.get('authorization')||'';if(!h.startsWith('Bearer '))return null;try{return (await authority.verifyCredential(h.slice(7),{scope})).sub;}catch{return null;}};}
/** Renew using a fresh proof of possession. Never prolong a credential from a bearer token alone. */
function createCredentialProvider({agentId,challenge,exchange,signChallenge,refreshBeforeSeconds=60,now=()=>Date.now()}={}){
 let current=null,inflight=null;
 return async()=>{
  if(current&&current.expires_at-Math.floor(now()/1000)>refreshBeforeSeconds)return current.credential;
  if(!inflight)inflight=(async()=>{const c=await challenge(agentId);const signature=await signChallenge(Buffer.from(JSON.stringify(c)));current=await exchange({challengeId:c.id,signature});return current.credential;})().finally(()=>{inflight=null;});
  return inflight;
 };
}
module.exports={createAuthority,createCredentialAuthenticator,createCredentialProvider};
/** Public proof endpoints only. Administrative enrollment is deliberately not exposed. */
function createAuthorityHandler({authority,basePath='/api/a423-auth',allowRequest=async()=>false}={}){
 return async request=>{
  const path=new URL(request.url).pathname;
  if(request.method!=='POST'||![basePath+'/challenge',basePath+'/exchange'].includes(path))return Response.json({error:'not found'},{status:404});
  if(await allowRequest(request)!==true)return Response.json({error:'rate limit or policy denied'},{status:429});
  try{if(!request.body||!(request.headers.get('content-type')||'').startsWith('application/json'))throw Error('JSON required');const reader=request.body.getReader();let size=0;const chunks=[];try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>16384){await reader.cancel();throw Error('Body too large');}chunks.push(Buffer.from(value));}}finally{reader.releaseLock();}const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
   const result=path.endsWith('/challenge')?await authority.challenge(body.agent_id):await authority.exchange(body);
   return Response.json(result,{headers:{'cache-control':'no-store'}});
  }catch{return Response.json({error:'invalid proof or request'},{status:400});}
 };
}
module.exports.createAuthorityHandler=createAuthorityHandler;
/** Receiver-side verification uses public trust roots and a revocation/status lookup, never the authority private key. */
function createCredentialVerifier({issuer,audience,publicKey:trustedKey,isActive,maxTtlSeconds=86400,now=()=>Date.now()}={}){
 const key=publicKey(trustedKey);requireValue(typeof isActive==='function','Explicit revocation/status lookup required');
 return async(credential,{scope='workflow'}={})=>{
  requireValue(typeof credential==='string'&&credential.length<=16000,'Invalid credential');const parts=credential.split('.');requireValue(parts.length===2&&verify(null,Buffer.from(parts[0]),key,Buffer.from(parts[1],'base64url')),'Invalid authority signature');
  const p=JSON.parse(Buffer.from(parts[0],'base64url').toString('utf8')),time=Math.floor(now()/1000);
  requireValue(p.version==='a423.credential.v1'&&p.iss===issuer&&p.aud===audience&&Number.isSafeInteger(p.exp)&&Number.isSafeInteger(p.iat)&&p.iat<=time&&p.exp>time&&p.exp-p.iat<=maxTtlSeconds&&Array.isArray(p.scopes)&&p.scopes.includes(scope),'Expired or invalid credential');
  requireValue(await isActive(p)===true,'Agent/organization revoked or unavailable');return p;
 };
}
module.exports.createCredentialVerifier=createCredentialVerifier;
