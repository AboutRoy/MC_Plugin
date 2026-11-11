// ---------- WhatsApp tips: background side ----------
// Receives messages read from WhatsApp Web (wa-content.js) or pasted on the dashboard,
// keeps the ones that are stock tips, matches them to a Moneycontrol stock,
// then tracks each tip's target and stop-loss and alerts when one is reached.
// Uses helpers from background.js: get, set, getSettings, mcSearch, pickId, fetchQuote, notify.

const tipSq = (s) => String(s || "").replace(/<[^>]+>/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
const tipNum = (v) => parseFloat(String(v ?? "").replace(/,/g, ""));
const tipR2 = (v) => Math.round(v * 100) / 100;
const tipRs = (v) => "₹" + Number(v).toLocaleString("en-IN", { maximumFractionDigits: 2 });

async function matchStock(cands) {
  for (const c of cands) {
    const w = c.split(" "); const tries = [c];
    if (w.length > 1) tries.push(w.slice(0, -1).join(" "));
    if (w.length > 2) tries.push(w.slice(0, -2).join(" "));
    for (const q of tries) {
      if (tipSq(q).length < 2) continue;
      let hits = [];
      try { hits = await mcSearch(q); } catch (e) { continue; }
      // only accept a search result that really contains what the message said
      const words = q.split(" ").map(tipSq).filter(x => x.length > 1);
      const hit = hits.find(h => { if (!h || !h.link_src) return false; const hay = tipSq(JSON.stringify(h)); return hay.includes(tipSq(q)) || (words.length > 1 && words.every(x => hay.includes(x))); });
      if (!hit) continue;
      const id = pickId(hit); if (!id.scid) continue;
      const quote = await fetchQuote(id.scid, id.exchange);
      if (!quote || quote.stale) continue;
      return { scid: id.scid, exchange: quote.ex, name: quote.d.SC_FULLNM || id.name || quote.d.company || c,
               url: hit.link_src, price: tipNum(quote.d.pricecurrent) };
    }
  }
  return null;
}

function tipLine(t) {
  const p = [];
  if (t.entry) p.push(`Entry ${tipRs(t.entry)}${t.entryHigh ? "–" + tipRs(t.entryHigh) : ""}`);
  if (t.targets.length) p.push(`Target ${t.targets.map(tipRs).join(" / ")}${t.targetSrc === "rule" ? " (your rule)" : ""}`);
  if (t.stopLoss) p.push(`Stop-loss ${tipRs(t.stopLoss)}${t.slSrc === "rule" ? " (your rule)" : ""}`);
  if (!t.targets.length && !t.stopLoss) p.push("No target or stop-loss given");
  return p.join(" · ");
}

let tipQueue = Promise.resolve();
const inQueue = (fn) => { const p = tipQueue.then(fn); tipQueue = p.catch(() => {}); return p; };

function handleWaMessages(payload) { return inQueue(() => handleNow(payload)); }

async function handleNow({ group = "", msgs = [], quiet = false }) {
  const settings = await getSettings(); const cfg = settings.tips;
  if (!cfg.on) return { added: 0, total: msgs.length };
  let { tips = [], tipSeen = [], tipGroups = [], dayLog = {}, stocks = [], quotes = {}, stockCache = {}, stockIgnore = [], tipPeople = [] } =
    await get(["tips", "tipSeen", "tipGroups", "dayLog", "stocks", "quotes", "stockCache", "stockIgnore", "tipPeople"]);
  const day = tipDayOf(Date.now());
  const dl = dayLog[day] || (dayLog[day] = { groups: {}, mentions: [] });
  const gl = dl.groups[group] || (dl.groups[group] = { msgs: 0, tips: 0 });
  // names of the people posting are never mistaken for stocks
  for (const m of msgs) String(m?.sender || "").toLowerCase().split(/[^a-z]+/).forEach(w => { if (w.length >= 3 && !tipPeople.includes(w)) tipPeople.push(w); });
  const dctx = discContext(stocks, quotes, tips, { stockCache, stockIgnore, tipPeople });
  const seen = new Set(tipSeen);
  // first time we see a group: record its recent tips without sending a burst of alerts
  const firstTime = !tipGroups.includes(group);
  if (firstTime) tipGroups.push(group);
  let added = 0;

  for (const m of msgs) {
    if (!m || !m.text) continue;
    const mid = m.id || "p_" + tipSq(m.text).slice(0, 80);
    if (seen.has(mid)) continue;
    seen.add(mid); gl.msgs++;
    const p = parseTip(m.text);
    if (!p) {            // not a call: file it under every stock it talks about
      try { noteDiscussion(dl, group, m, await detectStocks(m.text, dctx), "talk"); } catch (e) {}
      continue;
    }

    let stock = p.derivative ? null : await matchStock(p.candidates);
    if (!stock && !p.derivative) {      // the name was not where a call usually puts it: use any stock the message names
      try {
        const f = (await detectStocks(m.text, dctx)).find(x => x.scid);
        const fq = f && await fetchQuote(f.scid);
        if (fq && !fq.stale) stock = { scid: f.scid, exchange: fq.ex, name: fq.d.SC_FULLNM || f.label, url: f.url, price: tipNum(fq.d.pricecurrent) };
      } catch (e) {}
    }
    const base = p.entry || stock?.price || null;
    let targets = [...p.targets].sort((a, b) => p.action === "BUY" ? a - b : b - a);
    let stopLoss = p.stopLoss, targetSrc = targets.length ? "message" : "", slSrc = stopLoss ? "message" : "";
    if (p.action === "BUY" && base) {
      if (!targets.length && p.targetPct) { targets = [tipR2(base * (1 + p.targetPct / 100))]; targetSrc = "message"; }
      if (!targets.length && Number(cfg.defTargetPct) > 0) { targets = [tipR2(base * (1 + Number(cfg.defTargetPct) / 100))]; targetSrc = "rule"; }
      if (!stopLoss && Number(cfg.defStopPct) > 0) { stopLoss = tipR2(base * (1 - Number(cfg.defStopPct) / 100)); slSrc = "rule"; }
    }
    const key = stock?.scid || p.candidates[0];
    // the same call repeated or forwarded within 12 hours is kept once
    if (tips.some(t => t.key === key && t.action === p.action && t.group === group && Date.now() - t.t < 12 * 3600e3 &&
        JSON.stringify(t.msgTargets) === JSON.stringify(p.targets))) continue;

    const tip = { id: "t" + Date.now() + Math.random().toString(36).slice(2, 6), t: Date.now(), key, group, sender: m.sender || "", msgTime: m.time || "",
      text: m.text.slice(0, 700), action: p.action, label: stock?.name || p.candidates[0], matched: !!stock, derivative: p.derivative,
      scid: stock?.scid || "", exchange: stock?.exchange || "", url: stock?.url || "",
      entry: p.entry, entryHigh: p.entryHigh, msgTargets: p.targets, targets, stopLoss, targetSrc, slSrc,
      horizon: p.horizon, timeframe: p.timeframe, priceAtTip: stock?.price || null, last: stock?.price || null, lastT: Date.now(),
      hits: [], status: "open" };

    // a sell / exit call closes the loop on an earlier buy tip for the same stock
    if (p.action === "SELL" && stock) tips.forEach(t => { if (t.scid === stock.scid && t.action === "BUY" && t.status === "open") t.exitCalled = Date.now(); });

    tips.unshift(tip); added++; gl.tips++;
    noteDiscussion(dl, group, m, [{ key: stock?.scid || "TIP_" + tipSq(tip.label), label: tip.label, scid: tip.scid, url: tip.url }], "call");
    if (!quiet && !firstTime && cfg.notify !== false) {
      await notify(`💬 New tip: ${tip.action} ${tip.label}${tip.derivative ? " (F&O)" : ""}`,
        `${tipLine(tip)}\nFrom ${tip.sender || "?"} in ${group}. Unverified tip, not advice.`, settings);
    }
  }
  for (const d of Object.keys(dayLog).sort().slice(0, -14)) delete dayLog[d];      // keep two weeks
  const cacheKeys = Object.keys(dctx.cache);
  if (cacheKeys.length > 1500) cacheKeys.sort((a, b) => dctx.cache[a].t - dctx.cache[b].t).slice(0, 500).forEach(k => delete dctx.cache[k]);
  await set({ tips: tips.slice(0, 200), tipSeen: [...seen].slice(-4000), tipGroups: tipGroups.slice(-50), dayLog, stockCache: dctx.cache, tipPeople: tipPeople.slice(-400) });
  return { added, total: msgs.length };
}

// Called on every refresh: updates each open tip's price and alerts when its target or stop-loss is reached.
function checkTips(stocks, quotes, settings) { return inQueue(() => checkTipsNow(stocks, quotes, settings)); }

async function checkTipsNow(stocks, quotes, settings) {
  const { tips = [] } = await get("tips");
  const open = tips.filter(t => t.status === "open" && t.scid).slice(0, 40);
  if (!open.length) return;
  const keepMs = 30 * 24 * 3600e3; const out = [];
  await Promise.all(open.map(async (t) => {
    if (Date.now() - t.t > keepMs) { t.status = "expired"; t.closedT = Date.now(); return; }
    const onDash = stocks.find(s => s.scid === t.scid);
    let price = onDash && !quotes[onDash.id]?.error ? quotes[onDash.id]?.price : null;
    if (!price) { const q = await fetchQuote(t.scid, t.exchange); if (q && !q.stale) price = tipNum(q.d.pricecurrent); }
    if (!price) return;
    t.last = price; t.lastT = Date.now();
    if (t.action !== "BUY") return;
    for (const tg of t.targets) {
      if (price >= tg && !t.hits.includes(tg)) {
        t.hits.push(tg); t.hitT = t.hitT || {}; t.hitT[tg] = Date.now();
        out.push([`🎯 ${t.label} reached the tip's target ${tipRs(tg)}`,
          `Now ${tipRs(price)}${t.entry ? ", entry was " + tipRs(t.entry) : ""}. Tip from ${t.group}. Review it and decide whether to sell.`]);
      }
    }
    if (t.targets.length && t.hits.length >= t.targets.length) { t.status = "target"; t.closedT = Date.now(); }
    else if (t.stopLoss && price <= t.stopLoss) {
      t.status = "stopped"; t.closedT = Date.now();
      out.push([`🛑 ${t.label} fell to the tip's stop-loss ${tipRs(t.stopLoss)}`,
        `Now ${tipRs(price)}${t.entry ? ", entry was " + tipRs(t.entry) : ""}. Tip from ${t.group}. Review it and decide whether to exit.`]);
    }
  }));
  await set({ tips });
  if (settings.tips.notify !== false) for (const [title, body] of out) await notify(title, body, settings);
}

// Names of the stocks on your dashboard, to spot ordinary messages that mention them.
function myStockNames(stocks, quotes) {
  const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return stocks.map(s => {
    const label = s.displayName || quotes[s.id]?.name || s.name || "";
    const names = [s.displayName, quotes[s.id]?.name, s.name, quotes[s.id]?.short].filter(Boolean)
      .map(n => n.replace(/\b(ltd|limited)\.?$/i, "").trim()).filter(n => n.length >= 3);
    const first = names.map(n => n.split(/\s+/)[0]).filter(w => w.length >= 5);      // "Syngene", "Kotak"
    const all = [...new Set([...names, ...first])];
    return all.length ? { label, re: new RegExp("\\b(?:" + all.map(escRe).join("|") + ")\\b", "i") } : null;
  }).filter(Boolean);
}

// Makes sure the reader is running in every open WhatsApp Web tab, so you never have to reload that tab by hand
// (after the extension is reloaded or updated, the copy already in the tab stops working).
async function ensureReader() {
  let tabs = [];
  try { tabs = await chrome.tabs.query({ url: "https://web.whatsapp.com/*" }); } catch (e) {}
  for (const t of tabs) {
    let live = false;
    try { live = !!(await chrome.tabs.sendMessage(t.id, { type: "waPing" }))?.ok; } catch (e) {}
    if (live) continue;
    try { await chrome.scripting.executeScript({ target: { tabId: t.id }, files: ["wa-content.js"] }); await new Promise(r => setTimeout(r, 800)); } catch (e) {}
  }
  return tabs;
}

// Every 15 minutes: ask the WhatsApp Web tab to go through the watched groups, and send the end-of-day summary.
async function tipsSweep() {
  let asked = 0;
  const tabs = await ensureReader();
  for (const t of tabs) { try { const r = await chrome.tabs.sendMessage(t.id, { type: "waSweep" }); if (r?.ok) asked++; } catch (e) {} }
  await set({ tipsSweep: { t: Date.now(), tabs: tabs.length, asked } });
  await maybeDigest();
  return { tabs: tabs.length, asked };
}

async function maybeDigest() {
  const settings = await getSettings();
  if (!settings.tips.on || settings.tips.digest === false) return;
  const d = istNow(), mins = d.getHours() * 60 + d.getMinutes(), today = istDate();
  if (d.getDay() < 1 || d.getDay() > 5 || mins < 15 * 60 + 45) return;       // weekdays, after 3:45 pm IST
  const { tipDigestDay, tips = [], dayLog = {} } = await get(["tipDigestDay", "tips", "dayLog"]);
  if (tipDigestDay === today) return;
  const s = buildDaySummary(today, tips, dayLog);
  await set({ tipDigestDay: today });
  if (s.active) await notify("🗓 WhatsApp tips: today's summary", s.lines.join("\n") + "\nUnverified tips, not advice.", settings);
}
