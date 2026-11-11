// ---------- Free built-in research engine (no API cost) ----------
// Combines Moneycontrol premium data (MC Score, analyst target, news) with technical
// analysis on ~1 year of daily prices, and explains every signal with numbers.

const num = (v) => { const n = parseFloat(String(v ?? "").replace(/,/g, "")); return isNaN(n) ? null : n; };

// ----- best-effort fundamentals from page text -----
function extractFundamentals(stockText, scoreText, price) {
  const all = `${scoreText} ${stockText}`;
  const f = { mcScore: null, target: null, analysts: null, consensus: null };
  let m = all.match(/(?:MC\s*)?Score[^0-9]{0,60}?(\d{1,3})\s*\/\s*100/i) || all.match(/\b(\d{1,3})\s*\/\s*100\b/);
  if (m && +m[1] <= 100) f.mcScore = +m[1];
  // analyst target: take a number near "target" that is a sensible multiple of price
  const re = /target(?:\s*price)?[^₹\d]{0,50}(?:₹|Rs\.?|INR)?\s*([\d,]+(?:\.\d+)?)/gi;
  while ((m = re.exec(all))) {
    const t = num(m[1]);
    if (t && price && t > price * 0.4 && t < price * 3) { f.target = t; break; }
  }
  m = all.match(/(\d{1,2})\s+analysts?/i); if (m) f.analysts = +m[1];
  m = all.match(/(?:consensus|recommendation|analyst rating)[^.]{0,60}?\b(Strong Buy|Outperform|Buy|Accumulate|Hold|Neutral|Underperform|Reduce|Sell|Strong Sell)\b/i);
  if (m) f.consensus = m[1].replace(/\b\w/g, c => c.toUpperCase());
  return f;
}

// ----- news tone -----
const POS = /(profit (?:rises|jumps|up|surges)|net profit up|revenue (?:rises|up|jumps)|beats|record (?:high|order|revenue)|order win|bags order|wins order|upgrade|buy rating|raises target|target raised|bonus|buyback|dividend|expansion|approval|acquires|partnership|strong growth|surges|rallies)/i;
const NEG = /(profit (?:falls|drops|down|declines)|net loss|loss widens|revenue (?:falls|down|declines)|misses|downgrade|sell rating|cuts target|target cut|pledge|resign|probe|penalty|sebi|fraud|raid|default|lawsuit|recall|warning letter|plunges|crashes|slumps|weak|down \d+(?:\.\d+)?%)/i;
const RESULTS = /(results|Q[1-4]|quarter|net sales|net profit|earnings)/i;
function newsTone(headlines) {
  const pos = headlines.filter(h => POS.test(h.title)), neg = headlines.filter(h => NEG.test(h.title));
  return { pos, neg, results: headlines.filter(h => RESULTS.test(h.title)).slice(0, 2) };
}

// ----- technicals -----
const sma = (a, n) => a.length >= n ? a.slice(-n).reduce((x, y) => x + y, 0) / n : null;
function rsi(c, n = 14) {
  if (c.length < n + 1) return null;
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) { const d = c[i] - c[i - 1]; d > 0 ? g += d : l -= d; }
  g /= n; l /= n;
  for (let i = n + 1; i < c.length; i++) { const d = c[i] - c[i - 1]; g = (g * (n - 1) + Math.max(d, 0)) / n; l = (l * (n - 1) + Math.max(-d, 0)) / n; }
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}
const ret = (c, n) => c.length > n ? (c[c.length - 1] / c[c.length - 1 - n] - 1) * 100 : null;

function technicals(bars, price) {
  if (!bars || bars.c.length < 30) return null;
  const c = bars.c.slice(), v = (bars.v || []).slice();
  if (price) {
    // use the live price for today: replace today's bar, or append if history ends yesterday
    const lastDay = bars.t?.length ? new Date(bars.t[bars.t.length - 1] * 1000 + 330 * 60000).toISOString().slice(0, 10) : null;
    if (lastDay === istDate()) c[c.length - 1] = price; else { c.push(price); v.push(null); }
  }
  const p = c[c.length - 1];
  const d50 = sma(c, 50), d200 = sma(c, 200);
  const y = c.slice(-250);
  const hi = Math.max(...y), lo = Math.min(...y);
  const prevC = c.slice(0, -1);
  return {
    price: p, d50, d200, rsi: rsi(c), rsiPrev: rsi(prevC),
    above50: d50 ? p > d50 : null, above200: d200 ? p > d200 : null,
    golden: d50 && d200 ? d50 > d200 : null,
    prevAbove50: sma(prevC, 50) ? prevC[prevC.length - 1] > sma(prevC, 50) : null,
    prevAbove200: sma(prevC, 200) ? prevC[prevC.length - 1] > sma(prevC, 200) : null,
    r1m: ret(c, 21), r3m: ret(c, 63), r1y: ret(c, Math.min(245, c.length - 1)),
    hi, lo, fromHi: (p / hi - 1) * 100, fromLo: (p / lo - 1) * 100,
    volX: v.length > 21 && v[v.length - 1] ? v[v.length - 1] / (sma(v.slice(0, -1), 20) || 1) : null,
    days: c.length
  };
}

const f1 = (n) => n == null ? "—" : (Math.round(n * 10) / 10).toLocaleString("en-IN");
const pct = (n) => n == null ? "—" : `${n > 0 ? "+" : ""}${f1(n)}%`;
const rs = (n) => n == null ? "—" : "₹" + Math.round(n).toLocaleString("en-IN");

// ----- the rulebook -----
function analyzeRules({ s, q, bars, fund, headlines, prev, reason }) {
  const price = q?.price;
  const T = technicals(bars, price);
  const pts = []; // {w: weight, txt}
  const events = [];
  const held = Number(s.qty) > 0;
  const add = (w, txt) => pts.push({ w, txt });

  // Trend
  if (T) {
    // only count a trend when the gap is meaningful (>2%); otherwise call it flat
    const g200 = T.d200 ? (price / T.d200 - 1) * 100 : null, g50 = T.d50 ? (price / T.d50 - 1) * 100 : null;
    const spread = T.d50 && T.d200 ? (T.d50 / T.d200 - 1) * 100 : null;
    if (g200 != null) add(Math.abs(g200) < 2 ? 0 : g200 > 0 ? 1 : -1, Math.abs(g200) < 2 ? `Price ${rs(price)} is hugging its 200-day average ${rs(T.d200)} (${pct(g200)}) → no clear long-term trend.` : `Price ${rs(price)} is ${g200 > 0 ? "above" : "below"} its 200-day average ${rs(T.d200)} (${pct(g200)}) → long-term trend ${g200 > 0 ? "up" : "down"}.`);
    if (g50 != null) add(Math.abs(g50) < 2 ? 0 : g50 > 0 ? 1 : -1, Math.abs(g50) < 2 ? `Close to the 50-day average ${rs(T.d50)} (${pct(g50)}) → sideways in the medium term.` : `${g50 > 0 ? "Above" : "Below"} the 50-day average ${rs(T.d50)} (${pct(g50)}) → medium-term trend ${g50 > 0 ? "up" : "weak"}.`);
    if (spread != null && Math.abs(spread) >= 1) add(spread > 0 ? 1 : -1, spread > 0 ? `50-day average is ${pct(spread)} above the 200-day (bullish "golden cross" structure).` : `50-day average is ${pct(spread)} below the 200-day (bearish "death cross" structure).`);
    // momentum
    if (T.rsi != null) {
      if (T.rsi < 30) add(1, `RSI ${f1(T.rsi)} → oversold; selling may be stretched.`);
      else if (T.rsi > 75) add(-1, `RSI ${f1(T.rsi)} → overbought; short-term pullback risk.`);
      else add(0, `RSI ${f1(T.rsi)} → neutral momentum.`);
    }
    if (T.r3m != null) add(T.r3m > 15 ? 1 : T.r3m < -15 ? -1 : 0, `Returns: 1 month ${pct(T.r1m)}, 3 months ${pct(T.r3m)}, 1 year ${pct(T.r1y)}.`);
    // 52-week position
    if (T.fromHi > -3) add(g200 > 5 ? 1 : 0, `Trading near its 52-week high ${rs(T.hi)} (${pct(T.fromHi)}).`);
    else if (T.fromLo < 5) add(T.above200 ? 0 : -1, `Near its 52-week low ${rs(T.lo)} (${pct(T.fromLo)} above it)${T.above200 ? "" : " and still in a downtrend — avoid catching a falling knife"}.`);
    else add(0, `${pct(T.fromHi)} from 52-week high ${rs(T.hi)}, ${pct(T.fromLo)} above 52-week low ${rs(T.lo)}.`);
    if (T.volX && T.volX > 2) add(0, `Volume today is ${f1(T.volX)}× the 20-day average — unusual activity.`);
    // events vs previous check
    if (T.prevAbove200 != null && T.above200 !== T.prevAbove200) events.push(`crossed ${T.above200 ? "above" : "below"} its 200-day average`);
    if (T.prevAbove50 != null && T.above50 !== T.prevAbove50) events.push(`crossed ${T.above50 ? "above" : "below"} its 50-day average`);
    if (T.rsiPrev != null && T.rsi != null && ((T.rsiPrev >= 30 && T.rsi < 30) || (T.rsiPrev <= 75 && T.rsi > 75))) events.push(`RSI moved to ${f1(T.rsi)}`);
    if (price >= T.hi * 0.999 && (prev?.tech?.hi ?? 0) < T.hi) events.push(`hit a new 52-week high`);
    if (price <= T.lo * 1.001 && (prev?.tech?.lo ?? Infinity) > T.lo) events.push(`hit a new 52-week low`);
  } else {
    add(0, `Price history unavailable — signal uses Moneycontrol data only.`);
  }

  // Moneycontrol premium data
  if (fund?.mcScore != null) {
    const sc = fund.mcScore;
    add(sc >= 70 ? 2 : sc >= 55 ? 1 : sc < 40 ? -2 : 0, `MC Score ${sc}/100 → ${sc >= 70 ? "strong" : sc >= 55 ? "fair" : sc < 40 ? "weak" : "average"} overall quality on Moneycontrol.`);
    const ps = prev?.fund?.mcScore;
    if (ps != null && Math.abs(sc - ps) >= 5) events.push(`MC Score changed ${ps} → ${sc}`);
  }
  if (fund?.target && price) {
    const up = (fund.target / price - 1) * 100;
    add(up > 20 ? 2 : up > 10 ? 1 : up < -5 ? -2 : 0, `Analyst target ${rs(fund.target)}${fund.analysts ? ` (${fund.analysts} analysts)` : ""} → ${pct(up)} ${up >= 0 ? "upside" : "downside"} from today.`);
    const pt = prev?.fund?.target;
    if (pt && Math.abs(fund.target / pt - 1) > 0.05) events.push(`analyst target moved ${rs(pt)} → ${rs(fund.target)}`);
  }
  if (fund?.consensus) {
    const c = fund.consensus.toLowerCase();
    add(/strong buy|buy|outperform|accumulate/.test(c) ? 1 : /sell|reduce|underperform/.test(c) ? -1 : 0, `Analyst consensus: ${fund.consensus}.`);
  }

  // News
  const tone = newsTone(headlines || []);
  if (tone.pos.length) add(1, `Positive news: "${tone.pos[0].title}".`);
  if (tone.neg.length) add(-1, `Negative news: "${tone.neg[0].title}".`);
  if (tone.results.length && !tone.pos.includes(tone.results[0]) && !tone.neg.includes(tone.results[0])) add(0, `Latest results news: "${tone.results[0].title}".`);
  const seen = prev?.seenNews || [];
  const fresh = (headlines || []).filter(h => !seen.includes(h.url));
  if (prev && fresh.some(h => RESULTS.test(h.title) || NEG.test(h.title) || POS.test(h.title))) events.push(`new news: "${fresh[0].title}"`);

  // Your holding
  if (held && s.buyPrice && price) {
    const g = (price / s.buyPrice - 1) * 100;
    if (g > 40 && T?.rsi > 70) add(-1, `Your holding is up ${pct(g)} and the stock looks stretched — consider booking partial profit.`);
    else if (g < -25 && T && !T.above200) add(-1, `Your holding is down ${pct(g)} and the trend is still down — review your thesis.`);
    else add(0, `Your holding: ${s.qty} @ ${rs(s.buyPrice)} → ${pct(g)}.`);
  }

  // Score → signal
  const score = pts.reduce((a, p) => a + p.w, 0);
  let signal;
  const hasFund = fund?.mcScore != null || fund?.target != null;
  if (score >= 4 && hasFund) signal = "Consider adding";
  else if (score >= 4) signal = "Watch closely"; // good chart, but no Moneycontrol fundamentals to back it
  else if (score >= -1) signal = "Hold";
  else if (score >= -3) signal = "Watch closely";
  else signal = held ? "Consider trimming" : "Avoid";
  const dataPoints = [T, fund?.mcScore != null, fund?.target, (headlines || []).length].filter(Boolean).length;
  const confidence = dataPoints >= 4 && Math.abs(score) >= 3 ? "Medium" : "Low";

  const sorted = [...pts].sort((a, b) => Math.abs(b.w) - Math.abs(a.w));
  const key = sorted.filter(p => p.w > 0 || (p.w === 0 && sorted.length < 5)).map(p => p.txt);
  const risks = sorted.filter(p => p.w < 0).map(p => p.txt);
  const support = signal === "Hold" ? sorted.slice(0, 5).map(p => p.txt) : (score >= 0 ? key : [...risks, ...key]).slice(0, 5);
  const headline = signal === "Hold"
    ? `Mixed picture (score ${score}): ${sorted[0]?.txt.split("→")[0].trim() || "no strong signal"}`
    : `Score ${score > 0 ? "+" : ""}${score}: ${sorted.filter(p => Math.sign(p.w) === Math.sign(score))[0]?.txt.split("→")[0].trim() || ""}`;

  return {
    engine: "rules", signal, confidence, headline: headline.slice(0, 140), score,
    mc_score: fund?.mcScore ?? null, analyst_target: fund?.target ?? null,
    key_points: support.length ? support : ["Not enough data for a clear signal."],
    risks: (score >= 0 ? risks : sorted.filter(p => p.w > 0).map(p => "Counterpoint: " + p.txt)).slice(0, 3),
    validation: "Built-in rules on Moneycontrol data and price history — not cross-checked on the web. Use 📋 Copy research pack to have Claude verify.",
    what_changed: !prev?.signal ? "First review" : events.length ? `Stock ${events.join("; ")}.` + (prev.signal !== signal ? ` Signal ${prev.signal} → ${signal}.` : "")
      : prev.signal !== signal ? `Signal ${prev.signal} → ${signal}.` : "No major change.",
    important_change: events.length > 0 || (prev?.signal && prev.signal !== signal),
    sources: (headlines || []).slice(0, 3).map(h => ({ title: h.title, url: h.url })),
    tech: T ? { hi: T.hi, lo: T.lo, rsi: T.rsi, d50: T.d50, d200: T.d200 } : null,
    fund, headlines: (headlines || []).slice(0, 10)
  };
}

// ----- price history (Moneycontrol chart feed), cached once per day -----
async function getHistory(s, ids) {
  const key = "bars_" + s.id;
  const cached = (await get(key))[key];
  if (cached && cached.day === istDate() && cached.c?.length) return cached;
  const to = Math.floor(Date.now() / 1000), from = to - 400 * 86400;
  const syms = s.exchange === "bse" ? [ids?.bseId, ids?.nseId] : [ids?.nseId, ids?.bseId];
  for (const sym of syms.filter(Boolean)) {
    try {
      const r = await fetch(`https://priceapi.moneycontrol.com/techCharts/indianMarket/stock/history?symbol=${encodeURIComponent(sym)}&resolution=1D&from=${from}&to=${to}&countback=300&currencyCode=INR`,
        { credentials: "include", cache: "no-store" });
      const j = await r.json();
      if (j && j.s === "ok" && j.c?.length > 30) {
        const bars = { day: istDate(), t: j.t, c: j.c.map(Number), v: (j.v || []).map(Number), sym };
        await set({ [key]: bars });
        return bars;
      }
    } catch (e) { /* try next */ }
  }
  return cached || null;
}
