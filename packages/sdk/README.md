# @agentpay/sdk

Express middleware for protecting API endpoints with x402 micropayments.

## Install

```bash
npm install @agentpay/sdk express
```

## Usage

```ts
import express from "express";
import { paywall } from "@agentpay/sdk";

const app = express();

app.get("/api/data", paywall({ serviceId: "svc_xxx" }), (req, res) => {
  res.json({ result: "protected data" });
});
```

Set env vars `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` to connect to your Redis instance.
