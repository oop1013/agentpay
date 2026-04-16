# @agentpay88/client

Fetch wrapper that auto-detects `402 Payment Required` responses, signs an EIP-712 payment proof, and retries the request automatically.

## Install

```bash
npm install @agentpay88/client viem
```

## Quickstart

### 1. Build a `signPayment` function

The critical piece. You must produce a base64-encoded ERC-3009 `ReceiveWithAuthorization` proof signed via EIP-712. The helper `createEIP712Signer` does this for you with a raw private key:

```ts
import { createEIP712Signer, createAgentPayClient } from "@agentpay88/client";

// createEIP712Signer takes a 0x-prefixed private key and returns
// a signPayment function ready to pass into createAgentPayClient.
const signPayment = createEIP712Signer("0xYourPrivateKey");

const client = createAgentPayClient({
  callerWallet: "0xYourWalletAddress",
  signPayment,
});

const res = await client.fetch("https://your-agentpay-api.com/api/generate");
const data = await res.json();
```

### 2. Use a viem wallet client (browser / wagmi)

If you have a viem `WalletClient` (e.g. from wagmi's `useWalletClient`), construct `signPayment` directly:

```ts
import { createAgentPayClient } from "@agentpay88/client";
import { createWalletClient, custom } from "viem";
import { baseSepolia } from "viem/chains";

// EIP-712 domain for USDC on Base Sepolia
const USDC_DOMAIN = {
  name: "USD Coin",
  version: "2",
  chainId: 84532,
  verifyingContract: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
} as const;

const RECEIVE_WITH_AUTH_TYPES = {
  ReceiveWithAuthorization: [
    { name: "from",        type: "address" },
    { name: "to",          type: "address" },
    { name: "value",       type: "uint256" },
    { name: "validAfter",  type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce",       type: "bytes32" },
  ],
} as const;

const walletClient = createWalletClient({
  chain: baseSepolia,
  transport: custom(window.ethereum),
});

const [account] = await walletClient.getAddresses();

async function signPayment(requirements: { payTo: string; amount: number }) {
  const nowSec = Math.floor(Date.now() / 1000);

  // Generate a random 32-byte nonce
  const nonceBytes = crypto.getRandomValues(new Uint8Array(32));
  const nonce = `0x${Array.from(nonceBytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}` as `0x${string}`;

  const message = {
    from:        account,
    to:          requirements.payTo as `0x${string}`,
    value:       BigInt(requirements.amount),
    validAfter:  BigInt(0),
    validBefore: BigInt(nowSec + 300),  // 5-minute validity window
    nonce,
  };

  const signature = await walletClient.signTypedData({
    account,
    domain: USDC_DOMAIN,
    types:  RECEIVE_WITH_AUTH_TYPES,
    primaryType: "ReceiveWithAuthorization",
    message,
  });

  const proof = {
    from:        account,
    to:          requirements.payTo,
    value:       String(requirements.amount),
    validAfter:  "0",
    validBefore: String(nowSec + 300),
    nonce,
    signature,
    chainId: 84532,
  };

  return Buffer.from(JSON.stringify(proof)).toString("base64");
}

const client = createAgentPayClient({
  callerWallet: account,
  signPayment,
});

const res = await client.fetch("https://your-agentpay-api.com/api/generate");
```

## How it works

1. `client.fetch(url)` makes the request as normal.
2. If the response is `402 Payment Required`, the client reads the `x402` requirements from the body.
3. It calls `signPayment(requirements)` to produce a base64-encoded EIP-712 proof.
4. It retries the original request with two additional headers:
   - `x-402-payment`: the signed proof
   - `x-402-caller`: your wallet address
5. The server verifies the proof and, if valid, returns the real response.

## EIP-712 proof structure

The proof is a base64-encoded JSON object:

```ts
{
  from:        string;  // signer address (checksummed)
  to:          string;  // provider wallet (payTo)
  value:       string;  // amount in micro-USDC (integer as string)
  validAfter:  string;  // unix seconds — use "0"
  validBefore: string;  // unix seconds — set ~5 minutes in the future
  nonce:       string;  // random 0x-prefixed 32-byte hex
  signature:   string;  // EIP-712 typed-data signature (0x-prefixed)
  chainId:     number;  // 84532 = Base Sepolia
}
```

The server verifies this with `ecrecover` against the `ReceiveWithAuthorization` typed-data hash. The `from` address must match `x-402-caller`.

## API

### `createEIP712Signer(privateKey)`

```ts
function createEIP712Signer(
  privateKey: `0x${string}`
): (requirements: X402Requirements) => Promise<string>
```

Convenience factory for server-side or scripted usage. Returns a `signPayment` function.

### `createAgentPayClient(config)`

```ts
interface AgentPayClientConfig {
  callerWallet: string;
  signPayment: (requirements: X402Requirements) => Promise<string>;
  maxRetries?: number;  // default: 1
}

function createAgentPayClient(config: AgentPayClientConfig): {
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  callerWallet: string;
}
```

### `X402Requirements`

```ts
interface X402Requirements {
  version: string;
  description: string;
  payTo: string;
  amount: number;       // micro-USDC integer
  requiredHeaders: string[];
}
```

### `AgentPayError`

Thrown when `signPayment` fails. Contains `paymentDetails` with the full `402` response body.

## License

ISC
