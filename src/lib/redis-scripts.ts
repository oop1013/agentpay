import { redis } from "./redis";

/**
 * Lua script that atomically checks the spend cap and reserves the amount.
 *
 * KEYS[1] = auth hash key (e.g. "auth:<callerWallet>:<serviceId>")
 * ARGV[1] = amount to reserve (integer, micro-USDC)
 *
 * Returns 1 if the reservation succeeded (within cap), 0 if over cap.
 *
 * Using a Lua script makes the read-check-increment a single atomic operation,
 * preventing two concurrent payments from both passing the cap check and both
 * committing, which would overshoot spendCap.
 */
export const SPEND_CAP_RESERVE_SCRIPT = `
local spent = tonumber(redis.call("HGET", KEYS[1], "spent") or "0")
local cap = tonumber(redis.call("HGET", KEYS[1], "spendCap") or "0")
local amount = tonumber(ARGV[1])
if spent + amount > cap then return 0 end
redis.call("HINCRBY", KEYS[1], "spent", amount)
return 1
`;

/**
 * Atomically reserves `amount` against the spend cap for the given auth key.
 * Returns true if the payment is within cap (and spent has been incremented),
 * false if it would exceed the cap (no increment performed).
 */
export async function atomicSpendCapReserve(authKey: string, amount: number): Promise<boolean> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await (redis as any).eval(SPEND_CAP_RESERVE_SCRIPT, [authKey], [String(amount)]);
  return result === 1;
}
