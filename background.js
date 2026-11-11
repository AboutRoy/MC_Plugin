// ---------- My Moneycontrol Dashboard: background worker ----------
// Fetches quotes using your logged-in Moneycontrol session, stores history,
// checks alert rules and sends notifications.

const PRICE_API = (ex, id) => `https://priceapi.moneycontrol.com/pricefeed/${ex}/equitycash/${encodeURIComponent(id)}`;

const DEFAULT_SETTINGS = {
  interval: 1,              // minutes between refreshes
  marketHoursOnly: true,    // only poll 9:15–15:30 IST Mon–Fri
  desktop: true,
  whatsapp: { on: false, phone: "", apikey: "" },
  telegram: { on: false, token: "", chatId: "" },
  email: { on: false, serviceId: "", templateId: "", publicKey: "", privateKey: "", to: "" },
  ai: { on: false, engine: "rules", key: "", model: "claude-sonnet-5-5", briefTime: "09:00", flagPct: 4, webValidate: true },
  // WhatsApp tips: groups = one group name per line; default exit rule is used only when a tip gives none
  tips: { on: true, groups: "", autoOpen: true, notify: true, digest: true, defTargetPct: "", defStopPct: "" }
};
importScripts("rules.js", "research.js", "tips.js", "tips-summary.js", "tipsbg.js", "discuss.js");

// ---------- storage helpers ----------
const get = (keys) => chrome.storage.local.get(keys);
const set = (obj) => chrome.storage.local.set(obj);

async function getSettings() {
  const { settings } = await get("settings");
  return { ...DEFAULT_SETTINGS, ...(settings || {}),
    whatsapp: { ...DEFAULT_SETTINGS.whatsapp, ...(settings?.whatsapp || {}) },
    telegram: { ...DEFAULT_SETTINGS.telegram, ...(settings?.telegram || {}) },
    email: { ...DEFAULT_SETTINGS.email, ...(settings?.email || {}) },
    ai: { ...DEFAULT_SETTINGS.ai, ...(settings?.ai || {}) },
    tips: { ...DEFAULT_SETTINGS.tips, ...(settings?.tips || {}) } };
}

// ---------- time helpers (IST) ----------
function istNow() {
  const now = new Date();
  return new Date(now.getTime() + (now.getTimezoneOffset() + 330) * 60000);
}
function istDate() { const d = istNow(); return d.toISOString().slice(0, 10); }
function isMarketOpen() {
  const d = istNow(); const day = d.getDay(); const m = d.getHours() * 60 + d.getMinutes();
  return day >= 1 && day <= 5 && m >= 9 * 60 + 15 && m <= 15 * 60 + 30;
}

// ---------- resolving a Moneycontrol URL to its stock code ----------
// A quote is only trusted if it was updated in the last 10 days.
// (Moneycontrol keeps old feeds alive, e.g. an NSE feed last updated in 2013.)
const STALE_SECS = 10 * 24 * 3600;
function isFresh(d) {
  const ep = Number(d.lastupd_epoch);
  if (ep) return Date.now() / 1000 - ep < STALE_SECS;
  const t = Date.parse(String(d.lastupd || "").replace(" ", "T") + "+05:30");
  return isNaN(t) ? true : Date.now() - t < STALE_SECS * 1000;
}

async function fetchQuote(scid, preferEx = "nse") {
  const order = preferEx === "bse" ? ["bse", "nse"] : ["nse", "bse"];
  let staleHit = null;
  for (const ex of order) {
    try {
      const r = await fetch(PRICE_API(ex, scid), { credentials: "include", cache: "no-store" });
      if (!r.ok) continue;
      const d = (await r.json())?.data;
      if (!d || !d.pricecurrent || d.pricecurrent === "0" || d.pricecurrent === "-") continue;
      if (isFresh(d)) return { ex, d };
      staleHit = staleHit || { ex, d, stale: true };
    } catch (e) { /* try next */ }
  }
  return staleHit; // only old data available (e.g. suspended stock)
}

// Moneycontrol's page URL code is NOT always its price ID
// (Syngene's URL ends in SI10, but SI10 is UPL's price ID; Syngene's is SI62).
// So we look the stock up in Moneycontrol's own search and use its price_identifier.
async function mcSearch(query) {
  const r = await fetch(`https://www.moneycontrol.com/mccode/common/autosuggestion_solr.php?classic=true&query=${encodeURIComponent(query)}&type=1&format=json`,
    { credentials: "include", cache: "no-store" });
  const j = await r.json();
  return Array.isArray(j) ? j : [];
}
const norm = (u) => String(u || "").toLowerCase().split(/[?#]/)[0].replace(/\/+$/, "");
function pickId(hit) {
  const [id, exCode] = String(hit.price_identifier || "").split("-");
  return { scid: id || hit.sc_id, exchange: exCode === "B" ? "bse" : "nse",
           name: String(hit.name || hit.stock_name || "").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").trim() };
}

async function resolveStock(input) {
  input = input.trim();
  const isUrl = /^https?:\/\//i.test(input);
  const parts = norm(input).split("/");
  const query = isUrl ? parts[parts.length - 2] : input;   // e.g. "syngeneinternational"
  const urlCode = isUrl ? parts[parts.length - 1] : "";

  // 1) Moneycontrol search, matched to the exact URL (or code / name)
  try {
    const hits = await mcSearch(query);
    const hit = isUrl
      ? hits.find(h => norm(h.link_src) === norm(input)) || hits.find(h => norm(h.link_src).endsWith("/" + urlCode)) ||
        hits.find(h => norm(h.link_src).split("/").slice(-2, -1)[0] === query)
      : hits.find(h => String(h.sc_id).toLowerCase() === input.toLowerCase()) || hits[0];
    if (hit) {
      const id = pickId(hit);
      const q = await fetchQuote(id.scid, id.exchange);
      if (q) return { scid: id.scid, exchange: q.ex, name: q.d.SC_FULLNM || id.name || q.d.company,
                      url: isUrl ? input : hit.link_src, v: 2 };
    }
  } catch (e) { /* fall through */ }

  // 2) Fallback: code typed directly
  if (!isUrl) {
    const q = await fetchQuote(input.toUpperCase());
    if (q) return { scid: input.toUpperCase(), exchange: q.ex, name: q.d.SC_FULLNM || q.d.company, v: 2 };
  }
  throw new Error("Couldn't find this stock. Paste the full Moneycontrol stock page URL.");
}

// One-time repair of stocks added with the old (URL-code) method.
async function migrateStocks(stocks) {
  let changed = false;
  for (const s of stocks) {
    if (s.v === 2 || !s.url) continue;
    try {
      const r = await resolveStock(s.url);
      Object.assign(s, { scid: r.scid, exchange: r.exchange, name: r.name, v: 2 });
      changed = true;
    } catch (e) { s.v = 2; changed = true; }
  }
  return changed;
}

// ---------- refreshing all stocks ----------
let running = false;
async function refreshAll(force = false) {
  if (running) return; running = true;
  try {
    const settings = await getSettings();
    if (!force && settings.marketHoursOnly && !isMarketOpen()) return;
    const { stocks = [], quotes = {}, history = {} } = await get(["stocks", "quotes", "history"]);
    const before = JSON.stringify(stocks.map(s => [s.scid, s.exchange]));
    if (await migrateStocks(stocks)) {
      stocks.forEach((s, i) => {               // wipe old (wrong) data for repaired stocks
        if (JSON.stringify([s.scid, s.exchange]) !== JSON.stringify(JSON.parse(before)[i])) { delete quotes[s.id]; delete history[s.id]; }
      });
      await set({ stocks });
    }
    const today = istDate();

    await Promise.all(stocks.map(async (s) => {
      const q = await fetchQuote(s.scid, s.exchange);
      if (!q) { quotes[s.id] = { ...(quotes[s.id] || {}), error: "No data", updated: Date.now() }; return; }
      const d = q.d, n = (v) => parseFloat(String(v ?? "").replace(/,/g, ""));
      quotes[s.id] = {
        name: d.SC_FULLNM || d.company || s.name, short: d.company || "", ex: q.ex.toUpperCase(),
        price: n(d.pricecurrent), change: n(d.pricechange), pct: n(d.pricepercentchange),
        open: n(d.OPN), high: n(d.HP), low: n(d.LP), prev: n(d.priceprevclose),
        h52: n(d["52H"]), l52: n(d["52L"]), vol: d.VOL || d.vol || "",
        lastupd: d.lastupd || "", updated: Date.now(),
        error: q.stale ? `Old data: last traded ${String(d.lastupd || "").slice(0, 10)} (suspended or not trading?)` : null
      };
      if (q.stale) return;
      const h = history[s.id] && history[s.id].date === today ? history[s.id] : { date: today, pts: [] };
      h.pts.push([Date.now(), quotes[s.id].price]);
      if (h.pts.length > 500) h.pts.shift();
      history[s.id] = h;
    }));

    const indices = await fetchIndices(today);
    await set({ quotes, history, indices, lastRefresh: Date.now() });
    await checkAlerts(stocks, quotes, settings);
    try { await checkTips(stocks, quotes, settings); } catch (e) { /* tips never block a refresh */ }
    updateBadge(stocks, quotes);
  } finally { running = false; }
}

// ---------- market indices ----------
const INDICES = [
  { id: "nifty", name: "Nifty 50", code: "in;NSX" },
  { id: "sensex", name: "Sensex", code: "in;SEN" },
  { id: "banknifty", name: "Bank Nifty", code: "in;nbx" }
];
async function fetchIndices(today) {
  const { indices: old = {} } = await get("indices");
  const out = {};
  await Promise.all(INDICES.map(async (ix) => {
    const prevHist = old[ix.id]?.date === today ? old[ix.id].pts || [] : [];
    try {
      const r = await fetch(`https://priceapi.moneycontrol.com/pricefeed/notapplicable/inidicesindia/${encodeURIComponent(ix.code)}`,
        { credentials: "include", cache: "no-store" });
      const d = (await r.json())?.data;
      const n = (v) => parseFloat(String(v ?? "").replace(/,/g, ""));
      const price = n(d?.pricecurrent ?? d?.lastprice ?? d?.LTP);
      if (!d || isNaN(price)) throw new Error("No data");
      const pts = [...prevHist, [Date.now(), price]].slice(-500);
      out[ix.id] = { name: ix.name, price, change: n(d.pricechange ?? d.CHG), pct: n(d.pricepercentchange ?? d.PERCCHG),
        high: n(d.HIGH ?? d.HP), low: n(d.LOW ?? d.LP), date: today, pts, error: null };
    } catch (e) {
      out[ix.id] = { ...(old[ix.id] || {}), name: ix.name, error: "No data" };
    }
  }));
  return out;
}

function updateBadge(stocks, quotes) {
  const up = stocks.filter(s => (quotes[s.id]?.pct ?? 0) > 0).length;
  chrome.action.setBadgeText({ text: stocks.length ? `${up}/${stocks.length}` : "" });
  chrome.action.setBadgeBackgroundColor({ color: up >= stocks.length / 2 ? "#16a34a" : "#dc2626" });
}

// ---------- alerts ----------
async function checkAlerts(stocks, quotes, settings) {
  const today = istDate();
  let { fired } = await get("fired");
  if (!fired || fired.date !== today) fired = { date: today, keys: [] };
  const msgs = [];

  for (const s of stocks) {
    const q = quotes[s.id]; const a = s.alerts || {};
    if (!q || q.error || !q.price) continue;
    const rules = [
      ["above", a.above && q.price >= a.above, `crossed above ₹${a.above}`],
      ["below", a.below && q.price <= a.below, `dropped below ₹${a.below}`],
      ["pctUp", a.pctUp && q.pct >= a.pctUp, `is up ${q.pct.toFixed(2)}% today (alert at +${a.pctUp}%)`],
      ["pctDown", a.pctDown && q.pct <= -Math.abs(a.pctDown), `is down ${q.pct.toFixed(2)}% today (alert at -${Math.abs(a.pctDown)}%)`]
    ];
    for (const [key, hit, text] of rules) {
      const k = `${s.id}:${key}:${key.startsWith("pct") ? a[key] : a[key]}`;
      if (hit && !fired.keys.includes(k)) {
        fired.keys.push(k);
        msgs.push({ title: `${s.displayName || q.name} ${text}`, body: `Price ₹${q.price} (${q.change >= 0 ? "+" : ""}${q.change}, ${q.pct >= 0 ? "+" : ""}${q.pct.toFixed(2)}%)` });
      }
    }
  }
  await set({ fired });
  for (const m of msgs) await notify(m.title, m.body, settings);
}

async function notify(title, body, settings) {
  settings = settings || await getSettings();
  const results = [];
  if (settings.desktop) {
    chrome.notifications.create({ type: "basic", iconUrl: "icons/icon128.png", title, message: body, priority: 2 });
    results.push("desktop: sent");
  }
  const tg = settings.telegram;
  if (tg.on && (!tg.token || !tg.chatId)) results.push("telegram: bot token or chat ID missing in Settings");
  if (tg.on && tg.token && tg.chatId) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${tg.token.trim()}/sendMessage`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: tg.chatId.trim(), text: `📈 ${title}\n${body}` })
      });
      const j = await r.json().catch(() => ({}));
      results.push(`telegram: ${j.ok ? "sent" : "FAILED " + (j.description || r.status)}`);
    } catch (e) { results.push("telegram: FAILED " + e.message); }
  }
  const wa = settings.whatsapp;
  if (wa.on && (!wa.phone || !wa.apikey)) results.push("whatsapp: phone number or API key missing in Settings");
  if (wa.on && wa.phone && wa.apikey) {
    try {
      const phone = "+" + wa.phone.replace(/[^\d]/g, "").replace(/^0+/, ""); // normalise to +91XXXXXXXXXX
      const url = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(phone)}&text=${encodeURIComponent(`📈 ${title}\n${body}`)}&apikey=${encodeURIComponent(wa.apikey.trim())}`;
      const r = await fetch(url, { credentials: "omit", cache: "no-store" });
      // CallMeBot replies 200 even on errors, so read its message
      const txt = (await r.text()).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      const ok = r.ok && /queued/i.test(txt) && !/invalid|error/i.test(txt);
      results.push(`whatsapp: ${ok ? "sent" : "FAILED (" + r.status + ") " + txt.slice(0, 160)}`);
    } catch (e) { results.push("whatsapp: FAILED " + e.message); }
  }
  const em = settings.email;
  if (em.on && em.serviceId && em.templateId && em.publicKey) {
    try {
      const r = await fetch("https://api.emailjs.com/api/v1.0/email/send", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ service_id: em.serviceId, template_id: em.templateId, user_id: em.publicKey,
          accessToken: em.privateKey || undefined,
          template_params: { subject: title, message: body, to_email: em.to } })
      });
      results.push(`email: ${r.ok ? "sent" : "failed " + r.status + " " + (await r.text())}`);
    } catch (e) { results.push("email: " + e.message); }
  }
  // keep a small alert log for the dashboard
  const { alertLog = [] } = await get("alertLog");
  alertLog.unshift({ t: Date.now(), title, body, results });
  await set({ alertLog: alertLog.slice(0, 50) });
  return results;
}

// ---------- scheduling ----------
async function schedule() {
  const s = await getSettings();
  await chrome.alarms.clear("refresh");
  chrome.alarms.create("refresh", { periodInMinutes: Math.max(1, Number(s.interval) || 1), delayInMinutes: 0.1 });
  if (!(await chrome.alarms.get("tipsSweep"))) chrome.alarms.create("tipsSweep", { periodInMinutes: 15, delayInMinutes: 1 });
  await scheduleResearch();
}
chrome.runtime.onInstalled.addListener(async () => { await schedule(); ensureReader().catch(() => {}); });
chrome.runtime.onStartup.addListener(async () => { await schedule(); maybeCatchUpBrief(); ensureReader().catch(() => {}); });
chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name === "refresh") { refreshAll(); ensureReader().catch(() => {}); }
  if (a.name === "tipsSweep") tipsSweep().catch(() => {});
  if (a.name === "brief") { await scheduleResearch(); runResearchAll("Morning brief").catch(e => set({ researchStatus: "⚠ " + e.message })); }
  if (a.name === "flags") { maybeCatchUpBrief(); checkFlags(); }
});

chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL("dashboard.html");
  const tabs = await chrome.tabs.query({ url });
  if (tabs.length) { chrome.tabs.update(tabs[0].id, { active: true }); chrome.windows.update(tabs[0].windowId, { focused: true }); }
  else chrome.tabs.create({ url });
});

// ---------- messages from the dashboard ----------
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  (async () => {
    try {
      if (msg.type === "resolve") reply({ ok: true, ...(await resolveStock(msg.input)) });
      else if (msg.type === "refresh") { await refreshAll(true); reply({ ok: true }); }
      else if (msg.type === "reschedule") { await schedule(); reply({ ok: true }); }
      else if (msg.type === "researchNow") {
        // runs in background; dashboard watches researchStatus
        runResearchAll(msg.id ? "Manual research (one stock)" : "Manual research — full brief", msg.id || null)
          .catch(e => set({ researchStatus: "⚠ " + e.message }));
        reply({ ok: true });
      }
      else if (msg.type === "tgDetect") {
        // Finds the chat ID of whoever last messaged the bot (that's you)
        const r = await fetch(`https://api.telegram.org/bot${String(msg.token).trim()}/getUpdates`);
        const j = await r.json();
        if (!j.ok) throw new Error(j.description || "Invalid bot token");
        const last = [...(j.result || [])].reverse().find(u => u.message?.chat?.id);
        if (!last) throw new Error("No message found. Open your bot in Telegram, tap Start (or send 'hi'), then try again.");
        reply({ ok: true, chatId: String(last.message.chat.id), name: last.message.chat.first_name || "" });
      }
      else if (msg.type === "waMessages") reply({ ok: true, ...(await handleWaMessages({ group: msg.group, msgs: msg.msgs })) });
      else if (msg.type === "discIgnore") { await inQueue(() => discIgnore(msg.key)); reply({ ok: true }); }
      else if (msg.type === "discAi") reply({ ok: true, ...(await discAi(msg.day, msg.key)) });
      else if (msg.type === "tipsSweepNow") reply({ ok: true, ...(await tipsSweep()) });
      else if (msg.type === "tipsPaste") reply({ ok: true, ...(await handleWaMessages({ group: msg.group || "Pasted", msgs: splitPasted(msg.text), quiet: true })) });
      else if (msg.type === "test") reply({ ok: true, results: await notify("Test alert from My Dashboard", "If you see this, notifications work ✅") });
    } catch (e) { reply({ ok: false, error: e.message }); }
  })();
  return true;
});
