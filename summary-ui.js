// ---------- Daily summary tab ----------
// Uses $, fmt, sign, esc, send and state from dashboard.js, and buildDaySummary / tipTrackRecord from tips-summary.js.
let sumDay = null;     // null = today

function showTab(name) {
  $("#tabMain").hidden = name !== "main"; $("#tabDaily").hidden = name !== "daily";
  document.querySelectorAll("#tabs button").forEach(b => b.classList.toggle("on", b.dataset.tab === name));
  try { localStorage.setItem("tab", name); } catch (e) {}
}
$("#tabs").addEventListener("click", (e) => { const b = e.target.closest("button[data-tab]"); if (b) showTab(b.dataset.tab); });
try { if (localStorage.getItem("tab") === "daily") showTab("daily"); } catch (e) {}

function renderSummary() {
  const today = tipDayOf(Date.now()), tips = state.tips || [], dayLog = state.dayLog || {};
  const day = sumDay || today;
  const hm = (t) => new Date(t).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
  const dname = (d) => d === today ? "Today" : d === tipDayOf(Date.now() - 864e5) ? "Yesterday"
    : new Date(d + "T00:00:00").toLocaleDateString("en-IN", { weekday: "short", day: "2-digit", month: "short" });

  // today's count on the tab itself
  const tToday = buildDaySummary(today, tips, dayLog);
  const alerts = tToday.newTips.length + tToday.targetHits.length + tToday.stops.length + tToday.exits.length;
  document.querySelector("#tabs button[data-tab=daily]").innerHTML = `🗓 Daily summary${alerts ? `<span class="badge">${alerts}</span>` : ""}`;

  // last 7 days
  $("#dayChips").innerHTML = [...Array(7)].map((_, i) => tipDayOf(Date.now() - i * 864e5)).map(d => {
    const s = d === today ? tToday : buildDaySummary(d, tips, dayLog);
    return `<button type="button" data-day="${d}" class="${d === day ? "on" : s.active ? "" : "quiet"}">${dname(d)}${s.newTips.length ? " · " + s.newTips.length : ""}</button>`;
  }).join("");

  // 15-minute check status
  const sw = state.tipsSweep, cfg = { on: true, groups: "", ...(state.settings?.tips || {}) };
  $("#sweepStatus").textContent = !cfg.on ? "Reader is off (⚙ Settings)" : !cfg.groups.trim() ? "Add group names in ⚙ Settings"
    : !sw ? "Groups are checked every 15 minutes"
    : sw.tabs ? `Groups checked ${hm(sw.t)} · next about ${hm(sw.t + 15 * 60000)}`
    : `⚠ ${hm(sw.t)}: WhatsApp Web was not open in Edge · next try about ${hm(sw.t + 15 * 60000)}`;

  const s = day === today ? tToday : buildDaySummary(day, tips, dayLog);
  $("#dayText").innerHTML = `<h3>${dname(day)}'s summary</h3>` + s.lines.map(l => `<p>${esc(l)}</p>`).join("");
  $("#dayPills").innerHTML = `
    <div class="pill">Messages read<b>${s.msgs}</b></div>
    <div class="pill">Stocks discussed<b>${s.disc.length}</b></div>
    <div class="pill">Stock calls<b>${s.newTips.length}</b></div>
    <div class="pill">Buy / Sell<b><span class="chg up">${s.buys}</span> / <span class="chg down">${s.sells}</span></b></div>
    <div class="pill">Targets reached<b class="chg up">${s.targetHits.length}</b></div>
    <div class="pill">Stop-losses hit<b class="chg down">${s.stops.length}</b></div>`;

  const none = (t) => `<p class="none">${t}</p>`;
  const src = (t) => `${esc(t.group)}${t.sender ? " · " + esc(t.sender) : ""}`;
  const levels = (t) => [t.entry ? "Entry ₹" + fmt(t.entry) + (t.entryHigh ? "–" + fmt(t.entryHigh) : "") : "",
    t.targets?.length ? "Target " + t.targets.map(x => "₹" + fmt(x)).join(" / ") : "", t.stopLoss ? "Stop-loss ₹" + fmt(t.stopLoss) : ""].filter(Boolean).join(" · ")
    || "No price levels in the message";

  const newTips = s.newTips.length ? `<ul>${s.newTips.map(t => `<li><span class="call ${t.action === "BUY" ? "buy" : "sell"}">${t.action}</span> <b>${esc(t.label)}</b>${t.derivative ? " <span class='sub'>F&amp;O / index</span>" : !t.matched ? " <span class='sub'>not matched</span>" : ""}
      <div class="sub">${levels(t)}</div><div class="sub">${hm(t.t)} · ${src(t)}</div></li>`).join("")}</ul>` : none("No stock calls were found on this day.");

  const sig = [
    ...s.targetHits.map(h => ({ t: h.t, html: `🎯 <b>${esc(h.tip.label)}</b> reached its target ₹${fmt(h.level)}<div class="sub">${h.tip.entry ? "Entry ₹" + fmt(h.tip.entry) + " · " : ""}tip from ${src(h.tip)}</div>` })),
    ...s.stops.map(t => ({ t: t.closedT, html: `🛑 <b>${esc(t.label)}</b> fell to its stop-loss ₹${fmt(t.stopLoss)}<div class="sub">${t.entry ? "Entry ₹" + fmt(t.entry) + " · " : ""}tip from ${src(t)}</div>` })),
    ...s.exits.map(t => ({ t: t.exitCalled, html: `📣 <b>${esc(t.label)}</b>: the group posted a sell / exit call<div class="sub">Earlier buy tip from ${src(t)}</div>` }))
  ].sort((a, b) => b.t - a.t);
  const sells = sig.length ? `<ul>${sig.map(x => `<li>${x.html}</li>`).join("")}</ul>` : none("No tip reached its target or stop-loss on this day.");

  const max = Math.max(1, ...s.top.map(x => x.n));
  const top = s.top.length ? `<ul>${s.top.map(x => `<li><span class="bar" style="width:${Math.round(x.n / max * 120)}px"></span><b>${esc(x.label)}</b> <span class="sub">${x.n} time${x.n > 1 ? "s" : ""}</span></li>`).join("")}</ul>` : none("No stocks came up.");

  const ment = s.mentions.length ? `<ul>${s.mentions.slice().reverse().slice(0, 12).map(m => `<li><b>${esc(m.stock)}</b> <span class="sub">${hm(m.t)} · ${esc(m.group)}${m.sender ? " · " + esc(m.sender) : ""}</span><div>${esc(m.text)}</div></li>`).join("")}</ul>`
    : none("No other messages mentioned a stock on your dashboard.");

  const grp = s.groups.length ? `<table><tr><th>Group</th><th class="r">Messages</th><th class="r">Stock calls</th></tr>${s.groups.map(g => `<tr><td>${esc(g.name)}</td><td class="r">${g.msgs}</td><td class="r">${g.tips}</td></tr>`).join("")}</table>` : none("Nothing was read.");

  const tr = tipTrackRecord(tips);
  const rec = tr.length ? `<table><tr><th>Who</th><th class="r">Buy calls</th><th class="r">Target reached</th><th class="r">Stop-loss hit</th><th class="r">Still open</th><th class="r">Avg move so far</th></tr>${tr.map(r => `<tr><td>${esc(r.who)}</td><td class="r">${r.n}</td><td class="r chg up">${r.target}</td><td class="r chg down">${r.stopped}</td><td class="r">${r.open}</td><td class="r chg ${r.avg >= 0 ? "up" : "down"}">${r.avg == null ? "—" : sign(r.avg) + fmt(r.avg) + "%"}</td></tr>`).join("")}</table>`
    : none("No tracked buy calls yet.");

  // one card per stock that was talked about
  const TONE = { "positive": "up", "mostly positive": "up", "negative": "down", "mostly negative": "down" };
  const hasKey = !!state.settings?.ai?.key;
  const keepOpen = new Set([...document.querySelectorAll("#dayGrid details[open]")].map(d => d.dataset.key));
  const discHtml = s.disc.length ? `<div class="discGrid">${s.disc.map(d => {
      const onDash = d.scid && state.stocks.some(x => x.scid === d.scid);
      return `<div class="disc" data-key="${esc(d.key)}">
        <div class="discHead"><b>${esc(d.label)}</b>${d.url ? ` <a href="${esc(d.url)}" target="_blank" rel="noopener" title="Open on Moneycontrol">↗</a>` : ""}
          <span class="sub">${d.n} message${d.n > 1 ? "s" : ""}</span><span class="tone ${TONE[d.tone] || ""}">${esc(d.tone)}</span>${onDash ? `<span class="sub">on your dashboard</span>` : ""}</div>
        <p>${esc(d.text)}</p>
        ${d.ai ? `<p class="ai">✨ ${esc(d.ai.text)}</p>` : ""}
        <details data-key="${esc(d.key)}" ${keepOpen.has(d.key) ? "open" : ""}><summary>Show the messages</summary><ul>${d.msgs.map(m => `<li><span class="sub">${hm(m.t)} · ${esc(m.group)}${m.sender ? " · " + esc(m.sender) : ""}${m.kind === "call" ? " · call" : ""}</span><div>${esc(m.text)}</div></li>`).join("")}</ul></details>
        <div class="discActs">${d.scid && !onDash ? `<button type="button" data-disc="add" title="Add this stock to my dashboard">＋ Add to my stocks</button>` : ""}${hasKey ? `<button type="button" data-disc="ai" title="Send these messages to Claude with your API key for a written summary (uses your API credit)">✨ AI summary</button>` : ""}<button type="button" data-disc="ignore" title="This is not a stock, or I don't want it tracked: remove it and don't pick it up again">✕ Not a stock</button></div>
      </div>`; }).join("")}</div>` : none(s.msgs ? "No stock was named in the messages read on this day." : "Nothing was read.");

  $("#dayGrid").innerHTML = `
    <div class="dcard wide"><h4>Stock discussions: one summary per stock</h4>${discHtml}</div>
    <div class="dcard"><h4>New stock calls</h4>${newTips}</div>
    <div class="dcard"><h4>Sell signals from earlier tips</h4>${sells}</div>
    <div class="dcard"><h4>By group</h4>${grp}</div>
    <div class="dcard wide"><h4>Track record so far (all days, tracked buy calls)</h4>${rec}</div>`;
}

$("#dayChips").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-day]"); if (!b) return;
  sumDay = b.dataset.day === tipDayOf(Date.now()) ? null : b.dataset.day; renderSummary();
});
$("#dayGrid").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-disc]"); if (!btn) return;
  const key = btn.closest(".disc").dataset.key, day = sumDay || tipDayOf(Date.now());
  const d = buildStockDiscussions(day, state.dayLog || {}).find(x => x.key === key); if (!d) return;
  if (btn.dataset.disc === "ignore") await send({ type: "discIgnore", key });
  else if (btn.dataset.disc === "add") {
    btn.textContent = "Adding…";
    const r = await send({ type: "resolve", input: d.url || d.scid });
    if (!r?.ok) { btn.textContent = "⚠ Could not add"; return; }
    if (!state.stocks.some(s => s.scid === r.scid)) {
      state.stocks.push({ id: r.scid + "_" + Date.now(), scid: r.scid, exchange: r.exchange, name: r.name, url: r.url || d.url, v: 2, alerts: {} });
      await chrome.storage.local.set({ stocks: state.stocks });
    }
    await send({ type: "refresh" });
  } else if (btn.dataset.disc === "ai") {
    btn.textContent = "Summarising…"; btn.disabled = true;
    const r = await send({ type: "discAi", day, key });
    if (!r?.ok) { btn.textContent = "⚠ " + (r?.error || "Failed").slice(0, 60); btn.disabled = false; }
  }
});
$("#sweepBtn").addEventListener("click", async () => {
  $("#sweepBtn").textContent = "Checking…";
  const r = await send({ type: "tipsSweepNow" });
  $("#sweepBtn").textContent = "⟳ Check now";
  if (r?.ok && !r.tabs) $("#sweepStatus").textContent = "⚠ WhatsApp Web is not open in Edge. Open web.whatsapp.com and try again.";
  else if (r?.ok && !r.asked) $("#sweepStatus").textContent = "⚠ Reload the WhatsApp Web tab once, then try again.";
});

// This is the last script to load: draw once more so the tips table and this tab are filled
// even if the saved data arrived before these scripts were ready.
render();
