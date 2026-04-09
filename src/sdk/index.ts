// Server-side: Express middleware for protecting endpoints
export { paywall } from "./paywall";
export type { PaywallConfig } from "./paywall";

// Client-side: fetch wrapper for auto-paying 402 responses
export { createAgentPayClient, createEIP712Signer, AgentPayError } from "./client";
export type {
  AgentPayClientConfig,
  X402Requirements,
  PaymentRequiredResponse,
} from "./client";
