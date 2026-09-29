/**
 * Pons V2 launch rehearsal on a local fork of Robinhood Chain mainnet, against the real Pons V2
 * factory, bonding curve and fee escrow. Validates the fee path the Reward Engine depends on:
 *
 *   launch (Safe = creator fee recipient, 1% creator tax, buyback off, ETH quote)
 *   → curve trades → backend reward indexer (CurveBuy/CurveSell) → live pool incl. pending fees
 *   → factory recipient-change alert → Safe batch: sweepFees + escrow claim → ETH lands in the Safe
 *
 * Usage (fresh DB, e.g. noma_fork, migrated first):
 *   anvil --fork-url https://rpc.mainnet.chain.robinhood.com --chain-id 4663 --hardfork cancun --port 58645
 *   DATABASE_URL=postgres://…/noma_fork FORK_RPC=http://127.0.0.1:58645 npx tsx --env-file=.env scripts/pons-fork-rehearsal.ts
 * Fork only: the owner/trader keys below are public anvil dev keys.
 */
import {
  createTestClient,
  createWalletClient,
  encodeFunctionData,
  http,
  keccak256,
  parseAbi,
  parseEther,
  parseEventLogs,
  publicActions,
  toHex,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const RPC = process.env.FORK_RPC ?? "http://127.0.0.1:58645";
const CHAIN_ID = 4663;
const FACTORY: Address = "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e";
// Safe v1.4.1 canonical deployments
const SAFE_PROXY_FACTORY: Address = "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67";
const SAFE_L2_SINGLETON: Address = "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762";
const TAX_BPS = 100;

const owners = [
  privateKeyToAccount("0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97"),
  privateKeyToAccount("0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6"),
];
const traders = [
  privateKeyToAccount("0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba"),
  privateKeyToAccount("0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e"),
];
const creator = privateKeyToAccount("0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356");

const chain = { id: CHAIN_ID, name: "robinhood-fork", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } } as const;
const client = createTestClient({ mode: "anvil", chain, transport: http(RPC) }).extend(publicActions);
const wallet = (a: typeof creator) => createWalletClient({ account: a, chain, transport: http(RPC) });

const factoryAbi = parseAbi([
  "struct Socials { string twitter; string telegram; string discord; string website; string farcaster; }",
  "struct TokenParams { string name; string symbol; string logo; string description; Socials socials; address creatorFeeRecipient; uint16 creatorTaxBps; bool buybackEnabled; bytes32 expectedEconomics; bytes32 salt; }",
  "struct LaunchConfig { uint256 supply; uint256 curveFeeBps; uint256 phantomQuote; uint256 graduationThreshold; uint24 poolFee; int24 tickSpacing; bool enabled; }",
  "function launchToken(TokenParams params, uint256 launchConfigId, address pairToken) payable returns (address token, address curve)",
  "function launchFee() view returns (uint256)",
  "function launchConfigCount() view returns (uint256)",
  "function getLaunchConfig(uint256 id) view returns (LaunchConfig)",
  "function canLaunch(address launcher) view returns (bool)",
  "function owner() view returns (address)",
  "function setWhitelistedLauncher(address launcher, bool enabled)",
  "function setCreatorFeeRecipient(address token, address newRecipient)",
  "function feeEscrow() view returns (address)",
  "function memeHook() view returns (address)",
  "event TokenLaunched(address indexed token, address indexed curve, address indexed deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold)",
]);
const curveAbi = parseAbi([
  "function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) payable returns (uint256)",
  "function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient) returns (uint256)",
  "function deployer() view returns (address)",
  "function feeBps() view returns (uint256)",
  "function creatorTaxBps() view returns (uint256)",
  "event FeesSwept(uint256 protocolAmount, uint256 buybackAmount, uint256 creatorAmount)",
]);
const safeAbi = parseAbi([
  "function setup(address[] owners, uint256 threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)",
  "function nonce() view returns (uint256)",
  "function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) payable returns (bool)",
]);
const proxyFactoryAbi = parseAbi([
  "function createProxyWithNonce(address singleton, bytes initializer, uint256 saltNonce) returns (address proxy)",
]);
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function approve(address, uint256) returns (bool)"]);

async function send(hash: Hex, label: string) {
  const r = await client.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${label} reverted`);
  console.log(`  ✓ ${label} (gas ${r.gasUsed})`);
  return r;
}

function check(ok: boolean, msg: string) {
  if (!ok) throw new Error(msg);
  console.log(`  ✓ ${msg}`);
}

async function main() {
  // the forked head is an Arbitrum header without blob gas; a local block makes Cancun execution work
  await client.mine({ blocks: 1 });
  for (const a of [...owners, ...traders, creator]) await client.setBalance({ address: a.address, value: parseEther("100") });
  for (const [name, a] of [["Pons factory", FACTORY], ["Safe proxy factory", SAFE_PROXY_FACTORY], ["SafeL2", SAFE_L2_SINGLETON]] as const) {
    check(((await client.getCode({ address: a })) ?? "0x").length > 2, `${name} deployed on the fork (${a})`);
  }

  console.log("1. Reward Engine Safe (2-of-2)");
  const setup = encodeFunctionData({
    abi: safeAbi,
    functionName: "setup",
    args: [owners.map((o) => o.address), 2n, zeroAddress, "0x", zeroAddress, zeroAddress, 0n, zeroAddress],
  });
  const { result: SAFE, request } = await client.simulateContract({
    account: creator,
    address: SAFE_PROXY_FACTORY,
    abi: proxyFactoryAbi,
    functionName: "createProxyWithNonce",
    args: [SAFE_L2_SINGLETON, setup, BigInt(Date.now())],
  });
  await send(await wallet(creator).writeContract(request), `Safe created at ${SAFE}`);

  console.log("2. launch on the real Pons V2 factory");
  const escrow = await client.readContract({ address: FACTORY, abi: factoryAbi, functionName: "feeEscrow" });
  const hook = await client.readContract({ address: FACTORY, abi: factoryAbi, functionName: "memeHook" });
  console.log(`  fee escrow ${escrow}, meme hook ${hook}`);
  if (!(await client.readContract({ address: FACTORY, abi: factoryAbi, functionName: "canLaunch", args: [creator.address] }))) {
    // mainnet launches are gated; on the fork the factory owner whitelists our launcher
    const owner = await client.readContract({ address: FACTORY, abi: factoryAbi, functionName: "owner" });
    await client.impersonateAccount({ address: owner });
    await client.setBalance({ address: owner, value: parseEther("1") });
    await send(
      await createWalletClient({ account: owner, chain, transport: http(RPC) }).writeContract({
        address: FACTORY,
        abi: factoryAbi,
        functionName: "setWhitelistedLauncher",
        args: [creator.address, true],
      }),
      "public launches closed: factory owner (impersonated) whitelists the launcher",
    );
  } else console.log("  public launches are open");

  const count = await client.readContract({ address: FACTORY, abi: factoryAbi, functionName: "launchConfigCount" });
  let configId = -1n;
  for (let i = 0n; i < count; i++) {
    const c = await client.readContract({ address: FACTORY, abi: factoryAbi, functionName: "getLaunchConfig", args: [i] });
    console.log(`  config ${i}: fee ${c.curveFeeBps} bps, graduation ${Number(c.graduationThreshold) / 1e18} ETH, enabled ${c.enabled}`);
    if (c.enabled && configId < 0n) configId = i;
  }
  if (configId < 0n) throw new Error("no enabled launch config");
  const launchFee = await client.readContract({ address: FACTORY, abi: factoryAbi, functionName: "launchFee" });
  const startBlock = await client.getBlockNumber();
  const launchReceipt = await send(
    await wallet(creator).writeContract({
      address: FACTORY,
      abi: factoryAbi,
      functionName: "launchToken",
      args: [
        {
          name: "NOMA Rehearsal",
          symbol: "tNOMA",
          logo: "",
          description: "fork rehearsal",
          socials: { twitter: "", telegram: "", discord: "", website: "", farcaster: "" },
          creatorFeeRecipient: SAFE,
          creatorTaxBps: TAX_BPS,
          buybackEnabled: false,
          expectedEconomics: `0x${"0".repeat(64)}`,
          salt: keccak256(toHex(`noma-rehearsal-${Date.now()}`)),
        },
        configId,
        zeroAddress,
      ],
      value: launchFee,
    }),
    `launchToken (config ${configId}, fee ${Number(launchFee) / 1e18} ETH)`,
  );
  const launched = parseEventLogs({ abi: factoryAbi, eventName: "TokenLaunched", logs: launchReceipt.logs })[0]!.args;
  const TOKEN = launched.token;
  const CURVE = launched.curve;
  console.log(`  token ${TOKEN}, curve ${CURVE}`);
  check((await client.readContract({ address: CURVE, abi: curveAbi, functionName: "deployer" })) === SAFE, "curve creator fee recipient is the Safe");
  const feeBps = await client.readContract({ address: CURVE, abi: curveAbi, functionName: "feeBps" });
  console.log(`  curve base fee ${feeBps} bps, creator tax ${await client.readContract({ address: CURVE, abi: curveAbi, functionName: "creatorTaxBps" })} bps`);

  console.log("3. trades on the curve");
  await client.increaseTime({ seconds: 3600 }); // past any launch-window snipe tax
  await client.mine({ blocks: 1 });
  for (const [i, t] of traders.entries()) {
    const amount = parseEther(i === 0 ? "0.5" : "0.3");
    await send(
      await wallet(t).writeContract({ address: CURVE, abi: curveAbi, functionName: "buy", args: [amount, 0n, t.address], value: amount }),
      `trader ${i + 1} buys for ${Number(amount) / 1e18} ETH`,
    );
  }
  const held = await client.readContract({ address: TOKEN, abi: erc20, functionName: "balanceOf", args: [traders[0]!.address] });
  await send(await wallet(traders[0]!).writeContract({ address: TOKEN, abi: erc20, functionName: "approve", args: [CURVE, held / 2n] }), "approve");
  await send(
    await wallet(traders[0]!).writeContract({ address: CURVE, abi: curveAbi, functionName: "sell", args: [held / 2n, 0n, traders[0]!.address] }),
    "trader 1 sells half",
  );

  console.log("4. backend reward indexer against the fork");
  Object.assign(process.env, {
    CHAIN_RPC_URL: RPC,
    CHAIN_ID: String(CHAIN_ID),
    PONS_V2_FACTORY: FACTORY,
    PONS_FEE_ESCROW: escrow,
    NOMA_TOKEN_ADDRESS: TOKEN,
    NOMA_BONDING_CURVE: CURVE,
    PONS_V2_MEME_HOOK: "",
    NOMA_V4_POOL_ID: "",
    NOMA_QUOTE_ASSET: "ETH",
    SAFE_ADDRESS: SAFE,
    REWARD_INDEXER_START_BLOCK: String(startBlock),
  });
  const { db } = await import("../src/db/pool.js");
  const { redis } = await import("../src/redis.js");
  const { indexRewards } = await import("../src/modules/rewards/indexer.js");
  const { livePoolKey } = await import("../src/modules/rewards/service.js");
  const { pendingCreatorPayout } = await import("../src/modules/rewards/poolMath.js");
  const { ponsCurveAbi, ponsFeeEscrowAbi } = await import("../src/chain/abis/index.js");
  const { sweepCalls } = await import("../src/modules/rewards/executor.js");
  const { buildSafeTx, safeTxHash } = await import("../src/chain/safe.js");
  await redis.connect();

  await db.query("DELETE FROM fee_accruals; DELETE FROM indexer_cursors WHERE name = 'reward-indexer'; UPDATE reward_cycles SET status = 'distributed' WHERE status = 'active'");
  const { rows: cyc } = await db.query<{ id: number }>(
    `INSERT INTO reward_cycles (week_no, stock_symbol, starts_at, ends_at, status)
     VALUES ((SELECT COALESCE(max(week_no), 0) + 1 FROM reward_cycles), 'NVDA', now(), now() + interval '7 days', 'active') RETURNING id`,
  );
  const cycleId = cyc[0]!.id;
  const head = await client.getBlockNumber();
  const { getCursor } = await import("../src/db/pool.js");
  for (let i = 0; i < 5 && ((await getCursor("reward-indexer")) ?? 0n) < head; i++) await indexRewards();

  const { rows } = await db.query<{ source: string; side: string; trade: string; base: string; share: string; tax: string; usd: string | null; ts: Date }>(
    `SELECT source, side, trade_quote_amount AS trade, base_fee_amount AS base, creator_fee_share_amount AS share,
       creator_tax_amount AS tax, amount_usd AS usd, ts FROM fee_accruals WHERE cycle_id = $1 ORDER BY block, log_index`,
    [cycleId],
  );
  for (const r of rows) console.log(`  ${r.side} trade ${Number(r.trade) / 1e18} ETH: base fee ${r.base}, creator share ${r.share}, tax ${r.tax}, ts ${r.ts.toISOString()}`);
  check(rows.length === 3 && rows.filter((r) => r.side === "buy").length === 2, "indexer recorded 2 CurveBuy + 1 CurveSell");

  const [pFee, pTax, shareBps] = await Promise.all([
    client.readContract({ address: CURVE, abi: ponsCurveAbi, functionName: "quoteFeeBalance" }),
    client.readContract({ address: CURVE, abi: ponsCurveAbi, functionName: "creatorTaxBalance" }),
    client.readContract({ address: CURVE, abi: ponsCurveAbi, functionName: "protocolFeeShareBps" }),
  ]);
  const sum = (k: "base" | "share" | "tax") => rows.reduce((s, r) => s + BigInt(r[k]), 0n);
  check(sum("base") === pFee && sum("tax") === pTax, `indexed base fees and taxes equal the curve's pending balances (${pFee} / ${pTax})`);
  const expectedPayout = pendingCreatorPayout(pFee, pTax, BigInt(shareBps));
  const indexedPayout = sum("share") + sum("tax");
  check(indexedPayout - expectedPayout >= 0n && indexedPayout - expectedPayout < BigInt(rows.length), `per-trade creator split matches the aggregate within rounding (${indexedPayout} vs ${expectedPayout})`);
  const live = await redis.hgetall(livePoolKey(cycleId));
  console.log(`  live pool: claimed ${live.claimed}, claimable ${live.claimable}, pending ${live.pending}, total ${live.total}`);
  check(BigInt(live.pending!) === expectedPayout && BigInt(live.total!) === expectedPayout, "live pool counts creator fees still pending in the curve");

  console.log("5. creator fee recipient change is alerted");
  const owner = await client.readContract({ address: FACTORY, abi: factoryAbi, functionName: "owner" });
  await client.impersonateAccount({ address: owner });
  await client.setBalance({ address: owner, value: parseEther("1") });
  await send(
    await createWalletClient({ account: owner, chain, transport: http(RPC) }).writeContract({
      address: FACTORY,
      abi: factoryAbi,
      functionName: "setCreatorFeeRecipient",
      args: [TOKEN, creator.address],
    }),
    "factory owner proposes a new creator fee recipient (3-day timelock)",
  );
  await indexRewards(); // expect an "ALERT $NOMA creator fee recipient change" log line above

  console.log("6. Safe batch: sweep + escrow claim (what executor step A proposes)");
  const calls = await sweepCalls();
  check(calls.length === 1 && calls[0]!.label.includes("sweepFees"), "Safe may sweep the curve itself (buyback off)");
  calls.push({ label: "Pons Fee Escrow claim (ETH)", to: escrow, data: encodeFunctionData({ abi: ponsFeeEscrowAbi, functionName: "claim" }) });
  const nonce = await client.readContract({ address: SAFE, abi: safeAbi, functionName: "nonce" });
  const t = buildSafeTx(calls, nonce);
  const hash = safeTxHash(SAFE, CHAIN_ID, t);
  const sorted = [...owners].sort((a, b) => (a.address.toLowerCase() < b.address.toLowerCase() ? -1 : 1));
  const sigs = await Promise.all(sorted.map((o) => o.sign({ hash })));
  const before = await client.getBalance({ address: SAFE });
  const r = await send(
    await wallet(owners[0]!).writeContract({
      address: SAFE,
      abi: safeAbi,
      functionName: "execTransaction",
      args: [t.to, t.value, t.data, t.operation, t.safeTxGas, t.baseGas, t.gasPrice, t.gasToken, t.refundReceiver, `0x${sigs.map((s) => s.slice(2)).join("")}`],
    }),
    "Safe 2-of-2 executes MultiSend: sweepFees + claim",
  );
  const swept = parseEventLogs({ abi: curveAbi, eventName: "FeesSwept", logs: r.logs })[0];
  check(swept?.args.creatorAmount === expectedPayout, `FeesSwept creatorAmount equals the predicted payout (${expectedPayout})`);
  const received = (await client.getBalance({ address: SAFE })) - before;
  check(received === expectedPayout, `Safe received ${Number(received) / 1e18} ETH from the escrow`);
  check((await client.readContract({ address: escrow, abi: ponsFeeEscrowAbi, functionName: "balanceOf", args: [SAFE] })) === 0n, "escrow balance of the Safe is 0 after claim");

  console.log("PONS REHEARSAL OK");
  await redis.quit();
  await db.end();
  process.exit(0);
}

main().catch((e) => {
  console.error("PONS REHEARSAL FAILED:", (e as Error).message);
  process.exit(1);
});
