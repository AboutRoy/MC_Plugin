// ---------- WhatsApp tips: daily summary (shared by the background worker and the dashboard) ----------
(function (root) {
  const tipDayOf = (ts) => new Date(ts + 330 * 60000).toISOString().slice(0, 10);   // date in IST
  const money = (v) => "₹" + Number(v).toLocaleString("en-IN", { maximumFractionDigits: 2 });
  const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

  // ----- one discussion per stock -----
  const POS = /\b(buy|buying|bought|add(?:ed|ing)?|accumulat\w*|long|breakout|strong|bullish|rally|upside|multibagger|profit\w*|gain\w*|upper circuit|good (?:results|numbers)|beat|outperform\w*|recover\w*|bounc\w*|jump\w*|soar\w*|target (?:hit|done|achieved))\b|\d+\s?x\b|🚀|📈|🔥|💰/gi;
  const NEG = /\b(sell|selling|sold|exit\w*|short|weak|bearish|fall\w*|fell|crash\w*|stuck|trapped|loss\w*|avoid|breakdown|lower circuit|bad (?:results|numbers)|miss\w*|dump\w*|correction|panic|worried|stop ?loss hit|sl hit)\b|📉|😭|😢|🩸/gi;
  const THEMES = [
    ["results", /\b(results?|earnings|q[1-4]|quarter\w*|numbers|revenue|margins?)\b/i],
    ["price levels", /\b(target|tgt|support|resistance|sl|stop ?loss|breakout|breakdown|levels?)\b/i],
    ["buying", /\b(buy|buying|bought|add(?:ed|ing)?|accumulat\w*|entry)\b/i],
    ["selling or exiting", /\b(sell|selling|sold|exit\w*|book(?:ed|ing)? profits?)\b/i],
    ["being stuck or in loss", /\b(stuck|trapped|loss\w*|averag\w*)\b/i],
    ["holding", /\b(hold\w*)\b/i],
    ["news or deals", /\b(news|orders?|deal|contract|acquisition|merger|approval|usfda|block deal|stake)\b/i],
    ["dividend, bonus or split", /\b(dividend|bonus|split|buyback|rights issue)\b/i],
    ["IPO or listing", /\b(ipo|listing|gmp)\b/i]
  ];
  const hhmm = (t) => new Date(t + 330 * 60000).toISOString().slice(11, 16);

  // Summarises, for one day, what was said about each stock.
  function buildStockDiscussions(day, dayLog) {
    const disc = ((dayLog || {})[day] || {}).disc || {};
    return Object.values(disc).filter(e => e.msgs && e.msgs.length).map(e => {
      const all = e.msgs.map(m => m.text).join("\n");
      const pos = (all.match(POS) || []).length, neg = (all.match(NEG) || []).length;
      const tone = pos && neg ? (pos >= neg * 2 ? "mostly positive" : neg >= pos * 2 ? "mostly negative" : "mixed") : pos ? "positive" : neg ? "negative" : "neutral";
      const people = [...new Set(e.msgs.map(m => m.sender).filter(Boolean))];
      const groups = [...new Set(e.msgs.map(m => m.group))];
      const themes = THEMES.filter(([, re]) => re.test(all)).map(([name]) => name);
      const levels = [...new Set((all.match(/(?<![\d:.,\/-])\d{2,6}(?:\.\d+)?(?![\d:%\/-]|\s*(?:am|pm|x|k|cr|crores?|lakhs?|days?|weeks?|months?|years?|yrs?|nov|dec|jan|feb|mar|apr|may|jun|jul|aug|sep|oct)\b)/gi) || [])
        .map(Number).filter(v => v >= 10))].slice(0, 5);
      const calls = e.msgs.filter(m => m.kind === "call").length;
      const n = e.msgs.length, first = e.msgs[0].t, last = e.msgs[n - 1].t;
      const parts = [`${plural(n, "message")}${people.length ? " from " + plural(people.length, "person").replace("persons", "people") : ""}, ${hhmm(first)}${n > 1 && hhmm(last) !== hhmm(first) ? "–" + hhmm(last) : ""}${groups.length > 1 ? ", in " + plural(groups.length, "group") : ""}.`];
      parts.push(`Tone: ${tone}.`);
      if (themes.length) parts.push(`About: ${themes.join(", ")}.`);
      if (levels.length) parts.push(`Numbers mentioned: ${levels.join(", ")}.`);
      if (calls) parts.push(`${plural(calls, "buy/sell call")} with levels.`);
      return { ...e, n, people, groups, tone, pos, neg, themes, levels, calls, first, last, text: parts.join(" ") };
    }).sort((a, b) => b.n - a.n || b.last - a.last);
  }

  // Everything that happened on one day (YYYY-MM-DD, IST).
  function buildDaySummary(day, tips, dayLog) {
    const log = (dayLog || {})[day] || {};
    const groups = Object.entries(log.groups || {}).map(([name, g]) => ({ name, msgs: g.msgs || 0, tips: g.tips || 0 })).sort((a, b) => b.msgs - a.msgs);
    const msgs = groups.reduce((a, g) => a + g.msgs, 0);
    const live = (tips || []).filter(t => t.status !== "dismissed");
    const newTips = live.filter(t => tipDayOf(t.t) === day);
    const buys = newTips.filter(t => t.action === "BUY").length, sells = newTips.length - buys;
    const targetHits = [];
    for (const t of live) for (const level of t.hits || []) {
      const when = (t.hitT || {})[level] || (t.status === "target" ? t.closedT : null);
      if (when && tipDayOf(when) === day) targetHits.push({ tip: t, level, t: when });
    }
    const stops = live.filter(t => t.status === "stopped" && t.closedT && tipDayOf(t.closedT) === day);
    const exits = live.filter(t => t.exitCalled && tipDayOf(t.exitCalled) === day);
    const mentions = log.mentions || [];
    const disc = buildStockDiscussions(day, dayLog);
    const count = {};
    newTips.forEach(t => { count[t.label] = (count[t.label] || 0) + 1; });
    mentions.forEach(m => { count[m.stock] = (count[m.stock] || 0) + 1; });
    const top = Object.entries(count).map(([label, n]) => ({ label, n })).sort((a, b) => b.n - a.n).slice(0, 8);

    const lines = [];
    if (!msgs && !newTips.length && !targetHits.length && !stops.length && !exits.length && !disc.length) lines.push("Nothing was read from your groups on this day.");
    else {
      lines.push(`${plural(msgs, "message")} read from ${plural(groups.length, "group")}. ${plural(newTips.length, "stock call")} found${newTips.length ? ` (${buys} buy, ${sells} sell)` : ""}.`);
      if (disc.length) lines.push("Stocks discussed: " + disc.slice(0, 8).map(d => `${d.label} (${d.n}, ${d.tone})`).join("; ") + (disc.length > 8 ? `; and ${disc.length - 8} more` : "") + ".");
      else if (msgs) lines.push("No stock was named in the messages read.");
      if (newTips.length) lines.push("New calls: " + newTips.slice(0, 6).map(t => `${t.action} ${t.label}` +
        (t.targets?.length || t.stopLoss ? ` (${[t.targets?.length ? "target " + money(t.targets[0]) : "", t.stopLoss ? "stop-loss " + money(t.stopLoss) : ""].filter(Boolean).join(", ")})` : "")).join("; ") +
        (newTips.length > 6 ? `; and ${newTips.length - 6} more` : "") + ".");
      if (targetHits.length) lines.push("Target reached: " + targetHits.map(h => `${h.tip.label} at ${money(h.level)}`).join("; ") + ".");
      if (stops.length) lines.push("Stop-loss hit: " + stops.map(t => `${t.label} at ${money(t.stopLoss)}`).join("; ") + ".");
      if (exits.length) lines.push("Exit called in the group: " + exits.map(t => t.label).join("; ") + ".");
      if (!targetHits.length && !stops.length && !exits.length) lines.push("No earlier tip reached its target or stop-loss.");
    }
    return { day, msgs, groups, newTips, buys, sells, targetHits, stops, exits, mentions, top, disc, lines,
             active: !!(msgs || newTips.length || targetHits.length || stops.length || exits.length) };
  }

  // How each person's past buy calls have done so far.
  function tipTrackRecord(tips) {
    const by = {};
    for (const t of tips || []) {
      if (t.action !== "BUY" || !t.matched || t.status === "dismissed") continue;
      const k = `${t.group} · ${t.sender || "unknown"}`;
      const r = by[k] || (by[k] = { who: k, n: 0, target: 0, stopped: 0, open: 0, sum: 0, priced: 0 });
      r.n++;
      if (t.status === "stopped") r.stopped++; else if ((t.hits || []).length) r.target++; else if (t.status === "open") r.open++;
      const base = t.entry || t.priceAtTip;
      if (base && t.last) { r.sum += (t.last / base - 1) * 100; r.priced++; }
    }
    return Object.values(by).map(r => ({ ...r, avg: r.priced ? r.sum / r.priced : null })).sort((a, b) => b.n - a.n).slice(0, 10);
  }

  root.tipDayOf = tipDayOf; root.buildDaySummary = buildDaySummary; root.buildStockDiscussions = buildStockDiscussions; root.tipTrackRecord = tipTrackRecord;
})(typeof self !== "undefined" ? self : globalThis);
