import { Redis } from "ioredis";
import { config } from "./config.js";

/** Shared connection for cache reads/writes. BullMQ needs its own with maxRetriesPerRequest: null. */
export const redis = new Redis(config.REDIS_URL);

export const bullConnection = () => new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
