# API

## GET /health

Response:
```json
{ "ok": true, "service": "fomoholdersapi" }
```

## POST /indexer/tick?limit=25

Indexes a batch of recent FOMO-program signatures and updates KV wallet set.

Response example:
```json
{
  "ok": true,
  "indexed": 25,
  "walletsAdded": 14,
  "cursor": "5x..."
}
```

## GET /query/:mint

Returns FOMO wallet concentration estimate based on top holders.

Response example:
```json
{
  "ok": true,
  "mint": "So11111111111111111111111111111111111111112",
  "method": "top_holders_intersect_indexed_fomo_wallets",
  "topHolderCount": 20,
  "fomoWalletHits": 3,
  "fomoUiAmount": 123456.78,
  "totalUiAmountTopHolders": 987654.32,
  "fomoPctTopHolders": 12.5,
  "indexCoverageHint": "conservative_estimate_depends_on_index_warmth",
  "updatedAt": 1710000000000,
  "cache": "miss"
}
```

## Caveats

- Result is conservative and depends on index coverage.
- v1 uses top holders, not full supply scan.
