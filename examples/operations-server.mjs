// Runnable application shell. The configuration module supplies real application policies/services.
// A423_CONFIG_MODULE=/absolute/path/to/config.mjs node examples/operations-server.mjs
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createApplicationHandler } from '../src/operations/application.cjs';
if(!process.env.A423_CONFIG_MODULE)throw Error('A423_CONFIG_MODULE must export a configured applicationOptions object; no demo keys/bootstrap are enabled');
const {applicationOptions}=await import(pathToFileURL(process.env.A423_CONFIG_MODULE).href);
const handler=createApplicationHandler(applicationOptions);
const server=http.createServer(async(req,res)=>{
 try{
  if(req.method==='GET'&&req.url==='/'){res.writeHead(200,{'content-type':'text/html; charset=utf-8','content-security-policy':"default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'"});res.end(await readFile(new URL('./operations-dashboard.html',import.meta.url)));return;}
  const ac=new AbortController();res.on('close',()=>ac.abort());
  const request=new Request('http://localhost'+req.url,{method:req.method,headers:req.headers,body:['GET','HEAD'].includes(req.method)?undefined:req,duplex:'half',signal:ac.signal});
  const response=await handler(request);res.writeHead(response.status,Object.fromEntries(response.headers));
  if(response.body){for await(const chunk of response.body){if(res.destroyed)break;if(!res.write(Buffer.from(chunk)))await new Promise(resolve=>res.once('drain',resolve));}}res.end();
 }catch{if(!res.headersSent)res.writeHead(500);res.end('Request failed');}
});
server.listen(Number(process.env.PORT||3000),'127.0.0.1',()=>console.log('A423 application shell on http://127.0.0.1:'+server.address().port));
