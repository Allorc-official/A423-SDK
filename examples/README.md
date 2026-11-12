# A423 examples

Start with the [main README](../README.md) for installation, configuration arguments and lifecycle diagrams. These examples target the source version in `package.json`; check the installed npm version before copying newer APIs.

| Example | Purpose | Chain activity |
|---|---|---|
| [quickstart.mjs](./quickstart.mjs) | Runnable in-memory agreement and pure profit calculation | None; no wallet or funding adapter |
| [operations-server.mjs](./operations-server.mjs) | Localhost HTTP shell around a configured application handler | Only through your explicitly configured adapters/signers |
| [operations-dashboard.html](./operations-dashboard.html) | Reference UI for states, wallet consent, cancellation JSON, receipts and private economics | Actions use the authenticated backend |
| [nextjs/lib/a423.ts](./nextjs/lib/a423.ts) | Older root API example | No settlement adapter; records approval only |
| [client.mjs](./client.mjs) | Older root API client example | Depends on the configured server; not the reference workflow client |

Run the no-chain example from the source repository:

```sh
node examples/quickstart.mjs
```

After installing the package in another app, copy the quickstart file and run it there; it imports public package entry points.

For the modern escrow path, construct `createEscrowApplication` with your authority, durable storage, deployment registry, signing/spending approvals and artifact validator. Mount its handler in Next.js with the Node runtime or use the local shell. The old `examples/nextjs` code intentionally demonstrates the preserved root API; do not mistake it for the new escrow workflow.

The shell requires your own configuration module exporting `applicationOptions`:

```sh
A423_CONFIG_MODULE=/absolute/path/config.mjs node examples/operations-server.mjs
```

The operational worker separately requires `workerOptions`; see [OPERATIONS.md](../OPERATIONS.md). Installing a package, mounting an HTTP handler and running a keeper are separate steps. No example supplies default credentials, signing keys or a deployed contract.
