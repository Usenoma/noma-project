import { secp256k1 } from "@noble/curves/secp256k1";
import { HDKey, publicKeyToAddress } from "viem/accounts";
import { bytesToHex, type Address, type Hex } from "viem";
import { config } from "../config.js";

/**
 * Unique deposit address per invoice, derived from an xpub. The API only ever sees the public key;
 * sweeping is done by a separate signer holding the xprv.
 */
export function depositAddress(index: bigint, xpub = config.PAYMENT_XPUB): Address {
  if (!xpub) throw new Error("PAYMENT_XPUB not configured");
  if (index < 0n || index >= 2n ** 31n) throw new Error("deposit address index out of range");
  const child = HDKey.fromExtendedKey(xpub).deriveChild(Number(index));
  if (!child.publicKey) throw new Error("failed to derive public key");
  // HD keys are compressed; address derivation needs the uncompressed (0x04-prefixed) form.
  const uncompressed = secp256k1.ProjectivePoint.fromHex(child.publicKey).toRawBytes(false);
  return publicKeyToAddress(bytesToHex(uncompressed));
}

/** Sweeper only: private key of the deposit address at `index`, from the xprv behind PAYMENT_XPUB. */
export function depositPrivateKey(index: bigint, xprv: string): Hex {
  if (index < 0n || index >= 2n ** 31n) throw new Error("deposit address index out of range");
  const child = HDKey.fromExtendedKey(xprv).deriveChild(Number(index));
  if (!child.privateKey) throw new Error("PAYMENT_XPRV is not an extended private key");
  return bytesToHex(child.privateKey);
}

/** True when `xprv` is the private counterpart of `xpub` (same node: depth, chain code, key). */
export function xprvMatchesXpub(xprv: string, xpub: string): boolean {
  const node = HDKey.fromExtendedKey(xprv);
  return Boolean(node.privateKey) && node.publicExtendedKey === xpub;
}
