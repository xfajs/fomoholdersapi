export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (url.pathname === '/health') {
      const out = await health(env);
      return json(out);
    }

    // Optional manual trigger for debugging.
    if (url.pathname === '/indexer/tick' && request.method === 'POST') {
      try {
        const out = await runIndexerTick(env, Number(url.searchParams.get('limit') || 50));
        return json(out);
      } catch (err) {
        return json({ ok: false, where: 'indexer_tick', error: String(err?.message || err) }, 500);
      }
    }

    if (url.pathname.startsWith('/query/wallet/') && request.method === 'GET') {
      try {
        const wallet = url.pathname.split('/').pop();
        const out = await queryIsFomoWallet(env, wallet);
        return json(out);
      } catch (err) {
        return json({ ok: false, where: 'query_wallet', error: String(err?.message || err) }, 500);
      }
    }

    if (url.pathname.startsWith('/history/') && request.method === 'GET') {
      try {
        const mint = url.pathname.split('/').pop();
        const out = await queryHistory(env, mint);
        return json(out);
      } catch (err) {
        return json({ ok: false, where: 'history', error: String(err?.message || err) }, 500);
      }
    }

    if (url.pathname.startsWith('/token-info/') && request.method === 'GET') {
      try {
        const mint = url.pathname.split('/').pop();
        const out = await queryTokenInfo(mint);
        return json(out);
      } catch (err) {
        return json({ ok: false, where: 'token_info', error: String(err?.message || err) }, 500);
      }
    }

    if (url.pathname.startsWith('/query/') && request.method === 'GET') {
      try {
        const mint = url.pathname.split('/').pop();
        const out = await queryFomoHoldersPct(env, mint);
        return json(out);
      } catch (err) {
        return json({ ok: false, where: 'query', error: String(err?.message || err) }, 500);
      }
    }

    return json({ error: 'not_found' }, 404);
  },

  async scheduled(event, env, ctx) {
    // Runs from Cloudflare Cron Triggers.
    ctx.waitUntil(
      runIndexerTick(env, 50).catch((err) => {
        console.error('scheduled indexer tick failed:', err?.message || err);
      }),
    );
  },
};

const FEE_TOKEN_ACCOUNT = 'HrTf9CzXR1dRH4Sof5QrpmGWwpwAf3qZzwCsEjQpXcSq';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

async function runIndexerTick(env, limit = 50) {
  // Reads signatures that touched the fee vault and stores probable sender wallets in KV.
  // Cursor is persisted in KV key: idx:fee_vault:before
  const cursorKey = 'idx:fee_vault:before';
  const before = await env.FOMO_KV.get(cursorKey);

  const sigs = await rpc(env, 'getSignaturesForAddress', [
    FEE_TOKEN_ACCOUNT,
    {
      limit,
      ...(before ? { before } : {}),
    },
  ]);

  if (!Array.isArray(sigs) || sigs.length === 0) {
    return { ok: true, indexed: 0, reason: 'no_new_signatures' };
  }

  const wallets = new Set();
  const signatures = sigs.map((s) => s.signature).filter(Boolean);

  // Batch parse signatures via Helius Enhanced Transactions API (far fewer calls than per-signature getTransaction).
  const parsedTxs = await heliusBatchParse(signatures);

  for (const tx of parsedTxs) {
    const transfers = tx?.tokenTransfers || [];

    // Strict fingerprint: USDC transfer into FOMO fee token account.
    for (const tr of transfers) {
      const isUsdcFee = tr?.mint === USDC_MINT;
      const goesToFeeTokenAccount = tr?.toTokenAccount === FEE_TOKEN_ACCOUNT;
      if (isUsdcFee && goesToFeeTokenAccount && typeof tr?.fromUserAccount === 'string') {
        wallets.add(tr.fromUserAccount);
      }
    }
  }

  // Write discovered wallets to KV as key-only flags.
  const now = Date.now();
  await Promise.all(
    [...wallets].map((w) => env.FOMO_KV.put(`wallet:${w}`, '1', { metadata: { updatedAt: now } })),
  );

  // Advance cursor to oldest signature processed in this batch.
  const oldestSig = sigs[sigs.length - 1]?.signature;
  if (oldestSig) await env.FOMO_KV.put(cursorKey, oldestSig);

  await env.FOMO_KV.put('meta:lastTickAt', String(now));
  await env.FOMO_KV.put(
    'meta:lastTickSummary',
    JSON.stringify({ indexed: sigs.length, walletsAdded: wallets.size, cursor: oldestSig || null, at: now }),
  );

  return {
    ok: true,
    indexed: sigs.length,
    walletsAdded: wallets.size,
    cursor: oldestSig || null,
  };
}

async function health(env) {
  const [cursor, lastTickAtRaw, lastTickSummary, walletListSample] = await Promise.all([
    env.FOMO_KV.get('idx:fee_vault:before'),
    env.FOMO_KV.get('meta:lastTickAt'),
    env.FOMO_KV.get('meta:lastTickSummary', { type: 'json' }),
    env.FOMO_KV.list({ prefix: 'wallet:', limit: 1000 }),
  ]);

  return {
    ok: true,
    service: 'fomoholdersapi',
    stats: {
      walletIndexSampleCount: walletListSample.keys.length,
      walletIndexHasMore: !walletListSample.list_complete,
      hasCursor: !!cursor,
      lastTickAt: lastTickAtRaw ? Number(lastTickAtRaw) : null,
      lastTickSummary: lastTickSummary || null,
    },
  };
}

async function queryHistory(env, mint) {
  if (!mint) return { ok: false, error: 'missing_mint' };
  const points = (await env.FOMO_KV.get(`history:${mint}`, { type: 'json' })) || [];
  return { ok: true, mint, points, count: points.length };
}

async function queryTokenInfo(mint) {
  if (!mint) return { ok: false, error: 'missing_mint' };
  const res = await fetch(`https://frontend-api-v3.pump.fun/coins/${mint}`);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`pump token info ${res.status}: ${text}`);
  }
  const data = await res.json();
  return { ok: true, mint, data };
}

async function queryIsFomoWallet(env, wallet) {
  if (!wallet) return { ok: false, error: 'missing_wallet' };

  const exists = await env.FOMO_KV.get(`wallet:${wallet}`);
  return {
    ok: true,
    wallet,
    isFomoWallet: !!exists,
    updatedAt: Date.now(),
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

  // Aggregate token-account rows into owner-level rows for cleaner frontend display.
  const ownerMap = new Map();

  let total = 0;
  let fomo = 0;
  const fomoOwners = [];

  for (let i = 0; i < holderRows.length; i++) {
    const row = holderRows[i];
    const isFomo = !!checks[i];

    total += row.uiAmount;

    const prev = ownerMap.get(row.owner) || { owner: row.owner, uiAmount: 0, isFomoWallet: false };
    prev.uiAmount += row.uiAmount;
    prev.isFomoWallet = prev.isFomoWallet || isFomo;
    ownerMap.set(row.owner, prev);

    if (isFomo) {
      fomo += row.uiAmount;
      fomoOwners.push(row.owner);
    }
  }

  const holderList = [...ownerMap.values()]
    .sort((a, b) => b.uiAmount - a.uiAmount)
    .map((r, idx) => ({ rank: idx + 1, ...r }));

  const pctTop = total > 0 ? (fomo / total) * 100 : 0;

  let totalSupplyUi = null;
  let pctTotalSupply = null;
  try {
    const supply = await rpc(env, 'getTokenSupply', [mint]);
    totalSupplyUi = Number(supply?.value?.uiAmount || 0);
    pctTotalSupply = totalSupplyUi > 0 ? (fomo / totalSupplyUi) * 100 : 0;
  } catch {
    // keep null if supply lookup fails
  }

  const out = {
    ok: true,
    mint,
    method: 'top_holders_intersect_indexed_fomo_wallets',
    topHolderCount: holderRows.length,
    fomoWalletHits: [...new Set(fomoOwners)].length,
    fomoUiAmount: fomo,
    totalUiAmountTopHolders: total,
    fomoPctTopHolders: pctTop,
    totalSupplyUi,
    fomoPctTotalSupply: pctTotalSupply,
    holderList,
    indexCoverageHint: 'conservative_estimate_depends_on_index_warmth',
    updatedAt: Date.now(),
  };

  await env.FOMO_KV.put(cacheKey, JSON.stringify({ ...out, expiresAt: Date.now() + 60_000 }));

  // Append mint history snapshot (for frontend chart)
  const historyKey = `history:${mint}`;
  const prev = (await env.FOMO_KV.get(historyKey, { type: 'json' })) || [];
  const snapshot = {
    t: out.updatedAt,
    pctTotal: out.fomoPctTotalSupply,
    pctTop: out.fomoPctTopHolders,
    hits: out.fomoWalletHits,
  };
  const next = [...prev, snapshot].slice(-240);
  await env.FOMO_KV.put(historyKey, JSON.stringify(next));

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

async function heliusBatchParse(signatures) {
  if (!signatures?.length) return [];

  const endpoint = 'https://api.helius.xyz/v0/transactions/?api-key=ce8a535b-6103-49eb-9fb5-be190271d183';
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ transactions: signatures }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HELIUS_PARSE HTTP ${res.status}: ${text}`);
  }

  const data = await res.json();
  if (!Array.isArray(data)) {
    throw new Error(`HELIUS_PARSE unexpected response: ${JSON.stringify(data).slice(0, 500)}`);
  }

  return data;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...corsHeaders(),
    },
  });
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}
