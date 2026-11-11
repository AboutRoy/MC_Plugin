// ---------- WhatsApp tips: reader that runs inside the WhatsApp Web tab ----------
// It only READS. It never types, sends, deletes or changes anything in WhatsApp.
// It looks at the groups named in the dashboard's Settings, and passes new incoming
// messages to the dashboard, which decides whether each one is a stock tip.
(() => {
  // A copy left over from before the extension was reloaded is dead; only a live copy blocks a new one.
  if (window.__mcTipsReader && typeof window.__mcTipsReader === "object" && window.__mcTipsReader.alive()) return;
  const VERSION = "2.3.2";

  const sent = new Set(), expandTries = new Map();
  let cfg = null, alive = true, lastUser = 0, lastOpen = 0, lastBeat = 0, busy = false, sweep = [], sweepT = 0;
  const diag = { v: VERSION, started: Date.now(), ticks: 0, sentTotal: 0, tipsAdded: 0, lastSend: null, lastErr: "" };
  window.__mcTipsReader = { alive: () => alive && !!chrome.runtime?.id };
  const low = (s) => String(s || "").trim().toLowerCase();
  const q = (root, sels) => { for (const s of sels) { try { const el = root.querySelector(s); if (el) return el; } catch (e) {} } return null; };

  async function loadCfg() {
    const { settings } = await chrome.storage.local.get("settings");
    const t = settings?.tips || {};
    cfg = { on: t.on !== false, autoOpen: t.autoOpen !== false,
            groups: String(t.groups || "").split(/\n|,/).map(low).filter(Boolean) };
  }
  chrome.storage.onChanged.addListener((ch) => { if (ch.settings) loadCfg().catch(() => {}); });
  // remember when YOU last used this tab, so the reader never switches chats under your hands
  ["keydown", "mousedown"].forEach(ev => document.addEventListener(ev, (e) => { if (e.isTrusted) lastUser = Date.now(); }, true));

  const watched = (name) => { const n = low(name); return !!n && cfg.groups.some(g => n === g || n.includes(g)); };

  // the open conversation (right-hand side) and the chat list (left-hand side), found in more than one way
  const mainPane = () => q(document, ["#main", "[data-testid='conversation-panel-wrapper']", "div[role='main']"])
    || document.querySelector("footer [contenteditable='true']")?.closest("footer")?.parentElement || null;
  const listPane = () => q(document, ["#pane-side", "[data-testid='chat-list']", "[aria-label='Chat list']", "div[role='grid']"]);

  function currentChat(main) {
    const h = main?.querySelector("header"); if (!h) return "";
    const texts = [...h.querySelectorAll("span, div[role='button']")].map(el => (el.getAttribute("title") || (el.children.length ? "" : el.textContent) || "").trim()).filter(Boolean);
    return texts.find(watched) || texts[0] || (h.innerText || "").split("\n")[0].trim();
  }

  const hash = (s) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return "h" + (h >>> 0).toString(36); };

  function messageRows(main) {
    let rows = [...main.querySelectorAll("[data-id]")];
    if (!rows.length) rows = [...main.querySelectorAll("div.message-in, div.message-out")];
    if (!rows.length) rows = [...main.querySelectorAll("[role='row']")];
    return rows;
  }

  function messageText(row) {
    // the message's own text sits inside the block that carries the sender and time; a quoted reply above it is skipped
    const box = row.querySelector("[data-pre-plain-text]") || row;
    const el = [...box.querySelectorAll("span.selectable-text, [data-testid='selectable-text'], [class*='selectable-text']")]
      .find(e => !e.closest("[class*='quoted'], [data-testid*='quoted'], [aria-label*='Quoted' i]")) || q(box, [".copyable-text span[dir]"]);
    let text = (el?.innerText || "").trim();
    if (!text) {       // last resort: the longest piece of text in the bubble
      for (const s of row.querySelectorAll("span[dir='ltr'], span[dir='auto'], span[dir='rtl']")) { const t = (s.innerText || "").trim(); if (t.length > text.length) text = t; }
    }
    return text;
  }

  function collect(main) {
    const msgs = []; const rows = messageRows(main);
    diag.rows = rows.length; diag.withText = 0; diag.outgoing = 0;
    for (const row of rows) {
      const did = row.getAttribute("data-id") || row.closest("[data-id]")?.getAttribute("data-id") || "";
      const out = did.startsWith("true_") || row.matches(".message-out") ||
        !!row.querySelector(".message-out, [data-icon='tail-out'], [data-icon='msg-check'], [data-icon='msg-dblcheck'], [data-icon='msg-time']");
      if (out) { diag.outgoing++; continue; }                                  // sent by you
      // long messages are cut with "Read more": expand, and read on the next pass
      const more = [...row.querySelectorAll("[role='button']")].find(b => /^read more$/i.test((b.textContent || "").trim()));
      const key = did || "x";
      if (more && did && (expandTries.get(key) || 0) < 2) { expandTries.set(key, (expandTries.get(key) || 0) + 1); more.click(); continue; }
      const text = messageText(row);
      if (!text) continue;                                                     // photo, sticker, or still loading
      diag.withText++;
      const pre = row.querySelector("[data-pre-plain-text]")?.getAttribute("data-pre-plain-text") || "";
      const id = did || hash(pre + "|" + text);
      if (sent.has(id)) continue;
      const pm = pre.match(/^\[(.*?)\]\s*(.*?):\s*$/);
      msgs.push({ id, text, time: pm ? pm[1] : "", sender: pm ? pm[2] : "" });
    }
    return msgs;
  }

  function scanList(current) {
    const found = new Set(); let toOpen = null; const list = listPane();
    const titles = list ? [...list.querySelectorAll("span[title]")] : [];
    diag.listTitles = titles.length;
    for (const t of titles) {
      const title = t.getAttribute("title"); if (!watched(title)) continue;
      found.add(title);
      if (low(title) === low(current)) continue;
      const row = t.closest("[role='listitem'], [role='row']") || t.parentElement?.parentElement?.parentElement;
      if (!toOpen && row?.querySelector("[aria-label*='unread' i]")) toOpen = t;
    }
    return { found: [...found], toOpen, titles };
  }

  function openChat(el) {
    for (const type of ["mousedown", "mouseup", "click"])
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
  }

  async function tick() {
    if (!alive || busy) return; busy = true;
    try {
      if (!chrome.runtime?.id) { alive = false; return; }                // extension was reloaded: this copy stops
      diag.ticks++;
      if (!cfg) await loadCfg();
      const main = mainPane(), list = listPane();
      const current = currentChat(main);
      const isWatched = watched(current);
      Object.assign(diag, { hasMain: !!main, hasList: !!list, header: current.slice(0, 40), watchedOpen: isWatched, on: cfg.on, groups: cfg.groups });
      let found = [];
      if (cfg.on && cfg.groups.length) {
        if (main && isWatched) {
          const msgs = collect(main);
          if (msgs.length) {
            const r = await chrome.runtime.sendMessage({ type: "waMessages", group: current, msgs });
            diag.lastSend = { t: Date.now(), n: msgs.length, ok: !!r?.ok, added: r?.added ?? null, err: r?.error || "" };
            if (r?.ok) { msgs.forEach(m => sent.add(m.id)); diag.sentTotal += msgs.length; diag.tipsAdded += r.added || 0; }
          }
        }
        const s = scanList(current); found = s.found;
        const idle = document.visibilityState !== "visible" || Date.now() - lastUser > 60000;
        if (sweep.length && Date.now() - sweepT > 5 * 60000) sweep = [];             // give up a round that could not finish
        if (cfg.autoOpen && s.toOpen && idle && Date.now() - lastOpen > 15000) { lastOpen = Date.now(); openChat(s.toOpen); }
        else if (cfg.autoOpen && sweep.length && idle && Date.now() - lastOpen > 8000) {
          // 15-minute round: visit each watched group in turn so nothing is missed
          const next = sweep.shift();
          const el = low(next) === low(current) ? null : s.titles.find(t => t.getAttribute("title") === next);
          if (el) { lastOpen = Date.now(); openChat(el); }
        }
      }
      if (Date.now() - lastBeat > 15000) {
        lastBeat = Date.now();
        if (isWatched && !found.some(f => low(f) === low(current))) found.push(current);
        const missing = cfg.groups.filter(g => !found.some(f => low(f).includes(g)));
        await chrome.storage.local.set({ waStatus: { t: Date.now(), ready: !!(main || list), chat: current, found, missing, diag } });
      }
    } catch (e) {
      diag.lastErr = String(e?.message || e).slice(0, 200);
      if (/context invalidated/i.test(String(e))) alive = false;        // extension was reloaded: this copy stops
    } finally { busy = false; }
  }
  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg?.type === "waPing") { reply({ ok: true, v: VERSION }); return; }
    if (msg?.type !== "waSweep") return;
    sweep = cfg?.on && cfg.autoOpen ? scanList("").found : []; sweepT = Date.now();
    reply({ ok: true, groups: sweep.length });
  });
  setInterval(tick, 5000);
  tick();
})();
