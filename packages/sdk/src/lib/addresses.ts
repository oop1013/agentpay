/**
 * Normalize a wallet address to lowercase for consistent storage and comparison.
 */
export function normalizeAddress(address: string): string {
  return address.toLowerCase().trim();
}

/**
 * Check if a string looks like a valid Ethereum-style address.
 */
export function isValidAddress(address: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(address.trim());
}
