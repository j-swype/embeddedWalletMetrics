#!/usr/bin/env node
/**
 * Swype · Funding Report for Privy
 * One-time report: non-wallet sign-in users → ever funded (incoming tx).
 * No DB, no --save. Env: PRIVY_APP_ID, PRIVY_APP_SECRET.
 */

import { readFileSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';

const NON_WALLET_AUTH_TYPES = new Set([
  'email',
  'phone',
  'google_oauth',
  'twitter_oauth',
  'telegram',
  'farcaster',
  'apple_oauth',
  'discord_oauth',
  'github_oauth',
  'instagram_oauth',
  'linkedin_oauth',
  'spotify_oauth',
]);

const EVM_ASSETS = ['usdc', 'usdt'];
const CHAIN_ASSET_QUERIES = [
  { chain: 'ethereum',  assets: EVM_ASSETS },
  { chain: 'arbitrum',  assets: EVM_ASSETS },
  { chain: 'base',      assets: EVM_ASSETS },
  { chain: 'optimism',  assets: EVM_ASSETS },
  { chain: 'polygon',   assets: EVM_ASSETS },
  //{ chain: 'solana',   assets: ['usdc'] },
];

const DELAY_MS = 300;
const PRIVY_BASE = 'https://api.privy.io/v1';

function loadEnv() {
  const envPath = join(process.cwd(), '.env');
  if (!existsSync(envPath)) return;
  try {
    const raw = readFileSync(envPath, 'utf8');
    raw.split('\n').forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      const idx = trimmed.indexOf('=');
      if (idx <= 0) return;
      const key = trimmed.slice(0, idx).trim();
      let val = trimmed.slice(idx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
        val = val.slice(1, -1);
      process.env[key] = val;
    });
  } catch (_) {}
}

loadEnv();

const APP_ID = process.env.PRIVY_APP_ID;
const APP_SECRET = process.env.PRIVY_APP_SECRET;

if (!APP_ID || !APP_SECRET) {
  console.error('Missing PRIVY_APP_ID or PRIVY_APP_SECRET. Set in .env or environment.');
  process.exit(1);
}

const auth = Buffer.from(`${APP_ID}:${APP_SECRET}`).toString('base64');

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchPrivy(path, params = {}) {
  const base = PRIVY_BASE.endsWith('/') ? PRIVY_BASE : PRIVY_BASE + '/';
  const url = new URL(path.startsWith('/') ? path.slice(1) : path, base);
  Object.entries(params).forEach(([k, v]) => {
    if (Array.isArray(v)) {
      v.forEach((item) => url.searchParams.append(k, String(item)));
    } else {
      url.searchParams.set(k, String(v));
    }
  });
  const res = await fetch(url.toString(), {
    headers: {
      'Authorization': `Basic ${auth}`,
      'privy-app-id': APP_ID,
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) {
    const text = await res.text();
    const hint = res.status === 404 ? ' (List-users may require a paid Privy plan)' : '';
    throw new Error(`Privy API ${res.status}: ${text}${hint}`);
  }
  return res.json();
}

async function fetchAllUsers() {
  const users = [];
  let cursor = '';
  do {
    const q = { limit: 100 };
    if (cursor) q.cursor = cursor;
    const data = await fetchPrivy('users', q);
    const page = data.data ?? [];
    users.push(...page);
    cursor = data.next_cursor || '';
    await delay(DELAY_MS);
    if (page.length < 100) break;
  } while (cursor);
  return users;
}

function isSocialUser(user) {
  const accounts = user.linked_accounts ?? user.linkedAccounts ?? [];
  return accounts.some((a) => NON_WALLET_AUTH_TYPES.has(a.type));
}

function getEmbeddedWalletId(user) {
  const accounts = user.linked_accounts ?? user.linkedAccounts ?? [];
  const embedded = accounts.find(
    (a) =>
      a.type === 'wallet' &&
      (a.wallet_client_type === 'privy' || a.walletClientType === 'privy')
  );
  return embedded?.id ?? null;
}

async function walletReceivedDeposits(walletId, chain, assets) {
  const deposits = [];
  const batches = [];
  for (let i = 0; i < assets.length; i += 4) batches.push(assets.slice(i, i + 4));

  for (const batch of batches) {
    let cursor = '';
    do {
      const params = { chain, asset: batch, limit: 100 };
      if (cursor) params.cursor = cursor;
      const data = await fetchPrivy(`wallets/${walletId}/transactions`, params);
      await delay(DELAY_MS);
      const txs = data.transactions ?? [];
      for (const tx of txs) {
        const details = tx.details;
        if (details?.type === 'transfer_received' && (tx.status === 'confirmed' || tx.status === 'finalized')) {
          const rawValue = details.raw_value ?? details.rawValue ?? '0';
          const decimals = details.raw_value_decimals ?? details.rawValueDecimals ?? 0;
          deposits.push({
            chain: details.chain ?? chain,
            asset: details.asset ?? batch[0],
            amount: Number(rawValue) / 10 ** decimals,
            timestamp: tx.created_at ?? tx.createdAt ?? null,
          });
        }
      }
      cursor = data.next_cursor ?? '';
      if (txs.length < 100) break;
    } while (cursor);
  }
  return deposits;
}

async function checkSocialUserFunded(user) {
  const walletId = getEmbeddedWalletId(user);
  const empty = { funded: false, firstFundedAt: null, fundingChain: null, fundingAsset: null, embeddedWalletId: null, deposits: [] };
  if (!walletId) return empty;

  const allDeposits = [];
  for (const { chain, assets } of CHAIN_ASSET_QUERIES) {
    const deposits = await walletReceivedDeposits(walletId, chain, assets);
    allDeposits.push(...deposits);
  }

  if (allDeposits.length === 0) return { ...empty, embeddedWalletId: walletId };

  let firstFundedAt = null;
  let fundingChain = null;
  let fundingAsset = null;
  for (const d of allDeposits) {
    if (d.timestamp != null && (firstFundedAt == null || d.timestamp < firstFundedAt)) {
      firstFundedAt = d.timestamp;
      fundingChain = d.chain;
      fundingAsset = d.asset;
    }
  }

  return {
    funded: true,
    firstFundedAt: firstFundedAt != null ? new Date(firstFundedAt) : null,
    fundingChain,
    fundingAsset,
    embeddedWalletId: walletId,
    deposits: allDeposits,
  };
}

const isTTY = process.stdout.isTTY === true;

function renderDashboard({ checked, socialCreated, socialFunded, chainStats, userId }) {
  const lines = [];
  const pct = checked > 0 ? ((socialFunded / checked) * 100).toFixed(1) : '0.0';
  const dropOff = checked > 0 ? (((checked - socialFunded) / checked) * 100).toFixed(1) : '0.0';

  lines.push(`[Swype] Checking funded: ${checked}/${socialCreated} (${String(userId).slice(0, 20)}...)`);
  lines.push('');
  lines.push('--- Metrics ---');
  lines.push(`Social created: ${checked}`);
  lines.push(`Social funded:  ${socialFunded}`);
  lines.push(`Conversion:     ${pct}%`);
  lines.push(`Drop-off:       ${checked - socialFunded} (${dropOff}%)`);

  const activeChains = Object.values(chainStats).filter((s) => s.depositCount > 0);
  if (activeChains.length > 0) {
    lines.push('');
    lines.push('--- Deposits by Chain ---');
    const maxChainLen = Math.max(...activeChains.map((s) => s.chain.length));
    for (const s of activeChains) {
      const label = s.chain.padEnd(maxChainLen);
      const asset = s.asset.toUpperCase();
      const total = s.totalAmount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      lines.push(`  ${label} (${asset}):  ${s.depositCount} deposits from ${s.fundedUsers} users, total ${total} ${asset}`);
    }
  }

  return lines;
}

let lastDashboardLineCount = 0;

function drawDashboard(state) {
  const lines = renderDashboard(state);
  if (isTTY) {
    if (lastDashboardLineCount > 0) {
      process.stdout.write(`\x1B[${lastDashboardLineCount}A\x1B[0J`);
    }
    process.stdout.write(lines.join('\n') + '\n');
    lastDashboardLineCount = lines.length;
  } else {
    process.stdout.write(`\r${lines[0]}`);
  }
}

function writeReport(outputPath, { totalUsers, checked, socialFunded, chainStats }) {
  const conversion = checked > 0 ? socialFunded / checked : 0;
  const dropOffPct = (1 - conversion) * 100;
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
  const payload = {
    totalUsers,
    totalUsersAnalyzed: checked,
    nonWalletSignInCount: checked,
    fundedCount: socialFunded,
    conversionPercent: Math.round(conversion * 1000) / 10,
    dropOffPercent: Math.round(dropOffPct * 10) / 10,
    depositsByChain,
  };
  writeFileSync(outputPath, JSON.stringify(payload, null, 2), 'utf8');
}

function parseOutputArg() {
  const i = process.argv.indexOf('--output');
  if (i === -1 || !process.argv[i + 1]) return null;
  return process.argv[i + 1];
}

async function main() {
  const outputPath = parseOutputArg();

  console.log('─────────────────────────────────────');
  console.log('  Swype · Funding Report for Privy');
  console.log('  Sign-up → first funding conversion');
  console.log('─────────────────────────────────────');
  console.log('');

  console.log('Fetching all Privy users...');
  const allUsers = await fetchAllUsers();
  allUsers.sort((a, b) => (b.created_at ?? b.createdAt ?? 0) - (a.created_at ?? a.createdAt ?? 0));
  console.log('Total Privy users:', allUsers.length);

  const socialUsers = allUsers.filter(isSocialUser);
  const socialCreated = socialUsers.length;
  console.log('Non-wallet sign-in users (denominator):', socialCreated);

  if (socialCreated === 0) {
    console.log('No non-wallet users. Conversion = N/A.');
    console.log('');
    console.log('Powered by Swype · https://swype.io');
    return;
  }

  let socialFunded = 0;
  const chainStats = {};

  for (let i = 0; i < socialUsers.length; i++) {
    const user = socialUsers[i];
    const userId = user.id ?? user.did ?? '';
    const result = await checkSocialUserFunded(user);
    if (result.funded) socialFunded++;

    const userChainsSeen = new Set();
    for (const d of result.deposits) {
      const key = `${d.chain}:${d.asset}`;
      if (!chainStats[key]) chainStats[key] = { chain: d.chain, asset: d.asset, depositCount: 0, fundedUsers: 0, totalAmount: 0 };
      chainStats[key].depositCount++;
      chainStats[key].totalAmount += d.amount;
      if (!userChainsSeen.has(key)) {
        userChainsSeen.add(key);
        chainStats[key].fundedUsers++;
      }
    }

    drawDashboard({ checked: i + 1, socialCreated, socialFunded, chainStats, userId });
    if (outputPath) writeReport(outputPath, { totalUsers: allUsers.length, checked: i + 1, socialFunded, chainStats });
  }

  if (!isTTY) {
    process.stdout.write('\n');
    const finalLines = renderDashboard({ checked: socialCreated, socialCreated, socialFunded, chainStats, userId: 'done' });
    for (const line of finalLines.slice(1)) console.log(line);
  }

  if (outputPath) {
    console.log('Wrote metrics to', outputPath);
  }

  console.log('');
  console.log('Powered by Swype · https://swype.io');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
