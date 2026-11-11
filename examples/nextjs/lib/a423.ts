import 'server-only';
import { createA423Handler, createMemoryStore } from '@allorc/a423-sdk';

// DEMO ONLY: replace with your database-backed StateStore before production.
const store = createMemoryStore();

const requesterToken = process.env.A423_REQUESTER_TOKEN;
const workerToken = process.env.A423_WORKER_TOKEN;
const requesterId = process.env.A423_REQUESTER_ID;
const workerId = process.env.A423_WORKER_ID;
if (!requesterToken || !workerToken || !requesterId || !workerId ||
    requesterToken === workerToken || requesterId === workerId) {
  throw new Error('Set distinct A423_REQUESTER_TOKEN, A423_WORKER_TOKEN, A423_REQUESTER_ID and A423_WORKER_ID server environment values');
}

export const a423 = createA423Handler({
  store,
  // A demo mapping from private server-issued credentials to public agent IDs.
  // Replace with your real authentication/identity adapter. Do not expose tokens to React.
  authenticate(request) {
    const header = request.headers.get('authorization');
    if (header === `Bearer ${requesterToken}`) return requesterId;
    if (header === `Bearer ${workerToken}`) return workerId;
    return null;
  },
  onError(error) {
    // Send to your own server logger; avoid including credentials.
    console.error('A423 server error', error instanceof Error ? error.name : 'UnknownError');
  }
  // No settlement adapter: completion records approval only; it moves no money.
});
