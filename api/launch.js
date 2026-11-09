// d3sk launch: put a new coin on Raydium LaunchLab from your own wallet.
// The server only builds the transaction (and stores the coin's image + metadata as write-once files); the wallet signs and pays.
// POST a=img   {data: data-URL}                       -> { url }
// POST a=build {wallet, name, symbol, desc, image, website, x, telegram, buySol, simulate}
// GET  a=list                                          -> coins launched through d3sk, read from the chain
const { Connection, PublicKey, Keypair, SystemProgram, Transaction, TransactionInstruction } = require('@solana/web3.js');
const BN = require('bn.js');
const R = require('@raydium-io/raydium-sdk-v2');
const crypto = require('crypto');

const RPCS = [process.env.RPC_URL, 'https://api.mainnet-beta.solana.com', 'https://solana-rpc.publicnode.com'].filter(Boolean);
async function rpcFetch(url, opts) { let last = null; for (let round = 0; round < 2; round++) { for (const u of RPCS) { try { const r = await fetch(u, { ...opts, signal: AbortSignal.timeout(12000) }); if (r.status === 429 || r.status === 401 || r.status === 403 || r.status >= 500) { last = r; continue; } return r; } catch (e) { last = e; } } await new Promise(r => setTimeout(r, 700)); } if (last instanceof Error) throw last; return last; }
const conn = new Connection(RPCS[0], { commitment: 'confirmed', fetch: rpcFetch, disableRetryOnRateLimit: true });

const WSOL = new PublicKey('So11111111111111111111111111111111111111112');
const PROGRAM = R.LAUNCHPAD_PROGRAM, CONFIG = R.getPdaLaunchpadConfigId(PROGRAM, WSOL, 0, 0).publicKey;
// Raydium's own LaunchLab platform, unless a d3sk platform config is set
const PLATFORM = new PublicKey(process.env.D3SK_PAD || R.LAUNCHPAD_PLATFORM.toBase58());
// every coin launched through d3sk sends 0 SOL here with a memo, so the list can be read from the chain
const TAG = new PublicKey(process.env.D3SK_LAUNCH_TAG || '4UYXoNZBpi1PgPfkvZWXnVYFDFZ3ZwmrDNZ1bUV76rQN');
const MEMO = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const SUPPLY = new BN('1000000000000000'), SELL = new BN('793100000000000');   // 1B supply, 793.1M sold on the curve (LaunchLab's standard shape)
const RAISE = 85, MAX_BUY = 20, PFX = 'd3sk/';

const out = (res, code, b, cache) => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.setHeader('cache-control', cache || 'no-store'); res.end(JSON.stringify(b)); };
const body = req => new Promise(ok => { if (req.body) return ok(typeof req.body === 'string' ? JSON.parse(req.body) : req.body); let d = ''; req.on('data', c => d += c); req.on('end', () => { try { ok(JSON.parse(d || '{}')); } catch { ok({}); } }); });
const clean = (s, n) => String(s || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, n);
const pk = (s, what) => { try { return new PublicKey(String(s)); } catch { throw new Error(what || 'bad address'); } };
const link = (s, re, what) => { s = clean(s, 200); if (!s) return ''; if (!/^https:\/\/\S+$/.test(s) || (re && !re.test(s))) throw new Error(`the ${what} must be a https:// link`); return s; };
const blob = () => require('@vercel/blob');
async function putFile(path, data, type) { if (!process.env.BLOB_READ_WRITE_TOKEN) throw new Error('storage is not switched on yet');
  try { return (await blob().put(PFX + path, data, { access: 'public', addRandomSuffix: false, allowOverwrite: false, contentType: type, cacheControlMaxAge: 31536000 })).url; }
  catch (e) { if (/exist/i.test(e.message || '')) { const h = await blob().head(PFX + path).catch(() => null); if (h) return h.url; } throw e; } }

async function img(req) { const b = await body(req); const m = /^data:(image\/(png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(String(b.data || ''));
  if (!m) throw new Error('pick a png, jpg, webp or gif image'); const buf = Buffer.from(m[3], 'base64'); if (buf.length > 1.5e6) throw new Error('that image is too big (1.5 MB max)'); if (buf.length < 100) throw new Error('that image is empty');
  const h = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 24), ext = m[2] === 'jpeg' ? 'jpg' : m[2];
  return { url: await putFile(`img/${h}.${ext}`, buf, m[1]) }; }

let cfgCache = null;
async function cfg() { if (cfgCache && Date.now() - cfgCache.t < 120000) return cfgCache.v; const a = await conn.getAccountInfo(CONFIG); if (!a) throw new Error('could not read LaunchLab'); const v = R.LaunchpadConfig.decode(a.data); cfgCache = { t: Date.now(), v }; return v; }
async function sdk(owner) { return R.Raydium.load({ connection: conn, owner, cluster: 'mainnet', disableLoadToken: true, disableFeatureCheck: true, blockhashCommitment: 'confirmed' }); }
const tagIxs = (wallet, mint) => [new TransactionInstruction({ programId: MEMO, keys: [], data: Buffer.from('d3sk:launch:' + mint.toBase58()) }), SystemProgram.transfer({ fromPubkey: wallet, toPubkey: TAG, lamports: 0 })];

async function build(req) { const b = await body(req); const wallet = pk(b.wallet, 'connect a wallet first');
  const name = clean(b.name, 32), symbol = clean(b.symbol, 10).toUpperCase().replace(/^\$/, ''), desc = clean(b.desc, 500);
  if (!name) throw new Error('give the coin a name'); if (!symbol || !/^[A-Z0-9]{1,10}$/.test(symbol)) throw new Error('the ticker can use letters and numbers, up to 10');
  const image = link(b.image, null, 'image'); if (!image) throw new Error('add an image');
  const website = link(b.website, null, 'website'), x = link(b.x, /^https:\/\/(x|twitter)\.com\//, 'X link'), telegram = link(b.telegram, /^https:\/\/t\.me\//, 'Telegram link');
  const buySol = Math.max(0, +b.buySol || 0); if (!(buySol <= MAX_BUY)) throw new Error(`the first buy can be up to ${MAX_BUY} SOL`);
  const bal = await conn.getBalance(wallet).catch(() => null); if (bal != null && bal < (buySol + 0.03) * 1e9) throw new Error(`your wallet needs about ${(buySol + 0.03).toFixed(2)} SOL for this launch`);
  // the metadata every wallet and explorer reads, stored write-once
  const meta = { name, symbol, description: desc || `${name} ($${symbol}), launched from d3sk on Raydium LaunchLab.`, image, ...(website && { website }), ...(x && { twitter: x }), ...(telegram && { telegram }), extensions: { ...(website && { website }), ...(x && { twitter: x }), ...(telegram && { telegram }) }, createdOn: 'https://d3sk.vercel.app' };
  const js = JSON.stringify(meta), uri = await putFile(`meta/${crypto.createHash('sha256').update(js).digest('hex').slice(0, 24)}.json`, js, 'application/json');
  if (uri.length > 200) throw new Error('metadata link too long');
  const c = await cfg(); const mint = Keypair.generate(); const raydium = await sdk(wallet);
  const { transactions, extInfo } = await raydium.launchpad.createLaunchpad({
    programId: PROGRAM, mintA: mint.publicKey, decimals: 6, name, symbol, uri, migrateType: 'cpmm', configId: CONFIG, configInfo: c, mintBDecimals: 9, platformId: PLATFORM,
    txVersion: R.TxVersion.LEGACY, slippage: new BN(100), buyAmount: new BN(Math.round(buySol * 1e9)), createOnly: buySol === 0,
    supply: SUPPLY, totalSellA: SELL, totalFundRaisingB: new BN(RAISE * 1e9), totalLockedAmount: new BN(0), cliffPeriod: new BN(0), unlockPeriod: new BN(0),
    extraSigners: [mint], feePayer: wallet, computeBudgetConfig: { units: 600000, microLamports: 60000 } });
  const { blockhash } = await conn.getLatestBlockhash('confirmed');
  const mk = ixs => { const t = new Transaction(); t.add(...ixs); t.feePayer = wallet; t.recentBlockhash = blockhash; if (t.instructions.some(ix => ix.keys.some(k => k.isSigner && k.pubkey.equals(mint.publicKey)))) t.partialSign(mint); return t; };
  const fits = t => { try { return t.serialize({ requireAllSignatures: false, verifySignatures: false }).length <= 1232; } catch { return false; } };
  let list = transactions.map((tx, i) => mk(i === 0 ? [...tx.instructions, ...tagIxs(wallet, mint.publicKey)] : tx.instructions));
  if (!fits(list[0])) { list = transactions.map(tx => mk(tx.instructions)); list.push(mk(tagIxs(wallet, mint.publicKey))); }
  let sim = null; if (b.simulate) { const r = await conn.simulateTransaction(list[0]); sim = { err: r.value.err, units: r.value.unitsConsumed, logs: (r.value.logs || []).slice(-12) }; }
  return { mint: mint.publicKey.toBase58(), pool: (extInfo && extInfo.address && extInfo.address.poolId && extInfo.address.poolId.toBase58()) || R.getPdaLaunchpadPoolId(PROGRAM, mint.publicKey, WSOL).publicKey.toBase58(), uri, image, raiseSol: RAISE, txs: list.map(t => Buffer.from(t.serialize({ requireAllSignatures: false, verifySignatures: false })).toString('base64')), sim }; }

let listCache = null;
async function list() { if (listCache && Date.now() - listCache.t < 20000) return listCache.v;
  const sigs = (await conn.getSignaturesForAddress(TAG, { limit: 100 })).filter(s => !s.err); const coins = [];
  for (let i = 0; i < sigs.length; i += 25) { const txs = await conn.getParsedTransactions(sigs.slice(i, i + 25).map(s => s.signature), { maxSupportedTransactionVersion: 0 }).catch(() => []);
    txs.forEach((t, k) => { if (!t || !t.meta || t.meta.err) return; const m = t.transaction.message.instructions.find(ix => ix.program === 'spl-memo' && typeof ix.parsed === 'string' && /^d3sk:launch:[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(ix.parsed)); if (m) coins.push({ mint: m.parsed.slice(12), sig: sigs[i + k].signature, at: t.blockTime, creator: t.transaction.message.accountKeys[0].pubkey.toBase58() }); }); }
  let info = {}; if (coins.length) { try { const r = await fetch('https://lite-api.jup.ag/tokens/v2/search?query=' + coins.slice(0, 100).map(c => c.mint).join(','), { signal: AbortSignal.timeout(8000) }); for (const t of await r.json()) info[t.id] = t; } catch { } }
  const v = { tag: TAG.toBase58(), platform: PLATFORM.toBase58(), coins: coins.map(c => { const t = info[c.mint] || {}; return { ...c, symbol: t.symbol || null, name: t.name || null, icon: t.icon || null, usd: t.usdPrice ?? null, mcap: t.mcap ?? t.fdv ?? null, curve: t.bondingCurve ?? null }; }) };
  listCache = { t: Date.now(), v }; return v; }

module.exports = async (req, res) => { const q = new URL(req.url, 'http://x').searchParams, a = q.get('a');
  try {
    if (a === 'list') return out(res, 200, await list(), 's-maxage=15, stale-while-revalidate=60');
    if (req.method === 'POST' && a === 'img') return out(res, 200, await img(req));
    if (req.method === 'POST' && a === 'build') return out(res, 200, await build(req));
    return out(res, 404, { error: 'unknown action' });
  } catch (e) { return out(res, 400, { error: e.message || String(e) }); } };
module.exports._t = { build, img, list, conn, cfg, setCfg: v => { cfgCache = { t: Date.now() + 1e9, v }; } };
