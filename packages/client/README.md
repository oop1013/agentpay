# @agentpay/client

Fetch wrapper that auto-detects 402 Payment Required responses, pays via x402, and retries.

## Install

```bash
npm install @agentpay/client
```

## Usage

```ts
import { createAgentPayClient } from "@agentpay/client";

const client = createAgentPayClient({
  callerWallet: "0xYourWalletAddress",
  signPayment: async (requirements) => mySignX402(requirements),
});

const res = await client.fetch("https://api.example.com/protected-endpoint");
```
