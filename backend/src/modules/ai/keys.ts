import { createHash, randomBytes } from "node:crypto";
import { decryptJson, encryptJson } from "../../lib/crypto.js";
import { encryptionKey } from "../../lib/keys.js";

export const AI_KEY_PREFIX = "noma_sk_";

export interface AiKeyMaterial {
  key: string;
  hash: string;
  encrypted: string;
  last4: string;
}

/** Generate a NOMA bearer key. Only the hash is used for auth; the ciphertext lets the order-key holder recover it. */
export function generateAiKey(): AiKeyMaterial {
  const secret = randomBytes(32).toString("base64url");
  const key = `${AI_KEY_PREFIX}${secret}`;
  return {
    key,
    hash: hashAiKey(key),
    encrypted: encryptJson({ api_key: key }, encryptionKey),
    last4: secret.slice(-4),
  };
}

export function hashAiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export function validAiKey(key: string): boolean {
  return key.startsWith(AI_KEY_PREFIX) && key.length >= AI_KEY_PREFIX.length + 32;
}

export function decryptAiKey(encrypted: string): string {
  return decryptJson<{ api_key: string }>(encrypted, encryptionKey).api_key;
}
