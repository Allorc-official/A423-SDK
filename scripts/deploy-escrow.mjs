// Dry-run by default. Explicit --broadcast deploys; --verify submits published sources to Sourcify.
import fs from 'node:fs/promises';
import {JsonRpcProvider,Wallet,ContractFactory,getAddress} from 'ethers';
import escrow from '../src/escrow/index.cjs';
const args=new Set(process.argv.slice(2));
const chainId=Number(process.env.A423_CHAIN_ID),token=getAddress(process.env.A423_TOKEN_ADDRESS);
if(!Number.isSafeInteger(chainId)||chainId<=0)throw Error('Explicit A423_CHAIN_ID required');
const provider=new JsonRpcProvider(process.env.A423_RPC_URL);if(Number((await provider.getNetwork()).chainId)!==chainId)throw Error('RPC chain mismatch');
if(await provider.getCode(token)==='0x')throw Error('Token has no code');
if(!args.has('--broadcast')){console.log(JSON.stringify({dryRun:true,chainId,token,bytecodeBytes:(escrow.ESCROW_BYTECODE.length-2)/2}));process.exit(0);}
if(!process.env.A423_DEPLOYER_KEY)throw Error('A423_DEPLOYER_KEY required for explicit deployment');
const signer=new Wallet(process.env.A423_DEPLOYER_KEY,provider),factory=new ContractFactory(escrow.ESCROW_ABI,escrow.ESCROW_BYTECODE,signer);
const contract=await factory.deploy(token);const receipt=await contract.deploymentTransaction().wait(Number(process.env.A423_CONFIRMATIONS||1));
const address=await contract.getAddress();const result={chainId,token,address,transaction:receipt.hash,verification:'not_requested'};
await fs.writeFile(process.env.A423_DEPLOYMENT_FILE||'a423-deployment.json',JSON.stringify(result,null,2)+'\n',{mode:0o600});
if(args.has('--verify')){
 const stdJsonInput=JSON.parse(await fs.readFile(new URL('../contracts/standard-input.json',import.meta.url),'utf8'));
 const artifact=JSON.parse(await fs.readFile(new URL('../src/escrow/artifact.json',import.meta.url),'utf8'));
 const response=await fetch(`https://sourcify.dev/server/v2/verify/${chainId}/${address}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({stdJsonInput,compilerVersion:artifact.compiler.split('.Emscripten')[0],contractIdentifier:'A423Escrow.sol:A423Escrow',creationTransactionHash:receipt.hash}),redirect:'error',signal:AbortSignal.timeout(30000)});
 const verification=await response.json();if(!response.ok)throw Error('Deployed, but source verification submission failed: '+response.status);
 result.verification='submitted';result.verificationRequest=verification;
 await fs.writeFile(process.env.A423_DEPLOYMENT_FILE||'a423-deployment.json',JSON.stringify(result,null,2)+'\n',{mode:0o600});
}
console.log(JSON.stringify(result));
