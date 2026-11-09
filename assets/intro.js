// d3sk intro: no words. A transaction draws itself, a coin and a stock arrive from opposite sides,
// two signatures land, they cross wallet to wallet, the trade settles and opens onto the site. Under 4.5 s, skippable.
(() => {
  const el = document.getElementById('intro'); if (!el) return;
  const h = location.hash; let seen = false; try { seen = sessionStorage.getItem('d3sk_intro') === '1'; } catch (e) { }
  if (seen || (h && h !== '#/' && h !== '#') || matchMedia('(prefers-reduced-motion: reduce)').matches) { el.remove(); return; }
  try { sessionStorage.setItem('d3sk_intro', '1'); } catch (e) { }
  const root = document.documentElement; root.classList.add('intro-on');
  const c = el.querySelector('canvas'), g = c.getContext('2d'), DPR = Math.min(2, devicePixelRatio || 1);
  let W, H; const size = () => { W = innerWidth; H = innerHeight; c.width = W * DPR; c.height = H * DPR; c.style.width = W + 'px'; c.style.height = H + 'px'; g.setTransform(DPR, 0, 0, DPR, 0, 0); }; size(); addEventListener('resize', size);
  const cl = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v)), ph = (t, a, b) => cl((t - a) / (b - a)), eo = k => 1 - Math.pow(1 - cl(k), 3), eio = k => (k = cl(k), k < .5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
  const back = k => { k = cl(k); const s = 1.5; return 1 + (s + 1) * Math.pow(k - 1, 3) + s * Math.pow(k - 1, 2); };
  const T = { grid: [0, .5], box: [.2, 1.05], enter: [.65, 1.55], sigB: 1.75, sigA: 2.15, swap: [2.45, 3.2], flash: 3.2, out: 3.55, end: 4.25 };
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const sparks = Array.from({ length: 46 }, () => ({ a: rnd() * Math.PI * 2, v: .4 + rnd() * .9, r: 1 + rnd() * 2.2, c: rnd() < .5 ? '167,139,250' : '34,211,238' }));
  const dust = Array.from({ length: 70 }, () => ({ x: rnd(), y: rnd(), s: .3 + rnd() * .9, p: rnd() * 6.28 }));
  let t0 = null, done = false;
  function finish(fast) { if (done) return; done = true; el.classList.add('out'); setTimeout(() => { el.remove(); root.classList.remove('intro-on'); removeEventListener('resize', size); dispatchEvent(new Event('d3sk-intro-done')); }, fast ? 300 : 560); }
  el.querySelector('.iskip').addEventListener('click', () => finish(true)); addEventListener('keydown', function k(e) { if (e.key === 'Escape') { finish(true); removeEventListener('keydown', k); } });
  function rr(x, y, w, h, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }
  // the coin: gold, ridged edge, a hollow core
  function coin(x, y, r, a) { g.save(); g.globalAlpha = a; g.translate(x, y); const gr = g.createRadialGradient(-r * .35, -r * .35, r * .1, 0, 0, r); gr.addColorStop(0, '#ffe58a'); gr.addColorStop(.55, '#fbbf24'); gr.addColorStop(1, '#d97706'); g.fillStyle = gr; g.beginPath(); g.arc(0, 0, r, 0, 6.283); g.fill();
    g.strokeStyle = 'rgba(5,10,31,.28)'; g.lineWidth = Math.max(1.5, r * .06); for (let i = 0; i < 28; i++) { const q = i / 28 * 6.283; g.beginPath(); g.moveTo(Math.cos(q) * r * .86, Math.sin(q) * r * .86); g.lineTo(Math.cos(q) * r * .97, Math.sin(q) * r * .97); g.stroke(); }
    g.lineWidth = Math.max(2, r * .09); g.strokeStyle = 'rgba(5,10,31,.32)'; g.beginPath(); g.arc(0, 0, r * .52, 0, 6.283); g.stroke(); g.restore(); }
  // the stock: violet to cyan, a rising three-bar chart inside
  function stock(x, y, r, a) { g.save(); g.globalAlpha = a; g.translate(x, y); const gr = g.createLinearGradient(-r, -r, r, r); gr.addColorStop(0, '#a78bfa'); gr.addColorStop(1, '#22d3ee'); g.fillStyle = gr; g.beginPath(); g.arc(0, 0, r, 0, 6.283); g.fill();
    g.fillStyle = 'rgba(5,10,31,.78)'; const bw = r * .2, base = r * .42; [[-.42, .38], [-.1, .62], [.22, .9]].forEach(([dx, hh]) => { const bh = r * hh; rr(dx * r, base - bh, bw, bh, bw * .3); g.fill(); }); g.restore(); }
  function sig(x, y, k, now) { if (k <= 0) return; const p = eo(k / .35); g.save(); g.translate(x, y); g.scale(.4 + .6 * back(cl(k / .35)), .4 + .6 * back(cl(k / .35)));
    g.fillStyle = `rgba(52,211,153,${.95 * p})`; g.beginPath(); g.arc(0, 0, 11, 0, 6.283); g.fill(); g.strokeStyle = '#04140c'; g.lineWidth = 2.6; g.lineCap = 'round'; g.lineJoin = 'round'; const dk = cl((k - .15) / .35); g.beginPath(); g.moveTo(-5, 0); if (dk > 0) { g.lineTo(-5 + 3.5 * cl(dk * 2), 3.5 * cl(dk * 2)); if (dk > .5) g.lineTo(-1.5 + 7.5 * cl((dk - .5) * 2), 3.5 - 8.5 * cl((dk - .5) * 2)); } g.stroke(); g.restore();
    const rk = cl(k / .8); if (rk < 1) { g.strokeStyle = `rgba(52,211,153,${(1 - rk) * .6})`; g.lineWidth = 1.5; g.beginPath(); g.arc(x, y, 11 + rk * 30, 0, 6.283); g.stroke(); } }
  function frame(now) { if (done) return; if (t0 == null) t0 = now; const t = (now - t0) / 1000; if (t > T.end) { finish(); return; } requestAnimationFrame(frame);
    const cx = W / 2, cy = H / 2, bw = Math.min(W * .8, 860), bh = Math.min(H * .4, 290), r = Math.max(24, Math.min(bh * .22, 62)), xL = cx - bw * .3, xR = cx + bw * .3;
    const out = eio(ph(t, T.out, T.end)), zoom = 1 + out * .9, fadeAll = 1 - out;
    const bg = g.createRadialGradient(cx, cy * .9, 10, cx, cy, Math.max(W, H) * .75); bg.addColorStop(0, '#111d4f'); bg.addColorStop(.55, '#08112e'); bg.addColorStop(1, '#050a1f'); g.fillStyle = bg; g.fillRect(0, 0, W, H);
    // drifting dust and a dot grid
    const ga = eo(ph(t, ...T.grid)); g.fillStyle = `rgba(140,160,255,${.1 * ga * fadeAll})`; const step = 34; for (let x = (cx % step); x < W; x += step) for (let y = (cy % step); y < H; y += step) { const d = Math.hypot(x - cx, y - cy) / Math.max(W, H); if (d < .62) g.fillRect(x - .75, y - .75, 1.5, 1.5); }
    const sk = ph(t, 0, .55); if (sk > 0 && sk < 1) { const yy = eo(sk) * H; const sl = g.createLinearGradient(0, yy - 120, 0, yy); sl.addColorStop(0, 'rgba(34,211,238,0)'); sl.addColorStop(1, `rgba(34,211,238,${.16 * (1 - sk)})`); g.fillStyle = sl; g.fillRect(0, yy - 120, W, 120); g.fillStyle = `rgba(34,211,238,${.5 * (1 - sk)})`; g.fillRect(0, yy, W, 1.5); }
    dust.forEach(p => { const y = (p.y * H - t * 18 * p.s + H) % H; g.fillStyle = `rgba(34,211,238,${(.08 + .12 * Math.sin(p.p + t * 2)) * ga * fadeAll})`; g.fillRect(p.x * W, y, 1.6, 1.6); });
    const sh = t >= T.flash ? Math.max(0, 1 - (t - T.flash) / .35) * 7 : 0; g.save(); g.translate(cx + (rnd() - .5) * sh, cy + (rnd() - .5) * sh); g.scale(zoom, zoom); g.translate(-cx, -cy); g.globalAlpha = fadeAll;
    // the transaction box draws itself, dashed until it settles
    const bk = eo(ph(t, ...T.box)), flash = t >= T.flash ? cl(1 - (t - T.flash) / .5) : 0, settled = t >= T.flash;
    if (bk > 0) { const x = cx - bw / 2, y = cy - bh / 2, per = 2 * (bw + bh); g.save(); rr(x, y, bw, bh, 22); g.fillStyle = `rgba(6,11,34,${.55 * bk})`; g.fill();
      g.setLineDash(settled ? [] : [8, 7]); g.lineDashOffset = -t * 30; g.lineWidth = settled ? 2 : 1.5; const lg = g.createLinearGradient(x, 0, x + bw, 0); lg.addColorStop(0, `rgba(167,139,250,${.75 + flash * .25})`); lg.addColorStop(1, `rgba(34,211,238,${.75 + flash * .25})`); g.strokeStyle = lg;
      if (bk < 1) { g.save(); g.beginPath(); g.rect(cx - (bw / 2 + 4) * bk - 2, y - 6, (bw + 8) * bk + 4, bh + 12); g.clip(); rr(x, y, bw, bh, 22); g.stroke(); g.restore(); } else g.stroke();
      // two leg rails inside the box
      const ra = eo(ph(t, .8, 1.3)) * (1 - eo(ph(t, T.swap[1], T.flash + .2))); g.setLineDash([2, 8]); g.lineWidth = 1.5; g.strokeStyle = `rgba(140,160,255,${.35 * ra})`; g.beginPath(); g.moveTo(xL, cy - bh * .2); g.lineTo(xR, cy - bh * .2); g.moveTo(xL, cy + bh * .2); g.lineTo(xR, cy + bh * .2); g.stroke();
      const pk = ph(t, 1.05, T.flash); if (pk > 0 && pk < 1) { g.setLineDash([]); for (let q = 0; q < 2; q++) { const d = ((t * .42 + q * .5) % 1) * per; let px, py; if (d < bw) { px = x + d; py = y; } else if (d < bw + bh) { px = x + bw; py = y + d - bw; } else if (d < 2 * bw + bh) { px = x + bw - (d - bw - bh); py = y + bh; } else { px = x; py = y + bh - (d - 2 * bw - bh); } const pg2 = g.createRadialGradient(px, py, 0, px, py, 16); pg2.addColorStop(0, 'rgba(34,211,238,.9)'); pg2.addColorStop(1, 'rgba(34,211,238,0)'); g.fillStyle = pg2; g.beginPath(); g.arc(px, py, 16, 0, 6.283); g.fill(); } }
      if (flash > 0) { rr(x, y, bw, bh, 22); g.fillStyle = `rgba(34,211,238,${flash * .12})`; g.fill(); } g.restore(); }
    // the two tokens: in from opposite edges, a signature each, then they cross
    const en = ph(t, ...T.enter), sw = eio(ph(t, ...T.swap)), arc = Math.sin(sw * Math.PI) * bh * .62;
    const pL = { x: -r * 2 + (xL + r * 2) * back(en), y: cy }, pR = { x: W + r * 2 - (W + r * 2 - xR) * back(en), y: cy };
    const aX = pL.x + (xR - xL) * sw, aY = cy - arc, bX = pR.x - (xR - xL) * sw, bY = cy + arc;
    if (en > 0 && en < 1) { [[pL.x, 1, '251,191,36'], [pR.x, -1, '34,211,238']].forEach(([x, d, col]) => { const tl = g.createLinearGradient(x - d * r * 5, 0, x, 0); tl.addColorStop(0, `rgba(${col},0)`); tl.addColorStop(1, `rgba(${col},${.35 * (1 - en)})`); g.fillStyle = tl; g.fillRect(Math.min(x, x - d * r * 5), cy - r * .5, r * 5, r); }); }
    if (sw > 0 && sw < 1) { g.lineWidth = 2; [[aX, aY, -1, '251,191,36'], [bX, bY, 1, '34,211,238']].forEach(([x, y, s, col]) => { g.strokeStyle = `rgba(${col},.35)`; g.beginPath(); for (let i = 0; i <= 16; i++) { const k = Math.max(0, sw - i * .018), xx = xL + (xR - xL) * (s < 0 ? k : 1 - k), yy = cy + s * Math.sin(k * Math.PI) * bh * .62; i ? g.lineTo(xx, yy) : g.moveTo(xx, yy); } g.stroke(); }); }
    const xk = 1 - Math.abs(sw - .5) * 6; if (xk > 0 && sw > 0) { const rg = g.createRadialGradient(cx, cy, 0, cx, cy, r * 2.2); rg.addColorStop(0, `rgba(255,255,255,${.5 * xk})`); rg.addColorStop(.4, `rgba(34,211,238,${.25 * xk})`); rg.addColorStop(1, 'rgba(34,211,238,0)'); g.fillStyle = rg; g.beginPath(); g.arc(cx, cy, r * 2.2, 0, 6.283); g.fill(); }
    const tokA = en > 0 ? 1 : 0; coin(aX, aY, r, tokA); stock(bX, bY, r, tokA);
    // signatures: they sign first, then you
    sig(xR, cy + bh / 2 - 26, t - T.sigB, now); sig(xL, cy + bh / 2 - 26, t - T.sigA, now);
    // settle: a ring and sparks from the center
    if (t >= T.flash) { const k = ph(t, T.flash, T.flash + .9); g.strokeStyle = `rgba(34,211,238,${(1 - k) * .55})`; g.lineWidth = 2; g.beginPath(); g.arc(cx, cy, 20 + eo(k) * Math.max(W, H) * .55, 0, 6.283); g.stroke();
      g.strokeStyle = `rgba(167,139,250,${(1 - k) * .4})`; g.beginPath(); g.arc(cx, cy, 10 + eo(k) * Math.max(W, H) * .35, 0, 6.283); g.stroke();
      sparks.forEach(q => { const d = eo(k) * Math.min(W, H) * .32 * q.v; g.fillStyle = `rgba(${q.c},${(1 - k) * .9})`; g.beginPath(); g.arc(cx + Math.cos(q.a) * d, cy + Math.sin(q.a) * d, q.r * (1 - k * .5), 0, 6.283); g.fill(); }); }
    g.restore(); }
  requestAnimationFrame(frame);
})();
