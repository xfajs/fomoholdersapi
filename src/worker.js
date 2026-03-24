export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return json({ ok: true, service: 'fomoholdersapi' });
    }

    // Optional manual trigger for debugging.
    if (url.pathname === '/indexer/tick' && request.method === 'POST') {
      const out = await runIndexerTick(env, Number(url.searchParams.get('limit') || 25));
      return json(out);
    }

    if (url.pathname.startsWith('/query/') && request.method === 'GET') {
      const mint = url.pathname.split('/').pop();
      const out = await queryFomoHoldersPct(env, mint);
      return json(out);
    }

    return json({ error: 'not_found' }, 404);
  },

  async scheduled(event, env, ctx) {
    // Runs from Cloudflare Cron Triggers.
    ctx.waitUntil(runIndexerTick(env, 25));
  },
};

const FOMO_PROGRAM_ID = 'DF1ow4tspfHX9JwWJsAb9epbkA8hmpSEAtxXy1V27QBH';
const FEE_WALLET = 'HrTf9CzXR1dRH4Sof5QrpmGWwpwAf3qZzwCsEjQpXcSq';

async function runIndexerTick(env, limit = 25) {
  // Reads signatures that touched the FOMO program and stores probable signer wallets in KV.
  // Cursor is persisted in KV key: idx:fomo_program:before
  const cursorKey = 'idx:fomo_program:before';
  const before = await env.FOMO_KV.get(cursorKey);

  const sigs = await rpc(env, 'getSignaturesForAddress', [
    FOMO_PROGRAM_ID,
    {
      limit,
      ...(before ? { before } : {}),
    },
  ]);

  if (!Array.isArray(sigs) || sigs.length === 0) {
    return { ok: true, indexed: 0, reason: 'no_new_signatures' };
  }

  const wallets = new Set();

  for (const s of sigs) {
    const tx = await rpc(env, 'getTransaction', [s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]);
    if (!tx?.transaction?.message) continue;

    // Heuristic: first signer / fee payer is usually index 0 in account keys.
    const accountKeys = tx.transaction.message.accountKeys || [];
    const maybeSigner = accountKeys.find((k) => k?.signer)?.pubkey || accountKeys[0]?.pubkey || accountKeys[0];
    if (typeof maybeSigner === 'string') wallets.add(maybeSigner);

    // Bonus: keep txs that reference fee wallet as extra confidence for FOMO fingerprints.
    const mentionsFeeWallet = accountKeys.some((k) => (typeof k === 'string' ? k : k?.pubkey) === FEE_WALLET);
    if (mentionsFeeWallet && typeof maybeSigner === 'string') wallets.add(maybeSigner);
  }

  // Write discovered wallets to KV as key-only flags.
  const now = Date.now();
  await Promise.all(
    [...wallets].map((w) => env.FOMO_KV.put(`wallet:${w}`, '1', { metadata: { updatedAt: now } })),
  );

  // Advance cursor to oldest signature processed in this batch.
  const oldestSig = sigs[sigs.length - 1]?.signature;
  if (oldestSig) await env.FOMO_KV.put(cursorKey, oldestSig);

  return {
    ok: true,
    indexed: sigs.length,
    walletsAdded: wallets.size,
    cursor: oldestSig || null,
  };
}

async function queryFomoHoldersPct(env, mint) {
  if (!mint) return { ok: false, error: 'missing_mint' };

  const cacheKey = `cache:token:${mint}`;
  const cached = await env.FOMO_KV.get(cacheKey, { type: 'json' });
  if (cached && cached.expiresAt > Date.now()) {
    return { ...cached, cache: 'hit' };
  }

  const largest = await rpc(env, 'getTokenLargestAccounts', [mint]);
  const holders = (largest?.value || [])
    .map((x) => ({
      tokenAccount: x.address,
      amountRaw: Number(x.amount || 0),
      uiAmount: Number(x.uiAmount || 0),
    }))
    .filter((x) => x.amountRaw > 0);

  // Resolve owner wallet for each token account.
  const parsedAccounts = await rpc(env, 'getMultipleAccounts', [
    holders.map((h) => h.tokenAccount),
    { encoding: 'jsonParsed' },
  ]);

  const ownerByTokenAccount = new Map();
  (parsedAccounts?.value || []).forEach((acc, i) => {
    const owner = acc?.data?.parsed?.info?.owner;
    if (owner) ownerByTokenAccount.set(holders[i].tokenAccount, owner);
  });

  const holderRows = holders.map((h) => ({ ...h, owner: ownerByTokenAccount.get(h.tokenAccount) })).filter((h) => h.owner);

  // Intersect with indexed FOMO wallets set (KV key flags).
  const checks = await Promise.all(holderRows.map((h) => env.FOMO_KV.get(`wallet:${h.owner}`)));

  let total = 0;
  let fomo = 0;
  const fomoOwners = [];

  for (let i = 0; i < holderRows.length; i++) {
    const row = holderRows[i];
    total += row.uiAmount;
    if (checks[i]) {
      fomo += row.uiAmount;
      fomoOwners.push(row.owner);
    }
  }

  const pct = total > 0 ? (fomo / total) * 100 : 0;

  const out = {
    ok: true,
    mint,
    method: 'top_holders_intersect_indexed_fomo_wallets',
    topHolderCount: holderRows.length,
    fomoWalletHits: [...new Set(fomoOwners)].length,
    fomoUiAmount: fomo,
    totalUiAmountTopHolders: total,
    fomoPctTopHolders: pct,
    indexCoverageHint: 'conservative_estimate_depends_on_index_warmth',
    updatedAt: Date.now(),
  };

  await env.FOMO_KV.put(cacheKey, JSON.stringify({ ...out, expiresAt: Date.now() + 60_000 }));
  return { ...out, cache: 'miss' };
}

async function rpc(env, method, params) {
  const endpoint = 'https://mainnet.helius-rpc.com/?api-key=ce8a535b-6103-49eb-9fb5-be190271d183';

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`RPC HTTP ${res.status}: ${text}`);
  }

  const data = await res.json();
  if (data.error) throw new Error(`RPC ${method} error: ${JSON.stringify(data.error)}`);
  return data.result;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
