// Run after starting the Next.js example and setting the same server credentials.
import { createA423Client } from '../src/index.mjs';
import { randomUUID } from 'node:crypto';

for (const name of ['A423_REQUESTER_TOKEN', 'A423_WORKER_TOKEN', 'A423_WORKER_ID']) {
  if (!process.env[name]) throw new Error(`Set ${name} before running this example`);
}
const baseUrl = process.env.A423_BASE_URL || 'http://localhost:3000/api/a423';
const requester = createA423Client({ baseUrl, headers: { authorization: `Bearer ${process.env.A423_REQUESTER_TOKEN}` } });
const worker = createA423Client({ baseUrl, headers: { authorization: `Bearer ${process.env.A423_WORKER_TOKEN}` } });
const job = await requester.offer({
  worker_id: process.env.A423_WORKER_ID,
  title: 'Prepare a short brief', description: 'Return a link to the completed brief.',
  price: { amount_minor: 500, currency: 'USD' }
}, { idempotencyKey: randomUUID() }); // Persist this key if retrying this logical offer.
await worker.accept(job.id);
await worker.submit(job.id, { deliverable: 'https://example.com/brief.md' });
await requester.approve(job.id);
console.log(JSON.stringify(await requester.receipts(job.id), null, 2));
