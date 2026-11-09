# d3sk

OTC desk for Raydium coins and real stocks on Solana.

Two wallets trade directly in one transaction: leg A→B, leg B→A, a memo, and an optional desk fee. Wallet A signs first against a durable nonce; wallet B's signature settles it. No custom program, no desk key, no custody. Cancel = advance the nonce.

- `index.html`, `assets/` — the site (landing + app)
- `api/d3sk.js` — offers, tickets, nonce slots, pool checks, token checks
- `api/d3sk-config.json` — stock list, cash list, fee settings

Needs `BLOB_READ_WRITE_TOKEN` (Vercel Blob) for offers and tickets.
