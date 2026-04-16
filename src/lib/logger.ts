/**
 * Structured JSON logger for AgentPay.
 * Outputs one JSON line per event to stdout — compatible with Vercel log drains
 * and any log aggregator that consumes NDJSON.
 *
 * Events follow the pattern:
 *   { ts, level, event, ...fields }
 *
 * Key loop events:
 *   wallet.register      — a wallet was registered (new or idempotent)
 *   service.register     — a service was registered
 *   auth.create          — a spend-cap authorization was created or updated
 *   auth.revoke          — an authorization was revoked
 *   payment.verify       — x402 payment proof was verified
 *   payment.record       — usage was recorded after a verified payment
 *   usage.query          — usage records were queried
 */

export type LogLevel = "info" | "warn" | "error";

export interface LogFields {
  [key: string]: unknown;
}

function log(level: LogLevel, event: string, fields: LogFields = {}): void {
  const entry = {
    ts: new Date().toISOString(),
    level,
    event,
    service: "agentpay",
    ...fields,
  };
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(entry));
}

export const logger = {
  info: (event: string, fields?: LogFields) => log("info", event, fields),
  warn: (event: string, fields?: LogFields) => log("warn", event, fields),
  error: (event: string, fields?: LogFields) => log("error", event, fields),
};

export default logger;
