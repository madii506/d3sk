// d3sk API: the OTC desk for Raydium coins and real stocks.
// Every trade is one Solana transaction with two legs and two signatures. The wallet that starts it signs first, with a durable nonce so the
// signature stays valid; the other wallet's signature settles it. Nobody holds anyone's tokens, there is no desk key, and if either leg can't
// pay, nothing moves. Offers are free signed messages; tickets (pre-signed trades) are stored as they were signed; their status is read from
// the chain. Every settled trade pays 0 SOL to a fixed tag address, so the chain itself lists them.
// GET  a=token&mint= · a=pairs · a=offers · a=offer&id= · a=ticket&id= · a=tickets&wallet= · a=wallet&addr= · a=bags&addr= · a=holders&mint=
//      a=poolcheck&mint=&amount= · a=dumps · a=settled · a=stats · a=nonces&wallet= · a=simLegs&wa=&wb=&giveMint=&give=&getMint=&get= (dry run between any two wallets)
// POST a=prepareOffer · a=postOffer · a=prepareCancelOffer · a=cancelOffer · a=buildTicket · a=submitTicket · a=buildCancel · a=buildNonce
//      a=buildNonceRefund · a=send
const { Connection, PublicKey, SystemProgram, Transaction, TransactionInstruction, NonceAccount, NONCE_ACCOUNT_LENGTH, VersionedTransaction } = require('@solana/web3.js');
const SPL = require('@solana/spl-token');
const { ed25519 } = require('@noble/curves/ed25519');
const bs58 = (m => m.default || m)(require('bs58'));
const crypto = require('crypto');
const CFG = require('./d3sk-config.json');

// RPC with fallback: a rate-limited or failing endpoint hands the same request to the next one
const RPCS = [process.env.RPC_URL, 'https://api.mainnet-beta.solana.com', 'https://solana-rpc.publicnode.com'].filter(Boolean), RPC = RPCS[0];
async function rpcFetch(url, opts) { let last = null; for (let round = 0; round < 2; round++) { for (const u of RPCS) { try { const r = await fetch(u, { ...opts, signal: AbortSignal.timeout(12000) }); if (r.status === 429 || r.status === 401 || r.status === 403 || r.status >= 500) { last = r; continue; } return r; } catch (e) { last = e; } } await new Promise(r => setTimeout(r, 700)); } if (last instanceof Error) throw last; return last; }
const conn = new Connection(RPC, { commitment: 'confirmed', fetch: rpcFetch, disableRetryOnRateLimit: true });
const JUP = 'https://lite-api.jup.ag';
const SOL = 'So11111111111111111111111111111111111111112';
const MEMO = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const TAG = new PublicKey(process.env.D3SK_TAG || CFG.tag);
const TREASURY = (() => { try { return process.env.D3SK_TREASURY ? new PublicKey(process.env.D3SK_TREASURY) : (CFG.treasury ? new PublicKey(CFG.treasury) : null); } catch { return null; } })();
const FEE_BPS = Math.max(0, Math.min(100, +(process.env.D3SK_FEE_BPS ?? CFG.feeBps ?? 30)));
const SLOTS = 8, SEED = 'd3sk-';
const ALLOWED_PROGRAMS = new Set([SystemProgram.programId.toBase58(), SPL.TOKEN_PROGRAM_ID.toBase58(), SPL.TOKEN_2022_PROGRAM_ID.toBase58(), SPL.ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(), MEMO.toBase58()]);

const out = (res, code, body, cache) => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.setHeader('cache-control', cache || 'no-store'); res.end(JSON.stringify(body)); };
const body = req => new Promise(ok => { if (req.body) return ok(typeof req.body === 'string' ? JSON.parse(req.body) : req.body); let d = ''; req.on('data', c => d += c); req.on('end', () => { try { ok(JSON.parse(d || '{}')); } catch { ok({}); } }); });
const pk = (s, what) => { try { return new PublicKey(String(s)); } catch { throw new Error(what || 'bad address'); } };
const clean = (s, n) => String(s || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rid = () => crypto.randomBytes(9).toString('base64').replace(/\+/g, 'x').replace(/\//g, 'y').replace(/=+$/, '');
async function getJ(url, ms = 8000) { for (let k = 0; k < 2; k++) { const r = await fetch(url, { signal: AbortSignal.timeout(ms), headers: { accept: 'application/json' } }); if (r.status === 429 && !k) { await sleep(1300); continue; } if (!r.ok) throw new Error(url.split('/')[2] + ' ' + r.status); return r.json(); } }
const memoIx = (signer, text) => new TransactionInstruction({ programId: MEMO, keys: [{ pubkey: signer, isSigner: true, isWritable: false }], data: Buffer.from(text, 'utf8') });
const ser = t => Buffer.from(t.serialize({ requireAllSignatures: false, verifySignatures: false })).toString('base64');
const cache = new Map(); const memo = async (k, ttl, fn) => { const c = cache.get(k); if (c && Date.now() - c.t < ttl) return c.v; const v = await fn(); cache.set(k, { t: Date.now(), v }); return v; };

// ---------------------------------------------------------------- storage: Vercel Blob, write-once JSON (status always comes from the chain)
const blob = () => require('@vercel/blob');
const PFX = 'd3sk/';
async function putJSON(path, obj) { if (!process.env.BLOB_READ_WRITE_TOKEN) throw new Error('storage is not switched on yet'); return blob().put(PFX + path, JSON.stringify(obj), { access: 'public', addRandomSuffix: false, allowOverwrite: false, contentType: 'application/json', cacheControlMaxAge: 31536000 }); }
async function putMark(path) { if (!process.env.BLOB_READ_WRITE_TOKEN) throw new Error('storage is not switched on yet'); return blob().put(PFX + path, '1', { access: 'public', addRandomSuffix: false, allowOverwrite: true, contentType: 'text/plain' }); }
async function listAll(prefix) { if (!process.env.BLOB_READ_WRITE_TOKEN) return []; const outL = []; let cursor; do { const r = await blob().list({ prefix: PFX + prefix, cursor, limit: 1000 }); outL.push(...r.blobs); cursor = r.hasMore ? r.cursor : null; } while (cursor && outL.length < 5000); return outL; }
const jsonCache = new Map();
async function readJSON(url) { if (jsonCache.has(url)) return jsonCache.get(url); const r = await fetch(url, { signal: AbortSignal.timeout(8000) }); if (!r.ok) throw new Error('not found'); const j = await r.json(); jsonCache.set(url, j); return j; }
const blobBase = () => { const id = (process.env.BLOB_STORE_ID || '').replace(/^store_/, '') || String(process.env.BLOB_READ_WRITE_TOKEN || '').split('_')[3] || ''; return id ? `https://${id.toLowerCase()}.public.blob.vercel-storage.com/` : null; };
async function readPath(path) { const b = blobBase(); if (!b) throw new Error('storage is not switched on yet'); return readJSON(b + PFX + path); }

// ---------------------------------------------------------------- tokens: what a mint is, whether it can move wallet to wallet, and its price
const STOCKS = CFG.stocks, STOCK = Object.fromEntries(STOCKS.map(s => [s.mint, s])), THIN = 5000;
// official logos for the fixed pairs, so a real logo shows even when the price feed is rate-limited
const TL = 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/';
const ICONS = Object.fromEntries([...STOCKS.map(s => [s.mint, `https://xstocks-metadata.backed.fi/logos/tokens/${s.tok}.png`]), [SOL, TL + SOL + '/logo.png'], ...CFG.cash.map(c => [c.mint, TL + c.mint + '/logo.png'])]);
async function jupInfo(mints) { const o = {}; const L = [...new Set(mints)].filter(Boolean); for (let i = 0; i < L.length; i += 90) { try { const j = await getJ(`${JUP}/tokens/v2/search?query=${L.slice(i, i + 90).join(',')}`); for (const t of j || []) o[t.id] = { symbol: t.symbol, name: t.name, icon: t.icon || null, decimals: t.decimals, usd: STOCK[t.id] && (t.liquidity ?? 0) < THIN ? null : t.usdPrice ?? null, ch24: STOCK[t.id] && (t.liquidity ?? 0) < THIN ? null : t.stats24h ? t.stats24h.priceChange ?? null : null, mcap: t.mcap ?? t.fdv ?? null, liquidity: t.liquidity ?? null, verified: !!t.isVerified, holders: t.holderCount ?? null }; } catch { } } for (const m of L) if (ICONS[m]) o[m] = { ...(o[m] || {}), icon: (o[m] && o[m].icon) || ICONS[m] }; return o; }
const effMultiplier = st => { if (!st) return 1; const now = Date.now() / 1000; const m = +(now >= +(st.newMultiplierEffectiveTimestamp || 0) && st.newMultiplier ? st.newMultiplier : st.multiplier); return m > 0 ? m : 1; };
async function mintInfo(mintStr) { const mint = pk(mintStr, 'bad mint').toBase58();
  return memo('mint:' + mint, 300000, async () => {
    if (mint === SOL) return { mint, native: true, symbol: 'SOL', name: 'Solana', decimals: 9, program: null, multiplier: 1, ok: true, warn: [], block: null, kind: 'sol' };
    const acc = await conn.getParsedAccountInfo(new PublicKey(mint)); const v = acc.value; if (!v) throw new Error('that mint does not exist');
    const prog = v.owner.toBase58(); if (prog !== SPL.TOKEN_PROGRAM_ID.toBase58() && prog !== SPL.TOKEN_2022_PROGRAM_ID.toBase58()) throw new Error('not a token mint');
    const info = v.data.parsed && v.data.parsed.info; if (!info || v.data.parsed.type !== 'mint') throw new Error('not a token mint');
    const ext = Object.fromEntries((info.extensions || []).map(e => [e.extension, e.state || {}])); const warn = []; let block = null;
    const tf = ext.transferFeeConfig; if (tf && ((tf.newerTransferFee && +tf.newerTransferFee.transferFeeBasisPoints > 0) || (tf.olderTransferFee && +tf.olderTransferFee.transferFeeBasisPoints > 0))) block = 'this token takes a fee on every transfer';
    if (ext.transferHook && ext.transferHook.programId) block = 'this token runs a transfer hook';
    if (ext.nonTransferable) block = 'this token cannot be transferred';
    if (ext.pausableConfig && ext.pausableConfig.paused) block = 'its issuer has paused transfers';
    if (ext.defaultAccountState && ext.defaultAccountState.accountState === 'frozen') block = 'new holders start frozen by its issuer';
    if (ext.permanentDelegate) warn.push('its issuer keeps a permanent delegate (it can move or burn tokens)');
    if (info.freezeAuthority) warn.push('its issuer can freeze accounts');
    if (ext.pausableConfig) warn.push('its issuer can pause transfers');
    const stock = STOCK[mint] || null;
    return { mint, native: false, decimals: info.decimals, program: prog, token2022: prog === SPL.TOKEN_2022_PROGRAM_ID.toBase58(), multiplier: effMultiplier(ext.scaledUiAmountConfig), ok: !block, block, warn, kind: stock ? 'stock' : 'coin', stock: stock ? { sym: stock.sym, name: stock.name } : null };
  }); }
async function token(mintStr) { const m = await mintInfo(mintStr), J = (await memo('jup:' + m.mint, 30000, () => jupInfo([m.mint])))[m.mint] || {};
  const raydium = m.native || m.kind === 'stock' ? null : await memo('ray:' + m.mint, 120000, async () => { try { const d = await getJ(`https://api.dexscreener.com/tokens/v1/solana/${m.mint}`); const P = Array.isArray(d) ? d : []; const ray = P.filter(p => /raydium/i.test(p.dexId || '') || /launchlab/i.test(p.dexId || '')); return ray.length ? { pools: ray.length, liquidity: ray.reduce((a, p) => a + ((p.liquidity || {}).usd || 0), 0), dex: ray[0].dexId } : { pools: 0 }; } catch { return null; } });
  return { ...m, symbol: m.stock ? m.stock.sym : (J.symbol || m.symbol || m.mint.slice(0, 4)), name: m.stock ? m.stock.name : (J.name || m.name || ''), icon: J.icon || null, usd: J.usd ?? null, ch24: J.ch24 ?? null, mcap: J.mcap ?? null, liquidity: J.liquidity ?? null, verified: !!J.verified, raydium }; }
const toRaw = (ui, t) => { const x = Number(ui); if (!(x > 0) || !isFinite(x)) throw new Error('enter an amount above zero'); const raw = BigInt(Math.floor(x / (t.multiplier || 1) * 10 ** t.decimals + 1e-6)); if (raw <= 0n) throw new Error('that amount is too small'); return raw; };
const toUi = (raw, t) => Number(BigInt(raw)) / 10 ** t.decimals * (t.multiplier || 1);
async function solUsd() { return memo('solusd', 30000, async () => ((await jupInfo([SOL]))[SOL] || {}).usd || null); }

// ---------------------------------------------------------------- balances
async function balanceOf(owner, t) { const w = new PublicKey(owner);
  if (t.native) return BigInt(await conn.getBalance(w));
  const r = await conn.getTokenAccountsByOwner(w, { mint: new PublicKey(t.mint) }); let raw = 0n; for (const x of r.value) raw += BigInt(SPL.AccountLayout.decode(x.account.data).amount.toString()); return raw; }
async function walletView(addr) { const w = pk(addr, 'bad wallet');
  const [bal, a1, a2] = await Promise.all([conn.getBalance(w), conn.getParsedTokenAccountsByOwner(w, { programId: SPL.TOKEN_PROGRAM_ID }), conn.getParsedTokenAccountsByOwner(w, { programId: SPL.TOKEN_2022_PROGRAM_ID })]);
  const held = {}; for (const x of [...a1.value, ...a2.value]) { const i = x.account.data.parsed.info, ui = +i.tokenAmount.uiAmount || 0, raw = BigInt(i.tokenAmount.amount); if (raw <= 0n) continue; const h = held[i.mint] || (held[i.mint] = { raw: 0n, ui: 0 }); h.raw += raw; h.ui += ui; }
  const mints = Object.keys(held), info = await jupInfo([SOL, ...mints]), su = (info[SOL] || {}).usd ?? null;
  const tokens = mints.map(m => { const t = info[m] || {}, st = STOCK[m]; return { mint: m, amount: held[m].ui, raw: held[m].raw.toString(), symbol: st ? st.sym : (t.symbol || m.slice(0, 4)), name: st ? st.name : (t.name || ''), icon: t.icon || null, usd: t.usd != null ? t.usd * held[m].ui : null, price: t.usd ?? null, stock: !!st, verified: !!t.verified }; }).sort((x, y) => (y.usd || 0) - (x.usd || 0));
  const sol = bal / 1e9; return { wallet: w.toBase58(), sol, solUsd: su, solValue: su != null ? sol * su : null, tokens, totalUsd: (su != null ? sol * su : 0) + tokens.reduce((a, t) => a + (t.usd || 0), 0) }; }

// ---------------------------------------------------------------- durable nonces: up to 8 per wallet, at fixed addresses derived from the wallet
const nonceAddr = (w, k) => PublicKey.createWithSeed(w, SEED + k, SystemProgram.programId);
async function nonces(walletStr) { const w = pk(walletStr, 'bad wallet'); const addrs = await Promise.all(Array.from({ length: SLOTS }, (_, k) => nonceAddr(w, k)));
  const accs = await conn.getMultipleAccountsInfo(addrs); const idx = await listAll('tw/' + w.toBase58() + '/');
  const busy = new Set(); for (const b of idx) { const p = b.pathname.split('/').pop().split('~'); if (p[3] === 'a') busy.add(p[1] + ':' + p[2]); }
  return addrs.map((a, k) => { const acc = accs[k]; let nonce = null; if (acc && acc.data.length === NONCE_ACCOUNT_LENGTH) { try { nonce = NonceAccount.fromAccountData(acc.data).nonce; } catch { } }
    return { slot: k, address: a.toBase58(), exists: !!acc, lamports: acc ? acc.lamports : 0, nonce, busy: !!(nonce && busy.has(k + ':' + nonce)) }; }); }
async function buildNonce(req) { const b = await body(req), w = pk(b.wallet, 'connect a wallet first'); const N = await nonces(w.toBase58()); const free = N.find(n => !n.exists); if (!free) throw new Error('all 8 of your nonce slots exist already');
  const rent = await conn.getMinimumBalanceForRentExemption(NONCE_ACCOUNT_LENGTH); const t = new Transaction();
  t.add(...SystemProgram.createNonceAccount({ fromPubkey: w, noncePubkey: new PublicKey(free.address), basePubkey: w, seed: SEED + free.slot, authorizedPubkey: w, lamports: rent }).instructions, memoIx(w, 'd3sk:nonce:' + free.slot));
  const { blockhash } = await conn.getLatestBlockhash('confirmed'); t.recentBlockhash = blockhash; t.feePayer = w; return { slot: free.slot, address: free.address, rentSol: rent / 1e9, txs: [ser(t)] }; }
async function buildNonceRefund(req) { const b = await body(req), w = pk(b.wallet, 'connect a wallet first'); const N = (await nonces(w.toBase58())).filter(n => n.exists && !n.busy); if (!N.length) throw new Error('no free nonce slots to refund');
  const t = new Transaction(); for (const n of N) t.add(SystemProgram.nonceWithdraw({ noncePubkey: new PublicKey(n.address), authorizedPubkey: w, toPubkey: w, lamports: n.lamports }));
  const { blockhash } = await conn.getLatestBlockhash('confirmed'); t.recentBlockhash = blockhash; t.feePayer = w; return { slots: N.length, sol: N.reduce((a, n) => a + n.lamports, 0) / 1e9, txs: [ser(t)] }; }

// ---------------------------------------------------------------- the trade: two legs, one transaction
function legIxs(payer, from, to, t, raw) { if (t.native) return [SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports: BigInt(raw) })];
  const mint = new PublicKey(t.mint), prog = new PublicKey(t.program), src = SPL.getAssociatedTokenAddressSync(mint, from, true, prog), dst = SPL.getAssociatedTokenAddressSync(mint, to, true, prog);
  return [SPL.createAssociatedTokenAccountIdempotentInstruction(payer, dst, to, mint, prog), SPL.createTransferCheckedInstruction(src, mint, dst, from, BigInt(raw), t.decimals, [], prog)]; }
// a fee into an empty treasury must lift it past Solana's rent-exempt minimum, or the whole trade fails
const RENT0 = 890880; let treasBal = { t: 0, v: null };
async function treasuryLamports() { if (treasBal.v != null && Date.now() - treasBal.t < 60000) return treasBal.v; try { treasBal = { t: Date.now(), v: await conn.getBalance(TREASURY) }; return treasBal.v; } catch { return null; } }
async function feeFor(tA, rawA, tB, rawB) { if (!TREASURY || !FEE_BPS) return 0; const su = await solUsd(); const vA = tA.usd != null ? toUi(rawA, tA) * tA.usd : null, vB = tB.usd != null ? toUi(rawB, tB) * tB.usd : null; const v = Math.max(vA || 0, vB || 0);
  let f = !(su > 0) || !(v > 0) ? 1000000 : Math.max(500000, Math.min(5e9, Math.round(v * FEE_BPS / 1e4 / su * 1e9)));
  const tb = await treasuryLamports(); if (tb == null || tb < RENT0) f = Math.max(f, RENT0 - (tb || 0) + 10000); return f; }
function tradeTx({ a, b, tA, rawA, tB, rawB, nonceAccount, nonceValue, feeLamports, id }) { const t = new Transaction(); t.feePayer = a; t.recentBlockhash = nonceValue;
  if (nonceAccount) t.add(SystemProgram.nonceAdvance({ noncePubkey: nonceAccount, authorizedPubkey: a }));
  t.add(...legIxs(a, a, b, tA, rawA), ...legIxs(a, b, a, tB, rawB));
  if (feeLamports > 0 && TREASURY) t.add(SystemProgram.transfer({ fromPubkey: a, toPubkey: TREASURY, lamports: feeLamports }));
  t.add(memoIx(a, 'd3sk:' + id), SystemProgram.transfer({ fromPubkey: a, toPubkey: TAG, lamports: 0 })); return t; }
async function checkLegs(aStr, bStr, legA, legB) { const a = pk(aStr, 'connect a wallet first'), b = pk(bStr, 'bad counterparty wallet'); if (a.equals(b)) throw new Error('you can’t trade with yourself');
  const [tA, tB] = await Promise.all([token(legA.mint), token(legB.mint)]); if (tA.mint === tB.mint) throw new Error('pick two different tokens');
  for (const t of [tA, tB]) if (!t.ok) throw new Error(`${t.symbol}: ${t.block}`);
  const rawA = legA.raw ? BigInt(legA.raw) : toRaw(legA.amount, tA), rawB = legB.raw ? BigInt(legB.raw) : toRaw(legB.amount, tB); return { a, b, tA, tB, rawA, rawB }; }
// build: the starting wallet signs this, then submits it
async function buildTicket(req) { const B = await body(req); let a = B.wallet, bW = B.counterparty, legA = B.give, legB = B.get, offer = null;
  if (B.offerId) { offer = await readPath('o/' + String(B.offerId).replace(/[^A-Za-z0-9xy_-]/g, '') + '.json'); const st = await offerStatus([offer]); if (st[offer.id].status !== 'open') throw new Error('this offer is ' + st[offer.id].status);
    if (offer.private && offer.private !== a) throw new Error('this offer is private to another wallet'); bW = offer.maker; legA = { mint: offer.want.mint, raw: offer.want.raw }; legB = { mint: offer.give.mint, raw: offer.give.raw }; }
  if (!legA || !legB) throw new Error('pick what you give and what you get');
  const L = await checkLegs(a, bW, legA, legB);
  // the starter must hold their leg, plus SOL for fees and rent
  const [haveA, sol] = await Promise.all([balanceOf(L.a.toBase58(), L.tA), conn.getBalance(L.a)]); if (haveA < L.rawA) throw new Error(`you hold ${toUi(haveA, L.tA).toLocaleString('en-US', { maximumFractionDigits: 6 })} ${L.tA.symbol}, not enough for this trade`);
  const N = await nonces(L.a.toBase58()); const slot = N.find(n => n.exists && n.nonce && !n.busy);
  if (!slot) { if (N.every(n => n.exists)) throw new Error('you have 8 trades waiting; cancel one first'); return { needsNonce: true, ...(await buildNonce({ body: { wallet: L.a.toBase58() } })) }; }
  const fee = await feeFor(L.tA, L.rawA, L.tB, L.rawB); const need = fee + 2 * 2039280 + 10000 + (L.tA.native ? Number(L.rawA) : 0); if (sol < need) throw new Error(`you need about ${(need / 1e9).toFixed(4)} SOL for the fee and token accounts`);
  const id = rid(); const t = tradeTx({ ...L, nonceAccount: new PublicKey(slot.address), nonceValue: slot.nonce, feeLamports: fee, id });
  return { id, slot: slot.slot, nonce: slot.nonce, feeSol: fee / 1e9, offerId: offer ? offer.id : null, give: { symbol: L.tA.symbol, ui: toUi(L.rawA, L.tA) }, get: { symbol: L.tB.symbol, ui: toUi(L.rawB, L.tB) }, txs: [ser(t)] }; }
// parse a signed trade back out of its own bytes, so the stored ticket is exactly what the transaction does
async function parseTrade(txB64) { const t = Transaction.from(Buffer.from(txB64, 'base64')); const ix = t.instructions; if (!t.feePayer) throw new Error('no fee payer');
  for (const i of ix) if (!ALLOWED_PROGRAMS.has(i.programId.toBase58())) throw new Error('unexpected program in the trade');
  const a = t.feePayer, adv = ix[0]; if (!adv || !adv.programId.equals(SystemProgram.programId) || adv.data.readUInt32LE(0) !== 4) throw new Error('a trade must start by advancing a nonce');
  const nonceAccount = adv.keys[0].pubkey; if (!adv.keys[2].pubkey.equals(a)) throw new Error('nonce authority must be the starter');
  const mem = ix.find(i => i.programId.equals(MEMO)); const m = mem && mem.data.toString('utf8').match(/^d3sk:([A-Za-z0-9xy_-]{6,20})$/); if (!m) throw new Error('missing trade memo');
  const legs = []; let fee = 0n, other = null;
  for (const i of ix.slice(1)) { const p = i.programId.toBase58();
    if (p === SystemProgram.programId.toBase58()) { const k = i.data.readUInt32LE(0); if (k !== 2) throw new Error('unexpected system instruction'); const lam = i.data.readBigUInt64LE(4), from = i.keys[0].pubkey, to = i.keys[1].pubkey;
      if (to.equals(TAG)) continue; if (TREASURY && to.equals(TREASURY) && from.equals(a)) { fee += lam; continue; } legs.push({ mint: SOL, from: from.toBase58(), to: to.toBase58(), raw: lam.toString() }); continue; }
    if (p === SPL.TOKEN_PROGRAM_ID.toBase58() || p === SPL.TOKEN_2022_PROGRAM_ID.toBase58()) { if (i.data[0] !== 12) throw new Error('unexpected token instruction'); const raw = i.data.readBigUInt64LE(1), mint = i.keys[1].pubkey.toBase58(), owner = i.keys[3].pubkey; const dst = i.keys[2].pubkey;
      legs.push({ mint, from: owner.toBase58(), toAta: dst.toBase58(), raw: raw.toString(), program: p }); continue; }
    if (p === SPL.ASSOCIATED_TOKEN_PROGRAM_ID.toBase58()) { if (!(i.data.length === 1 && i.data[0] === 1) || !i.keys[0].pubkey.equals(a)) throw new Error('unexpected token-account instruction'); continue; } }
  if (legs.length !== 2) throw new Error('a trade has exactly two legs'); const L1 = legs.find(l => l.from === a.toBase58()), L2 = legs.find(l => l.from !== a.toBase58()); if (!L1 || !L2) throw new Error('each side sends one leg');
  other = new PublicKey(L2.from);
  // token legs must land in the other side's own token account
  for (const [L, to] of [[L1, other], [L2, a]]) { if (L.mint === SOL) { if (L.to !== to.toBase58()) throw new Error('SOL leg goes to the wrong wallet'); continue; } const ata = SPL.getAssociatedTokenAddressSync(new PublicKey(L.mint), to, true, new PublicKey(L.program)).toBase58(); if (ata !== L.toAta) throw new Error('a leg goes to the wrong token account'); }
  const N = await nonces(a.toBase58()); const slot = N.find(n => n.address === nonceAccount.toBase58()); if (!slot) throw new Error('that nonce is not one of the starter’s d3sk nonces');
  return { t, id: m[1], a: a.toBase58(), b: other.toBase58(), nonceAccount: nonceAccount.toBase58(), slot: slot.slot, nonce: t.recentBlockhash, currentNonce: slot.nonce, legA: { mint: L1.mint, raw: L1.raw }, legB: { mint: L2.mint, raw: L2.raw }, feeLamports: Number(fee) }; }
async function submitTicket(req) { const B = await body(req); const P = await parseTrade(String(B.tx || ''));
  const sigA = P.t.signatures.find(s => s.publicKey.toBase58() === P.a); if (!sigA || !sigA.signature) throw new Error('the trade is not signed by its starter');
  if (!ed25519.verify(sigA.signature, P.t.serializeMessage(), new PublicKey(P.a).toBytes())) throw new Error('bad signature');
  if (P.nonce !== P.currentNonce) throw new Error('that nonce has moved on; build the trade again');
  const sig = bs58.encode(sigA.signature); const offerId = B.offerId ? String(B.offerId).replace(/[^A-Za-z0-9xy_-]/g, '') : null;
  if (offerId) { const o = await readPath('o/' + offerId + '.json'); if (o.maker !== P.b || o.give.mint !== P.legB.mint || o.give.raw !== P.legB.raw || o.want.mint !== P.legA.mint || o.want.raw !== P.legA.raw) throw new Error('this trade does not match the offer'); }
  const [tA, tB] = await Promise.all([token(P.legA.mint), token(P.legB.mint)]);
  const ticket = { v: 1, id: P.id, offerId, a: P.a, b: P.b, legA: { ...P.legA, symbol: tA.symbol, decimals: tA.decimals, ui: toUi(P.legA.raw, tA) }, legB: { ...P.legB, symbol: tB.symbol, decimals: tB.decimals, ui: toUi(P.legB.raw, tB) }, feeLamports: P.feeLamports, nonceAccount: P.nonceAccount, slot: P.slot, nonce: P.nonce, sig, tx: ser(P.t), note: clean(B.note, 140), created: Date.now() };
  await putJSON('t/' + ticket.id + '.json', ticket);
  await Promise.all([putMark(`tw/${P.a}/${ticket.id}~${P.slot}~${P.nonce}~a`), putMark(`tw/${P.b}/${ticket.id}~${P.slot}~${P.nonce}~b`), offerId ? putMark(`to/${offerId}/${ticket.id}`) : null]);
  cache.delete('tickets:' + P.a); cache.delete('tickets:' + P.b); return { id: ticket.id, sig }; }
// status straight from the chain: settled (its first signature landed), void (its nonce moved: cancelled, or another trade used it), or open
async function ticketStatus(list) { const outS = {}; if (!list.length) return outS;
  for (let i = 0; i < list.length; i += 200) { const part = list.slice(i, i + 200); const [st, accs] = await Promise.all([conn.getSignatureStatuses(part.map(t => t.sig), { searchTransactionHistory: true }), conn.getMultipleAccountsInfo(part.map(t => new PublicKey(t.nonceAccount)))]);
    part.forEach((t, k) => { const s = st.value[k]; let cur = null; const acc = accs[k]; if (acc && acc.data.length === NONCE_ACCOUNT_LENGTH) { try { cur = NonceAccount.fromAccountData(acc.data).nonce; } catch { } }
      outS[t.id] = s && !s.err && /confirmed|finalized/.test(s.confirmationStatus || '') ? { status: 'settled', slot: s.slot } : s && s.err ? { status: 'failed', err: s.err } : cur !== t.nonce ? { status: 'void' } : { status: 'open' }; }); }
  return outS; }
async function getTicket(id) { const t = await readPath('t/' + String(id).replace(/[^A-Za-z0-9xy_-]/g, '') + '.json'); const s = (await ticketStatus([t]))[t.id]; const [tA, tB, su] = await Promise.all([token(t.legA.mint), token(t.legB.mint), solUsd()]);
  let sim = null; if (s.status === 'open') { try { const tx = Transaction.from(Buffer.from(t.tx, 'base64')); const r = await conn.simulateTransaction(new VersionedTransaction(tx.compileMessage()), { sigVerify: false }); sim = { ok: !r.value.err, err: r.value.err, logs: (r.value.logs || []).filter(l => /rror|insufficient|failed/i.test(l)).slice(-4) }; } catch (e) { sim = { ok: false, err: String(e.message || e).slice(0, 160) }; } }
  return { ticket: { ...t, tx: s.status === 'open' ? t.tx : null }, ...s, sim, tokens: { a: tA, b: tB }, values: { a: tA.usd != null ? t.legA.ui * tA.usd : null, b: tB.usd != null ? t.legB.ui * tB.usd : null }, solUsd: su }; }
async function walletTickets(w) { const W = pk(w, 'bad wallet').toBase58(); return memo('tickets:' + W, 10000, async () => { const idx = await listAll('tw/' + W + '/'); const ids = [...new Set(idx.map(b => b.pathname.split('/').pop().split('~')[0]))].slice(-200);
  const T = (await Promise.all(ids.map(id => readPath('t/' + id + '.json').catch(() => null)))).filter(Boolean); const S = await ticketStatus(T);
  return T.map(t => ({ ...t, tx: null, ...S[t.id], role: t.a === W ? 'started' : 'counterparty' })).sort((x, y) => y.created - x.created); }); }
async function buildCancel(req) { const B = await body(req), w = pk(B.wallet, 'connect a wallet first'); const t = await readPath('t/' + String(B.id).replace(/[^A-Za-z0-9xy_-]/g, '') + '.json');
  if (t.a !== w.toBase58()) throw new Error('only the wallet that started a trade can cancel it'); const s = (await ticketStatus([t]))[t.id]; if (s.status !== 'open') throw new Error('this trade is already ' + s.status);
  const tx = new Transaction().add(SystemProgram.nonceAdvance({ noncePubkey: new PublicKey(t.nonceAccount), authorizedPubkey: w }), memoIx(w, 'd3sk:cancel:' + t.id)); const { blockhash } = await conn.getLatestBlockhash('confirmed'); tx.recentBlockhash = blockhash; tx.feePayer = w; cache.delete('tickets:' + t.a); cache.delete('tickets:' + t.b); return { txs: [ser(tx)] }; }

// ---------------------------------------------------------------- offers: a free signed message; anyone can start a trade on it, the maker's signature settles
const offerMsg = o => `d3sk offer ${o.id}\nmaker: ${o.maker}\ngive: ${o.give.ui} ${o.give.symbol} (${o.give.mint}, raw ${o.give.raw})\nget: ${o.want.ui} ${o.want.symbol} (${o.want.mint}, raw ${o.want.raw})\nprivate: ${o.private || 'no'}\nexpires: ${new Date(o.expires).toISOString()}\nThis only lists the offer. No tokens move until both wallets sign one trade.`;
const decSig = B => { const raw = String(B.sig || ''); const sig = B.enc === 'base64' ? Buffer.from(raw, 'base64') : Buffer.from(bs58.decode(raw)); if (sig.length !== 64) throw new Error('bad signature'); return sig; };
async function prepareOffer(req) { const B = await body(req), maker = pk(B.wallet, 'connect a wallet first').toBase58(); const priv = B.private ? pk(B.private, 'bad private wallet').toBase58() : null;
  const L = await checkLegs(maker, priv || TAG.toBase58(), B.give, B.get); const have = await balanceOf(maker, L.tA); if (have < L.rawA) throw new Error(`you hold ${toUi(have, L.tA).toLocaleString('en-US', { maximumFractionDigits: 6 })} ${L.tA.symbol}, not enough to offer this`);
  const hours = Math.max(1, Math.min(24 * 30, Math.round(+B.hours || 72)));
  const o = { v: 1, id: rid(), maker, give: { mint: L.tA.mint, symbol: L.tA.symbol, decimals: L.tA.decimals, raw: L.rawA.toString(), ui: +toUi(L.rawA, L.tA).toPrecision(12) }, want: { mint: L.tB.mint, symbol: L.tB.symbol, decimals: L.tB.decimals, raw: L.rawB.toString(), ui: +toUi(L.rawB, L.tB).toPrecision(12) }, private: priv, note: clean(B.note, 140), created: Date.now(), expires: Date.now() + hours * 3600000 };
  return { offer: o, message: offerMsg(o) }; }
async function postOffer(req) { const B = await body(req), o = B.offer; if (!o || !o.id || !o.maker) throw new Error('nothing to post'); const msg = offerMsg(o);
  const sig = decSig(B); if (!ed25519.verify(sig, Buffer.from(msg, 'utf8'), new PublicKey(o.maker).toBytes())) throw new Error('the signature does not match this offer');
  if (Date.now() - o.created > 15 * 60000) throw new Error('this offer was prepared too long ago; prepare it again');
  const L = await checkLegs(o.maker, o.private || TAG.toBase58(), { mint: o.give.mint, raw: o.give.raw }, { mint: o.want.mint, raw: o.want.raw }); if (L.rawA.toString() !== o.give.raw || L.rawB.toString() !== o.want.raw) throw new Error('amounts changed');
  const stored = { ...o, note: clean(o.note, 140), msg, sig: bs58.encode(sig) }; await putJSON('o/' + o.id + '.json', stored); cache.delete('offers'); return { id: o.id }; }
async function prepareCancelOffer(req) { const B = await body(req); const o = await readPath('o/' + String(B.id).replace(/[^A-Za-z0-9xy_-]/g, '') + '.json'); if (o.maker !== pk(B.wallet, 'connect a wallet first').toBase58()) throw new Error('only its maker can cancel an offer'); return { message: `d3sk cancel offer ${o.id}` }; }
async function cancelOffer(req) { const B = await body(req); const o = await readPath('o/' + String(B.id).replace(/[^A-Za-z0-9xy_-]/g, '') + '.json'); const sig = decSig(B);
  if (!ed25519.verify(sig, Buffer.from(`d3sk cancel offer ${o.id}`, 'utf8'), new PublicKey(o.maker).toBytes())) throw new Error('bad signature'); await putMark('ox/' + o.id); cache.delete('offers'); return { ok: true }; }
async function offerStatus(list) { const outS = {}; if (!list.length) return outS; const [cx, tx] = await Promise.all([listAll('ox/'), listAll('to/')]); const cancelled = new Set(cx.map(b => b.pathname.split('/').pop()));
  const want = new Set(list.map(o => o.id)), byOffer = {}; for (const b of tx) { const parts = b.pathname.split('/'), oid = parts[parts.length - 2]; if (want.has(oid)) (byOffer[oid] = byOffer[oid] || []).push(parts[parts.length - 1]); }
  const T = (await Promise.all([].concat(...Object.values(byOffer)).slice(0, 400).map(id => readPath('t/' + id + '.json').catch(() => null)))).filter(Boolean); const S = await ticketStatus(T);
  const base = {}; for (const o of list) { const tk = T.filter(t => t.offerId === o.id), settled = tk.find(t => S[t.id] && S[t.id].status === 'settled'), pending = tk.filter(t => S[t.id] && S[t.id].status === 'open');
    base[o.id] = { status: settled ? 'filled' : cancelled.has(o.id) ? 'cancelled' : Date.now() > o.expires ? 'expired' : 'open', funded: null, pending: pending.map(t => ({ id: t.id, taker: t.a, created: t.created })), fill: settled ? { id: settled.id, sig: settled.sig, taker: settled.a } : null }; }
  // is the maker still holding what they offered? (open offers only)
  const open = list.filter(o => base[o.id].status === 'open').slice(0, 80); for (let i = 0; i < open.length; i += 10) await Promise.all(open.slice(i, i + 10).map(async o => { try { base[o.id].funded = (await balanceOf(o.maker, { native: o.give.mint === SOL, mint: o.give.mint })) >= BigInt(o.give.raw); } catch { base[o.id].funded = null; } }));
  return base; }
async function offers() { return memo('offers', 12000, async () => { const L = (await listAll('o/')).filter(b => b.pathname.endsWith('.json')).sort((x, y) => new Date(y.uploadedAt) - new Date(x.uploadedAt)).slice(0, 300);
  const O = (await Promise.all(L.map(b => readJSON(b.url).catch(() => null)))).filter(Boolean); const S = await offerStatus(O);
  const mints = [...new Set(O.flatMap(o => [o.give.mint, o.want.mint]))], J = await jupInfo(mints), su = await solUsd();
  const val = (leg) => { const j = J[leg.mint] || {}; const p = leg.mint === SOL ? su : j.usd; return p != null ? leg.ui * p : null; };
  return O.map(o => ({ ...o, msg: undefined, ...S[o.id], giveUsd: val(o.give), wantUsd: val(o.want), icons: { give: (J[o.give.mint] || {}).icon || null, want: (J[o.want.mint] || {}).icon || null } })); }); }

// ---------------------------------------------------------------- tools: the pool check, bags, whales, dump watch, pairs
async function poolcheck(mintStr, amount) { const t = await token(mintStr); if (t.native) throw new Error('pick a coin or a stock, not SOL'); const raw = toRaw(amount, t), su = await solUsd();
  const q = await getJ(`${JUP}/swap/v1/quote?inputMint=${t.mint}&outputMint=${SOL}&amount=${raw}&slippageBps=5000`, 10000).catch(e => ({ error: e.message })); if (!q || !q.outAmount) throw new Error((q && q.error) || 'no route for this size right now');
  const spot = t.usd != null ? toUi(raw, t) * t.usd : null, got = +q.outAmount / 1e9 * (su || 0);
  return { token: { symbol: t.symbol, mint: t.mint, icon: t.icon, usd: t.usd }, amount: toUi(raw, t), spotUsd: spot, poolUsd: su ? got : null, poolSol: +q.outAmount / 1e9, impactPct: +q.priceImpactPct * 100, lossUsd: spot != null && su ? Math.max(0, spot - got) : null, route: (q.routePlan || []).map(x => x.swapInfo.label) }; }
async function bags(addr) { const W = pk(addr, 'bad wallet').toBase58(); return memo('bags:' + W, 60000, async () => { const v = await walletView(W); const list = v.tokens.filter(t => t.usd != null && t.usd >= 20).slice(0, 10);
  for (const t of list) { try { const q = await getJ(`${JUP}/swap/v1/quote?inputMint=${t.mint}&outputMint=${SOL}&amount=${t.raw}&slippageBps=5000`, 9000); t.impactPct = +q.priceImpactPct * 100; t.poolUsd = v.solUsd ? +q.outAmount / 1e9 * v.solUsd : null; } catch { t.impactPct = null; } await sleep(150); }
  return { ...v, bags: list }; }); }
async function holders(mintStr) { const t = await token(mintStr); if (t.native) throw new Error('pick a coin or a stock'); return memo('holders:' + t.mint, 60000, async () => {
  let top, sup; try { [top, sup] = await Promise.all([conn.getTokenLargestAccounts(new PublicKey(t.mint)), conn.getTokenSupply(new PublicKey(t.mint))]); } catch (e) { throw new Error('the public Solana RPC is rate-limiting holder lists right now. try again in a minute'); } const infos = await conn.getMultipleParsedAccounts(top.value.map(x => x.address));
  const supply = +sup.value.amount; const rows = infos.value.map((x, i) => x ? { owner: x.data.parsed.info.owner, raw: top.value[i].amount } : null).filter(Boolean)
    .map(r => { let wallet = false; try { wallet = PublicKey.isOnCurve(new PublicKey(r.owner).toBytes()); } catch { } const ui = toUi(r.raw, t); return { owner: r.owner, wallet, ui, pct: supply ? +r.raw / supply * 100 : null, usd: t.usd != null ? ui * t.usd : null }; });
  return { token: { symbol: t.symbol, mint: t.mint, icon: t.icon, usd: t.usd, name: t.name, kind: t.kind }, holders: rows }; }); }
async function dumps() { return memo('dumps', 60000, async () => { let pools = []; try { const j = await getJ('https://api.geckoterminal.com/api/v2/networks/solana/trending_pools?include=base_token,dex&page=1', 9000); pools = (j.data || []).filter(p => /raydium/i.test(((p.relationships || {}).dex || {}).data ? p.relationships.dex.data.id : '')).slice(0, 6); } catch { }
  const outD = []; for (const p of pools) { try { const tr = await getJ(`https://api.geckoterminal.com/api/v2/networks/solana/pools/${p.attributes.address}/trades?trade_volume_in_usd_greater_than=500`, 9000);
      for (const x of (tr.data || []).slice(0, 25)) { const at = x.attributes; if (at.kind !== 'sell') continue; outD.push({ pool: p.attributes.address, name: p.attributes.name, dex: p.relationships.dex.data.id, usd: +at.volume_in_usd, priceBefore: null, price: +at.price_to_in_usd || +at.price_from_in_usd, at: Date.parse(at.block_timestamp), tx: at.tx_hash, wallet: at.tx_from_address, mint: (p.relationships.base_token.data.id || '').replace(/^solana_/, '') }); } } catch { } await sleep(200); }
  return { pools: pools.map(p => ({ address: p.attributes.address, name: p.attributes.name, dex: p.relationships.dex.data.id, volume24h: +((p.attributes.volume_usd || {}).h24 || 0), reserveUsd: +(p.attributes.reserve_in_usd || 0) })), dumps: outD.sort((x, y) => y.at - x.at).slice(0, 40) }; }); }
async function pairs() { return memo('pairs', 30000, async () => { const J = await jupInfo([SOL, ...CFG.cash.map(c => c.mint), ...STOCKS.map(s => s.mint)]);
  let coins = []; try { const j = await getJ('https://api.geckoterminal.com/api/v2/networks/solana/trending_pools?include=base_token,dex&page=1', 9000); const seen = new Set();
    for (const p of j.data || []) { const dex = ((p.relationships || {}).dex || {}).data ? p.relationships.dex.data.id : ''; if (!/raydium/i.test(dex)) continue; const mint = (p.relationships.base_token.data.id || '').replace(/^solana_/, ''); if (!mint || seen.has(mint) || mint === SOL) continue; seen.add(mint); coins.push({ mint, name: p.attributes.name.split(' / ')[0], dex, volume24h: +((p.attributes.volume_usd || {}).h24 || 0), ch24: +((p.attributes.price_change_percentage || {}).h24 || 0) }); } } catch { }
  const CJ = await jupInfo(coins.map(c => c.mint)); coins = coins.map(c => ({ ...c, symbol: (CJ[c.mint] || {}).symbol || c.name, icon: (CJ[c.mint] || {}).icon || null, usd: (CJ[c.mint] || {}).usd ?? null, mcap: (CJ[c.mint] || {}).mcap ?? null })).slice(0, 16);
  const tk = m => ({ icon: (J[m] || {}).icon || null, usd: (J[m] || {}).usd ?? null, ch24: (J[m] || {}).ch24 ?? null });
  return { at: Date.now(), sol: { mint: SOL, symbol: 'SOL', name: 'Solana', ...tk(SOL) }, cash: CFG.cash.map(c => ({ ...c, ...tk(c.mint) })), stocks: STOCKS.map(s => ({ ...s, symbol: s.sym, ...tk(s.mint) })), coins }; }); }
async function settled() { return memo('settled', 20000, async () => { const sigs = (await conn.getSignaturesForAddress(TAG, { limit: 200 })).filter(x => !x.err); const outS = [];
  for (let i = 0; i < sigs.length; i += 50) { const txs = await conn.getParsedTransactions(sigs.slice(i, i + 50).map(x => x.signature), { maxSupportedTransactionVersion: 0 }).catch(() => []);
    txs.forEach((t, k) => { if (!t || !t.meta || t.meta.err) return; const memoIxP = t.transaction.message.instructions.find(ix => ix.program === 'spl-memo' && typeof ix.parsed === 'string' && /^d3sk:[A-Za-z0-9xy_-]{6,20}$/.test(ix.parsed)); if (!memoIxP) return; outS.push({ id: memoIxP.parsed.slice(5), sig: sigs[i + k].signature, at: t.blockTime }); }); }
  const T = (await Promise.all(outS.map(s => readPath('t/' + s.id + '.json').catch(() => null)))); const su = await solUsd(); const mints = [...new Set(T.filter(Boolean).flatMap(t => [t.legA.mint, t.legB.mint]))], J = await jupInfo(mints);
  const rows = outS.map((s, k) => { const t = T[k]; if (!t) return { ...s }; const v = l => { const p = l.mint === SOL ? su : (J[l.mint] || {}).usd; return p != null ? l.ui * p : null; }; return { ...s, a: t.a, b: t.b, legA: { symbol: t.legA.symbol, ui: t.legA.ui, mint: t.legA.mint, icon: (J[t.legA.mint] || {}).icon || null }, legB: { symbol: t.legB.symbol, ui: t.legB.ui, mint: t.legB.mint, icon: (J[t.legB.mint] || {}).icon || null }, usd: Math.max(v(t.legA) || 0, v(t.legB) || 0) || null }; });
  return { tag: TAG.toBase58(), trades: rows, totals: { trades: rows.length, volumeUsd: rows.reduce((a, r) => a + (r.usd || 0), 0) } }; }); }
async function stats() { const [S, O] = await Promise.all([settled().catch(() => ({ totals: { trades: 0, volumeUsd: 0 } })), offers().catch(() => [])]); return { trades: S.totals.trades, volumeUsd: S.totals.volumeUsd, openOffers: O.filter(o => o.status === 'open').length, offers: O.length, feeBps: TREASURY ? FEE_BPS : 0, treasury: TREASURY ? TREASURY.toBase58() : null, storage: !!process.env.BLOB_READ_WRITE_TOKEN, tag: TAG.toBase58() }; }
// a dry run of the two legs between any two wallets (normal blockhash, no nonce), simulated with signatures skipped
async function simLegs(q) { const a = q.get('wa'), b = q.get('wb'); const L = await checkLegs(a, b, { mint: q.get('giveMint'), amount: +q.get('give') }, { mint: q.get('getMint'), amount: +q.get('get') }); const fee = await feeFor(L.tA, L.rawA, L.tB, L.rawB);
  const { blockhash } = await conn.getLatestBlockhash('confirmed'); const t = tradeTx({ ...L, nonceAccount: null, nonceValue: blockhash, feeLamports: fee, id: 'simulate1' });
  const r = await conn.simulateTransaction(new VersionedTransaction(t.compileMessage()), { sigVerify: false, replaceRecentBlockhash: true });
  return { give: `${toUi(L.rawA, L.tA)} ${L.tA.symbol}`, get: `${toUi(L.rawB, L.tB)} ${L.tB.symbol}`, programs: t.instructions.map(i => i.programId.toBase58().slice(0, 6)), bytes: t.serialize({ requireAllSignatures: false, verifySignatures: false }).length, feeSol: fee / 1e9, err: r.value.err, units: r.value.unitsConsumed, logs: (r.value.logs || []).filter(l => /rror|insufficient|failed|TransferChecked|Transfer/i.test(l)).slice(-8), warn: { a: L.tA.warn, b: L.tB.warn } }; }
async function sendTxs(req) { const b = await body(req); if (!Array.isArray(b.txs) || !b.txs.length || b.txs.length > 4) throw new Error('nothing to send'); const sigs = [];
  for (const t of b.txs) { const sig = await conn.sendRawTransaction(Buffer.from(t, 'base64'), { skipPreflight: false, maxRetries: 3 }); sigs.push(sig);
    for (let k = 0; k < 40; k++) { const s = (await conn.getSignatureStatuses([sig])).value[0]; if (s && s.err) throw new Error('transaction failed: ' + JSON.stringify(s.err)); if (s && /confirmed|finalized/.test(s.confirmationStatus || '')) break; await sleep(700); } }
  cache.clear(); return { sigs }; }

module.exports = async (req, res) => { if (req.method === 'GET') res.setHeader('access-control-allow-origin', '*');
  const q = new URL(req.url, 'http://x').searchParams, a = q.get('a');
  try {
    if (a === 'stats') return out(res, 200, await stats(), 's-maxage=15');
    if (a === 'token') return out(res, 200, await token(q.get('mint')), 's-maxage=30');
    if (a === 'pairs') return out(res, 200, await pairs(), 's-maxage=30, stale-while-revalidate=120');
    if (a === 'offers') return out(res, 200, { offers: await offers() }, 's-maxage=8');
    if (a === 'offer') { const id = String(q.get('id') || '').replace(/[^A-Za-z0-9xy_-]/g, ''); const o = await readPath('o/' + id + '.json'); const S = await offerStatus([o]); return out(res, 200, { offer: { ...o, ...S[o.id] } }); }
    if (a === 'ticket') return out(res, 200, await getTicket(q.get('id')));
    if (a === 'tickets') return out(res, 200, { tickets: await walletTickets(q.get('wallet')) });
    if (a === 'nonces') return out(res, 200, { nonces: await nonces(q.get('wallet')) });
    if (a === 'wallet') return out(res, 200, await walletView(q.get('addr')));
    if (a === 'bags') return out(res, 200, await bags(q.get('addr')), 's-maxage=30');
    if (a === 'holders') return out(res, 200, await holders(q.get('mint')), 's-maxage=60');
    if (a === 'poolcheck') return out(res, 200, await poolcheck(q.get('mint'), +q.get('amount')), 's-maxage=15');
    if (a === 'dumps') return out(res, 200, await dumps(), 's-maxage=45, stale-while-revalidate=120');
    if (a === 'settled') return out(res, 200, await settled(), 's-maxage=15');
    if (a === 'simLegs') return out(res, 200, await simLegs(q));
    if (req.method === 'POST' && a === 'prepareOffer') return out(res, 200, await prepareOffer(req));
    if (req.method === 'POST' && a === 'postOffer') return out(res, 200, await postOffer(req));
    if (req.method === 'POST' && a === 'prepareCancelOffer') return out(res, 200, await prepareCancelOffer(req));
    if (req.method === 'POST' && a === 'cancelOffer') return out(res, 200, await cancelOffer(req));
    if (req.method === 'POST' && a === 'buildTicket') return out(res, 200, await buildTicket(req));
    if (req.method === 'POST' && a === 'submitTicket') return out(res, 200, await submitTicket(req));
    if (req.method === 'POST' && a === 'buildCancel') return out(res, 200, await buildCancel(req));
    if (req.method === 'POST' && a === 'buildNonce') return out(res, 200, await buildNonce(req));
    if (req.method === 'POST' && a === 'buildNonceRefund') return out(res, 200, await buildNonceRefund(req));
    if (req.method === 'POST' && a === 'send') return out(res, 200, await sendTxs(req));
    return out(res, 404, { error: 'unknown action' });
  } catch (e) { return out(res, 400, { error: e.message || String(e) }); }
};
module.exports._t = { conn, parseTrade, tradeTx, offerMsg, toRaw, toUi, effMultiplier, nonceAddr, mintInfo, cache, legIxs };
