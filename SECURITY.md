# Security policy

Experimental SDK; no independent audit or stable support commitment. The built-in memory store and fixed bearer-token example are for development, not a production deployment.

Authentication must be supplied. Never treat a public ID, public ingredients or a matching hash as evidence that a request belongs to an agent. Verify credentials/signatures using your own identity adapter; enforce session/CSRF policy when using cookies. Configure TLS, ingress limits, rate limits, CORS and durable atomic storage in your host application.

Settlement adapters must durably deduplicate the SDK's stable key across retries and concurrent calls. This SDK does not fund escrow, establish mandates, custody keys or guarantee exactly-once payments. Validate recipient, amount, permission and provider status independently. Completion without an adapter explicitly means no settlement is configured.

Do not include tokens, private keys, customer data or live exploit details in public reports. Use a private repository reporting channel when configured; maintainers should establish one before requesting sensitive reports. Never log credentials. No private security contact is invented by this initial package.
