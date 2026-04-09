const X402_PAYMENT_HEADER = "x-402-payment";
const X402_CALLER_HEADER = "x-402-caller";

export interface AgentPayClientConfig {
  /** Caller wallet address used for identification and authorization */
  callerWallet: string;
  /**
   * Sign a payment for the given x402 requirements.
   * Returns a payment proof string to attach as the x-402-payment header.
   * In Phase 1, this can return any non-empty string for testing.
   * In production, this will sign a real x402 USDC payment on Base.
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
