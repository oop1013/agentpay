import { privateKeyToAccount } from "viem/accounts";

const X402_PAYMENT_HEADER = "x-402-payment";
const X402_CALLER_HEADER = "x-402-caller";

// EIP-712 domain for USDC on Base Sepolia (chainId 84532)
const USDC_DOMAIN = {
  name: "USD Coin",
  version: "2",
  chainId: 84532,
  verifyingContract: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const,
} as const;

const RECEIVE_WITH_AUTH_TYPES = {
  ReceiveWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

/**
 * Creates a signPayment callback that produces real EIP-712 signed proofs
 * compatible with verifyX402Proof() on the server.
 *
 * Uses ERC-3009 ReceiveWithAuthorization typed data signed with the caller's
 * private key. The proof is base64-encoded JSON.
 *
 * @param privateKey - Hex private key of the caller wallet (0x-prefixed)
 */
export function createEIP712Signer(privateKey: `0x${string}`) {
  const account = privateKeyToAccount(privateKey);

  return async (requirements: X402Requirements): Promise<string> => {
    const nowSec = Math.floor(Date.now() / 1000);
    const nonceBytes = crypto.getRandomValues(new Uint8Array(32));
    const nonce = `0x${Array.from(nonceBytes).map(b => b.toString(16).padStart(2, "0")).join("")}` as `0x${string}`;

    const message = {
      from: account.address,
      to: requirements.payTo as `0x${string}`,
      value: BigInt(requirements.amount),
      validAfter: BigInt(0),
      validBefore: BigInt(nowSec + 300),
      nonce,
    };

    const signature = await account.signTypedData({
      domain: USDC_DOMAIN,
      types: RECEIVE_WITH_AUTH_TYPES,
      primaryType: "ReceiveWithAuthorization",
      message,
    });

    const proof = {
      from: account.address,
      to: requirements.payTo,
      value: String(requirements.amount),
      validAfter: "0",
      validBefore: String(nowSec + 300),
      nonce,
      signature,
      chainId: 84532,
    };

    return Buffer.from(JSON.stringify(proof)).toString("base64");
  };
}

export interface AgentPayClientConfig {
  /** Caller wallet address used for identification and authorization */
  callerWallet: string;
  /**
   * Sign a payment for the given x402 requirements.
   * Returns a base64-encoded JSON proof string to attach as the x-402-payment header.
   * Use createEIP712Signer(privateKey) to create a real signer.
   */
  signPayment: (requirements: X402Requirements) => Promise<string>;
  /** Maximum number of times to retry after a 402. Defaults to 1. */
  maxRetries?: number;
}

export interface X402Requirements {
  version: string;
  description: string;
  payTo: string;
  amount: number;
  requiredHeaders: string[];
}

export interface PaymentRequiredResponse {
  status: 402;
  message: string;
  serviceId: string;
  serviceName: string;
  pricePerCall: number;
  providerWallet: string;
  network: string;
  token: string;
  x402: X402Requirements;
}

/**
 * Creates a wrapped fetch function that auto-detects 402 Payment Required
 * responses, pays via x402, and retries the original request.
 *
 * Usage:
 *   const client = createAgentPayClient({
 *     callerWallet: "0x...",
 *     signPayment: async (req) => "signed-proof-string",
 *   });
 *
 *   const res = await client.fetch("https://api.example.com/protected");
 */
export function createAgentPayClient(config: AgentPayClientConfig) {
  const { callerWallet, signPayment, maxRetries = 1 } = config;

  async function agentPayFetch(
    input: string | URL | Request,
    init?: RequestInit
  ): Promise<Response> {
    let attempts = 0;
    let lastResponse: Response;

    while (attempts <= maxRetries) {
      lastResponse = await fetch(input, init);

      if (lastResponse.status !== 402) {
        return lastResponse;
      }

      attempts++;
      if (attempts > maxRetries) {
        return lastResponse;
      }

      // Parse 402 payment requirements
      let body: PaymentRequiredResponse;
      try {
        body = await lastResponse.json() as PaymentRequiredResponse;
      } catch {
        return lastResponse;
      }

      if (!body.x402) {
        return lastResponse;
      }

      // Sign the payment
      let paymentProof: string;
      try {
        paymentProof = await signPayment(body.x402);
      } catch (err) {
        throw new AgentPayError(
          `Failed to sign payment for ${body.serviceName}: ${err}`,
          body
        );
      }

      // Retry with payment proof headers
      const retryHeaders = new Headers(init?.headers);
      retryHeaders.set(X402_PAYMENT_HEADER, paymentProof);
      retryHeaders.set(X402_CALLER_HEADER, callerWallet);

      init = {
        ...init,
        headers: retryHeaders,
      };
    }

    return lastResponse!;
  }

  return {
    fetch: agentPayFetch,
    callerWallet,
  };
}

export class AgentPayError extends Error {
  public readonly paymentDetails: PaymentRequiredResponse;

  constructor(message: string, paymentDetails: PaymentRequiredResponse) {
    super(message);
    this.name = "AgentPayError";
    this.paymentDetails = paymentDetails;
  }
}
