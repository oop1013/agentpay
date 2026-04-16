import { Redis } from "@upstash/redis";
import { redisMock } from "./redis-mock";

const useUpstash =
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN;

export const redis: Redis = useUpstash
  ? new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL!,
      token: process.env.UPSTASH_REDIS_REST_TOKEN!,
    })
  : (redisMock as unknown as Redis);

if (!useUpstash) {
  console.warn("[agentpay] No Upstash credentials found — using in-memory mock Redis");
}
