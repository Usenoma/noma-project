/**
 * Launch rehearsal on a local fork of Robinhood Chain mainnet (anvil --fork-url ... --hardfork shanghai).
 * Uses the real Safe v1.4.1 contracts already deployed on mainnet and the backend's own Safe batch
 * builder, so what is signed here is exactly what owners would sign in Safe{Wallet}.
 *
 * Flow: stake → Safe batch (approve + notifyReward) signed by 2 owners → 7 days → claimAll →
 *       requestUnstake → 7-day cooldown → withdraw.
 *
 * Usage: FORK_RPC=http://127.0.0.1:58645 SAFE=0x.. STAKING=0x.. NOMA=0x.. ZEC=0x.. \
 *        npx tsx --env-file=.env scripts/fork-rehearsal.ts
 * Fork only: the owner/staker keys below are public anvil dev keys.
 */
import { createTestClient, createWalletClient, http, parseAbi, publicActions, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { erc20Abi, nomaStakingAbi } from "../src/chain/abis/index.js";
import { buildSafeTx, safeTxHash, type SafeCall } from "../src/chain/safe.js";

const RPC = process.env.FORK_RPC ?? "http://127.0.0.1:58645";
const SAFE = process.env.SAFE as Address;
const STAKING = process.env.STAKING as Address;
const NOMA = process.env.NOMA as Address;
const ZEC = process.env.ZEC as Address;
const CHAIN_ID = 4663;

const owners = [
  privateKeyToAccount("0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97"),
  privateKeyToAccount("0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6"),
];
const staker = privateKeyToAccount("0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba");

const chain = { id: CHAIN_ID, name: "robinhood-fork", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } } as const;
const client = createTestClient({ mode: "anvil", chain, transport: http(RPC) }).extend(publicActions);
const wallet = (a: typeof staker) => createWalletClient({ account: a, chain, transport: http(RPC) });

const mintAbi = parseAbi(["function mint(address to, uint256 amount)"]);
const safeAbi = parseAbi([
  "function nonce() view returns (uint256)",
  "function getThreshold() view returns (uint256)",
  "function getOwners() view returns (address[])",
  "function getTransactionHash(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,uint256 _nonce) view returns (bytes32)",
  "function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) payable returns (bool)",
]);

async function tx(hash: Hex, label: string) {
  const r = await client.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${label} reverted`);
  console.log(`  ✓ ${label} (gas ${r.gasUsed})`);
  return r;
}

async function safeExec(calls: SafeCall[], label: string) {
  const nonce = await client.readContract({ address: SAFE, abi: safeAbi, functionName: "nonce" });
  const t = buildSafeTx(calls, nonce);
  const ours = safeTxHash(SAFE, CHAIN_ID, t);
  const onchain = await client.readContract({
    address: SAFE,
    abi: safeAbi,
    functionName: "getTransactionHash",
    args: [t.to, t.value, t.data, t.operation, t.safeTxGas, t.baseGas, t.gasPrice, t.gasToken, t.refundReceiver, t.nonce],
  });
  if (ours !== onchain) throw new Error(`safeTxHash mismatch: backend ${ours} vs Safe ${onchain}`);
  console.log(`  ✓ backend safeTxHash matches the mainnet Safe contract (${ours.slice(0, 12)}…)`);
  const sorted = [...owners].sort((a, b) => (a.address.toLowerCase() < b.address.toLowerCase() ? -1 : 1));
  const sigs = await Promise.all(sorted.map((o) => o.sign({ hash: ours })));
  await client.setBalance({ address: owners[0]!.address, value: 10n ** 18n });
  return tx(
    await wallet(owners[0]!).writeContract({
      address: SAFE,
      abi: safeAbi,
      functionName: "execTransaction",
      args: [t.to, t.value, t.data, t.operation, t.safeTxGas, t.baseGas, t.gasPrice, t.gasToken, t.refundReceiver, `0x${sigs.map((s) => s.slice(2)).join("")}`],
    }),
    label,
  );
}

async function main() {
  console.log(`Safe ${SAFE}: threshold ${await client.readContract({ address: SAFE, abi: safeAbi, functionName: "getThreshold" })} of ${(await client.readContract({ address: SAFE, abi: safeAbi, functionName: "getOwners" })).length}`);
  await client.setBalance({ address: staker.address, value: 10n ** 18n });
  const W = wallet(staker);

  console.log("1. stake");
  await tx(await W.writeContract({ address: NOMA, abi: mintAbi, functionName: "mint", args: [staker.address, 1_000n * 10n ** 18n] }), "mint 1000 tNOMA");
  await tx(await W.writeContract({ address: NOMA, abi: erc20Abi, functionName: "approve", args: [STAKING, 1_000n * 10n ** 18n] }), "approve");
  await tx(await W.writeContract({ address: STAKING, abi: nomaStakingAbi, functionName: "stake", args: [1_000n * 10n ** 18n] }), "stake 1000 tNOMA");

  console.log("2. Safe funds the reward stream (what the executor proposes each cycle)");
  const reward = 100n * 10n ** 8n; // 100 tZEC (8 decimals)
  await tx(await W.writeContract({ address: ZEC, abi: mintAbi, functionName: "mint", args: [SAFE, reward] }), "Safe receives 100 tZEC (stands in for the swap)");
  const { encodeFunctionData } = await import("viem");
  await safeExec(
    [
      { to: ZEC, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [STAKING, reward] }) },
      { to: STAKING, data: encodeFunctionData({ abi: nomaStakingAbi, functionName: "notifyReward", args: [ZEC, reward] }) },
    ],
    "Safe 2-of-2 executes MultiSend: approve + notifyReward",
  );

  console.log("3. seven days later");
  await client.increaseTime({ seconds: 7 * 86400 });
  await client.mine({ blocks: 1 });
  const earned = await client.readContract({ address: STAKING, abi: nomaStakingAbi, functionName: "earned", args: [staker.address, ZEC] });
  console.log(`  earned: ${Number(earned) / 1e8} tZEC`);
  await tx(await W.writeContract({ address: STAKING, abi: nomaStakingAbi, functionName: "claimAll" }), "claimAll");
  const got = await client.readContract({ address: ZEC, abi: erc20Abi, functionName: "balanceOf", args: [staker.address] });
  console.log(`  staker tZEC balance: ${Number(got) / 1e8}`);
  if (reward - got > 10n) throw new Error("staker did not receive the full stream");

  console.log("4. unstake with 7-day cooldown");
  await tx(await W.writeContract({ address: STAKING, abi: nomaStakingAbi, functionName: "requestUnstake", args: [1_000n * 10n ** 18n] }), "requestUnstake 1000");
  try {
    await W.writeContract({ address: STAKING, abi: nomaStakingAbi, functionName: "withdraw" });
    throw new Error("withdraw before cooldown should revert");
  } catch (e) {
    if ((e as Error).message.includes("should revert")) throw e;
    console.log("  ✓ withdraw before cooldown reverts");
  }
  await client.increaseTime({ seconds: 7 * 86400 });
  await client.mine({ blocks: 1 });
  await tx(await W.writeContract({ address: STAKING, abi: nomaStakingAbi, functionName: "withdraw" }), "withdraw after cooldown");
  const back = await client.readContract({ address: NOMA, abi: erc20Abi, functionName: "balanceOf", args: [staker.address] });
  console.log(`  staker tNOMA balance: ${Number(back / 10n ** 18n)}`);
  console.log("REHEARSAL OK");
  process.exit(0);
}

main().catch((e) => {
  console.error("REHEARSAL FAILED:", (e as Error).message);
  process.exit(1);
});
