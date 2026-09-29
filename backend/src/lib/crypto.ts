import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";

const IV_LEN = 12;
const TAG_LEN = 16;

/** AES-256-GCM. Output: base64(iv | tag | ciphertext). */
export function encrypt(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64");
}

export function decrypt(blob: string, key: Buffer): string {
  const buf = Buffer.from(blob, "base64");
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

export const encryptJson = (value: unknown, key: Buffer) => encrypt(JSON.stringify(value), key);
export const decryptJson = <T>(blob: string, key: Buffer) => JSON.parse(decrypt(blob, key)) as T;

/** Order key: the only credential for an anonymous order. Shown once, stored as sha256. */
export function generateOrderKey(): string {
  return `nok_${randomBytes(32).toString("base64url")}`;
}

export function hashOrderKey(orderKey: string): string {
  return createHash("sha256").update(orderKey).digest("hex");
}

export function verifyOrderKey(orderKey: string, storedHash: string): boolean {
  const a = Buffer.from(hashOrderKey(orderKey), "hex");
  const b = Buffer.from(storedHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
