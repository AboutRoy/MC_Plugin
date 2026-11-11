// ---------- WhatsApp tips: dashboard section ----------
// Uses $, fmt, sign, esc, send and state from dashboard.js.
const tipTime = (t) => new Date(t).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
const tipDay = (t) => new Date(t).toLocaleDateString("en-IN", { day: "2-digit", month: "short" });

function waStatusText() {
  const cfg = { on: true, groups: "", ...(state.settings?.tips || {}) }, st = state.waStatus;
  if (!cfg.on) return "Reader is off. Turn it on in ⚙ Settings.";
  if (!cfg.groups.trim()) return "⚠ Add your group names in ⚙ Settings → WhatsApp tips.";
  if (!st || Date.now() - st.t > 3 * 60000) return "⚠ Not reading: open web.whatsapp.com in an Edge tab and leave it open.";
  if (!st.ready) return "⚠ WhatsApp Web is open but not signed in yet.";
  let s = `✅ Reading · checked ${new Date(st.t).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}`;
  if (st.found?.length) s += ` · watching: ${st.found.join(", ")}`;
  if (st.missing?.length) s += ` · ⚠ not in view: ${st.missing.join(", ")} (check the name, and pin the group in WhatsApp)`;
  return s;
}

// Plain readout of what the reader inside the WhatsApp tab can see. No message text is shown.
function waDiagText() {
  const st = state.waStatus, sw = state.tipsSweep, tm = (t) => t ? new Date(t).toLocaleTimeString("en-IN") : "never";
  const L = [`Dashboard version: ${chrome.runtime.getManifest?.().version || "?"}`];
  if (!st) L.push("Reader: has never reported. It is not running in the WhatsApp tab. Reload the extension, then press F5 on the WhatsApp Web tab.");
  else {
    const d = st.diag || {}, age = Math.round((Date.now() - st.t) / 1000);
    L.push(`Reader version: ${d.v || "old copy: press F5 on the WhatsApp Web tab"}`);
    L.push(`Last report: ${tm(st.t)} (${age}s ago)${age > 180 ? "  <- STALE: reader is not running now" : ""}`);
    L.push(`Reader turned on: ${d.on}   Watching: ${(d.groups || []).join(" | ") || "(none)"}`);
    L.push(`Chat list found: ${d.hasList}   chat names seen in list: ${d.listTitles ?? "?"}`);
    L.push(`Open chat panel found: ${d.hasMain}   open chat name read as: "${d.header ?? st.chat ?? ""}"   is a watched group: ${d.watchedOpen}`);
    L.push(`Messages on screen: ${d.rows ?? "?"}   with readable text: ${d.withText ?? "?"}   sent by you (skipped): ${d.outgoing ?? "?"}`);
    L.push(`Passed to dashboard so far: ${d.sentTotal ?? 0} messages, ${d.tipsAdded ?? 0} kept as tips`);
    L.push(`Last hand-over: ${d.lastSend ? `${tm(d.lastSend.t)}, ${d.lastSend.n} messages, ok=${d.lastSend.ok}, tips=${d.lastSend.added}${d.lastSend.err ? ", error=" + d.lastSend.err : ""}` : "none yet"}`);
    L.push(`Last error: ${d.lastErr || "none"}`);
  }
  L.push(`15-minute check: ${sw ? `${tm(sw.t)}, WhatsApp tabs found=${sw.tabs}, answered=${sw.asked}` : "not run yet"}`);
  const today = (state.dayLog || {})[tipDayOf(Date.now())];
  L.push(`Today's log: ${today ? Object.entries(today.groups || {}).map(([g, x]) => `${g}: ${x.msgs} messages, ${x.tips} tips`).join("; ") : "empty"}`);
  return L.join("\n");
}

function whenToSell(t) {
  if (t.derivative) return ["warn", "Options / futures or index call: shown only, price not tracked"];
  if (!t.matched) return ["warn", "Stock not recognised on Moneycontrol: not tracked"];
  if (t.action === "SELL") return ["stop", "Tip says sell / exit now"];
  if (t.status === "target") return ["hit", `🎯 Target reached on ${tipDay(t.closedT)}: the tip's sell level`];
  if (t.status === "stopped") return ["stop", `🛑 Stop-loss hit on ${tipDay(t.closedT)}: the tip's exit level`];
  if (t.status === "expired") return ["", "Closed after 30 days without reaching target or stop-loss"];
  if (t.exitCalled) return ["stop", `📣 The group posted a sell / exit call on ${tipDay(t.exitCalled)}`];
  const next = t.targets.find(x => !t.hits.includes(x)), p = [];
  if (t.hits.length && next) p.push(`First target reached. Next: sell at ₹${fmt(next)}`);
  else if (next) p.push(`Sell at ₹${fmt(next)}${t.targetSrc === "rule" ? " (your rule)" : ""}`);
  if (t.stopLoss) p.push(`${next ? "or exit" : "Exit"} if it falls to ₹${fmt(t.stopLoss)}${t.slSrc === "rule" ? " (your rule)" : ""}`);
  if (!p.length) return ["warn", "⚠ No target or stop-loss in the message. Set a default rule in ⚙ Settings."];
  const span = [t.horizon, t.timeframe].filter(Boolean).join(", ");
  return ["", p.join(", ") + (span ? ` · ${span}` : "")];
}

function renderTips() {
  $("#waStatus").textContent = waStatusText();
  $("#waDiag").textContent = waDiagText();
  const all = state.tips || [], showAll = $("#tipsShowAll").checked;
  const list = all.filter(t => showAll || (t.status !== "dismissed" && t.status !== "expired"));
  $("#tipsEmpty").hidden = list.length > 0;
  if (!list.length) { $("#tipsTable").innerHTML = ""; return; }
  const keepOpen = new Set([...document.querySelectorAll("#tipsTable details[open]")].map(d => d.closest("tr").dataset.id));
  $("#tipsTable").innerHTML = `<tr><th>Seen</th><th>Stock</th><th>Call</th><th>Entry</th><th>Target</th><th>Stop-loss</th><th>Now</th><th>When to sell</th><th>Source</th><th></th></tr>` +
    list.map(t => {
      const base = t.entry || t.priceAtTip, chg = base && t.last ? (t.last / base - 1) * 100 : null;
      const [cls, when] = whenToSell(t);
      const onDash = t.scid && state.stocks.some(s => s.scid === t.scid);
      const tg = t.targets.length ? t.targets.map(x => t.hits.includes(x) ? `<s>₹${fmt(x)}</s> ✓` : `₹${fmt(x)}`).join("<br>") : "—";
      return `<tr data-id="${t.id}" class="${t.status === "open" ? "" : "closed"}">
        <td class="num">${tipTime(t.t)}</td>
        <td><b>${esc(t.label)}</b>${t.url ? ` <a href="${esc(t.url)}" target="_blank" rel="noopener" title="Open on Moneycontrol" style="color:var(--muted);text-decoration:none">↗</a>` : ""}
          <div class="sub">${t.matched ? esc((t.exchange || "").toUpperCase() + " · " + t.scid) : t.derivative ? "F&amp;O / index" : "not matched"}${onDash ? " · on your dashboard" : ""}</div></td>
        <td><span class="call ${t.action === "BUY" ? "buy" : "sell"}">${t.action}</span></td>
        <td class="num">${t.entry ? "₹" + fmt(t.entry) + (t.entryHigh ? "–" + fmt(t.entryHigh) : "") : "—"}</td>
        <td class="num">${tg}</td>
        <td class="num">${t.stopLoss ? "₹" + fmt(t.stopLoss) : "—"}</td>
        <td class="num">${t.last ? "₹" + fmt(t.last) : "—"}${chg != null ? `<div class="chg ${chg >= 0 ? "up" : "down"}" title="Since the tip's ${t.entry ? "entry price" : "price when seen"}">${sign(chg)}${fmt(chg)}%</div>` : ""}</td>
        <td class="when ${cls}">${esc(when)}</td>
        <td><details ${keepOpen.has(t.id) ? "open" : ""}><summary title="Show the original message">${esc(t.group)}${t.sender ? " · " + esc(t.sender) : ""}</summary><pre>${esc(t.text)}</pre></details></td>
        <td class="acts">${t.matched && t.action === "BUY" ? `<button data-tip="track" title="${onDash ? "Set this tip's target and stop-loss as price alerts on the stock card (only where no alert is set)" : "Add to my stocks, with the tip's target and stop-loss as price alerts"}">${onDash ? "🔔 Set alerts" : "＋ Add"}</button> ` : ""}<button data-tip="dismiss" title="${t.status === "dismissed" ? "Restore" : "Dismiss"}">${t.status === "dismissed" ? "↺" : "✕"}</button></td>
      </tr>`;
    }).join("");
}

$("#tipsShowAll").addEventListener("change", renderTips);
$("#tipsTable").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-tip]"); if (!btn) return;
  const id = btn.closest("tr").dataset.id;
  const { tips = [] } = await chrome.storage.local.get("tips");
  const t = tips.find(x => x.id === id); if (!t) return;
  if (btn.dataset.tip === "dismiss") {
    t.status = t.status === "dismissed" ? "open" : "dismissed";
    await chrome.storage.local.set({ tips });
  } else if (btn.dataset.tip === "track") {
    const next = t.targets.find(x => !t.hits.includes(x)) || null;
    let s = state.stocks.find(x => x.scid === t.scid);
    if (!s) {
      s = { id: t.scid + "_" + Date.now(), scid: t.scid, exchange: t.exchange, name: t.label, url: t.url, v: 2, alerts: {} };
      state.stocks.push(s);
    }
    s.alerts = s.alerts || {};
    if (!s.alerts.above && next) s.alerts.above = next;
    if (!s.alerts.below && t.stopLoss) s.alerts.below = t.stopLoss;
    await chrome.storage.local.set({ stocks: state.stocks });
    await send({ type: "refresh" });
  }
});

$("#tipsPasteBtn").addEventListener("click", () => { $("#pasteMsg").textContent = ""; $("#pasteDlg").showModal(); });
$("#pasteClose").addEventListener("click", () => $("#pasteDlg").close());
$("#pasteGo").addEventListener("click", async () => {
  const text = $("#pasteText").value.trim(); if (!text) return;
  $("#pasteMsg").textContent = "Reading…";
  const r = await send({ type: "tipsPaste", text, group: $("#pasteGroup").value.trim() });
  if (!r?.ok) { $("#pasteMsg").textContent = "⚠ " + (r?.error || "Failed"); return; }
  $("#pasteMsg").textContent = r.added ? `Added ${r.added} tip${r.added > 1 ? "s" : ""} from ${r.total} message${r.total > 1 ? "s" : ""} ✓`
    : `No new tips found in ${r.total} message${r.total > 1 ? "s" : ""}.`;
  if (r.added) $("#pasteText").value = "";
});
