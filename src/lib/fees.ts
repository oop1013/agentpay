import { DEFAULT_PLATFORM_FEE_BPS, computePlatformFee, computeProviderNet } from "./money";

export interface FeeBreakdown {
  grossAmount: number;
  platformFee: number;
  providerNet: number;
  feeBps: number;
}

/**
 * Compute full fee breakdown for a given gross amount.
 */
export function computeFeeBreakdown(
  grossAmount: number,
  feeBps: number = DEFAULT_PLATFORM_FEE_BPS
): FeeBreakdown {
  return {
    grossAmount,
    platformFee: computePlatformFee(grossAmount, feeBps),
    providerNet: computeProviderNet(grossAmount, feeBps),
    feeBps,
  };
}
