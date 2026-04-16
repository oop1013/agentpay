export const DEFAULT_PLATFORM_FEE_BPS = 100; // 1%

/**
 * Compute platform fee from gross amount using integer arithmetic.
 * platformFee = floor(grossAmount * feeBps / 10000)
 */
export function computePlatformFee(grossAmount: number, feeBps: number): number {
  return Math.floor(grossAmount * feeBps / 10000);
}

/**
 * Compute provider net after platform fee deduction.
 * providerNet = grossAmount - platformFee
 */
export function computeProviderNet(grossAmount: number, feeBps: number): number {
  return grossAmount - computePlatformFee(grossAmount, feeBps);
}

/**
 * Validate that a service price produces a positive provider net.
 */
export function isValidPrice(pricePerCall: number, feeBps: number): boolean {
  if (pricePerCall <= 0 || !Number.isInteger(pricePerCall)) return false;
  return computeProviderNet(pricePerCall, feeBps) > 0;
}
