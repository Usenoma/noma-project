import { config } from "../config.js";

export const encryptionKey = Buffer.from(config.ENCRYPTION_KEY, "base64");
