import { Redis } from "ioredis";
import { config } from "./config.js";

/** Shared connection for cache reads/writes. BullMQ needs its own with maxRetriesPerRequest: null. */
export const redis = new Redis(config.REDIS_URL, { lazyConnect: true });

export const bullConnection = () => new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });

/** Rate limiter needs a fail-fast connection so a Redis outage does not hang requests. */
export const rateLimitRedis = () => new Redis(config.REDIS_URL, { connectTimeout: 500, maxRetriesPerRequest: 1 });
