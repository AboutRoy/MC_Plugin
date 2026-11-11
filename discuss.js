// ---------- Stock discussions: which stocks were talked about, in any message ----------
// A message does not have to be a buy/sell call. Every message that names a stock is filed under that stock,
// so the Daily summary can show one discussion per stock.
// How a stock is recognised (fixed rules, no AI):
//   1. stocks already on your dashboard, in earlier tips, or recognised before
//   2. index names (Nifty, Bank Nifty, Sensex)
//   3. words written like a name (Capitalised or ALL CAPS) or in a short list of popular stock names,
//      checked once against Moneycontrol's own search and then remembered
// Uses helpers from background.js / tipsbg.js: mcSearch, pickId, norm, tipSq.

const DISC_STOP = new Set(("the a an and or but if then else for from with without into onto over under about above below after before again " +
  "this that these those there here what which who whom whose when where why how all any both each few more most other some such only own same " +
  "than too very can will just should would could may might must shall not no nor yes yeah yep ok okay fine sure thanks thank please sorry welcome " +
  "you your yours they them their theirs she her hers him his its our ours mine myself yourself " +
  "have has had having does did doing done been being were was are is am get got gets getting give gave given take took taken make made " +
  "see saw seen look looks looking watch wait waiting keep kept let lets think thought know knew known feel felt say said says tell told ask asked " +
  "want wanted need needed like liked love loved hope hoping try tried use used work worked works working come came coming going gone went " +
  "good great nice best better bad worse worst big small huge high higher low lower new old next last first second third final early late " +
  "today tomorrow yesterday tonight morning evening night noon week weeks month months year years day days time times hour hours minute minutes " +
  "monday tuesday wednesday thursday friday saturday sunday jan feb mar apr may jun jul aug sep sept oct nov dec " +
  "january february march april june july august september october november december " +
  "guys friends bhai sir madam dear bro brother boss team group admin members member everyone anybody anyone someone nobody people " +
  "happy diwali holi eid christmas birthday anniversary festival wishes hello hi hey gm good morning namaste congrats congratulations wow super awesome magic almost always also still even ever never maybe really " +
  "india indian bharat mumbai delhi bangalore bengaluru chennai kolkata hyderabad pune gujarat china japan usa america europe dubai " +
  "market markets stock stocks share shares scrip equity equities trade trades trading trader traders invest investing investor investors investment " +
  "buy buying bought sell selling sold exit exited hold holding holdings add added adding accumulate long short call calls put puts option options " +
  "future futures fut intraday btst stbt swing positional delivery cash target targets tgt stoploss stop loss entry price prices level levels zone " +
  "cmp ltp nav exp ipo sip fii dii fpi gdp rbi sebi nse bse usd inr eps ath atl pnl mtf fno roe roce ebitda pat yoy qoq agm egm ofs qip gmp " +
  "nifty sensex banknifty finnifty midcap smallcap largecap microcap index indices sector sectors fund funds mutual etf etfs bond bonds " +
  "gold silver crude oil copper dollar rupee rupees crypto bitcoin " +
  "bank banks banking finance financial pharma auto autos metal metals power energy steel cement infra realty defence defense railway railways " +
  "chemical chemicals textile textiles sugar paper media telecom tech technology software capital goods consumer fmcg psu private public " +
  "results result earnings quarter quarterly numbers profit profits loss losses revenue sales growth margin margins debt dividend bonus split buyback " +
  "news order orders deal update updates alert report reports chart charts support resistance breakout breakdown trend volume volumes circuit " +
  "bull bulls bullish bear bears bearish rally crash correction dip dips fall falling rise rising down side upside downside green red " +
  "lakh lakhs crore crores cr thousand hundred percent points point lot lots qty quantity avg average " +
  "whatsapp telegram twitter youtube google video photo image link message messages forwarded deleted missed voice " +
  "stuck trapped tat board global limited ltd company corp industries enterprise enterprises group holdings services solutions international " +
  "one two three four five six seven eight nine ten zero half double triple once twice " +
  "read more less much many lot lots bit little part full whole open close closed opening closing start started end ended " +
  "above around near between range across till until since while during because though although however otherwise instead already soon later now").split(/\s+/));

// popular names that count even when typed in small letters ("stuck with laurus")
const DISC_SEED = new Set(("laurus reliance infosys infy tcs hdfc icici sbi sbin itc wipro zomato eternal paytm nykaa suzlon irfc ireda rvnl irctc hal bel bhel ntpc " +
  "ongc vedanta hindalco jsw sail maruti bharti airtel jio lic dmart titan trent pidilite dixon polycab kaynes cdsl mcx cams groww swiggy ather hyundai " +
  "waaree inox syngene kotak axis indusind idfc pnb canara vodafone idea tatamotors tatasteel tatapower adanient adaniports adanipower bajfinance " +
  "hcl hcltech techm ltim lti persistent coforge mphasis kpit tataelxsi cipla lupin sunpharma drreddy divis biocon glenmark zydus mankind " +
  "ultratech ambuja shree grasim nestle britannia dabur marico colgate hul hindunilever asianpaint berger havells voltas bluestar crompton " +
  "eicher heromoto tvs ashokley bosch mrf apollo ceat balkrishna bhartiforge escorts coalindia nmdc gail ioc bpcl hpcl oil petronet igl mgl " +
  "indigo spicejet delhivery nazara policybazaar pbfintech cartrade mapmyindia happiest tanla route affle indiamart naukri justdial " +
  "yesbank federalbank bandhan aubank rbl iob uco ucobank unionbank bankofbaroda bob muthoot manappuram chola shriram pfc rec hudco nbcc ncc " +
  "lt larsen siemens abb cgpower cummins thermax bharatforge mazagon cochin grse bdl beml data astra zen paras ideaforge tejas hfcl railtel ircon " +
  "jswsteel tatachem deepak aarti srf navin pi upl coromandel chambal gnfc gsfc rcf fact olectra jbm exide amararaja servotech kpi borosil " +
  "angelone motilal iifl edelweiss jiofin jiofinancial cdsl bajajhousing bajajauto bajajfinserv premierenergies ola olaelectric lenskart meesho").split(/\s+/));

const DISC_GROUPS = { tata: "Tata group (stock not named)", adani: "Adani group (stock not named)", bajaj: "Bajaj group (stock not named)",
  birla: "Birla group (stock not named)", jindal: "Jindal group (stock not named)", godrej: "Godrej group (stock not named)" };

const DISC_INDEX = [
  { key: "IDX_BANKNIFTY", label: "Bank Nifty", scid: "", url: "", re: /\bbank\s*nifty\b/i },
  { key: "IDX_NIFTY", label: "Nifty 50", scid: "", url: "", re: /\bnifty(?:\s*50)?\b/i },
  { key: "IDX_SENSEX", label: "Sensex", scid: "", url: "", re: /\bsensex\b/i }
];

const discEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const discRe = (names) => new RegExp("\\b(?:" + names.map(discEsc).join("|") + ")\\b", "i");
const discNames = (list) => {
  const names = list.filter(Boolean).map(n => String(n).replace(/\b(ltd|limited)\.?$/i, "").trim()).filter(n => n.length >= 3);
  const first = names.map(n => n.split(/\s+/)[0]).filter(w => w.length >= 5 && !DISC_STOP.has(w.toLowerCase()) && !DISC_GROUPS[w.toLowerCase()]);
  return [...new Set([...names, ...first])];
};

// Everything already known, built once per batch of messages.
function discContext(stocks, quotes, tips, saved) {
  const known = [], have = new Set();
  const push = (key, label, scid, url, names) => { if (!key || have.has(key) || !names.length) return; have.add(key); known.push({ key, label, scid, url, re: discRe(names) }); };
  for (const s of stocks) push(s.scid, s.displayName || quotes[s.id]?.name || s.name, s.scid, s.url || "", discNames([s.displayName, quotes[s.id]?.name, s.name, quotes[s.id]?.short]));
  for (const t of tips) if (t.matched && t.scid) push(t.scid, t.label, t.scid, t.url || "", discNames([t.label]));
  const cache = saved.stockCache || {};
  const byScid = {};
  for (const [alias, c] of Object.entries(cache)) if (c && c.scid) (byScid[c.scid] || (byScid[c.scid] = { c, aliases: [] })).aliases.push(alias);
  for (const { c, aliases } of Object.values(byScid)) push(c.scid, c.label, c.scid, c.url, aliases);
  return { known, cache, ignore: new Set(saved.stockIgnore || []), people: new Set(saved.tipPeople || []), budget: 15 };
}

async function discLookup(alias, caps, ctx) {
  if (ctx.ignore.has("a:" + alias)) return null;
  if (DISC_GROUPS[alias]) return { key: "GRP_" + alias, label: DISC_GROUPS[alias], scid: "", url: "" };
  const c = ctx.cache[alias];
  if (c && (c.scid || Date.now() - c.t < 7 * 864e5)) return c.scid ? { key: c.scid, label: c.label, scid: c.scid, url: c.url } : null;
  if (ctx.budget <= 0) return null;
  ctx.budget--;
  let hits = [];
  try { hits = await mcSearch(alias); } catch (e) { return null; }
  const a = tipSq(alias), slug = (h) => norm(h.link_src).split("/").slice(-2, -1)[0] || "";
  let hit = hits.find(h => h?.link_src && slug(h) === a) || (a.length >= 4 ? hits.find(h => h?.link_src && slug(h).startsWith(a)) : null);
  if (!hit && caps) {       // a ticker such as SBIN or TCS: must appear as a whole word in the search result
    const re = new RegExp("\\b" + discEsc(alias.toUpperCase()) + "\\b");
    hit = hits.find(h => h?.link_src && re.test(JSON.stringify(h).replace(/<[^>]+>/g, " ")));
  }
  if (!hit) { ctx.cache[alias] = { t: Date.now() }; return null; }
  const id = pickId(hit);
  if (!id.scid) { ctx.cache[alias] = { t: Date.now() }; return null; }
  ctx.cache[alias] = { t: Date.now(), scid: id.scid, label: id.name || alias, url: hit.link_src };
  return { key: id.scid, label: id.name || alias, scid: id.scid, url: hit.link_src };
}

// Returns the stocks (and indices) a message talks about.
async function detectStocks(text, ctx) {
  const found = new Map();
  const add = (k) => { if (k && !ctx.ignore.has(k.key) && !found.has(k.key)) found.set(k.key, { key: k.key, label: k.label, scid: k.scid, url: k.url }); };
  let T = String(text || "").slice(0, 1500);
  for (const ix of DISC_INDEX) if (ix.re.test(T)) { add(ix); T = T.replace(new RegExp(ix.re.source, "gi"), " "); }
  for (const k of ctx.known) if (k.re.test(T)) { add(k); T = T.replace(new RegExp(k.re.source, "gi"), " "); }

  const toks = []; const re = /@?[A-Za-z][A-Za-z&]*/g; let m;
  while ((m = re.exec(T))) {
    if (m[0][0] === "@") continue;                                   // a person being tagged
    const before = T.slice(0, m.index).trimEnd();
    toks.push({ w: m[0], i: m.index, start: !before || /[.!?\n:]$/.test(before) });
  }
  for (let i = 0; i < toks.length; i++) {
    const { w, start } = toks[i], lw = w.toLowerCase();
    if (lw.length < 3 || DISC_STOP.has(lw) || ctx.people.has(lw)) continue;
    const caps = w === w.toUpperCase(), named = /^[A-Z][a-z]/.test(w) && w.length >= 4 && !start, seed = DISC_SEED.has(lw) || !!DISC_GROUPS[lw];
    if (!(caps || named || seed)) continue;
    const nx = toks[i + 1];
    const pair = nx && nx.i === toks[i].i + w.length + 1 && nx.w.length >= 3 && !ctx.people.has(nx.w.toLowerCase()) &&
      (/^[A-Z]/.test(nx.w) || seed) && (!DISC_STOP.has(nx.w.toLowerCase()) || /^(bank|power|steel|motors|finance|auto|pharma|chemicals|industries|india|energy|capital|enterprises|ports|paints|consumer|cement|tech|technologies|labs|international|global|green)$/i.test(nx.w));
    let r = null;
    if (pair) { r = await discLookup(lw + " " + nx.w.toLowerCase(), false, ctx); if (r) i++; }
    if (!r) r = await discLookup(lw, caps, ctx);
    add(r);
  }
  return [...found.values()];
}

function noteDiscussion(dl, group, m, found, kind) {
  dl.disc = dl.disc || {};
  for (const k of found) {
    const e = dl.disc[k.key] || (dl.disc[k.key] = { key: k.key, label: k.label, scid: k.scid || "", url: k.url || "", msgs: [] });
    if (e.msgs.length < 40) e.msgs.push({ t: Date.now(), group, sender: m.sender || "", text: String(m.text).slice(0, 320), kind });
  }
}

// "Not a stock": forget it and never pick it up again.
async function discIgnore(key) {
  const { dayLog = {}, stockIgnore = [], stockCache = {} } = await get(["dayLog", "stockIgnore", "stockCache"]);
  const ig = new Set(stockIgnore); ig.add(key);
  for (const [alias, c] of Object.entries(stockCache)) if (c?.scid === key) { ig.add("a:" + alias); delete stockCache[alias]; }
  if (key.startsWith("GRP_")) ig.add("a:" + key.slice(4));
  for (const d of Object.values(dayLog)) if (d.disc) delete d.disc[key];
  await set({ dayLog, stockIgnore: [...ig].slice(-500), stockCache });
}

// Optional: a written summary of one stock's discussion by Claude, using the API key from Settings (paid, only when you click).
async function discAi(day, key) {
  const settings = await getSettings(); const ai = settings.ai || {};
  if (!ai.key) throw new Error("Add a Claude API key in ⚙ Settings to use AI summaries.");
  const { dayLog = {} } = await get("dayLog");
  const e = dayLog[day]?.disc?.[key]; if (!e) throw new Error("Discussion not found.");
  const chat = e.msgs.map(x => `${x.sender || "Someone"}: ${x.text}`).join("\n");
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": ai.key.trim(), "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
    body: JSON.stringify({ model: ai.model || "claude-sonnet-5-5", max_tokens: 400,
      system: "You summarise a WhatsApp group discussion about one Indian stock for a retail investor. Reply with 2 to 4 short plain sentences: what people said, the overall mood, any price levels or reasons given, and any disagreement. Report only what the messages say. Do not add facts, do not give advice or a recommendation.",
      messages: [{ role: "user", content: `Stock: ${e.label}\nMessages:\n${chat}` }] })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error?.message || `Claude API error ${r.status}`);
  const text = (j.content || []).filter(c => c.type === "text").map(c => c.text).join(" ").trim();
  await inQueue(async () => {
    const { dayLog: dl = {} } = await get("dayLog");
    if (dl[day]?.disc?.[key]) { dl[day].disc[key].ai = { t: Date.now(), text }; await set({ dayLog: dl }); }
  });
  return { text };
}
