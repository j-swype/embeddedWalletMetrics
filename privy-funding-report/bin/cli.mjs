#!/usr/bin/env node
/**
 * Privy Funding Report — Blockchain RPC Edition
 *
 * Measures conversion from sign-in to first funded embedded/smart wallet
 * for any Privy app by directly querying blockchain RPC endpoints.
 *
 * Instead of calling Privy's transaction API, this tool queries on-chain data
 * via JSON-RPC (eth_getLogs for ERC20 transfers, eth_getBalance for native tokens).
 *
 * Usage:
 *   node bin/cli.mjs [options]
 *
 * Options:
 *   --output <path>     Write metrics to a JSON file
 *   --sample <size>     Use statistical sampling for large populations
 *   --social-only       Only analyze users who signed in via social/email/phone
 *   --chains <list>     Comma-separated chain list (overrides CHAINS env var)
 *   --verbose           Enable debug output
 *
 * Env vars:
 *   PRIVY_APP_ID              Privy app ID (required)
 *   PRIVY_APP_SECRET          Privy app secret (required)
 *   CHAINS                    Comma-separated chains (default: ethereum,arbitrum,base,optimism,polygon)
 *   CHAIN_RPC_URL_<CHAIN>     Per-chain RPC override (uppercase, e.g. CHAIN_RPC_URL_ETHEREUM=https://...)
 *   RPC_DELAY_MS              Delay between RPC calls in ms (default: 200)
 */

import { readFileSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';

// ─── Constants ───────────────────────────────────────────────────────────────

/** ERC20 Transfer event signature: Transfer(address indexed from, address indexed to, uint256 value) */
const ERC20_TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df5233ef3';

/** Well-known ERC20 token addresses by chain and symbol */
const TOKEN_ADDRESSES = {
  ethereum: {
    usdc: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    usdt: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    eusc: '0x2Ae3F1c711f1F3213bE4d261C1a717D3F4B85014', // EURC on Ethereum
  },
  arbitrum: {
    usdc: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    usdt: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
    eusc: '0xD4B88Df4D29F5CedD68579770811aF6E218ce640', // EURC on Arbitrum
    usdb: '0xd9AeC86B65D86f6A7B5B1b0c42FFA531710b6CA', // USDB on Arbitrum
  },
  base: {
    usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    usdt: '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA',
    usdb: '0xbB0e17EF65F80Ab513c8DD091C7a5Bb2515A8c5C', // USDB on Base
  },
  optimism: {
    usdc: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
    usdt: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58',
    eusc: '0x80b5a32E4F032B2a058bC3C1B0517a46f6815D19', // EURC on Optimism
  },
  polygon: {
    usdc: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
    usdt: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
    pol:  null, // POL is the native token on Polygon — use eth_getBalance
  },
};

/**
 * Default public RPC endpoints per chain.
 * Users should override via CHAIN_RPC_URL_<CHAIN> for production use.
 */
const DEFAULT_RPC_URLS = {
  ethereum:  'https://eth.llamarpc.com',
  arbitrum:  'https://arbitrum.llamarpc.com',
  base:      'https://base.llamarpc.com',
  optimism:  'https://optimism.llamarpc.com',
  polygon:   'https://polygon-bor-rpc.publicnode.com',
};

/** Native token symbols and decimals per chain */
const NATIVE_TOKEN = {
  ethereum: { symbol: 'ETH', decimals: 18 },
  arbitrum: { symbol: 'ETH', decimals: 18 },
  base:     { symbol: 'ETH', decimals: 18 },
  optimism: { symbol: 'ETH', decimals: 18 },
  polygon:  { symbol: 'POL', decimals: 18 },
};

/** ERC20 token decimals */
const ERC20_DECIMALS = {
  usdc: 6, usdt: 6, eusc: 2, usdb: 18, pol: 18,
};

/** Auth types considered "social" (non-wallet sign-in) */
const SOCIAL_AUTH_TYPES = new Set([
  'email', 'phone',
  'google_oauth', 'twitter_oauth', 'telegram', 'farcaster',
  'apple_oauth', 'discord_oauth', 'github_oauth',
  'instagram_oauth', 'linkedin_oauth', 'spotify_oauth',
]);

/** Wallet client types we track (embedded + smart wallets) */
const WALLET_CLIENT_TYPES = new Set(['privy', 'smart_wallet']);

/** Privy API pagination limit */
const PRIVY_PAGE_SIZE = 100;

/** Delay between Privy API calls (ms) */
const PRIVY_DELAY_MS = 300;

// ─── Environment & Config ────────────────────────────────────────────────────

/**
 * Minimal .env loader — reads KEY=VALUE pairs from .env in cwd.
 * Does not overwrite existing env vars (shell takes precedence).
 */
function loadEnv() {
  const envPath = join(process.cwd(), '.env');
  if (!existsSync(envPath)) return;
  try {
    const raw = readFileSync(envPath, 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx <= 0) continue;
      const key = trimmed.slice(0, idx).trim();
      let val = trimmed.slice(idx + 1).trim();
      // Strip surrounding quotes
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = val;
    }
  } catch (_) { /* ignore read errors */ }
}

loadEnv();

// ─── CLI Argument Parsing ────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--output' && args[i + 1])        { opts.output = args[++i]; }
    else if (arg === '--sample' && args[i + 1])    { opts.sample = parseInt(args[++i], 10); }
    else if (arg === '--social-only')              { opts.socialOnly = true; }
    else if (arg === '--verbose')                  { opts.verbose = true; }
    else if (arg === '--chains' && args[i + 1])    { opts.chains = args[++i].split(',').map(c => c.trim().toLowerCase()); }
    else if (arg === '--help' || arg === '-h')     { opts.help = true; }
    else if (arg === '--version')                  { opts.version = true; }
  }
  return opts;
}

const opts = parseArgs();

if (opts.version) {
  const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'));
  console.log(pkg.name, pkg.version);
  process.exit(0);
}

if (opts.help) {
  console.log(`Privy Funding Report — Blockchain RPC Edition

Usage: node bin/cli.mjs [options]

Options:
  --output <path>     Write final metrics to a JSON file
  --sample <size>     Use statistical sampling when user count exceeds <size>
  --social-only       Only analyze users with social/email/phone sign-in
  --chains <list>     Comma-separated chain names (e.g. ethereum,arbitrum,base)
  --verbose           Enable debug/trace output
  --help, -h          Show this help
  --version           Show version

Environment:
  PRIVY_APP_ID              Required. Your Privy app ID.
  PRIVY_APP_SECRET          Required. Your Privy app secret.
  CHAINS                    Comma-separated chain list (default: ethereum,arbitrum,base,optimism,polygon)
  CHAIN_RPC_URL_<CHAIN>     Override RPC URL for a specific chain (uppercase, e.g. CHAIN_RPC_URL_ETHEREUM=...)
  RPC_DELAY_MS              Delay between RPC calls in ms (default: 200)

Supported chains: ethereum, arbitrum, base, optimism, polygon
Supported assets: ETH (native), USDC, USDT, EURC, USDB, POL (native on Polygon)
`);
  process.exit(0);
}

// ─── Config Resolution ───────────────────────────────────────────────────────

const verbose = opts.verbose
  ? (...args) => console.log('[verbose]', ...args)
  : () => {};

const APP_ID     = process.env.PRIVY_APP_ID;
const APP_SECRET = process.env.PRIVY_APP_SECRET;
const RPC_DELAY  = parseInt(process.env.RPC_DELAY_MS || '200', 10);

/** Build the chain configuration from CLI flags and env vars */
function resolveChains() {
  // --chains flag takes highest priority, then CHAINS env, then defaults
  const chainList = opts.chains
    ?? (process.env.CHAINS ? process.env.CHAINS.split(',').map(c => c.trim().toLowerCase()) : null)
    ?? ['ethereum', 'arbitrum', 'base', 'optimism', 'polygon'];

  const chains = [];
  for (const name of chainList) {
    const defaultRpc = DEFAULT_RPC_URLS[name];
    if (!defaultRpc) {
      console.warn(`Warning: unknown chain "${name}" — skipping. Known: ${Object.keys(DEFAULT_RPC_URLS).join(', ')}`);
      continue;
    }
    // Per-chain RPC override via env: CHAIN_RPC_URL_ETHEREUM, CHAIN_RPC_URL_ARBITRUM, etc.
    const envKey = `CHAIN_RPC_URL_${name.toUpperCase()}`;
    const rpcUrl = process.env[envKey] || defaultRpc;
    const tokens = TOKEN_ADDRESSES[name] || {};
    const native = NATIVE_TOKEN[name] || { symbol: 'ETH', decimals: 18 };

    chains.push({ name, rpcUrl, tokens, native });
  }
  return chains;
}

const CHAINS = resolveChains();

if (!APP_ID || !APP_SECRET) {
  console.error('Error: PRIVY_APP_ID and PRIVY_APP_SECRET are required. Set them in .env or as environment variables.');
  process.exit(1);
}

if (CHAINS.length === 0) {
  console.error('Error: No valid chains configured. Set CHAINS or use --chains.');
  process.exit(1);
}

// ─── Utility Functions ───────────────────────────────────────────────────────

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Pad a hex string to 32 bytes (64 hex chars), removing 0x prefix if present.
 * Used for indexed parameters in eth_getLogs topics.
 */
function padAddressToTopic(address) {
  const clean = address.startsWith('0x') ? address.slice(2) : address;
  const lower = clean.toLowerCase();
  return lower.padStart(64, '0');
}

/** Convert a hex number (with or without 0x prefix) to a BigInt */
function hexToBigInt(hex) {
  const clean = hex.startsWith('0x') ? hex : '0x' + hex;
  return BigInt(clean);
}

/**
 * Format a BigInt amount as a human-readable number with given decimals.
 */
function formatAmount(rawBigInt, decimals) {
  const divisor = 10n ** BigInt(decimals);
  const intPart = rawBigInt / divisor;
  const fracPart = rawBigInt % divisor;
  const fracStr = fracPart.toString().padStart(decimals, '0').slice(0, Math.min(decimals, 6));
  return Number(`${intPart}.${fracStr}`);
}

/**
 * Fisher-Yates in-place shuffle for sampling.
 * Returns the first `size` elements from the shuffled array.
 */
function sampleArray(arr, size) {
  // Create a copy to avoid mutating the original
  const copy = [...arr];
  const sampleSize = Math.min(size, copy.length);
  for (let i = copy.length - 1; i > 0 && i >= copy.length - sampleSize; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(copy.length - sampleSize);
}

/**
 * Compute Wilson score confidence interval for a binomial proportion.
 * Returns { lower, upper, marginOfError } at 95% confidence.
 */
function wilsonCI(successes, total, z = 1.96) {
  if (total === 0) return { lower: 0, upper: 0, marginOfError: 0 };
  const p = successes / total;
  const n = total;
  const denom = 1 + z * z / n;
  const center = (p + z * z / (2 * n)) / denom;
  const spread = (z * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n)) / denom;
  return {
    lower: Math.max(0, center - spread),
    upper: Math.min(1, center + spread),
    marginOfError: spread,
  };
}

// ─── Privy API Client ────────────────────────────────────────────────────────

const PRIVY_BASE = 'https://api.privy.io/v1';
const privyAuth = Buffer.from(`${APP_ID}:${APP_SECRET}`).toString('base64');

/**
 * Fetch from the Privy Management API with pagination support.
 * Handles Basic auth and privy-app-id headers automatically.
 */
async function fetchPrivy(path, params = {}) {
  const base = PRIVY_BASE.endsWith('/') ? PRIVY_BASE : PRIVY_BASE + '/';
  const url = new URL(path.startsWith('/') ? path.slice(1) : path, base);
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) {
      for (const item of v) url.searchParams.append(k, String(item));
    } else {
      url.searchParams.set(k, String(v));
    }
  }
  const res = await fetch(url.toString(), {
    headers: {
      'Authorization': `Basic ${privyAuth}`,
      'privy-app-id': APP_ID,
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) {
    const text = await res.text();
    const hint = res.status === 404 ? ' (list-users may require a paid Privy plan)' : '';
    throw new Error(`Privy API ${res.status}: ${text}${hint}`);
  }
  return res.json();
}

/**
 * Paginate through all users of the Privy app.
 */
async function fetchAllUsers() {
  const users = [];
  let cursor = '';
  do {
    const params = { limit: PRIVY_PAGE_SIZE };
    if (cursor) params.cursor = cursor;
    const data = await fetchPrivy('users', params);
    const page = data.data ?? [];
    users.push(...page);
    cursor = data.next_cursor || '';
    await delay(PRIVY_DELAY_MS);
    if (page.length < PRIVY_PAGE_SIZE) break;
  } while (cursor);
  return users;
}

// ─── Blockchain RPC Client ───────────────────────────────────────────────────

/**
 * Send a JSON-RPC call to a blockchain endpoint.
 * Returns the 'result' field from the response.
 */
async function rpcCall(rpcUrl, method, params) {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const json = await res.json();
  if (json.error) {
    throw new Error(`RPC error ${json.error.code}: ${json.error.message}`);
  }
  return json.result;
}

/**
 * Check native token (ETH/POL) balance for an address via eth_getBalance.
 */
async function checkNativeBalance(rpcUrl, address) {
  try {
    const balance = await rpcCall(rpcUrl, 'eth_getBalance', [address, 'latest']);
    return hexToBigInt(balance);
  } catch (err) {
    verbose(`eth_getBalance failed for ${address}: ${err.message}`);
    return 0n;
  }
}

/**
 * Check ERC20 token balance for an address via eth_call (balanceOf).
 * Contract ABI: balanceOf(address) returns uint256.
 */
async function checkERC20Balance(rpcUrl, tokenAddress, address) {
  // balanceOf(address) selector = 0x70a08231 + padded address
  const selector = '0x70a08231';
  const paddedAddr = padAddressToTopic(address);
  const data = selector + paddedAddr;
  try {
    const result = await rpcCall(rpcUrl, 'eth_call', [
      { to: tokenAddress, data },
      'latest',
    ]);
    return hexToBigInt(result);
  } catch (err) {
    verbose(`eth_call balanceOf failed for ${tokenAddress}: ${err.message}`);
    return 0n;
  }
}

/**
 * Query ERC20 Transfer event logs for a specific token to a specific address.
 * Uses eth_getLogs with topic filtering for efficiency.
 * Returns an array of { blockNumber, amount (BigInt) } entries.
 */
async function queryTransferLogs(rpcUrl, tokenAddress, walletAddress, fromBlock) {
  const toTopic = padAddressToTopic(walletAddress);
  try {
    const logs = await rpcCall(rpcUrl, 'eth_getLogs', [{
      fromBlock: fromBlock || 'earliest',
      toBlock: 'latest',
      address: tokenAddress,
      topics: [
        ERC20_TRANSFER_TOPIC,         // topic0: Transfer event signature
        null,                          // topic1: from (any)
        toTopic,                       // topic2: to (matching wallet)
      ],
    }]);
    if (!Array.isArray(logs)) return [];
    return logs
      .filter(log => log.topics && log.topics.length >= 3)
      .map(log => ({
        blockNumber: typeof log.blockNumber === 'string' ? parseInt(log.blockNumber, 16) : (log.blockNumber || 0),
        amount: hexToBigInt(log.topics[3] || '0x0'),
      }));
  } catch (err) {
    // Some RPCs reject large ranges — log and return empty
    verbose(`eth_getLogs failed for ${tokenAddress}: ${err.message}`);
    return [];
  }
}

// ─── Wallet Detection ────────────────────────────────────────────────────────

/**
 * Extract the Ethereum address from a Privy wallet account object.
 */
function getWalletAddress(account) {
  return account.address ?? null;
}

/**
 * Get all embedded and smart wallet accounts from a Privy user object.
 * Returns array of { id, address, clientType } objects.
 */
function getWalletAccounts(user) {
  const accounts = user.linked_accounts ?? user.linkedAccounts ?? [];
  const wallets = [];
  for (const acct of accounts) {
    const clientType = acct.wallet_client_type ?? acct.walletClientType ?? null;
    if (acct.type === 'wallet' && WALLET_CLIENT_TYPES.has(clientType)) {
      wallets.push({
        id: acct.id ?? null,
        address: getWalletAddress(acct),
        clientType,
      });
    }
  }
  return wallets;
}

/**
 * Check if a user has any social/non-wallet linked account.
 */
function isSocialUser(user) {
  const accounts = user.linked_accounts ?? user.linkedAccounts ?? [];
  return accounts.some(a => SOCIAL_AUTH_TYPES.has(a.type));
}

// ─── Per-Wallet Funding Check ────────────────────────────────────────────────

/**
 * Check if a single wallet address has ever received funds on any configured chain.
 * Queries native balance + ERC20 balances for all supported tokens.
 *
 * Returns {
 *   funded: boolean,
 *   deposits: [{ chain, asset, amount }],
 *   firstFundBlock: number|null,
 *   fundingChain: string|null,
 *   fundingAsset: string|null,
 * }
 */
async function checkWalletFunded(address) {
  const deposits = [];
  let firstFundBlock = null;
  let fundingChain = null;
  let fundingAsset = null;

  for (const chain of CHAINS) {
    // ── Check native token balance (ETH/POL) ──
    try {
      const nativeBal = await checkNativeBalance(chain.rpcUrl, address);
      await delay(RPC_DELAY);
      if (nativeBal > 0n) {
        const amount = formatAmount(nativeBal, chain.native.decimals);
        deposits.push({
          chain: chain.name,
          asset: chain.native.symbol.toLowerCase(),
          amount,
        });
        if (firstFundBlock === null) {
          firstFundBlock = 0; // eth_getBalance doesn't give us block number
          fundingChain = chain.name;
          fundingAsset = chain.native.symbol.toLowerCase();
        }
      }
    } catch (err) {
      verbose(`Native balance check failed on ${chain.name}: ${err.message}`);
    }

    // ── Check ERC20 token balances ──
    for (const [symbol, tokenAddr] of Object.entries(chain.tokens)) {
      if (!tokenAddr) continue; // null = native token, handled above
      try {
        const balance = await checkERC20Balance(chain.rpcUrl, tokenAddr, address);
        await delay(RPC_DELAY);
        const decimals = ERC20_DECIMALS[symbol] ?? 18;
        if (balance > 0n) {
          const amount = formatAmount(balance, decimals);
          deposits.push({
            chain: chain.name,
            asset: symbol.toLowerCase(),
            amount,
          });
          if (firstFundBlock === null) {
            firstFundBlock = 0;
            fundingChain = chain.name;
            fundingAsset = symbol.toLowerCase();
          }
        }
      } catch (err) {
        verbose(`ERC20 balance check failed for ${symbol} on ${chain.name}: ${err.message}`);
      }
    }
  }

  return {
    funded: deposits.length > 0,
    deposits,
    firstFundBlock,
    fundingChain,
    fundingAsset,
  };
}

/**
 * Check if a user has any funded wallet (embedded or smart).
 * Returns merged result across all wallets.
 */
async function checkUserFunded(user) {
  const wallets = getWalletAccounts(user);
  if (wallets.length === 0) {
    return { funded: false, deposits: [], walletAddresses: [] };
  }

  const allDeposits = [];
  const walletAddresses = wallets.filter(w => w.address).map(w => w.address);

  for (const wallet of wallets) {
    if (!wallet.address) continue;
    verbose(`  Checking wallet ${wallet.address} (${wallet.clientType}) for user ${user.id}`);
    const result = await checkWalletFunded(wallet.address);
    if (result.funded) {
      allDeposits.push(...result.deposits);
    }
  }

  return {
    funded: allDeposits.length > 0,
    deposits: allDeposits,
    walletAddresses,
  };
}

// ─── Report Generation ───────────────────────────────────────────────────────

/**
 * Write the final metrics report to a JSON file.
 */
function writeReport(outputPath, data) {
  writeFileSync(outputPath, JSON.stringify(data, null, 2), 'utf8');
}

/**
 * Build the report JSON payload.
 */
function buildReport({ totalUsers, analyzed, fundedCount, chainStats, sampled, sampleSize, populationSize }) {
  const conversion = analyzed > 0 ? fundedCount / analyzed : 0;
  const dropOffPct = (1 - conversion) * 100;

  // Build deposits-by-chain breakdown
  const depositsByChain = {};
  for (const [key, s] of Object.entries(chainStats)) {
    if (s.depositCount > 0) {
      depositsByChain[key] = {
        chain: s.chain,
        asset: s.asset,
        fundedUsers: s.fundedUsers,
        depositCount: s.depositCount,
        totalAmount: Math.round(s.totalAmount * 100) / 100,
      };
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    totalUsers,
    totalUsersAnalyzed: analyzed,
    fundedCount,
    conversionPercent: Math.round(conversion * 1000) / 10,
    dropOffPercent: Math.round(dropOffPct * 10) / 10,
    depositsByChain,
    chainsScanned: CHAINS.map(c => c.name),
    assetsScanned: [...new Set(CHAINS.flatMap(c => [
      c.native.symbol.toLowerCase(),
      ...Object.keys(c.tokens).filter(t => c.tokens[t] !== null),
    ]))],
  };

  // Add sampling metadata if sampling was used
  if (sampled) {
    const ci = wilsonCI(fundedCount, analyzed);
    report.sampling = {
      populationSize,
      sampleSize: analyzed,
      confidence: '95%',
      marginOfErrorPercent: Math.round(ci.marginOfError * 1000) / 10,
      conversionLower: Math.round(ci.lower * 1000) / 10,
      conversionUpper: Math.round(ci.upper * 1000) / 10,
    };
  }

  return report;
}

// ─── Progress Logging ────────────────────────────────────────────────────────

/**
 * Simple progress logger — prints a one-liner every N users.
 * No ANSI escape codes, no cursor movement.
 */
function logProgress(checked, total, funded, userId) {
  const pct = checked > 0 ? ((funded / checked) * 100).toFixed(1) : '0.0';
  const userIdShort = String(userId).slice(0, 24);
  console.log(`[${checked}/${total}] ${userIdShort}... — funded so far: ${funded} (${pct}%)`);
}

/**
 * Print the final summary report to console.
 */
function printSummary({ totalUsers, analyzed, fundedCount, chainStats, sampled, populationSize }) {
  const conversion = analyzed > 0 ? fundedCount / analyzed : 0;
  const dropOff = analyzed - fundedCount;
  const pct = (conversion * 100).toFixed(1);
  const dropPct = ((1 - conversion) * 100).toFixed(1);

  console.log('');
  console.log('--- Final Report ---');
  console.log(`Total Privy users:       ${totalUsers}`);
  if (sampled) {
    console.log(`Sampled from population: ${populationSize} (sample size: ${analyzed})`);
  } else {
    console.log(`Users analyzed:          ${analyzed}`);
  }
  console.log(`Funded wallets:          ${fundedCount}`);
  console.log(`Conversion rate:         ${pct}%`);
  console.log(`Drop-off:                ${drop} users (${dropPct}%)`);

  // Confidence interval for sampled data
  if (sampled && analyzed > 0) {
    const ci = wilsonCI(fundedCount, analyzed);
    console.log(`95% CI:                  ${Math.round(ci.lower * 1000) / 10}% – ${Math.round(ci.upper * 1000) / 10}% (±${Math.round(ci.marginOfError * 1000) / 10}%)`);
  }

  // Chain breakdown
  const activeChains = Object.values(chainStats).filter(s => s.depositCount > 0);
  if (activeChains.length > 0) {
    console.log('');
    console.log('--- Deposits by Chain ---');
    const maxLen = Math.max(...activeChains.map(s => (s.chain + ':' + s.asset).length));
    for (const s of activeChains) {
      const label = `${s.chain}:${s.asset}`.padEnd(maxLen);
      const total = s.totalAmount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      console.log(`  ${label}  ${s.depositCount} deposits from ${s.fundedUsers} users, total ${total}`);
    }
  }

  console.log('');
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const startTime = Date.now();

  console.log('Privy Funding Report — Blockchain RPC Edition');
  console.log(`Chains: ${CHAINS.map(c => c.name).join(', ')}`);
  console.log(`Social-only filter: ${opts.socialOnly ? 'ON' : 'OFF (all users with wallets)'}`);
  if (opts.sample) console.log(`Sampling: up to ${opts.sample} users`);
  if (opts.output) console.log(`Output: ${opts.output}`);
  console.log('');

  // ── Step 1: Fetch all users from Privy ──
  console.log('Fetching all Privy users...');
  let allUsers;
  try {
    allUsers = await fetchAllUsers();
  } catch (err) {
    console.error(`Failed to fetch users: ${err.message}`);
    process.exit(1);
  }
  console.log(`Fetched ${allUsers.length} total users`);

  // ── Step 2: Filter users with wallets ──
  const usersWithWallets = allUsers.filter(u => {
    const wallets = getWalletAccounts(u);
    return wallets.length > 0;
  });
  console.log(`Users with embedded/smart wallets: ${usersWithWallets.length}`);

  // Optionally filter to social-only users
  let targetUsers;
  if (opts.socialOnly) {
    targetUsers = usersWithWallets.filter(isSocialUser);
    console.log(`Social sign-in users (filtered): ${targetUsers.length}`);
  } else {
    targetUsers = usersWithWallets;
    console.log(`Analyzing all users with wallets`);
  }

  if (targetUsers.length === 0) {
    console.log('No users to analyze. Nothing to do.');
    return;
  }

  // ── Step 3: Apply sampling if requested ──
  const populationSize = targetUsers.length;
  const sampled = opts.sample && populationSize > opts.sample;

  if (sampled) {
    targetUsers = sampleArray(targetUsers, opts.sample);
    console.log(`Sampled ${targetUsers.length} users from ${populationSize} (Fisher-Yates shuffle)`);
  }

  // Sort newest first for progress visibility
  targetUsers.sort((a, b) => (b.created_at ?? b.createdAt ?? 0) - (a.created_at ?? a.createdAt ?? 0));

  // ── Step 4: Check each user's wallet funding ──
  console.log('');
  console.log('Checking wallet funding via blockchain RPC...');

  let fundedCount = 0;
  const chainStats = {};
  const PROGRESS_INTERVAL = opts.verbose ? 1 : Math.max(1, Math.floor(targetUsers.length / 20));

  for (let i = 0; i < targetUsers.length; i++) {
    const user = targetUsers[i];
    const userId = user.id ?? user.did ?? 'unknown';

    try {
      const result = await checkUserFunded(user);
      if (result.funded) fundedCount++;

      // Accumulate chain stats
      const userChainKeys = new Set();
      for (const d of result.deposits) {
        const key = `${d.chain}:${d.asset}`;
        if (!chainStats[key]) {
          chainStats[key] = { chain: d.chain, asset: d.asset, depositCount: 0, fundedUsers: 0, totalAmount: 0 };
        }
        chainStats[key].depositCount++;
        chainStats[key].totalAmount += d.amount;
        if (!userChainKeys.has(key)) {
          userChainKeys.add(key);
          chainStats[key].fundedUsers++;
        }
      }

      // Progress output
      if ((i + 1) % PROGRESS_INTERVAL === 0 || i === targetUsers.length - 1) {
        logProgress(i + 1, targetUsers.length, fundedCount, userId);
      }
    } catch (err) {
      verbose(`Error checking user ${userId}: ${err.message}`);
    }

    // Write incremental report if output path is specified
    if (opts.output && (i + 1) % 10 === 0) {
      const report = buildReport({
        totalUsers: allUsers.length,
        analyzed: i + 1,
        fundedCount,
        chainStats,
        sampled,
        sampleSize: targetUsers.length,
        populationSize,
      });
      writeReport(opts.output, report);
    }
  }

  // ── Step 5: Print summary and write final report ──
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  printSummary({
    totalUsers: allUsers.length,
    analyzed: targetUsers.length,
    fundedCount,
    chainStats,
    sampled,
    populationSize,
  });

  console.log(`Completed in ${elapsed}s`);

  if (opts.output) {
    const report = buildReport({
      totalUsers: allUsers.length,
      analyzed: targetUsers.length,
      fundedCount,
      chainStats,
      sampled,
      sampleSize: targetUsers.length,
      populationSize,
    });
    writeReport(opts.output, report);
    console.log(`Report written to ${opts.output}`);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
