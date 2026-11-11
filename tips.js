// ---------- WhatsApp tips: turns a chat message into a structured stock tip ----------
// Used by the background worker. parseTip(text) returns null for ordinary chatter.
(function (root) {
  const NUM = "\\d+(?:\\.\\d+)?";
  // a number that is a price, not a time / percentage / duration
  const PRICE = `(${NUM})(?![\\d.]|\\s*(?::\\d|AM\\b|PM\\b|%|DAYS?\\b|WEEKS?\\b|MONTHS?\\b|YEARS?\\b|YRS?\\b|LOTS?\\b|QTY\\b|SHARES?\\b))`;
  const STOP = new Set(("ABOVE BELOW AT AROUND NEAR CMP LTP TARGET TARGETS TGT TGTS TG TP SL STOPLOSS STOP LOSS FOR IN RANGE BETWEEN " +
    "FUT FUTURE FUTURES CE PE NOW TODAY TOMORROW ON WITH PRICE BUY BUYING BOUGHT SELL SELLING ENTRY EXIT ADD ACCUMULATE LONG SHORT CALL CALLS " +
    "INTRADAY BTST STBT SWING POSITIONAL DELIVERY CASH EQ EQUITY STOCK STOCKS SHARE SHARES SCRIP AND OR THE A AN IS ARE OF TO FROM RS INR " +
    "LEVEL LEVELS ZONE DIPS DIP ONLY STRICT HOLD HOLDING BOOK PROFIT PROFITS PARTIAL ALERT UPDATE NEW TIP TIPS RECOMMENDATION JACKPOT SURE SHOT " +
    "TRADE IDEA PICK MULTIBAGGER THIS THAT IT MY OUR YOUR WE I YOU ALL ANY SOME MORE QTY QUANTITY LOT LOTS MARKET OPEN CLOSE HIGH LOW TIME TERM " +
    "GOOD MORNING EVENING HI HELLO DEAR FRIENDS MEMBERS GUYS PLEASE KINDLY NOTE DAY WEEK MONTH YEAR NAME COMPANY SYMBOL IF WILL CAN MAY " +
    "ACHIEVED DONE HIT REACHED NEAR STRONG WEAK BULLISH BEARISH BREAKOUT MOMENTUM LOOKS LOOKING LOOK SEEMS HAS HAVE WAS GIVEN GAVE").split(" "));
  const LEAD = new Set("CALL CALLS STOCK STOCKS SHARE SHARES ALERT NOW TODAY IN ON THE INTRADAY BTST STBT SWING POSITIONAL DELIVERY CASH EQ EQUITY SOME MORE NEW TIP TRADE IDEA PICK FOR".split(" "));
  const INDEX = /\b(NIFTY|BANKNIFTY|BANK NIFTY|FINNIFTY|MIDCPNIFTY|SENSEX|BANKEX)\b/;

  function clean(text) {
    return String(text || "").slice(0, 1500)
      .replace(/₹/g, " RS ").replace(/[   ]/g, " ")
      .replace(/[*_~`]/g, " ")
      .replace(/[^\x20-\x7E\n]/g, " ")          // emojis and other symbols
      .toUpperCase()
      .replace(/(\d),(?=\d{2,3}\b)/g, "$1")      // 1,250 -> 1250
      .replace(/(?:\bRS\.?|\bINR)\s*(?=\d)/g, "")
      .replace(/(\d)\s*\/-/g, "$1 ")
      .replace(/[ \t]+/g, " ");
  }

  function nameFrom(str) {
    const toks = String(str || "").replace(/^[^A-Z0-9#$]+/, "").split(/\s+/);
    const out = []; let i = 0;
    while (i < toks.length && i < 4 && LEAD.has(toks[i].replace(/[^A-Z]/g, ""))) i++;
    for (; i < toks.length && out.length < 4; i++) {
      const raw = toks[i].replace(/^[#$(\[]+/, ""), t = raw.replace(/[^A-Z0-9&]+$/, "");
      if (!/^[A-Z][A-Z0-9&.\-']*$/.test(t) || STOP.has(t)) break;
      out.push(t);
      if (/[:,;()@=]$/.test(raw)) break;
    }
    const name = out.join(" ");
    return name.replace(/[^A-Z]/g, "").length >= 2 ? name : "";
  }

  function parseTip(text) {
    let U = clean(text);
    if (U.replace(/\s/g, "").length < 6) return null;
    // "target 1 achieved" is an update, not a price level
    U = U.replace(/\b(?:TARGETS?|TGTS?|TG|TP|T)\s*[1-5]?\s*(?:IS\s+|HAS\s+BEEN\s+)?(?:ACHIEVED|DONE|HIT|REACHED|COMPLETED)\b/g, " ");
    // "TARGET 1: 165", "T1 165", "TGT2-172" -> "TARGET 165"
    U = U.replace(/\b(?:TARGETS?|TGTS?|TG|TP|T)\s*-?\s*([1-5])\s*[:=\-]\s*(?=\d)/g, "TARGET ")
         .replace(/\b(?:TARGET|TGT|TG|TP|T)([1-5])\b\s*[:=\-@]?\s*(?=\d)/g, "TARGET ");

    // --- targets ---
    const SEP = `(?:\\s*(?:[\\/,&+\\-]|AND|TO|THEN)\\s*|\\s+)`;
    const TR = new RegExp(`\\b(?:TARGETS?|TGTS?|TG|TP)\\b\\s*(?:PRICE\\s*)?(?:(?:OF|IS|AT|WILL BE|[:=\\-@>])\\s*)*((?:${PRICE})(?:${SEP}${PRICE})*)`, "g");
    const targets = []; let m, targetPct = null;
    while ((m = TR.exec(U))) (m[1].match(new RegExp(NUM, "g")) || []).forEach(x => { const v = parseFloat(x); if (v > 0 && !targets.includes(v)) targets.push(v); });
    const tp = U.match(new RegExp(`\\b(?:TARGETS?|TGTS?|TG|TP)\\b[^0-9\\n]{0,12}(${NUM})\\s*%`));
    if (tp && !targets.length) targetPct = parseFloat(tp[1]);

    // --- stop-loss ---
    const SR = new RegExp(`\\b(?:STOP\\s*-?\\s*LOSS(?:ES)?|STOPLOSS|SL|S\\/L)\\b\\s*(?:PRICE\\s*)?(?:(?:OF|IS|AT|BELOW|ABOVE|WILL BE|ON CLOSING BASIS|CLOSING BASIS|[:=\\-@<>])\\s*)*${PRICE}`);
    const sm = U.match(SR); const stopLoss = sm ? parseFloat(sm[1]) : null;

    // --- entry price (looked for in the text with target / stop-loss parts removed) ---
    const U2 = U.replace(TR, " ~ ").replace(SR, " ~ ");
    const E1 = new RegExp(`(?:@|\\b(?:AT|ABOVE|BELOW|AROUND|NEAR|CMP|LTP|BETWEEN|RANGE|ZONE|LEVELS?)\\b|\\b(?:BUY|SELL|ENTRY)\\s*(?:PRICE|RANGE|ZONE|LEVEL)?\\s*[:=\\-])\\s*(?:(?:IS|OF|[:=\\-])\\s*)*${PRICE}(?:\\s*(?:-|TO|AND|\\/)\\s*${PRICE})?`);
    const E2 = new RegExp(`\\b(?:BUY|SELL|ACCUMULATE|LONG|SHORT|ENTRY)\\b[^0-9\\n~]{1,40}?${PRICE}(?:\\s*(?:-|TO)\\s*${PRICE})?`);
    const em = U2.match(E1) || U2.match(E2);
    let entry = em ? parseFloat(em[1]) : null, entryHigh = em && em[2] ? parseFloat(em[2]) : null;
    if (entry && entryHigh && entryHigh < entry) [entry, entryHigh] = [entryHigh, entry];

    // --- buy or sell ---
    // "bought", "sold", "long term" are remarks about the past or the horizon, not calls
    const bi = U.search(/\b(BUY|BUYING|ACCUMULATE|ADD|LONG(?!\s*-?\s*TERM))\b/);
    const si = U.search(/\b(SELL|SHORT(?!\s*-?\s*TERM)|EXIT|BOOK\s+(?:FULL\s+|PARTIAL\s+)?PROFITS?)\b/);
    let action = null;
    if (bi >= 0 && (si < 0 || bi < si)) action = "BUY"; else if (si >= 0) action = "SELL";
    const hasLevels = targets.length || targetPct || stopLoss;
    if (!action) {
      if (targets.length && stopLoss) action = targets[0] >= stopLoss ? "BUY" : "SELL";
      else if (targets.length && entry) action = targets[0] >= entry ? "BUY" : "SELL";
      else return null;
    } else if (!hasLevels) {
      // No target and no stop-loss: only a clear instruction counts ("Buy X at 950", "X book profits"),
      // not a remark or a question ("should I buy X at 950?", "I will buy at 900").
      const isExit = /\b(EXIT|BOOK\s+(?:FULL\s+|PARTIAL\s+)?PROFITS?)\b/.test(U);
      const lead = /(?:^|[.!?\n:,])\s*(?:[A-Z0-9&.#$-]+\s+){0,3}(?:BUY|SELL|ACCUMULATE|EXIT|BOOK\s+(?:FULL\s+|PARTIAL\s+)?PROFITS?)\b/.test(U);
      if (!lead || (!entry && !isExit)) return null;
      if (/\?/.test(U) || /\b(SHOULD|SHALL|CAN|COULD|ANYONE|ANYBODY|I|MY|WE|WILL|WOULD|PLANNING|THINKING|WAS|DID|HAD|IF)\b/.test(U)) return null;
    }

    // --- which stock ---
    const cands = []; const add = (s) => { const n = nameFrom(s); if (n && !cands.includes(n)) cands.push(n); };
    const lab = U.match(/\b(?:STOCK|SCRIP|SCRIPT|SHARE|SYMBOL|COMPANY)\s*(?:NAME)?\s*[:=\-]+\s*([^\n]+)/); if (lab) add(lab[1]);
    (U.match(/[#$][A-Z][A-Z0-9&]{1,20}/g) || []).forEach(h => add(h.slice(1)));
    const AR = /\b(?:BUY|BUYING|BOUGHT|SELL|SELLING|ACCUMULATE|LONG|SHORT|ADD|EXIT|BOOK\s+(?:FULL\s+|PARTIAL\s+)?PROFITS?)\b\s*(?:IN\s+)?[:=\-]*\s*([^\n]*)/g;
    while ((m = AR.exec(U))) add(m[1]);
    U.split("\n").forEach(line => add(line));
    if (!cands.length) return null;

    const derivative = /\b\d{2,6}\s*(?:CE|PE)\b|\bFUT(?:URES?)?\b|\b(?:CALL|PUT)\s+OPTIONS?\b|\bOPTIONS?\b/.test(U) || INDEX.test(U);
    const hz = U.match(/\b(INTRADAY|BTST|STBT|SWING|POSITIONAL|SHORT\s*TERM|LONG\s*TERM|MEDIUM\s*TERM|DELIVERY)\b/);
    const tf = U.match(/\b(\d+(?:\s*(?:-|TO)\s*\d+)?)\s*(DAYS?|WEEKS?|MONTHS?|YEARS?|YRS?)\b/);
    return { action, candidates: cands.slice(0, 6), entry, entryHigh, targets, targetPct, stopLoss, derivative,
      horizon: hz ? hz[1].replace(/\s+/g, " ").toLowerCase() : "", timeframe: tf ? `${tf[1]} ${tf[2]}`.toLowerCase() : "" };
  }

  // Splits pasted text (a WhatsApp chat export, or messages copied from WhatsApp) into separate messages.
  function splitPasted(text) {
    const lines = String(text || "").replace(/[  ‎‏]/g, " ").split(/\r?\n/);
    const A = /^\[?\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4},?\s+\d{1,2}[:.]\d{2}(?::\d{2})?\s*(?:[AaPp]\.?\s?[Mm]\.?)?\]?\s*(?:-\s*)?([^:]{1,40}):\s?(.*)$/;
    const B = /^\[\d{1,2}[:.]\d{2}\s*(?:[AaPp]\.?\s?[Mm]\.?)?,\s*[\d\/.\-]+\]\s*([^:]{1,40}):\s?(.*)$/;
    const msgs = []; let cur = null, structured = false;
    for (const line of lines) {
      const m = line.match(A) || line.match(B);
      if (m) { structured = true; cur = { sender: m[1].trim(), text: m[2] }; msgs.push(cur); }
      else if (cur) cur.text += "\n" + line;
      else if (line.trim()) { cur = { sender: "", text: line }; msgs.push(cur); }
    }
    const out = structured ? msgs : String(text || "").split(/\n\s*\n/).map(t => ({ sender: "", text: t }));
    return out.map(x => ({ ...x, text: x.text.trim() })).filter(x => x.text);
  }

  root.parseTip = parseTip; root.splitPasted = splitPasted;
})(typeof self !== "undefined" ? self : globalThis);
