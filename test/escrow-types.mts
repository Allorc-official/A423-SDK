import { JsonRpcProvider, Wallet } from 'ethers';
import { createWorkflow, type WorkflowStore } from '@allorc/a423-sdk/workflow';
import { createEscrowAdapters, createMemoryTransactionStore, escrowTransitions, workerConsent, ESCROW_ABI, ESCROW_BYTECODE } from '@allorc/a423-sdk/escrow';
declare const store: WorkflowStore;
const provider=new JsonRpcProvider('http://localhost:8545');
const config={chainId:31337,contractAddress:'0x0000000000000000000000000000000000000001',tokenAddress:'0x0000000000000000000000000000000000000002'};
const adapters=createEscrowAdapters({provider,...config,transactions:createMemoryTransactionStore(),confirmations:2,signerFor:async()=>Wallet.createRandom().connect(provider),addressFor:async()=> '0x0000000000000000000000000000000000000003',validateArtifact:async()=>true});
const workflow=createWorkflow({store,adapters,transitions:escrowTransitions});
async function consent(){const j=await workflow.get('job','worker');return workerConsent(j,config);}
void consent;void ESCROW_ABI;void ESCROW_BYTECODE;
