const $ = (s) => document.querySelector(s);
const send = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, res));
const fmt = (n, d = 2) => (n == null || isNaN(n)) ? "—" : Number(n).toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d });
const sign = (n) => (n > 0 ? "+" : "");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const SIGCLS = { "Consider adding": "add", "Hold": "", "Watch closely": "watch", "Consider trimming": "trim", "Avoid": "avoid" };
const SIGICON = { "Consider adding": "🟢", "Hold": "⚪", "Watch closely": "🟡", "Consider trimming": "🟠", "Avoid": "🔴" };
let researchId = null;
let state = { stocks: [], quotes: {}, history: {}, alertLog: [], settings: {} };
let editingId = null;

async function load() {
  state = { ...state, ...(await chrome.storage.local.get(["stocks", "quotes", "history", "alertLog", "lastRefresh", "settings", "indices", "research", "researchStatus", "tips", "waStatus", "dayLog", "tipsSweep"])) };
  state.research = state.research || {};
  state.stocks = state.stocks || []; state.quotes = state.quotes || {}; state.history = state.history || {};
  render();
}

function isMarketOpen() {
  const now = new Date(); const d = new Date(now.getTime() + (now.getTimezoneOffset() + 330) * 60000);
  const m = d.getHours() * 60 + d.getMinutes();
  return d.getDay() >= 1 && d.getDay() <= 5 && m >= 555 && m <= 930;
}

// Which board a stock sits on. Until you drag it yourself, a stock with a quantity is "Invested" and the rest are "Watchlist".
const SECTIONS = [["invested", "💼 Invested", "No holdings here yet. Drag a stock card here."], ["watch", "👀 Watchlist", "Nothing on the watchlist. Drag a stock card here."]];
const secOf = (s) => s.section === "invested" || s.section === "watch" ? s.section : (Number(s.qty) > 0 ? "invested" : "watch");

function holding(s, q) {
  const qty = Number(s.qty) || 0, bp = Number(s.buyPrice) || 0;
  if (!qty || !q || !q.price) return { qty: 0, invested: 0, value: 0, today: 0, total: 0, totalPct: 0 };
  const invested = qty * bp, value = qty * q.price, today = qty * (q.change || 0), total = bp ? value - invested : 0;
  return { qty, invested: bp ? invested : value, value, today, total, totalPct: invested ? (total / invested) * 100 : 0 };
}

function spark(pts, up) {
  if (!pts || pts.length < 2) return `<svg class="spark"></svg>`;
  const ys = pts.map(p => p[1]); const min = Math.min(...ys), max = Math.max(...ys), r = max - min || 1;
  const W = 260, H = 46;
  const path = pts.map((p, i) => `${(i / (pts.length - 1)) * W},${H - 3 - ((p[1] - min) / r) * (H - 6)}`).join(" ");
  const c = up ? "var(--up)" : "var(--down)";
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><polyline fill="none" stroke="${c}" stroke-width="1.6" points="${path}"/></svg>`;
}

function render() {
  const open = isMarketOpen();
  $("#marketDot").className = "dot" + (open ? " open" : "");
  $("#marketText").textContent = open ? "Market open" : "Market closed";
  $("#lastRefresh").textContent = state.lastRefresh ? new Date(state.lastRefresh).toLocaleTimeString("en-IN") : "—";

  // market indices strip
  const IX = state.indices || {};
  $("#indices").innerHTML = ["nifty", "sensex", "banknifty"].filter(k => IX[k]).map(k => {
    const x = IX[k]; const dir = x.pct > 0 ? "up" : x.pct < 0 ? "down" : "";
    return `<div class="ix"><span class="n">${x.name}</span>
      <span class="p">${x.error && !x.price ? "—" : fmt(x.price)}</span>
      <span class="chg ${dir}">${x.error && !x.price ? x.error : `${sign(x.change)}${fmt(x.change)} (${sign(x.pct)}${fmt(x.pct)}%)`}</span>
      ${spark(x.pts, x.pct >= 0)}</div>`;
  }).join("");

  let list = [...state.stocks];
  const sort = $("#sort").value, Q = state.quotes;
  const nm = (s) => s.displayName || Q[s.id]?.name || s.name;
  if (sort === "pctDesc") list.sort((a, b) => (Q[b.id]?.pct ?? -999) - (Q[a.id]?.pct ?? -999));
  if (sort === "pctAsc") list.sort((a, b) => (Q[a.id]?.pct ?? 999) - (Q[b.id]?.pct ?? 999));
  if (sort === "name") list.sort((a, b) => nm(a).localeCompare(nm(b)));
  if (sort === "pnl") list.sort((a, b) => holding(b, Q[b.id]).total - holding(a, Q[a.id]).total);

  // portfolio totals
  let inv = 0, cur = 0, day = 0, held = 0;
  for (const s of state.stocks) {
    const h = holding(s, Q[s.id]); if (!h.qty) continue;
    held++; inv += h.invested; cur += h.value; day += h.today;
  }
  const tot = cur - inv, totPct = inv ? (tot / inv) * 100 : 0;
  const dayPct = (cur - day) ? (day / (cur - day)) * 100 : 0;
  const pfPills = held ? `
    <div class="pill pf">Portfolio value<b>₹${fmt(cur, 0)}</b></div>
    <div class="pill pf">Today's P&amp;L<b class="chg ${day >= 0 ? "up" : "down"}">${sign(day)}₹${fmt(day, 0)} (${sign(dayPct)}${fmt(dayPct)}%)</b></div>
    <div class="pill pf">Total P&amp;L<b class="chg ${tot >= 0 ? "up" : "down"}">${sign(tot)}₹${fmt(tot, 0)} (${sign(totPct)}${fmt(totPct)}%)</b></div>` : "";

  // summary
  const qs = state.stocks.map(s => Q[s.id] && { ...Q[s.id], name: nm(s) }).filter(q => q && !q.error);
  const up = qs.filter(q => q.pct > 0).length, down = qs.filter(q => q.pct < 0).length;
  const avg = qs.length ? qs.reduce((a, q) => a + q.pct, 0) / qs.length : 0;
  const best = qs.reduce((b, q) => (!b || q.pct > b.pct ? q : b), null);
  const worst = qs.reduce((b, q) => (!b || q.pct < b.pct ? q : b), null);
  $("#summary").innerHTML = state.stocks.length ? `${pfPills}
    <div class="pill">Tracking<b>${state.stocks.length}</b></div>
    <div class="pill">Up / Down<b><span class="chg up">${up}</span> / <span class="chg down">${down}</span></b></div>
    <div class="pill">Avg move<b class="chg ${avg >= 0 ? "up" : "down"}">${sign(avg)}${fmt(avg)}%</b></div>
    ${best ? `<div class="pill">Top gainer<b class="chg up">${best.name} ${sign(best.pct)}${fmt(best.pct)}%</b></div>` : ""}
    ${worst ? `<div class="pill">Top loser<b class="chg down">${worst.name} ${sign(worst.pct)}${fmt(worst.pct)}%</b></div>` : ""}` : "";

  $("#empty").hidden = state.stocks.length > 0;
  const cardHtml = (s) => {
    const q = Q[s.id] || {}; const dir = q.pct > 0 ? "up" : q.pct < 0 ? "down" : "";
    const a = s.alerts || {}; const hasAlert = a.above || a.below || a.pctUp || a.pctDown;
    const h = holding(s, q);
    const holdHtml = h.qty ? `<div class="hold">
        <span>Qty <b>${h.qty}</b> @ <b>${fmt(s.buyPrice)}</b></span><span>Value <b>₹${fmt(h.value, 0)}</b></span>
        <span>Today <b class="${h.today >= 0 ? "up" : "down"}">${sign(h.today)}₹${fmt(h.today, 0)}</b></span>
        <span>Total <b class="${h.total >= 0 ? "up" : "down"}">${sign(h.total)}₹${fmt(h.total, 0)} (${sign(h.totalPct)}${fmt(h.totalPct)}%)</b></span>
      </div>` : "";
    const pos = q.h52 > q.l52 ? Math.min(100, Math.max(0, ((q.price - q.l52) / (q.h52 - q.l52)) * 100)) : null;
    return `<div class="card ${dir}" data-id="${s.id}" draggable="true">
      <div class="tools">
        <button class="bell ${hasAlert ? "on" : ""}" data-act="alert" title="${hasAlert ? "Alerts on · edit" : "Set alerts / holding"}">🔔</button>
        <a href="${s.url || "https://www.moneycontrol.com"}" target="_blank" title="Open on Moneycontrol">↗</a>
        <button data-act="remove" title="Remove">✕</button>
      </div>
      <div class="name" title="${nm(s)}">${nm(s)}</div>
      <div class="ex">${q.ex || s.exchange?.toUpperCase() || ""} · ${s.scid}</div>
      <div class="price">₹${fmt(q.price)}</div>
      <div class="chg ${dir}">${sign(q.change)}${fmt(q.change)} (${sign(q.pct)}${fmt(q.pct)}%)</div>
      ${spark(state.history[s.id]?.pts, q.pct >= 0)}
      <div class="meta">
        <span>Open <b>${fmt(q.open)}</b></span><span>Prev <b>${fmt(q.prev)}</b></span>
        <span>High <b>${fmt(q.high)}</b></span><span>Low <b>${fmt(q.low)}</b></span>
      </div>
      ${pos != null ? `<div class="range" title="52-week range ${fmt(q.l52)} – ${fmt(q.h52)}"><i style="left:${pos}%"></i></div>
      <div class="meta"><span>52W L <b>${fmt(q.l52)}</b></span><span style="text-align:right">52W H <b>${fmt(q.h52)}</b></span></div>` : ""}
      ${holdHtml}
      ${(() => { const r = state.research[s.id]; if (!r) return "";
        if (r.error && !r.signal) return `<div class="sig err" data-act="research" title="${esc(r.error)}">🧠 Research failed <span>${esc(r.error)}</span></div>`;
        return `<div class="sig ${SIGCLS[r.signal] || ""}" data-act="research" title="Click for full research">${SIGICON[r.signal] || "🧠"} ${esc(r.signal)} <span>· ${esc(r.headline)}</span></div>`; })()}
      ${q.error ? `<div class="err">⚠ ${q.error}</div>` : ""}
    </div>`;
  };

  // two boards: stocks you hold, and stocks you are only watching. Cards can be dragged between them.
  if (!window.__dragging) $("#grid").innerHTML = SECTIONS.map(([key, title, hint]) => {
    const items = list.filter(s => secOf(s) === key);
    let extra = "";
    if (key === "invested") {
      let val = 0, dayPnl = 0; items.forEach(s => { const h = holding(s, Q[s.id]); val += h.value; dayPnl += h.today; });
      if (val) extra = `<span class="secStat">Value <b>₹${fmt(val, 0)}</b></span><span class="secStat">Today <b class="chg ${dayPnl >= 0 ? "up" : "down"}">${sign(dayPnl)}₹${fmt(dayPnl, 0)}</b></span>`;
    } else {
      const u = items.filter(s => Q[s.id]?.pct > 0).length, d = items.filter(s => Q[s.id]?.pct < 0).length;
      if (items.length) extra = `<span class="secStat">Up / Down <b><span class="chg up">${u}</span> / <span class="chg down">${d}</span></b></span>`;
    }
    return `<section class="sec" data-sec="${key}">
      <div class="secHead"><h3>${title}</h3><span class="secCount">${items.length}</span>${extra}</div>
      <div class="cards">${items.map(cardHtml).join("") || `<div class="dropHint">${hint}</div>`}</div>
    </section>`;
  }).join("");

  if (typeof renderTips === "function") renderTips();
  if (typeof renderSummary === "function") renderSummary();
  $("#researchStatus").textContent = state.researchStatus ? "🧠 " + state.researchStatus : "";
  if ($("#researchDlg").open && researchId) openResearch(researchId);

  $("#log").innerHTML = (state.alertLog || []).slice(0, 15).map(l =>
    `<li>${new Date(l.t).toLocaleString("en-IN")} — <b>${l.title}</b> · ${l.body} <small>(${(l.results || []).join(", ")})</small></li>`).join("") || "<li>No alerts yet.</li>";
}

// ---------- research detail ----------
function openResearch(id) {
  researchId = id;
  const s = state.stocks.find(x => x.id === id); if (!s) return;
  const r = state.research[id] || {}; const name = s.displayName || state.quotes[id]?.name || s.name;
  const list = (a) => (a || []).map(x => `<li>${esc(x)}</li>`).join("");
  $("#researchBody").innerHTML = !r.signal ? `<h3>${esc(name)}</h3><p>${r.error ? "⚠ " + esc(r.error) : "No research yet. Click Re-run for this stock."}</p>` : `
    <h3>${SIGICON[r.signal] || ""} ${esc(name)}: ${esc(r.signal)} <small style="color:var(--muted)">(${esc(r.confidence)} confidence)</small></h3>
    <div style="color:var(--muted);font-size:12px">${esc(r.date)} · price then ₹${fmt(r.price)} · trigger: ${esc(r.reason)}</div>
    <p><b>${esc(r.headline)}</b></p>
    <div class="meta"><span>MC Score <b>${r.mc_score ?? "—"}</b></span><span>Analyst target <b>${r.analyst_target ? "₹" + fmt(r.analyst_target) : "—"}</b>${r.analyst_target && state.quotes[id]?.price ? ` (${sign(r.analyst_target / state.quotes[id].price * 100 - 100)}${fmt(r.analyst_target / state.quotes[id].price * 100 - 100, 1)}% from now)` : ""}</span></div>
    <h4>Key points behind this signal</h4><ul>${list(r.key_points)}</ul>
    <h4>Risks</h4><ul>${list(r.risks)}</ul>
    <h4>${r.engine === "rules" ? "How this was worked out" : "Cross-checked on the web"}</h4><p>${esc(r.validation || "—")}${r.engine === "rules" ? ` (Rule score ${r.score > 0 ? "+" : ""}${r.score}: ≥ +4 Consider adding · −1 to +3 Hold · −2 to −3 Watch closely · ≤ −4 Trim/Avoid)` : ""}</p>
    <h4>What changed</h4><p>${esc(r.what_changed || "—")}</p>
    <h4>Sources</h4><ul>${(r.sources || []).map(x => `<li><a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.title || x.url)}</a></li>`).join("") || "<li>—</li>"}</ul>
    ${r.error ? `<p class="err">Last re-run failed: ${esc(r.error)}</p>` : ""}
    <div class="disc">${r.engine === "rules" ? "Automated rule-based signal from Moneycontrol data and price history." : "AI research signal based on Moneycontrol and web sources."} It can be wrong or out of date. It is not financial advice. Verify before investing.</div>`;
  if (!$("#researchDlg").open) $("#researchDlg").showModal();
}
$("#researchClose").addEventListener("click", () => { researchId = null; $("#researchDlg").close(); });
$("#researchOneBtn").addEventListener("click", async () => { if (researchId) await send({ type: "researchNow", id: researchId }); });
$("#researchBtn").addEventListener("click", async () => {
  const ai = state.settings?.ai || {};
  if (ai.engine === "claude") {
    if (!ai.key) { alert("Add your Claude API key in ⚙ Settings, or switch the engine to Free."); return; }
    if (!confirm(`Run Claude research on all ${state.stocks.length} stocks? It uses your API credit.`)) return;
  }
  await send({ type: "researchNow" });
});

// ---------- copy research pack (paste into your Claude chat — no API cost) ----------
$("#packBtn").addEventListener("click", async () => {
  const Q = state.quotes, R = state.research;
  const lines = [];
  lines.push(`I track these Indian stocks on Moneycontrol (premium). Below is today's data and my dashboard's rule-based signals.
Please: (1) review each stock, (2) use web search to verify the key facts (latest results, analyst targets, major news) against independent sources like NSE/BSE filings, ET, Business Standard, Mint, Reuters, (3) give me a research view for each — Consider adding / Hold / Watch closely / Consider trimming / Avoid — with the key points and risks behind it, and (4) flag anything that changed recently. I understand this is research, not financial advice.
Date: ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} IST\n`);
  for (const s of state.stocks) {
    const q = Q[s.id] || {}, r = R[s.id] || {}; const name = s.displayName || q.name || s.name;
    lines.push(`=== ${name} (${q.ex || ""}${r.ids?.nseId ? " " + r.ids.nseId : ""}) ===`);
    lines.push(`Price ₹${q.price} (${q.pct >= 0 ? "+" : ""}${fmt(q.pct)}% today), 52W ${q.l52}–${q.h52}`);
    if (s.qty) lines.push(`My holding: ${s.qty} @ ₹${s.buyPrice ?? "?"}`);
    if (r.signal) {
      lines.push(`Dashboard signal: ${r.signal} (${r.confidence}) — ${r.headline}`);
      lines.push(`MC Score: ${r.mc_score ?? "n/a"} | Analyst target: ${r.analyst_target ?? "n/a"}${r.fund?.consensus ? " | Consensus: " + r.fund.consensus : ""}`);
      (r.key_points || []).forEach(p => lines.push(`  + ${p}`));
      (r.risks || []).forEach(p => lines.push(`  - ${p}`));
      if (r.headlines?.length) lines.push(`Recent Moneycontrol headlines:\n${r.headlines.slice(0, 5).map(h => "  • " + h.title).join("\n")}`);
      if (r.mcText) lines.push(`Moneycontrol page extract: ${r.mcText.slice(0, 900)}`);
    } else lines.push(`(No research yet — click Research now first)`);
    lines.push("");
  }
  const text = lines.join("\n");
  try { await navigator.clipboard.writeText(text); $("#packBtn").textContent = "✓ Copied — paste into Claude"; }
  catch (e) { prompt("Copy this text:", text); }
  setTimeout(() => $("#packBtn").textContent = "📋 Copy research pack", 4000);
});

// ---------- add stock ----------
$("#addForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("#addInput").value.trim(); if (!input) return;
  $("#addMsg").textContent = "Looking it up…";
  const r = await send({ type: "resolve", input });
  if (!r?.ok) { $("#addMsg").textContent = "⚠ " + (r?.error || "Failed"); return; }
  if (state.stocks.some(s => s.scid === r.scid && s.v === 2)) { $("#addMsg").textContent = "Already on your dashboard."; return; }
  state.stocks.push({ id: r.scid + "_" + Date.now(), scid: r.scid, exchange: r.exchange, name: r.name,
    url: r.url || (/^https?:/i.test(input) ? input : ""), v: 2, alerts: {} });
  await chrome.storage.local.set({ stocks: state.stocks });
  $("#addInput").value = ""; $("#addMsg").textContent = `Added ${r.name} ✓`;
  await send({ type: "refresh" });
});

// ---------- card actions ----------
$("#grid").addEventListener("click", async (e) => {
  const sig = e.target.closest("[data-act=research]");
  if (sig) { openResearch(sig.closest(".card").dataset.id); return; }
  const btn = e.target.closest("button[data-act]"); if (!btn) return;
  const id = btn.closest(".card").dataset.id;
  if (btn.dataset.act === "remove") {
    if (!confirm("Remove this stock from your dashboard?")) return;
    state.stocks = state.stocks.filter(s => s.id !== id);
    await chrome.storage.local.set({ stocks: state.stocks });
  } else if (btn.dataset.act === "alert") {
    editingId = id; const s = state.stocks.find(x => x.id === id); const a = s.alerts || {};
    $("#alertTitle").textContent = s.displayName || state.quotes[id]?.name || s.name;
    const f = $("#alertForm"); ["above", "below", "pctUp", "pctDown"].forEach(k => f[k].value = a[k] ?? "");
    f.displayName.value = s.displayName || ""; f.qty.value = s.qty ?? ""; f.buyPrice.value = s.buyPrice ?? "";
    $("#alertDlg").showModal();
  }
});
$("#alertDlg").addEventListener("close", async () => {
  if ($("#alertDlg").returnValue !== "save" || !editingId) return;
  const f = $("#alertForm"); const num = (v) => v === "" ? null : Number(v);
  const s = state.stocks.find(x => x.id === editingId);
  s.alerts = { above: num(f.above.value), below: num(f.below.value), pctUp: num(f.pctUp.value), pctDown: num(f.pctDown.value) };
  s.displayName = f.displayName.value.trim(); s.qty = num(f.qty.value); s.buyPrice = num(f.buyPrice.value);
  await chrome.storage.local.set({ stocks: state.stocks });
});

// ---------- drag to reorder ----------
// Drag a card onto the other board to move it, or onto another card to place it next to that card.
let dragId = null;
const clearDrop = () => document.querySelectorAll(".sec.over, .card.before, .card.after, .card.dragging").forEach(el => el.classList.remove("over", "before", "after", "dragging"));
const dropSide = (card, e) => { const r = card.getBoundingClientRect(); return e.clientX > r.left + r.width / 2 ? "after" : "before"; };
$("#grid").addEventListener("dragstart", (e) => {
  const c = e.target.closest?.(".card"); if (!c) return;
  dragId = c.dataset.id; window.__dragging = true; c.classList.add("dragging");
  e.dataTransfer.effectAllowed = "move"; try { e.dataTransfer.setData("text/plain", dragId); } catch (err) {}
});
$("#grid").addEventListener("dragend", () => { dragId = null; window.__dragging = false; clearDrop(); render(); });
$("#grid").addEventListener("dragover", (e) => {
  const sec = e.target.closest?.(".sec"); if (!dragId || !sec) return;
  e.preventDefault(); e.dataTransfer.dropEffect = "move";
  document.querySelectorAll(".sec.over, .card.before, .card.after").forEach(el => el.classList.remove("over", "before", "after"));
  sec.classList.add("over");
  const card = e.target.closest(".card");
  if (card && card.dataset.id !== dragId && $("#sort").value === "manual") card.classList.add(dropSide(card, e));
});
$("#grid").addEventListener("drop", async (e) => {
  const sec = e.target.closest?.(".sec"); if (!dragId || !sec) return;
  e.preventDefault();
  const s = state.stocks.find(x => x.id === dragId); if (!s) return;
  const card = e.target.closest(".card"), target = card && card.dataset.id !== dragId ? card.dataset.id : null;
  s.section = sec.dataset.sec;
  if (target && $("#sort").value === "manual") {          // place it beside the card it was dropped on
    const side = dropSide(card, e);
    state.stocks.splice(state.stocks.indexOf(s), 1);
    const to = state.stocks.findIndex(x => x.id === target);
    state.stocks.splice(side === "after" ? to + 1 : to, 0, s);
  } else if (!card) {                                      // dropped on empty space: goes to the end of that board
    state.stocks.splice(state.stocks.indexOf(s), 1); state.stocks.push(s);
  }
  dragId = null; window.__dragging = false; clearDrop();
  await chrome.storage.local.set({ stocks: state.stocks });
  render();
});

// ---------- header ----------
$("#sort").addEventListener("change", () => { localStorage.setItem("sort", $("#sort").value); render(); });
try { $("#sort").value = localStorage.getItem("sort") || "manual"; } catch (e) {}
$("#refreshBtn").addEventListener("click", async () => { $("#refreshBtn").textContent = "…"; await send({ type: "refresh" }); $("#refreshBtn").textContent = "⟳ Refresh"; });

// ---------- settings ----------
$("#settingsBtn").addEventListener("click", () => {
  const s = { interval: 1, marketHoursOnly: true, desktop: true, whatsapp: {}, telegram: {}, email: {}, ...(state.settings || {}) };
  const tg = s.telegram || {};
  const f = $("#settingsForm");
  f.interval.value = s.interval; f.marketHoursOnly.checked = s.marketHoursOnly; f.desktop.checked = s.desktop;
  const ai = { engine: "rules", model: "claude-sonnet-5-5", briefTime: "09:00", flagPct: 4, webValidate: true, ...(s.ai || {}) };
  f.ai_on.checked = !!ai.on; f.ai_engine.value = ai.engine; f.ai_key.value = ai.key || ""; f.ai_model.value = ai.model; f.ai_briefTime.value = ai.briefTime;
  f.ai_flagPct.value = ai.flagPct; f.ai_webValidate.checked = ai.webValidate !== false;
  f.tg_on.checked = !!tg.on; f.tg_token.value = tg.token || ""; f.tg_chatId.value = tg.chatId || ""; $("#tgMsg").textContent = "";
  f.wa_on.checked = !!s.whatsapp.on; f.wa_phone.value = s.whatsapp.phone || ""; f.wa_apikey.value = s.whatsapp.apikey || "";
  ["on", "serviceId", "templateId", "publicKey", "privateKey", "to"].forEach(k => {
    const el = f["em_" + k]; if (k === "on") el.checked = !!s.email.on; else el.value = s.email[k] || "";
  });
  const tp = { on: true, groups: "", autoOpen: true, notify: true, digest: true, defTargetPct: "", defStopPct: "", ...(s.tips || {}) };
  f.tips_digest.checked = !!tp.digest;
  f.tips_on.checked = !!tp.on; f.tips_groups.value = tp.groups || ""; f.tips_autoOpen.checked = !!tp.autoOpen; f.tips_notify.checked = !!tp.notify;
  f.tips_defTargetPct.value = tp.defTargetPct ?? ""; f.tips_defStopPct.value = tp.defStopPct ?? "";
  $("#testMsg").textContent = ""; $("#settingsDlg").showModal();
});
function readSettings() {
  const f = $("#settingsForm");
  return { interval: Math.max(1, Number(f.interval.value) || 1), marketHoursOnly: f.marketHoursOnly.checked, desktop: f.desktop.checked,
    ai: { on: f.ai_on.checked, engine: f.ai_engine.value, key: f.ai_key.value.trim(), model: f.ai_model.value.trim() || "claude-sonnet-5-5",
      briefTime: f.ai_briefTime.value || "09:00", flagPct: Number(f.ai_flagPct.value) || 4, webValidate: f.ai_webValidate.checked },
    tips: { on: f.tips_on.checked, groups: f.tips_groups.value.trim(), autoOpen: f.tips_autoOpen.checked, notify: f.tips_notify.checked, digest: f.tips_digest.checked,
      defTargetPct: f.tips_defTargetPct.value, defStopPct: f.tips_defStopPct.value },
    telegram: { on: f.tg_on.checked, token: f.tg_token.value.trim(), chatId: f.tg_chatId.value.trim() },
    whatsapp: { on: f.wa_on.checked, phone: f.wa_phone.value.trim(), apikey: f.wa_apikey.value.trim() },
    email: { on: f.em_on.checked, serviceId: f.em_serviceId.value.trim(), templateId: f.em_templateId.value.trim(),
      publicKey: f.em_publicKey.value.trim(), privateKey: f.em_privateKey.value.trim(), to: f.em_to.value.trim() } };
}
$("#settingsDlg").addEventListener("close", async () => {
  if ($("#settingsDlg").returnValue !== "save") return;
  await chrome.storage.local.set({ settings: readSettings() }); await send({ type: "reschedule" });
});
$("#tgDetectBtn").addEventListener("click", async () => {
  const f = $("#settingsForm"); const token = f.tg_token.value.trim();
  if (!token) { $("#tgMsg").textContent = "Paste the bot token first."; return; }
  $("#tgMsg").textContent = "Checking…";
  const r = await send({ type: "tgDetect", token });
  if (r?.ok) { f.tg_chatId.value = r.chatId; f.tg_on.checked = true; $("#tgMsg").textContent = `Found ✓ ${r.name}. Now click Send test alert.`; }
  else $("#tgMsg").textContent = "⚠ " + (r?.error || "Failed");
});
$("#testBtn").addEventListener("click", async () => {
  await chrome.storage.local.set({ settings: readSettings() });
  $("#testMsg").textContent = "Sending…";
  const r = await send({ type: "test" });
  $("#testMsg").textContent = r?.ok ? r.results.join(" · ") || "No channel enabled" : "⚠ " + r?.error;
});

chrome.storage.onChanged.addListener(load);
setInterval(render, 30000); // keep market-open badge fresh
load().then(() => send({ type: "refresh" }));
