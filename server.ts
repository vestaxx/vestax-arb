// VeSTAX ARBS. Books: Polymarket.us, Goated, Bet105, Bovada, Gemini. See prior version's header comments for full history (trimmed here for size).
// BET105 HEADLESS TEST (Oct 14 2026): one-shot probe via Browserless to see if Cloudflare still blocks a real headless browser.
import { SQL } from "bun";
import { PolymarketUS } from "polymarket-us";

const sql = new SQL({ url: Bun.env.DATABASE_URL!, max: 3, idleTimeout: 30 });
const KEY = Bun.env.ARB_KEY ?? "";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
const pm: any = new PolymarketUS({});
const GT = "https://apis.goated.com/sportsbook";
const FEE = 0.0695;
const PRE_WINDOW_MS = 72 * 3600e3;
const PRE_RECHECK_MS = 60000;
const PM_CATALOGUE_MS = 120000;
const NAME_TIME_TOL_MS = 3 * 3600e3;
const MAX_JOBS = 40;
const LIVE_CYCLE_MS = 3000;
const IDLE_CYCLE_MS = 8000;
const CRICKET_MAX_PM_COST = Number(Bun.env.CRICKET_MAX_PM_COST ?? 0.5);
const TENNIS_ON = Bun.env.ARB_TENNIS === "1";
// esports defaults ON (unlike tennis, which is opt-in) since it was explicitly requested; set
// ARB_ESPORTS_OFF=1 to disable if it turns out to misfire once real traffic is seen.
const ESPORTS_ON = Bun.env.ARB_ESPORTS_OFF !== "1";
const FEED_MAX_PCT = Number(Bun.env.ARB_FEED_MAX_PCT ?? 8);
const BVD_LIVE = Bun.env.BVD_LIVE === "1";
const GEM_OFF = Bun.env.GEMINI_OFF === "1";
const GEM_FEE = 0.07;
const START_TOL_MS = Number(Bun.env.ARB_START_TOL_MIN ?? 120) * 60000;
let logoCache: Uint8Array | null = null;

const BLOCKED = (Bun.env.ARB_BLOCKED_LEAGUES ?? "czechligapro,wtt").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
// table tennis is explicitly exempt from league blocking, regardless of what BLOCKED currently
// contains -- user-requested: no table tennis game should ever be filtered out by this mechanism.
// Table tennis only ever reaches pmGames (the id-matched array; its market type never satisfies
// NAME_TYPE, so it never appears in pmNameGames), so this only needs checking at those two call
// sites, both of which already have g.t ("table_tennis_match_winner" etc.) on hand.
const isBlocked = (evSlug: any, mkSlug: any, league: any, pmType?: any) => {
  if (/^table_tennis/i.test(String(pmType ?? ""))) return false;
  const es = String(evSlug ?? "").toLowerCase(), ms = String(mkSlug ?? "").toLowerCase();
  const lg = String(league ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return BLOCKED.some((b) => es.includes(b) || ms.includes("-" + b + "-") || lg.includes(b));
};
console.log(`Blocked leagues: ${JSON.stringify(BLOCKED)} | tennis ${TENNIS_ON ? "ON" : "off"} | scan reader ${Bun.env.ANTHROPIC_API_KEY ? "ON" : "needs ANTHROPIC_API_KEY"} | bet105 feed ${Bun.env.B105_TOKEN ? "ON" : "needs B105_TOKEN"} | bovada ${Bun.env.BOVADA_OFF === "1" ? "off" : BVD_LIVE ? "live + pre-match" : "pre-match only"} (alt lines off) | gemini ${GEM_OFF ? "off" : "pre-match"} | feed arb cap ${FEED_MAX_PCT}% | start tol ${START_TOL_MS / 60000}m`);

const TRADE_ON = Bun.env.ARB_TRADE === "1";
const TRADE_MAX_USD = Number(Bun.env.ARB_TRADE_MAX_USD ?? 150);
const FORCE_MULT = 1 + Number(Bun.env.ARB_TRADE_FORCE_PCT ?? 3) / 100;
// how far past the quoted price a single order is allowed to slip, as basis points. Previously this
// stretched all the way to the breakeven ceiling, which on at least one fast-moving live market let a
// fill land AT or slightly BEYOND the ceiling it was meant to never cross. A small fixed band is tighter:
// it'll occasionally leave a chunk unfilled on a fast market, which is far better than overpaying.
const MAX_SLIPPAGE_BIPS = Number(Bun.env.ARB_MAX_SLIPPAGE_BIPS ?? 60);
const trader: any =
  Bun.env.POLYMARKET_KEY_ID && Bun.env.POLYMARKET_SECRET_KEY
    ? new PolymarketUS({ keyId: Bun.env.POLYMARKET_KEY_ID, secretKey: Bun.env.POLYMARKET_SECRET_KEY })
    : null;
const tradeBusy = new Set<number>();
console.log(`One-tap buy: ${TRADE_ON ? "ON" : "off"}, keys loaded=${!!trader}, cap=$${TRADE_MAX_USD}, force=+${Math.round((FORCE_MULT - 1) * 100)}%, max slippage ${MAX_SLIPPAGE_BIPS}bips`);
console.log(`DEXSPORT_DEBUG_ROUTE_MARKER_V3: ${Bun.env.DEXSPORT_DEBUG_TOKEN ? "token set" : "NO TOKEN"}`);

const costPerShare = (p: number) => p + FEE * p * (1 - p);
function wholePair(bank: number, oA: number, oB: number): [number, number] | null {
  if (!(bank >= 2) || !(oA > 1) || !(oB > 1)) return null;
  const ia = 1 / oA, ib = 1 / oB, sum = ia + ib;
  const a0 = (bank * ia) / sum, b0 = (bank * ib) / sum;
  let best: [number, number] | null = null, bestProfit = 0.01 - 1e-9;
  for (let a = Math.max(1, Math.floor(a0) - 3); a <= Math.ceil(a0) + 3; a++) {
    for (let b = Math.max(1, Math.floor(b0) - 3); b <= Math.ceil(b0) + 3; b++) {
      if (a + b > bank + 1e-9) continue;
      const profit = Math.min(a * oA, b * oB) - a - b;
      if (profit > bestProfit) { bestProfit = profit; best = [a, b]; }
    }
  }
  return best;
}
function breakEvenPrice(goatedOdds: number) {
  const c = 1 - 1 / goatedOdds;
  if (!(c > 0 && c < 1)) return 0;
  const disc = (1 + FEE) ** 2 - 4 * FEE * c;
  if (disc < 0) return 0;
  return ((1 + FEE) - Math.sqrt(disc)) / (2 * FEE);
}
function readFill(res: any): { shares: number; longPx: number | null; orderId: string | null } {
  let shares = 0, notional = 0, orderId: string | null = null;
  const num = (v: any) => { const x = Number(typeof v === "object" && v ? v.value : v); return Number.isFinite(x) ? x : null; };
  const walk = (n: any) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!n || typeof n !== "object") return;
    orderId ??= n.id ?? n.orderId ?? null;
    for (const k of ["executions", "fills"]) {
      if (Array.isArray(n[k])) for (const f of n[k]) {
        const q = num(f?.lastShares ?? f?.last_shares);
        const p = num(f?.lastPx ?? f?.last_px);
        if (q && p) { shares += q; notional += q * p; }
      }
    }
    for (const v of Object.values(n)) if (v && typeof v === "object") walk(v);
  };
  walk(res);
  return { shares, longPx: shares > 0 ? notional / shares : null, orderId };
}
async function tradeQuote(slug: string, long: boolean): Promise<number | null> {
  const d = (await pm.markets.bbo(slug))?.marketData;
  if (d?.state !== "MARKET_STATE_OPEN") return null;
  const ask = Number(d?.bestAsk?.value), bid = Number(d?.bestBid?.value);
  const p = long ? ask : 1 - bid;
  return p > 0.02 && p < 0.98 ? p : null;
}
async function placeBuy(slug: string, long: boolean, cash: number, p0: number, bips: number) {
  const make = (indicator: string) => ({
    marketSlug: slug,
    intent: long ? "ORDER_INTENT_BUY_LONG" : "ORDER_INTENT_BUY_SHORT",
    type: "ORDER_TYPE_MARKET",
    cashOrderQty: { value: cash.toFixed(2), currency: "USD" },
    tif: "TIME_IN_FORCE_IMMEDIATE_OR_CANCEL",
    synchronousExecution: true,
    manualOrderIndicator: indicator,
    slippageTolerance: { currentPrice: { value: p0.toFixed(4), currency: "USD" }, bips },
  });
  let res: any;
  try {
    res = await trader.orders.create(make("MANUAL_ORDER_INDICATOR_MANUAL"));
  } catch (e: any) {
    if (/manual_?order_?indicator/i.test(String(e?.message ?? e))) res = await trader.orders.create(make("MANUAL_ORDER_INDICATOR_AUTOMATIC"));
    else throw e;
  }
  return readFill(res);
}
async function trade(body: any) {
  if (!TRADE_ON || !trader) throw new Error("One-tap buying is switched off.");
  const id = Number(body?.id);
  if (!Number.isInteger(id)) throw new Error("bad id");
  const mode: "quote" | "buy" | "force" = body?.mode === "buy" || body?.mode === "force" ? body.mode : "quote";
  const gStake = Number(body?.stake), gPay = Number(body?.payout);
  const cashIn = Number(body?.cash);
  const cashMode = Number.isFinite(cashIn) && cashIn >= 1;
  const C = cashMode ? Math.round(cashIn) : 0;
  if (!(gStake > 0) || !(gPay > gStake * 1.01) || gPay > 5000 || gPay / gStake > 200) throw new Error("Enter your sportsbook stake and payout (from your bet slip).");
  if (cashMode && (C > 5000 || gPay < gStake + C + 0.01)) throw new Error(`With these numbers you can spend at most $${Math.max(0, Math.floor(gPay - gStake - 0.01))} on Polymarket and still win either way.`);
  // timing instrumentation for this call's network round-trips (DB + Polymarket), logged alongside
  // the existing TRADE line below -- added to get real numbers on where execution latency actually
  // goes (this server runs in Railway's sfo region; whether a region move would help is a question
  // for this data, not a guess) before considering any infra change.
  const tLookup0 = performance.now();
  const [row]: any = await sql`SELECT opp_key FROM arb_opps WHERE id = ${id}`;
  const lookupMs = Math.round(performance.now() - tLookup0);
  if (!row) throw new Error("Couldn't find that arb.");
  const key = String(row.opp_key);
  const m = /^[TS]\|(.+)\|([ouls])(?:~\w+)?$/.exec(key) ?? /^(.+)\|([ab])(?:~\w+)?$/.exec(key);
  if (!m) throw new Error("This arb can't be bought with one tap.");
  const slug = m[1], long = m[2] === "a" || m[2] === "o" || m[2] === "l";
  const odds = cashMode ? (gStake + C) / gStake : gPay / gStake;
  const pMax = Math.floor(breakEvenPrice(odds) * 10000) / 10000;
  const pForce = Math.min(0.99, Math.floor(pMax * FORCE_MULT * 10000) / 10000);
  if (!(pMax > 0.02)) throw new Error("Those numbers leave no room to hedge on Polymarket.");
  // normally a second hedge attempt on the same opp within 10 minutes is assumed to be a retry of the
  // SAME sportsbook stake (double-tap, page refresh, etc.) and gets its target reduced by what's already
  // filled. "additional" means the person is telling us this is a genuinely SEPARATE second stake on the
  // sportsbook (e.g. it double-submitted there) -- so skip that lookback and hedge this one fresh.
  const additional = body?.additional === true;
  // the previous-fills lookback (DB) and the live Polymarket quote are independent of each other --
  // neither needs the other's result, only `key`/`slug`/`long` which are already known at this point --
  // so run them concurrently instead of back-to-back. Saves one full round-trip's worth of latency on
  // every trade() call (previously: DB query, then wait for it to finish, then start the PM quote).
  const tQuote0 = performance.now();
  const [prevRows, p0]: [any[], number | null] = await Promise.all([
    additional
      ? Promise.resolve([{ shares: 0, cost: 0 }])
      : sql`SELECT COALESCE(SUM(filled_shares), 0)::float AS shares, COALESCE(SUM(cost_est), 0)::float AS cost
                FROM arb_trades WHERE opp_key = ${key} AND created_at > now() - interval '10 minutes' AND filled_shares > 0`,
    tradeQuote(slug, long),
  ]);
  const quoteMs = Math.round(performance.now() - tQuote0);
  const prev: any = prevRows[0];
  const have = Number(prev?.shares ?? 0), prevCost = Number(prev?.cost ?? 0);
  if (p0 == null) throw new Error("Polymarket has no open price for this market right now.");
  const leftCash0 = cashMode ? Math.max(0, C - prevCost) : 0;
  const remaining = cashMode ? leftCash0 / costPerShare(p0) : Math.max(0, gPay - have);
  const q = {
    p0, pMax, pForce, wanted: cashMode ? have + remaining : gPay, have, remaining, cash: C,
    costNow: cashMode ? leftCash0 : remaining * costPerShare(p0),
    costMax: cashMode ? leftCash0 : remaining * costPerShare(pMax),
    costForce: cashMode ? leftCash0 : remaining * costPerShare(pForce),
    profitNow: cashMode ? Math.min(have + remaining, gPay) - gStake - prevCost - leftCash0 : gPay - gStake - prevCost - remaining * costPerShare(p0),
    ok: p0 <= pMax, canForce: p0 <= pForce, maxUsd: TRADE_MAX_USD,
  };
  if (mode === "quote") return { mode, ...q };
  if (cashMode ? leftCash0 < 0.5 : remaining < 0.01 * gPay) throw new Error("This one is already fully hedged.");
  const ceiling = mode === "force" ? pForce : pMax;
  if (p0 > ceiling) throw new Error(`The price is ${(p0 * 100).toFixed(1)}¢, above the ${(ceiling * 100).toFixed(1)}¢ limit. Nothing was bought.`);
  const worst = cashMode ? leftCash0 : remaining * costPerShare(ceiling);
  if (worst > TRADE_MAX_USD) throw new Error(`That could spend up to $${worst.toFixed(2)}, over the $${TRADE_MAX_USD} cap per tap. Nothing was bought.`);
  if (tradeBusy.has(id)) throw new Error("An order for this arb is already being sent. Wait a moment.");
  tradeBusy.add(id);
  let filled = 0, notional = 0, spent = 0, stop = "";
  let left = remaining, leftC = leftCash0;
  const more = () => (cashMode ? leftC > 0.5 : left > 0.005 * gPay);
  const ids: string[] = [];
  const fillQuoteMs: number[] = [], fillBuyMs: number[] = [];
  try {
    for (let i = 0; i < 3 && more(); i++) {
      let px: number | null;
      if (i === 0) px = p0;
      else {
        const t0 = performance.now();
        px = await tradeQuote(slug, long);
        fillQuoteMs.push(Math.round(performance.now() - t0));
      }
      if (px == null) { stop = "the market closed or has no price"; break; }
      if (px > ceiling) { stop = `the price rose to ${(px * 100).toFixed(1)}¢ (limit ${(ceiling * 100).toFixed(1)}¢)`; break; }
      const cash = cashMode ? leftC : left * costPerShare(px);
      if (cash < 0.5) break;
      // cap the order's own slippage tolerance to a small fixed band (never more than the room to the
      // ceiling, but never more than MAX_SLIPPAGE_BIPS either) -- see MAX_SLIPPAGE_BIPS comment above
      const roomToCeiling = Math.floor((ceiling / px - 1) * 10000);
      // "force" mode exists specifically to tolerate more slippage than plain "buy" -- capping its
      // order-level tolerance at the same flat MAX_SLIPPAGE_BIPS as buy defeats that on fast live
      // markets: the price moves more than 0.6% between quote and fill, the IOC order cancels with
      // zero shares, and the hedge never lands even though the user explicitly asked to pay more for it.
      const bips = Math.max(1, mode === "force" ? roomToCeiling : Math.min(MAX_SLIPPAGE_BIPS, roomToCeiling));
      const tBuy0 = performance.now();
      const f = await placeBuy(slug, long, cash, px, bips);
      fillBuyMs.push(Math.round(performance.now() - tBuy0));
      if (f.orderId) ids.push(String(f.orderId));
      if (f.shares > 0 && f.longPx != null) {
        const paid = long ? f.longPx : 1 - f.longPx;
        const cost = f.shares * costPerShare(paid);
        filled += f.shares; notional += f.shares * paid; left -= f.shares; leftC -= cost; spent += cost;
        // the exchange is expected to honor the slippage band above, but if a fill still lands beyond
        // the ceiling, stop immediately rather than risking it again on a further chunk
        if (paid > ceiling + 0.0005) { stop = `a fill landed at ${(paid * 100).toFixed(2)}c, past the ${(ceiling * 100).toFixed(2)}c limit -- stopped`; break; }
      } else { stop = "nothing more was available at or below the limit"; break; }
      if (more()) await Bun.sleep(150);
    }
  } catch (e: any) {
    stop = "error: " + String(e?.message ?? e).slice(0, 160) + " (check your Polymarket positions before trying again)";
  } finally {
    tradeBusy.delete(id);
  }
  const avg = filled > 0 ? notional / filled : null;
  const tInsert0 = performance.now();
  try {
    await sql`INSERT INTO arb_trades (opp_id, opp_key, mode, goated_stake, goated_payout, wanted_shares, filled_shares, avg_paid, cost_est, ceiling, order_ids, note)
              VALUES (${id}, ${key}, ${mode}, ${gStake}, ${gPay}, ${remaining}, ${filled}, ${avg}, ${spent}, ${ceiling}, ${ids.join(",") || null}, ${stop || (additional ? "additional stake" : null)})`;
  } catch (e: any) { console.error("trade log failed:", e?.message ?? e); }
  const insertMs = Math.round(performance.now() - tInsert0);
  console.log(`TRADE ${mode}${cashMode ? " cash $" + C : ""} ${slug} ${long ? "long" : "short"}: filled ${filled.toFixed(2)} shares for ~$${spent.toFixed(2)}, avg ${avg == null ? "-" : avg.toFixed(4)}, ceiling ${ceiling}${stop ? ", stopped: " + stop : ""}`);
  console.log(`TRADE-TIMING lookup=${lookupMs}ms prevQuery+quote(parallel)=${quoteMs}ms fillQuotes=[${fillQuoteMs.join(",")}]ms fillBuys=[${fillBuyMs.join(",")}]ms insert=${insertMs}ms`);
  const done = cashMode ? leftC <= 0.5 : Math.max(0, remaining - filled) < 0.01 * gPay;
  const remainingNow = cashMode ? (done ? 0 : Math.max(0, leftC) / costPerShare(p0)) : Math.max(0, remaining - filled);
  // this leg of the hedge didn't fully go through -- notify immediately so it doesn't sit unhedged unnoticed
  if (!done) {
    try {
      const [arbRow]: any = await sql`SELECT sport, league, player_a, player_b FROM arb_opps WHERE id = ${id}`;
      const label = arbRow ? `${arbRow.player_a} vs ${arbRow.player_b}` : key;
      void ntfy(
        `Not fully hedged: ${label}`,
        `Sportsbook stake $${gStake.toFixed(2)} (pays $${gPay.toFixed(2)}) but only ${filled.toFixed(2)} of ${remaining.toFixed(2)} Polymarket shares filled.` +
          (stop ? ` Stopped because ${stop}.` : "") +
          ` Still exposed on ${remainingNow.toFixed(2)} shares -- check Polymarket and finish by hand if needed.`,
        "urgent",
      );
    } catch (e: any) { console.error("partial-fill alert failed:", e?.message ?? e); }
  }
  return { mode, filled, haveNow: have + filled, remainingNow, wanted: cashMode ? have + remaining : gPay, avgPaid: avg, costEst: spent, done, stop, ceiling, p0 };
}

const NTFY_TOPIC = Bun.env.NTFY_TOPIC ?? "";
const ALERT_MIN_PCT = Number(Bun.env.ALERT_MIN_PCT ?? 5);
const ALERT_MIN_PCT_LIVE = Number(Bun.env.ALERT_MIN_PCT_LIVE ?? 3);
const ALERT_ANY_PCT = Math.min(ALERT_MIN_PCT, ALERT_MIN_PCT_LIVE);
const ALERT_BANKROLL = Number(Bun.env.ALERT_BANKROLL ?? 100);
const ALERT_COOLDOWN_MS = 10 * 60000;
const PAGE_URL = Bun.env.ARB_PAGE_URL ?? "https://vestax-arb-production.up.railway.app/";
const MIN_LIQ_USD = Number(Bun.env.ARB_MIN_LIQ_USD ?? 10);
const LIQ_CUSHION = Number(Bun.env.ARB_LIQ_CUSHION ?? 1.25);
const SLIP_KEEP = Number(Bun.env.ARB_SLIP_KEEP ?? 0.5);
function bookLevel(x: any): { p: number; q: number } | null {
  const num = (v: any) => { const n = Number(typeof v === "object" && v ? v.value : v); return Number.isFinite(n) ? n : NaN; };
  const p = num(x?.px ?? x?.price), q = num(x?.qty ?? x?.quantity ?? x?.size ?? x?.shares);
  return p > 0 && p < 1 && q > 0 ? { p, q } : null;
}
function walkBuy(levels: { p: number; q: number }[], maxRaw: number, cash: number) {
  let left = cash, shares = 0, spent = 0;
  for (const l of levels) {
    if (l.p > maxRaw || left <= 0.005) break;
    const cps = costPerShare(l.p), take = Math.min(left, l.q * cps);
    shares += take / cps; spent += take; left -= take;
  }
  return { shares, spent, left };
}
async function pmDepth(slug: string, long: boolean, dPm: number, dGt: number, topLiq: number): Promise<{ ok: boolean; depth: number; need: number }> {
  const w = wholePair(ALERT_BANKROLL, dGt, dPm);
  const ia = 1 / dPm, ib = 1 / dGt;
  const C = w ? w[1] : (ALERT_BANKROLL * ia) / (ia + ib);
  const Sg = w ? w[0] : ALERT_BANKROLL - C;
  const maxRaw = breakEvenPrice((Sg + C) / Sg);
  const need = Math.max(MIN_LIQ_USD, C * LIQ_CUSHION);
  let levels: { p: number; q: number }[] = [];
  try {
    const d = (await pm.markets.book(slug))?.marketData;
    const raw = long ? (d?.offers ?? d?.asks ?? []) : (d?.bids ?? []);
    levels = (Array.isArray(raw) ? raw : []).map(bookLevel).filter(Boolean) as { p: number; q: number }[];
    if (!long) levels = levels.map((l) => ({ p: 1 - l.p, q: l.q }));
    levels.sort((a, b) => a.p - b.p);
  } catch (e: any) { console.error("book failed", slug, e?.message ?? e); }
  if (!levels.length) return { ok: topLiq >= need * 2, depth: topLiq, need };
  let depth = 0;
  for (const l of levels) { if (l.p > maxRaw) break; depth += l.q * costPerShare(l.p); }
  const fill = walkBuy(levels, maxRaw, C);
  const profitQ = Math.min(Sg * dGt, C * dPm) - Sg - C;
  const profitA = Math.min(Sg * dGt, fill.shares) - Sg - fill.spent;
  const ok = depth >= need && fill.left < 0.5 && profitA >= Math.max(0.01, profitQ * SLIP_KEEP);
  return { ok, depth, need };
}
const alerted = new Map<string, number>();
async function ntfy(title: string, body: string, priority = "high", click?: string | null, actions?: string): Promise<boolean> {
  if (!NTFY_TOPIC) return false;
  try {
    const headers: Record<string, string> = { Title: title, Priority: priority, Tags: "moneybag" };
    if (actions) headers.Actions = actions;
    const r = await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, { method: "POST", headers, body });
    console.log(`ALERT "${title}" -> ${r.status}`);
    return r.ok;
  } catch (e: any) { console.error("alert failed:", e?.message ?? e); return false; }
}
function alertArb(a: { key: string; pct: number; sport: string; league: string; live: boolean; start: number; pmName: string; pmCents: number; pmLiq: number; gtName: string; gtLabel?: string; gtOdds: number; stakePm: number; stakeGt: number; pmUrl?: string | null; gtUrl?: string | null }) {
  if (!NTFY_TOPIC || a.pct < (a.live ? ALERT_MIN_PCT_LIVE : ALERT_MIN_PCT)) return;
  if (Date.now() - (alerted.get(a.key) ?? 0) < ALERT_COOLDOWN_MS) return;
  alerted.set(a.key, Date.now());
  const lab = a.gtLabel ?? "Goated";
  const when = a.live ? "LIVE now" : Number.isFinite(a.start)
    ? "starts " + new Date(a.start).toLocaleTimeString("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", minute: "2-digit" }) + " PT" : "pre-match";
  const dPm = (a.stakeGt * a.gtOdds) / a.stakePm;
  const w = wholePair(ALERT_BANKROLL, a.gtOdds, dPm);
  const sg = w ? w[0] : a.stakeGt, sp = w ? w[1] : a.stakePm;
  const fmt = (x: number) => (w ? String(x) : x.toFixed(2));
  const locked = Math.min(sg * a.gtOdds, sp * dPm) - sg - sp;
  const body = [
    `${a.sport} · ${a.league} · ${when}`,
    `1) ${lab}: ${a.gtName} @ ${a.gtOdds.toFixed(2)} -> bet $${fmt(sg)}`,
    `2) Polymarket: ${a.pmName} @ ${a.pmCents}c -> bet $${fmt(sp)}` + (a.pmLiq ? ` (depth ~$${Math.round(a.pmLiq)})` : ""),
    `Locks about +$${locked.toFixed(2)} (${((100 * locked) / (sg + sp)).toFixed(2)}%) on $${fmt(sg + sp)}.`,
    a.live ? "LIVE: prices move fast and big live gaps are often stale - check both sides." : "Confirm both prices before betting.",
  ].join("\n");
  const acts: string[] = [];
  if (a.gtUrl) acts.push(`view, Open ${lab}, ${a.gtUrl}`);
  if (a.pmUrl) acts.push(`view, Open Polymarket, ${a.pmUrl}`);
  acts.push(`view, Arbs page, ${PAGE_URL}`);
  void ntfy(`ARB ${a.pct.toFixed(1)}% ${a.sport}${a.live ? " LIVE" : ""}`, body, "high", a.gtUrl || a.pmUrl, acts.join("; "));
}
function alertCross(key: string, pct: number, sport: string, matchup: string, live: boolean, start: number,
  legA: { book: string; name: string; odds: number; url?: string | null }, legB: { book: string; name: string; odds: number; url?: string | null }) {
  if (!NTFY_TOPIC || pct < (live ? ALERT_MIN_PCT_LIVE : ALERT_MIN_PCT)) return;
  if (Date.now() - (alerted.get(key) ?? 0) < ALERT_COOLDOWN_MS) return;
  alerted.set(key, Date.now());
  const when = live ? "LIVE now" : Number.isFinite(start)
    ? "starts " + new Date(start).toLocaleTimeString("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", minute: "2-digit" }) + " PT" : "pre-match";
  const w = wholePair(ALERT_BANKROLL, legA.odds, legB.odds);
  const ia = 1 / legA.odds, ib = 1 / legB.odds;
  const sa = w ? w[0] : Math.round((ALERT_BANKROLL * ia) / (ia + ib)), sb = w ? w[1] : ALERT_BANKROLL - sa;
  const locked = Math.min(sa * legA.odds, sb * legB.odds) - sa - sb;
  const body = [
    `${sport} · ${matchup} · ${when}`,
    `1) ${FEED_LABEL[legA.book] ?? legA.book}: ${legA.name} @ ${legA.odds.toFixed(2)} -> bet $${sa}`,
    `2) ${FEED_LABEL[legB.book] ?? legB.book}: ${legB.name} @ ${legB.odds.toFixed(2)} -> bet $${sb}`,
    `Locks about +$${locked.toFixed(2)} (${((100 * locked) / (sa + sb)).toFixed(2)}%) on $${sa + sb}. No Polymarket leg -- place both bets by hand and confirm both prices first.`,
  ].join("\n");
  const acts: string[] = [];
  if (legA.url) acts.push(`view, Open ${FEED_LABEL[legA.book] ?? legA.book}, ${legA.url}`);
  if (legB.url) acts.push(`view, Open ${FEED_LABEL[legB.book] ?? legB.book}, ${legB.url}`);
  acts.push(`view, Arbs page, ${PAGE_URL}`);
  void ntfy(`ARB ${pct.toFixed(1)}% ${sport}${live ? " LIVE" : ""}`, body, "high", legA.url || legB.url, acts.join("; "));
}

const pairKey = (a: string, b: string) => [a, b].sort().join("-");
async function gt(path: string) {
  const r = await fetch(GT + path, { headers: { "user-agent": UA, accept: "application/json" } });
  if (!r.ok) throw new Error(`goated ${r.status} ${path}`);
  return (await r.json())?.data;
}
async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) await fn(items[i++]); }));
}
const pmDecimal = (p: number) => 1 / (p + FEE * p * (1 - p));
const pid = (s: any) => String((s?.team?.providerIds ?? []).find((p: any) => p.provider === "PROVIDER_ODDSPAPI")?.providerId ?? "");
const srId = (s: any) => {
  const v = String((s?.team?.providerIds ?? []).find((p: any) => p.provider === "PROVIDER_SPORTRADAR" && String(p.providerId).startsWith("sr:competitor:"))?.providerId ?? "");
  return v.replace("sr:competitor:", "");
};
const pmEventUrl = (slug: any) => (slug ? `https://polymarket.us/event/${slug}` : null);
const BAD_TYPE = new RegExp(
  Bun.env.ARB_BAD_TYPE ||
    "spread|total|handicap|draw|1x2|three|half|quarter|period|inning|set_|map_|round|prop|over|under|exact|score|first_|second_|third_|fourth_|touchdown|player|futures|election",
  "i",
);
// soccer's total-market type name is inferred from the pattern its own winner market uses
// ("soccer_team_full_time_winner", confirmed in the Goated/Polymarket catalogue logs) -- not
// independently confirmed, but the naming convention is consistent across every other sport here.
const TOT_TYPE = /^(football|basketball|baseball)_team_full_game_total$|^soccer_team_full_time_total$/;
const SPREAD_TYPE = /^(football|basketball|baseball)_team_full_game_spread$/;
const OT_OK = /(overtime|extra innings?) (is |are )?included|includes? (overtime|extra innings?)|including (overtime|extra innings?)|incl\.? (overtime|extra innings?)/i;
const TEAM_SPORTS = /football|basketball|baseball|esports/i;
// NOTE: esports here is inferred from Polymarket's apparent sportsMarketType naming convention
// (an "esports_" prefix, matching how "tennis_" and "football_..." are already used elsewhere in
// this file) -- not confirmed against real esports market payloads. Check logs after deploy.
const NAME_TYPE = /(football|basketball|baseball|hockey|nhl|nba|ncaab|nfl|ncaaf|cbb|mlb|esports).*(winner|moneyline)|^moneyline$/i;
const NAME_BAD = /spread|total|handicap|half|quarter|period|inning|first_|second_|third_|fourth_|touchdown|player|prop|over|under|exact|score|futures|champion|season|conference|division|efootball|esoccer|soccer|full_time|tie|draw/i;
// soccer's winner market is 3-way (home/draw/away) -- it must NEVER be treated as an arbable
// two-way moneyline (that's exactly the tie risk soccer totals-only support exists to avoid).
// This exact-string exception exists only to pull team names off that market for matching
// purposes; SOCCER_WINNER_TYPE itself is never read anywhere a moneyline odds pair gets built.
const SOCCER_WINNER_TYPE = "soccer_team_full_time_winner";
// confirmed directly against Polymarket's public /sports/market-types endpoint: esports' full-match
// winner type is "esports_match_result", not the "esports_team_full_game_winner" pattern guessed
// earlier -- that guess happened to still work for ID-matching (the isEsports startsWith("esports_")
// check doesn't care about the suffix) but NAME_TYPE requires "winner" or "moneyline" in the string,
// which "_result" never satisfies. This is likely why esports has never once appeared in any log --
// any esports market without a usable provider ID had nothing to fall back to.
const ESPORTS_RESULT_TYPE = "esports_match_result";
// confirmed in real production logs this session: "esports_map_winner_2" etc. -- a specific map's
// own winner, distinct from the full-match "esports_match_winner". Map-level moneylines carry the
// map number right in the type string, which is what lets this get threaded through as its own
// matching dimension (g.mapNum) without touching how every other sport/market here works.
const ESPORTS_MAP_WINNER_TYPE = /^esports_map_winner_(\d+)$/;
const STOPW = new Set(["the", "of", "university", "univ", "college", "fc", "men", "mens", "women", "womens"]);
const DIR: Record<string, string[]> = { se: ["south", "east"], sw: ["south", "west"], ne: ["north", "east"], nw: ["north", "west"] };
const isFem = (s: any) => /\b(lady|ladies|women'?s?|female)\b|\(w\)/i.test(String(s ?? ""));
function toks(s: any): string[] {
  let x = String(s ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  x = x.replace(/&/g, " and ").replace(/\(([^)]*)\)/g, " $1 ").replace(/[^a-z0-9 ]+/g, " ");
  const raw = x.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  raw.forEach((w, i) => {
    const w2 = w === "st" ? (i === raw.length - 1 ? "state" : "saint") : w;
    if (DIR[w2]) out.push(...DIR[w2]); else out.push(w2);
  });
  return out.filter((w) => !STOPW.has(w));
}
function sim(a: string, b: string): number {
  const A = toks(a), B = toks(b);
  if (!A.length || !B.length) return 0;
  const sa = new Set(A), sb = new Set(B);
  let inter = 0;
  for (const w of sa) if (sb.has(w)) inter++;
  if (!inter) return 0;
  const dice = (2 * inter) / (sa.size + sb.size);
  const sh = A.length <= B.length ? A : B, lg = A.length <= B.length ? B : A;
  if (sh.every((w) => lg.includes(w))) {
    if (sh.length === lg.length) return 1;
    const prefix = sh.every((w, i) => lg[i] === w);
    const nick = sh.length === 1 && lg[lg.length - 1] === sh[0];
    if (prefix || nick) return Math.max(dice, 0.85);
  }
  return dice;
}
const bestSim = (xs: string[], ys: string[]) => { let m = 0; for (const x of xs) for (const y of ys) m = Math.max(m, sim(x, y)); return m; };
const variants = (side: any) =>
  [...new Set([side?.team?.name, side?.team?.safeName, side?.team?.alias, side?.description].filter(Boolean).map(String))];
const teamNames = (side: any) => [...new Set([side?.team?.name, side?.team?.safeName, side?.team?.alias].filter(Boolean).map(String))];
const fullName = (side: any) => {
  const n = String(side?.team?.name ?? "").trim(), d = String(side?.description ?? "").trim();
  if (n && d) {
    const tn = toks(n), td = toks(d);
    return td.every((w) => tn.includes(w)) ? n : `${n} ${d}`;
  }
  return n || d;
};

let gtSports: { slug: string; name: string; winnerId: string }[] = [];
let gtEvents = new Map<string, any>();
let gtTeamList: any[] = [];
let gtCatAt = 0;
// full pool of competitor ids seen across every Goated table tennis event (not just paired ones --
// pairKey requires an exact pair match, which is stricter than "does this id exist anywhere in
// Goated's table tennis competitor pool at all"). Used by the overlap diagnostic below to answer,
// with real evidence rather than eyeballing a handful of samples, whether PM's and Goated's id
// schemes for table tennis can ever line up.
let gtTtAllIds = new Set<string>();
async function refreshGoated() {
  if (Date.now() - gtCatAt < 240000 && gtEvents.size) return;
  const sports = (await gt("/listing/sports?lang=en")) ?? [];
  if (!gtCatAt) console.log(`RAW GOATED SPORTS: ${JSON.stringify(sports.map((s: any) => ({ name: s.name, slug: s.slug, markets: (s.defaultMarkets ?? []).map((m: any) => m.name) })))}`);
  gtSports = sports
    .map((s: any) => {
      const w = (s.defaultMarkets ?? []).find((m: any) => /^winner/i.test(m.name ?? ""));
      return w ? { slug: s.slug, name: s.name, winnerId: w.id } : null;
    })
    .filter(Boolean);
  const tourns: { sport: any; slug: string; name: string; cslug: string }[] = [];
  await pool(gtSports, 3, async (sp) => {
    try {
      const cats = (await gt(`/listing/sport/${sp.slug}/all-categories?lang=en`)) ?? [];
      for (const c of cats) for (const t of c.tournaments ?? []) tourns.push({ sport: sp, slug: t.slug, name: t.name, cslug: String(c.slug ?? c.category_slug ?? "") });
    } catch (e: any) { console.error("goated sport failed", sp.slug, e?.message ?? e); }
  });
  const m = new Map<string, any>();
  const ttIds = new Set<string>();
  await pool(tourns, 4, async (t) => {
    try {
      for (const e of (await gt(`/listing/tournament/${t.slug}/all-events?lang=en`)) ?? []) {
        const comps = (e.competitors ?? []).map((c: any) => ({ id: String(c.external_id ?? "").replace(/^sr:competitor:/, ""), q: c.qualifier, name: c.name }));
        if (t.sport.name === "Table Tennis") for (const c of comps) if (c.id) ttIds.add(c.id);
        if (comps.length !== 2 || comps.some((c: any) => !c.id)) continue;
        const url = t.cslug ? `https://www.goated.com/sports/${t.sport.slug}/${t.cslug}/${t.slug}/${e.slug}` : `https://www.goated.com/sports/${t.sport.slug}`;
        m.set(pairKey(comps[0].id, comps[1].id), { slug: e.slug, status: e.status, scheduled: e.scheduled, league: t.name, sport: t.sport, comps, url });
      }
    } catch (e: any) { console.error("goated tournament failed", t.slug, e?.message ?? e); }
  });
  gtEvents = m;
  gtTtAllIds = ttIds;
  gtTeamList = [...m.values()].filter((e) => TEAM_SPORTS.test(e.sport.name));
  gtCatAt = Date.now();
  const per: Record<string, number> = {};
  for (const e of m.values()) per[e.sport.name] = (per[e.sport.name] ?? 0) + 1;
  console.log(`Goated catalogue: ${gtSports.length} two-way sports, ${tourns.length} tournaments, ${m.size} events ${JSON.stringify(per)}`);
}
(async () => { while (true) { try { await refreshGoated(); } catch (e: any) { console.error("goated catalogue refresh failed", e?.message ?? e); } await Bun.sleep(5000); } })();

function gtWinnerFrom(mk: any[], ev: any): Record<string, number> | null {
  const w = mk.find((x: any) => x.id === ev.sport.winnerId) ?? mk.find((x: any) => /^winner/i.test(x.title ?? ""));
  if (!w) return null;
  const sels = (w.selectionGroups ?? []).flatMap((g: any) => g.selections ?? []);
  if (sels.length !== 2) return null;
  const out: Record<string, number> = {};
  const home = ev.comps.find((c: any) => c.q === "home"), away = ev.comps.find((c: any) => c.q === "away");
  for (const s of sels) {
    if (!s.active || String(s.market_status) !== "1") return null;
    const odds = Number(s.odds);
    if (!(odds > 1)) return null;
    const who = s.external_id === "4" ? home : s.external_id === "5" ? away : ev.comps.find((c: any) => c.name === s.name);
    if (who) out[who.id] = odds;
  }
  return Object.keys(out).length === 2 ? out : null;
}
type GtTot = Map<number, { over?: number; under?: number }>;
function gtTotalsFrom(mk: any[]): GtTot {
  const out: GtTot = new Map();
  const w = mk.find((x: any) => /^total \(incl\. (overtime|extra innings)\)$/i.test(String(x.title ?? "").trim()));
  if (!w) return out;
  for (const g of w.selectionGroups ?? []) {
    const side = String(g.name ?? "").toLowerCase();
    if (side !== "over" && side !== "under") continue;
    for (const s of g.selections ?? []) {
      if (!s.active || String(s.market_status) !== "1") continue;
      const odds = Number(s.odds);
      const mm = /total=([0-9.]+)/.exec(String(s.market_key ?? ""));
      const line = mm ? Number(mm[1]) : Number(s.name);
      if (!(odds > 1) || !Number.isFinite(line)) continue;
      const e = out.get(line) ?? {};
      e[side as "over" | "under"] = odds;
      out.set(line, e);
    }
  }
  return out;
}
type GtHand = { team: string; h: number; odds: number }[];
function gtHandicapFrom(mk: any[]): GtHand {
  const out: GtHand = [];
  const w = mk.find((x: any) => /^handicap \(incl\. (overtime|extra innings)\)$/i.test(String(x.title ?? "").trim()));
  if (!w) return out;
  for (const g of w.selectionGroups ?? []) {
    for (const s of g.selections ?? []) {
      if (!s.active || String(s.market_status) !== "1") continue;
      const odds = Number(s.odds), h = Number(String(s.name ?? "").replace("+", ""));
      if (odds > 1 && Number.isFinite(h)) out.push({ team: String(g.name ?? ""), h, odds });
    }
  }
  return out;
}
async function gtMarkets(ev: any): Promise<{ winner: Record<string, number> | null; totals: GtTot; hand: GtHand }> {
  const mk = (await gt(`/event/${ev.slug}/formatted-markets?lang=en&category=all`)) ?? [];
  const team = TEAM_SPORTS.test(ev.sport.name);
  return { winner: gtWinnerFrom(mk, ev), totals: team ? gtTotalsFrom(mk) : (new Map() as GtTot), hand: team ? gtHandicapFrom(mk) : [] };
}

type FeedEv = { teams: [string, string]; spreads: { team: string; line: number; odds: number }[]; totals: { line: number; over?: number; under?: number }[]; ml: Record<string, number>; live: boolean; start?: number; url?: string; link?: string; league?: string; sport?: string; mapMl?: Record<number, Record<string, number>> };
const feeds: Record<string, Map<string, { at: number; ev: FeedEv }>> = { bet105: new Map(), bovada: new Map(), gemini: new Map() };
const FEED_BOOKS = ["bet105", "bovada", "gemini"];
const FEED_TTL: Record<string, number> = { bet105: 100000, bovada: 30000, gemini: 45000 };
const FEED_LABEL: Record<string, string> = { bet105: "Bet105", bovada: "Bovada", gemini: "Gemini", goated: "Goated" };
const FEED_SFX: Record<string, string> = { bet105: "~b105", bovada: "~bvd", gemini: "~gem" };
const B105_TOKEN = Bun.env.B105_TOKEN ?? "";
// temporary: Dexsport is a client-rendered Web3 dapp with no documented odds API and Cloudflare
// protection, so there's nothing to see from a server-side fetch. This records what a Tampermonkey
// recorder script captures on the real page (its own network responses) so the real integration can be
// designed from actual data instead of guessed. Remove this + the table once that's done.
const DEXSPORT_DEBUG_TOKEN = Bun.env.DEXSPORT_DEBUG_TOKEN ?? "";
async function dexsportDebugStore(body: any) {
  const url = tStr(body?.url, 500);
  const status = Number.isInteger(Number(body?.status)) ? Number(body.status) : null;
  const rawBody = String(body?.body ?? "").slice(0, 400_000);
  if (!url) throw new Error("missing url");
  await sql`INSERT INTO dexsport_debug (url, status, body) VALUES (${url}, ${status}, ${rawBody})`;
  return { ok: true };
}
const B105_URL = "https://app.bet105.ag/sports/home";
const BVD_HOST = "https://www.bovada.lv";
const BVD_HEAD = { "user-agent": UA, accept: "application/json, text/plain, */*", "accept-language": "en-US,en;q=0.9", referer: BVD_HOST + "/" };
function feedLive(book: string): FeedEv[] {
  const m = feeds[book], out: FeedEv[] = [], now = Date.now();
  for (const [k, v] of m) { if (now - v.at > (v.ev.live ? 20000 : FEED_TTL[book])) m.delete(k); else out.push(v.ev); }
  return out;
}
function b105Store(body: any) {
  const num = (x: any) => Number(x);
  const dec = (x: any) => { const n = num(x); return n > 1 && n < 1000 ? n : NaN; };
  const evs: any[] = Array.isArray(body?.events) ? body.events.slice(0, 600) : [];
  let n = 0;
  for (const e of evs) {
    const teams = (Array.isArray(e?.teams) ? e.teams : []).map((t: any) => String(t ?? "").trim().slice(0, 60));
    if (teams.length !== 2 || !teams[0] || !teams[1] || teams[0] === teams[1]) continue;
    if (teams.some((t: string) => /^(over|under|draw|yes|no)$/i.test(t))) continue;
    const ev: FeedEv = { teams: [teams[0], teams[1]], spreads: [], totals: [], ml: {}, live: !!e.live };
    const st = num(e.start);
    if (Number.isFinite(st) && st > 1e12 && st < 4e12) ev.start = st;
    const sp = String(e.sport ?? "").toLowerCase();
    if (/^(football|basketball|baseball|hockey|tennis|soccer)$/.test(sp)) ev.sport = sp;
    const lg = String(e.league ?? "").trim().slice(0, 30);
    if (lg) ev.league = lg.toUpperCase();
    const u = String(e.url ?? "");
    if (/^\/event\/\d{6,12}$/.test(u)) ev.url = "https://app.bet105.ag" + u;
    for (const s of (Array.isArray(e.spreads) ? e.spreads : []).slice(0, 60)) {
      const o = dec(s?.odds);
      if (teams.includes(String(s?.team)) && Number.isFinite(num(s?.line)) && o > 1) ev.spreads.push({ team: String(s.team), line: num(s.line), odds: o });
    }
    for (const t of (Array.isArray(e.totals) ? e.totals : []).slice(0, 60)) {
      const o = dec(t?.over), u2 = dec(t?.under);
      if (Number.isFinite(num(t?.line)) && (o > 1 || u2 > 1)) ev.totals.push({ line: num(t.line), over: o > 1 ? o : undefined, under: u2 > 1 ? u2 : undefined });
    }
    for (const tm of teams) { const o = dec(e.ml?.[tm]); if (o > 1) ev.ml[tm] = o; }
    // soccer totals-only -- see the matching note in bvdParse for why this strip happens regardless
    // of what the feed itself reports.
    if (ev.sport === "soccer") { ev.ml = {}; ev.spreads = []; }
    feeds.bet105.set(teams.map((t: string) => t.toLowerCase()).sort().join("|") + (ev.live ? "|L" : "") + (ev.start ? "|" + Math.round(ev.start / 1800000) : ""), { at: Date.now(), ev });
    n++;
  }
  return { ok: true, stored: n };
}
let b105HeadlessLog = "";
async function b105HeadlessTest() {
  const base = Bun.env.BROWSERLESS_URL, tok = Bun.env.BROWSERLESS_TOKEN;
  if (!base || !tok) { console.log("BET105 HEADLESS TEST: skipped, env not set"); return; }
  try {
    const r = await fetch(`${base}/content?token=${encodeURIComponent(tok)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: B105_URL, gotoOptions: { waitUntil: "networkidle2", timeout: 30000 }, waitForTimeout: 4000 }),
      signal: AbortSignal.timeout(45000),
    });
    const body = await r.text();
    const looksBlocked = /cloudflare|captcha|access denied|attention required|cf-browser-verification|just a moment/i.test(body);
    const hasOdds = /moneyline|spread|total|odds|vs\.?\s|@/i.test(body) && body.length > 20000;
    b105HeadlessLog = `BET105 HEADLESS TEST: status ${r.status}, bytes ${body.length}, looksBlocked=${looksBlocked}, hasOdds=${hasOdds}, snippet: ${body.replace(/\s+/g, " ").slice(0, 400)}`;
  } catch (e: any) {
    b105HeadlessLog = `BET105 HEADLESS TEST: error ${String(e?.message ?? e).slice(0, 300)}`;
  }
  console.log(b105HeadlessLog);
}
void b105HeadlessTest();
const BVD_SPORTS: { sport: string; fb: [string, string][] }[] = [
  { sport: "football", fb: [["NFL", "football/nfl"], ["NCAAF", "football/college-football"]] },
  { sport: "basketball", fb: [["NBA", "basketball/nba"], ["NCAAB", "basketball/college-basketball"]] },
  { sport: "baseball", fb: [["MLB", "baseball/mlb"]] },
  { sport: "hockey", fb: [["NHL", "hockey/nhl"]] },
  // paths guessed from Bovada's usual /sport/game URL convention, not confirmed against a real
  // response the way football/basketball/etc. were -- "esports" (the primary attempt) failing
  // over to these per-title paths is expected and logged the same way other sports already are.
  ...(ESPORTS_ON ? [{ sport: "esports", fb: [["CS2", "esports/counter-strike"], ["LoL", "esports/league-of-legends"], ["Dota 2", "esports/dota-2"], ["Valorant", "esports/valorant"]] as [string, string][] }] : []),
  // soccer totals-only (see bvdParse: ml/spreads get stripped for soccer right after bvdCollect runs,
  // keeping only totals -- deliberately, since soccer's 3-way moneyline is exactly the tie risk this is
  // meant to avoid). Fallback paths guessed, same caveat as esports above.
  { sport: "soccer", fb: [["EPL", "soccer/england-premier-league"], ["UCL", "soccer/uefa-champions-league"], ["La Liga", "soccer/spain-laliga"]] },
  { sport: "tennis", fb: [] },
];
// ESPT/ESPO/ESPORTS/ESPORT and SOCC are guesses at Bovada's short codes (unconfirmed, unlike the
// others which came from real captured responses); if events come through with ev.sport unset,
// check BOVADA feed logs for the actual code and add it here.
const BVD_CODE: Record<string, string> = { FOOT: "football", BASK: "basketball", BASE: "baseball", HCKY: "hockey", TENN: "tennis", ESPT: "esports", ESPO: "esports", ESPORTS: "esports", ESPORT: "esports", SOCC: "soccer", SOCCER: "soccer" };
const bvdCoupon = (p: string) => `/services/sports/event/coupon/events/A/description/${p}?marketFilterId=def&lang=en`;
const bvdState: Record<string, string> = {};
const bvdNum = (x: any) => { const n = parseFloat(String(x ?? "").replace(/[^0-9.+-]/g, "")); return Number.isFinite(n) ? n : NaN; };
const bvdOpen = (x: any) => !x?.status || String(x.status).toUpperCase() === "O";
function bvdCollect(ev: any, live: boolean, teams: string[], alt: boolean, out: FeedEv) {
  const tot: Record<string, { line: number; over?: number; under?: number }> = {};
  for (const g of ev.displayGroups ?? []) {
    for (const m of g.markets ?? []) {
      if (!bvdOpen(m)) continue;
      const per = m.period ?? {}, pd = String(per.description ?? "");
      // esports best-of-N series: each map is its own period (e.g. period.description "Map 2"),
      // the same mechanism Bovada uses for halves/quarters elsewhere. Confirmed via captured WS
      // traffic -- but note the batch coupon endpoint this function is fed from (marketFilterId=def)
      // never actually returns these periods; map moneylines are populated separately by
      // bvdFetchMapMl/pullBovadaMapMl below, which hits the per-event endpoint with no filter.
      const mapM = /^map\s*(\d+)/i.exec(pd);
      if (!(per.main === true || /^(game|match|full)/i.test(pd) || mapM)) continue;
      if (typeof per.live === "boolean" && per.live !== live) continue;
      const d = String(m.description ?? "").toLowerCase(), kd = String(m.key ?? "") + " " + d;
      if (!mapM && /team total|1st|2nd|half|quarter|period|set |games/.test(d)) continue;
      if (!alt && /alt/.test(d)) continue;
      // only a map's moneyline is built out below -- a map-level spread/total would otherwise fall
      // into the same buckets as the full-match ones further down and silently corrupt them
      if (mapM && !(/2W-12|moneyline/i.test(kd) && !/total|spread|handicap|alt/.test(d))) continue;
      const outs: any[] = (m.outcomes ?? []).filter(bvdOpen);
      if (/2W-12|moneyline/i.test(kd) && !/total|spread|handicap|alt/.test(d)) {
        if (mapM) {
          // a map's own moneyline -- kept separate from the full-match ml so it never gets
          // compared against the wrong map (or the series winner) by mistake
          const mapNum = Number(mapM[1]);
          if (!out.mapMl) out.mapMl = {};
          if (!out.mapMl[mapNum]) out.mapMl[mapNum] = {};
          const bucket = out.mapMl[mapNum];
          for (const o of outs) { const dc = bvdNum(o?.price?.decimal); if (dc > 1 && teams.includes(String(o.description))) bucket[String(o.description)] = dc; }
          continue;
        }
        for (const o of outs) { const dc = bvdNum(o?.price?.decimal); if (dc > 1 && teams.includes(String(o.description))) out.ml[String(o.description)] = dc; }
      } else if (/2W-HCAP|spread|handicap|run line|puck line/i.test(kd)) {
        for (const o of outs) {
          const dc = bvdNum(o?.price?.decimal), h = bvdNum(o?.price?.handicap);
          if (dc > 1 && Number.isFinite(h) && teams.includes(String(o.description))) out.spreads.push({ team: String(o.description), line: h, odds: dc });
        }
      } else if (/2W-OU|total/i.test(kd)) {
        for (const o of outs) {
          const dc = bvdNum(o?.price?.decimal), h = bvdNum(o?.price?.handicap), side = String(o.description ?? "").toLowerCase();
          if (dc > 1 && Number.isFinite(h) && (side === "over" || side === "under")) { const t = tot[String(h)] ?? (tot[String(h)] = { line: h }); t[side as "over" | "under"] = Math.max(dc, t[side as "over" | "under"] ?? 0); }
        }
      }
    }
  }
  out.totals = Object.values(tot);
}
function bvdParse(ev: any, league: string): FeedEv | null {
  if (ev?.type && ev.type !== "GAMEEVENT") return null;
  const live = !!ev?.live;
  if (live && !BVD_LIVE) return null;
  if (live && !(Date.now() - Number(ev.lastModified) <= 20000)) return null;
  const st = Number(ev.startTime);
  if (!live && Number.isFinite(st) && st > 1e11 && st < Date.now() - 60000) return null;
  let teams: string[] = (ev?.competitors ?? []).map((c: any) => String(c?.name ?? "").trim()).filter(Boolean);
  if (teams.length !== 2) { const p = String(ev?.description ?? "").split(/\s+(?:@|vs\.?|v)\s+/i); teams = p.length === 2 ? [p[0].trim(), p[1].trim()] : []; }
  if (teams.length !== 2 || teams[0] === teams[1]) return null;
  const out: FeedEv = { teams: [teams[0], teams[1]], spreads: [], totals: [], ml: {}, live, league: league || undefined, sport: BVD_CODE[String(ev.sport)] };
  if (Number.isFinite(st) && st > 1e11) out.start = st;
  if (ev.link) { out.link = String(ev.link); out.url = BVD_HOST + "/sports" + out.link; }
  bvdCollect(ev, live, teams, false, out);
  // soccer totals-only: a 3-way moneyline (or an Asian handicap that can push) is exactly the tie
  // risk this feature exists to avoid, so these never reach arb logic for soccer regardless of
  // what Bovada itself reports.
  if (out.sport === "soccer") { out.ml = {}; out.spreads = []; }
  return out;
}
async function bvdLoad(path: string): Promise<{ ok: boolean; state: string }> {
  try {
    const r = await fetch(BVD_HOST + bvdCoupon(path), { headers: BVD_HEAD, signal: AbortSignal.timeout(12000) });
    if (!r.ok) return { ok: false, state: r.status + " " + String(await r.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 90) };
    const j: any = await r.json();
    let n = 0, skipped = 0;
    for (const g of Array.isArray(j) ? j : [j]) {
      const pth: any[] = Array.isArray(g?.path) ? g.path : [];
      const lg = String((pth.find((x) => x?.type === "LEAGUE") ?? pth[pth.length - 1])?.description ?? "");
      for (const ev of g?.events ?? []) {
        const p = bvdParse(ev, lg);
        if (!p) { skipped++; continue; }
        feeds.bovada.set(String(ev.id ?? p.teams.join("|")), { at: Date.now(), ev: p });
        n++;
      }
    }
    return { ok: true, state: "ok " + n + (skipped ? " (skipped " + skipped + " live/started/unreadable)" : "") };
  } catch (e: any) { return { ok: false, state: "error " + String(e?.message ?? e).slice(0, 80) }; }
}
async function pullBovada() {
  for (const s of BVD_SPORTS) {
    const note = (name: string, state: string) => { if (bvdState[name] !== state) { bvdState[name] = state; console.log(`BOVADA feed ${name}: ${state}`); } };
    const res = await bvdLoad(s.sport);
    note(s.sport, res.state);
    if (!res.ok) for (const [name, p] of s.fb) { const r2 = await bvdLoad(p); note(name, r2.state); await Bun.sleep(300); }
    await Bun.sleep(400);
  }
}
if (Bun.env.BOVADA_OFF !== "1") (async () => { while (true) { try { await pullBovada(); } catch (e: any) { console.error("bovada pull failed", e?.message ?? e); } await Bun.sleep(12000); } })();
async function bvdEnrich(fe: FeedEv): Promise<FeedEv> {
  return fe;
}
// Per-event map-level moneylines for Bovada esports. Confirmed via captured WS (STOMP) traffic:
// Bovada's own event page subscribes to /eventByLink/... and gets back a "fullEvent" payload with
// displayGroups[].markets[] where each map has its own period (id 12148/12149/12150, description
// "Map 1"/"Map 2"/"Map 3"). The batch coupon endpoint used by bvdLoad (marketFilterId=def) strips
// these out -- confirmed by direct comparison -- but the per-event REST endpoint below, hit with no
// marketFilterId at all, returns the full market tree including the map periods. No WS client needed.
const bvdEventCoupon = (link: string) => `/services/sports/event/coupon/events/A/description${link}?preMatchOnly=true&lang=en`;
async function bvdFetchMapMl(link: string): Promise<Record<number, Record<string, number>> | null> {
  try {
    const r = await fetch(BVD_HOST + bvdEventCoupon(link), { headers: BVD_HEAD, signal: AbortSignal.timeout(12000) });
    if (!r.ok) return null;
    const j: any = await r.json();
    const out: Record<number, Record<string, number>> = {};
    for (const g of Array.isArray(j) ? j : [j]) {
      for (const ev of g?.events ?? []) {
        for (const dg of ev?.displayGroups ?? []) {
          for (const m of dg?.markets ?? []) {
            if (!bvdOpen(m)) continue;
            const pd = String(m.period?.description ?? "");
            const mapM = /^map\s*(\d+)/i.exec(pd);
            if (!mapM) continue;
            const desc = String(m.description ?? "").toLowerCase(), kd = String(m.key ?? "") + " " + desc;
            if (!(/2W-12|moneyline/i.test(kd)) || /total|spread|handicap|alt/.test(desc)) continue;
            const mapNum = Number(mapM[1]);
            const bucket = out[mapNum] ?? (out[mapNum] = {});
            for (const o of (m.outcomes ?? []).filter(bvdOpen)) {
              const dc = bvdNum(o?.price?.decimal);
              // outcome names here are suffixed e.g. "Eternal Fire - Map 2" -- strip that back to
              // the plain team name so it matches the team strings already used in e.teams/e.ml.
              const nm = String(o.description ?? "").replace(/\s*-\s*map\s*\d+\s*$/i, "").trim();
              if (dc > 1 && nm) bucket[nm] = dc;
            }
          }
        }
      }
    }
    return Object.keys(out).length ? out : null;
  } catch (e: any) { return null; }
}
async function pullBovadaMapMl() {
  let n = 0, errN = 0;
  for (const [, rec] of feeds.bovada) {
    if (rec.ev.sport !== "esports" || !rec.ev.link) continue;
    const mapMl = await bvdFetchMapMl(rec.ev.link);
    if (mapMl) { rec.ev.mapMl = mapMl; n++; } else errN++;
    await Bun.sleep(300);
  }
  if (n || errN) console.log(`BOVADA map-ml: updated ${n} esports event(s)${errN ? `, ${errN} failed/empty` : ""}`);
}
if (Bun.env.BOVADA_OFF !== "1" && ESPORTS_ON) (async () => { while (true) { try { await pullBovadaMapMl(); } catch (e: any) { console.error("bovada map-ml pull failed", e?.message ?? e); } await Bun.sleep(25000); } })();

let gemLast = "";
const gemNote = (s: string) => { if (s !== gemLast) { gemLast = s; console.log("GEMINI feed: " + s); } };
const gemOdds = (x: any) => { const p = Number(x); return p > 0 && p < 1 ? Math.round(1000 / (p + GEM_FEE * p * (1 - p))) / 1000 : NaN; };
const gemFull = (e: any) => ["full_contest", "regulation"].includes(e?.sportsMarket?.scope?.type);
const gemOpen = (e: any): any[] => (e?.contracts ?? []).filter((c: any) => c?.marketState === "open" && c?.status === "active");
function gemParse(data: any[]): Map<string, FeedEv> {
  const games = new Map<string, any[]>();
  const walk = (e: any) => {
    if (e?.gameId && e.sportsMarket) games.set(String(e.gameId), [...(games.get(String(e.gameId)) ?? []), e]);
    for (const c of e?.events ?? []) walk(c);
  };
  for (const top of data) walk(top);
  const out = new Map<string, FeedEv>();
  for (const [gid, evs] of games) {
    const ml = evs.find((e) => e.sportsMarket.type === "moneyline" && e.sportsMarket.subject === "contest" && gemFull(e));
    if (!ml) continue;
    const away = (ml.participants ?? []).find((p: any) => p.side === "away"), home = (ml.participants ?? []).find((p: any) => p.side === "home");
    const start = Date.parse(ml.startTime ?? "");
    if (!away || !home || !(start > Date.now())) continue;
    const T: any = { [away.abbreviation]: away, [home.abbreviation]: home };
    const team = (c: any) => T[(/^[A-Z]+/.exec(String(c.ticker ?? "")) ?? [""])[0]];
    const sp = String(ml.sportsMarket.sport ?? "").replace("american_", "");
    const ev: FeedEv = { teams: [String(away.name), String(home.name)], spreads: [], totals: [], ml: {}, live: false, start, url: "https://www.gemini.com/predictions", league: String(ml.ticker ?? "").split("-")[0].toUpperCase() };
    if (/^(football|basketball|baseball|hockey|tennis)$/.test(sp)) ev.sport = sp;
    let tie = false;
    for (const c of gemOpen(ml)) {
      const t = team(c), o = gemOdds(c.prices?.buy?.yes);
      if (c.sportsSide === "tie") tie = true;
      else if (t && o > 1) ev.ml[String(t.name)] = o;
    }
    if (tie || Object.keys(ev.ml).length !== 2) continue;
    const best = new Map<string, any>(), tot = new Map<number, any>();
    for (const e of evs) {
      const sm = e.sportsMarket;
      if (!gemFull(e) || (sm.type !== "spread" && sm.type !== "total")) continue;
      for (const c of gemOpen(e)) {
        const m = /more than\s+(\d+(?:\.\d+)?)/i.exec(String(c.label ?? ""));
        if (!m) continue;
        const L = Number(m[1]), t = team(c), by = gemOdds(c.prices?.buy?.yes), bn = gemOdds(c.prices?.buy?.no);
        if (sm.type === "spread" && sm.subject === "team" && t) {
          for (const [tm, line, o] of [[t, -L, by], [t === away ? home : away, L, bn]] as any[]) {
            const k = tm.name + "|" + line, cur = best.get(k);
            if (o > 1 && (!cur || o > cur.odds)) best.set(k, { team: String(tm.name), line, odds: o });
          }
        } else if (sm.type === "total" && sm.subject === "contest") {
          const r = tot.get(L) ?? { line: L };
          if (by > 1) r.over = by;
          if (bn > 1) r.under = bn;
          tot.set(L, r);
        }
      }
    }
    ev.spreads = [...best.values()];
    ev.totals = [...tot.values()].filter((t) => t.over || t.under);
    out.set(gid, ev);
  }
  return out;
}
async function pullGemini() {
  const data: any[] = [], seen = new Set<string>();
  for (let page = 0, off = 0; page < 8; page++) {
    const qs = new URLSearchParams({ status: "active", sports_market_type: "moneyline", sports_market_scope: "full_contest", limit: "100", offset: String(off) });
    const r = await fetch("https://api.gemini.com/v1/prediction-markets/events?" + qs, { signal: AbortSignal.timeout(25000) });
    if (!r.ok) return gemNote("HTTP " + r.status);
    const rows: any[] = (await r.json())?.data ?? [], fresh = rows.filter((x) => !seen.has(String(x?.id)));
    if (!fresh.length) break;
    for (const x of fresh) seen.add(String(x?.id));
    data.push(...fresh);
    off += rows.length;
  }
  const evs = gemParse(data);
  for (const [gid, ev] of evs) feeds.gemini.set(gid, { at: Date.now(), ev });
  gemNote(`ok ${evs.size} pre-match games from ${data.length} events`);
}
if (!GEM_OFF) (async () => { while (true) { try { await pullGemini(); } catch (e: any) { gemNote("error " + String(e?.message ?? e).slice(0, 80)); } await Bun.sleep(15000); } })();

function matchFeed(g: any, evs: FeedEv[], startP: number, kind: string): { ev: FeedEv; n0: string; n1: string } | null {
  const isLive = !!g.ev.live;
  const Ln: string[] = g.Ln ?? [g.L?.description], Sn: string[] = g.Sn ?? [g.S?.description];
  let b1: any = null, b2 = 0;
  for (const e of evs) {
    if (e.live !== isLive) continue;
    if (e.sport && kind && e.sport !== kind) continue;
    if (isLive ? e.start && Math.abs(e.start - startP) > START_TOL_MS : !(e.start && Math.abs(e.start - startP) <= START_TOL_MS)) continue;
    const [c1, c2] = e.teams;
    if (g.fem !== undefined && g.fem !== (isFem(c1) || isFem(c2))) continue;
    const l1 = bestSim(Ln, [c1]), s2 = bestSim(Sn, [c2]), l2 = bestSim(Ln, [c2]), s1 = bestSim(Sn, [c1]);
    const straight = l1 + s2, flipped = l2 + s1, flip = flipped > straight, sc = Math.max(straight, flipped);
    const lo = flip ? Math.min(l2, s1) : Math.min(l1, s2);
    const amb = Math.abs(straight - flipped) < 0.2;
    if (!b1 || sc > b1.sc) { b2 = Math.max(b2, b1?.sc ?? 0); b1 = { e, sc, lo, flip, amb }; } else b2 = Math.max(b2, sc);
  }
  if (!b1 || b1.lo < 0.75 || b1.sc - b2 < 0.12 || b1.amb) return null;
  const [c1, c2] = b1.e.teams;
  return { ev: b1.e, n0: b1.flip ? c2 : c1, n1: b1.flip ? c1 : c2 };
}
function feedMarkets(j: any): { winner: Record<string, number> | null; totals: GtTot; hand: GtHand } {
  const e: FeedEv = j.feed, [c0, c1] = j.ge.comps;
  const o0 = e.ml[c0.name], o1 = e.ml[c1.name];
  const totals: GtTot = new Map();
  for (const t of e.totals) totals.set(t.line, { over: t.over, under: t.under });
  return { winner: o0 > 1 && o1 > 1 ? { "0": o0, "1": o1 } : null, totals, hand: e.spreads.map((s) => ({ team: s.team, h: s.line, odds: s.odds })) };
}

let pmGames: any[] = [];
let pmNameGames: any[] = [];
// esports map-level winner markets ("esports_map_winner_2" etc.) -- kept in their own array rather
// than folded into pmNameGames, since a single esports event can carry a full-match winner AND
// several per-map winners together, and the shared nameMk/nameGames machinery only keeps one
// market's worth of team-name data per event (fine for every other sport, which never has more
// than one qualifying winner-type market per event, but wrong here).
let pmMapGames: { slug: string; mapNum: number; Ld: string; Sd: string; Lv: string[]; Sv: string[]; evTitle: string; evSlug: string; startTime: string | null; live: boolean; fem: boolean }[] = [];
const MAP_NOMATCH_LOGGED = new Set<string>();
let pmCatAt = 0;
let pmRefreshing = false;
const slimEv = (ev: any) => ({ id: String(ev.id), startTime: ev.startTime ?? null, live: !!ev.live, title: String(ev.title ?? ""), slug: String(ev.slug ?? "") });

async function refreshPolymarket() {
  if (Date.now() - pmCatAt < PM_CATALOGUE_MS && (pmGames.length || pmNameGames.length)) return;
  if (pmRefreshing) return;
  pmRefreshing = true;
  try {
    const seen = new Set<string>();
    const games: any[] = [], nameGames: any[] = [], mapGames: typeof pmMapGames = [];
    const kept: Record<string, number> = {}, nameTypes: Record<string, number> = {};
    const totKept: Record<string, number> = {};
    const totSkip = { noOT: 0, other: 0 };
    const spSkip = { noOT: 0, other: 0 };
    const spKept: Record<string, number> = {};
    let pages = 0, total = 0, nameSkipped = 0;
    for (let off = 0; off < 8000; off += 200) {
      const r = await pm.events.list({ active: true, closed: false, limit: 200, offset: off });
      const evs = r.events ?? [];
      pages++;
      let fresh = 0;
      for (const ev of evs) {
        const eid = String(ev.id);
        if (seen.has(eid)) continue;
        seen.add(eid); fresh++; total++;
        let picked = false;
        const teamMk: any[] = [];
        const nameMk: any[] = [];
        const tots: any[] = [];
        const sps: any[] = [];
        for (const m of ev.markets ?? []) {
          const t = String(m.sportsMarketType ?? "");
          if (!t) continue;
          const sides = m.marketSides ?? [];
          const L = sides.find((s: any) => s.long), S = sides.find((s: any) => !s.long);
          const mapM = ESPORTS_MAP_WINNER_TYPE.exec(t);
          if (mapM && L && S) {
            mapGames.push({
              slug: m.slug, mapNum: Number(mapM[1]), Ld: L.description, Sd: S.description,
              Lv: variants(L), Sv: variants(S), evTitle: String(ev.title ?? ""), evSlug: String(ev.slug ?? ""),
              startTime: ev.startTime ?? null, live: !!ev.live,
              fem: [L.description, S.description, String(ev.title ?? "")].some(isFem),
            });
            continue;
          }
          if (TOT_TYPE.test(t)) {
            const line = Number(m.line);
            const open = m.active !== false && !m.closed && m.status !== "MARKET_STATUS_RESOLVED";
            const over = Number(L?.quote?.value), under = Number(S?.quote?.value);
            // soccer's full-time total has no overtime to account for (its own books' totals are
            // never asked to say so), unlike football/basketball/baseball where OT_OK is the guard
            // against a PM/book settlement mismatch -- so skip that requirement for soccer specifically.
            const isSoccerTot = /^soccer_/.test(t);
            if (!open || !(line % 1 === 0.5) || !L || !S || L.description !== "Over" || !(over > 0) || !(under > 0)) totSkip.other++;
            else if (!isSoccerTot && !OT_OK.test(String(m.description ?? ""))) totSkip.noOT++;
            else { tots.push({ slug: m.slug, line, over, under }); totKept[t] = (totKept[t] ?? 0) + 1; }
            continue;
          }
          if (SPREAD_TYPE.test(t)) {
            const hL = Number(String(L?.description ?? "").replace("+", ""));
            const open = m.active !== false && !m.closed && m.status !== "MARKET_STATUS_RESOLVED";
            const qL = Number(L?.quote?.value), qS = Number(S?.quote?.value);
            if (!open || !L || !S || !Number.isFinite(hL) || Math.abs(hL) % 1 !== 0.5 || !(qL > 0) || !(qS > 0)) spSkip.other++;
            else if (!OT_OK.test(String(m.description ?? ""))) spSkip.noOT++;
            else { sps.push({ slug: m.slug, hL, lt: teamNames(L), st: teamNames(S), qL, qS }); spKept[t] = (spKept[t] ?? 0) + 1; }
            continue;
          }
          if (((NAME_TYPE.test(t) && !NAME_BAD.test(t)) || t === SOCCER_WINNER_TYPE || t === ESPORTS_RESULT_TYPE) && L) {
            nameMk.push({ slug: m.slug, t, nSides: sides.length, Lv: variants(L), Ld: L.description, Lf: fullName(L), Lk: String(L?.team?.id ?? L?.description), Sv: S ? variants(S) : [], Sd: S?.description, Sf: S ? fullName(S) : "" });
            continue;
          }
          const isTennis = t.startsWith("tennis_");
          const isEsports = t.startsWith("esports_");
          if (isTennis && !TENNIS_ON) continue;
          if (isEsports && !ESPORTS_ON) continue;
          if (BAD_TYPE.test(t)) continue;
          // table tennis doesn't need (and never benefited from) a Sportradar-ID fallback the way
          // tennis/esports do. PM's table tennis sides carry no Sportradar id at all (pid()'s
          // "PROVIDER_ODDSPAPI" value is the only usable id here), but that id turns out to be the
          // literal same number as Goated's Sportradar competitor id (minus the "sr:competitor:"
          // prefix) -- confirmed by direct set overlap (see TT-ID-OVERLAP below). pid() alone was
          // always sufficient; the real issue was the league-block, fixed separately in isBlocked.
          const idOf = (s: any) => pid(s) || (isTennis || isEsports ? srId(s) : "");
          if (!L || !idOf(L)) continue;
          if (sides.length === 2 && S && idOf(S) && idOf(L) !== idOf(S)) {
            kept[t] = (kept[t] ?? 0) + 1;
            games.push({ ev: slimEv(ev), wm: { slug: m.slug }, L: { description: L.description }, S: { description: S.description }, lid: idOf(L), sid: idOf(S), t });
            picked = true;
            break;
          }
          if (/team_.*winner/i.test(t)) teamMk.push({ slug: m.slug, t, Ld: L.description, id: idOf(L) });
        }
        if (picked) continue;
        if (nameMk.length) {
          const two = nameMk.find((x) => x.nSides === 2 && x.Sd && /full_game|^moneyline$/.test(x.t)) ?? nameMk.find((x) => x.nSides === 2 && x.Sd);
          let g: any = null;
          if (two) {
            g = { ev: slimEv(ev), wm: { slug: two.slug }, Ln: two.Lv, Sn: two.Sv, Ld: two.Ld, Sd: two.Sd, Lf: two.Lf, Sf: two.Sf, t: two.t };
          } else {
            const byTeam = new Map<string, any>();
            for (const x of nameMk) if (!byTeam.has(x.Lk)) byTeam.set(x.Lk, x);
            if (byTeam.size === 2) {
              const [a, b] = [...byTeam.values()];
              g = { ev: slimEv(ev), wm: { slug: a.slug }, Ln: a.Lv, Sn: b.Lv, Ld: a.Ld, Sd: b.Ld, Lf: a.Lf, Sf: b.Lf, t: a.t };
            }
          }
          if (g) {
            // Goated's actual sport names are "ESport Counter-Strike" / "ESport Dota" (confirmed in
            // the RAW GOATED SPORTS catalogue dump) -- singular "esport", no trailing s. The filter
            // regex below is tested against those names in matchName(), so matching on /esports/i
            // (plural, from PM's own "esports_..." market-type naming) silently excluded every
            // single Goated esports event from ever being considered a candidate match. /esport/i
            // (no trailing s) is a substring of both namings and matches either correctly.
            g.sport = /basketball|nba|ncaab|cbb/i.test(g.t) ? /basketball/i : /baseball|mlb/i.test(g.t) ? /baseball/i : /football|nfl|ncaaf/i.test(g.t) ? /football/i : /hockey|nhl/i.test(g.t) ? /hockey/i : /esports/i.test(g.t) ? /esport/i : /soccer/i.test(g.t) ? /soccer/i : null;
            g.fem = [...g.Ln, ...g.Sn, g.Lf, g.Sf, g.ev.title].some(isFem);
            g.tots = tots;
            g.sps = sps;
            nameGames.push(g);
            nameTypes[g.t] = (nameTypes[g.t] ?? 0) + 1;
          } else nameSkipped++;
          continue;
        }
        const teams = [...new Map(teamMk.map((x) => [x.id, x])).values()];
        if (teams.length === 2) {
          const [a, b] = teams;
          kept[a.t + " (per-team)"] = (kept[a.t + " (per-team)"] ?? 0) + 1;
          games.push({ ev: slimEv(ev), wm: { slug: a.slug }, L: { description: a.Ld }, S: { description: b.Ld }, lid: a.id, sid: b.id, t: a.t });
        }
      }
      if (evs.length < 200 || fresh === 0) break;
      await Bun.sleep(250);
    }
    pmGames = games;
    pmNameGames = nameGames;
    pmMapGames = mapGames;
    pmCatAt = Date.now();
    console.log(`Polymarket esports map games: ${mapGames.length}${mapGames.length ? " " + JSON.stringify(mapGames.map((g) => ({ Ld: g.Ld, Sd: g.Sd, mapNum: g.mapNum, live: g.live, start: g.startTime }))) : ""}`);
    console.log(`Polymarket catalogue: ${total} events over ${pages} page(s), ${games.length} id-matched winner markets ${JSON.stringify(kept)}`);
    console.log(`Polymarket team-name games: ${nameGames.length} ${JSON.stringify(nameTypes)} (skipped ${nameSkipped} with !=2 teams) | mem ${Math.round(process.memoryUsage().rss / 1048576)}MB`);
    console.log(`Polymarket totals kept ${JSON.stringify(totKept)}, skipped no-overtime-text ${totSkip.noOT}, other ${totSkip.other}; ${nameGames.filter((g) => g.tots.length).length} games have totals`);
    console.log(`Polymarket spreads kept ${JSON.stringify(spKept)}, skipped no-overtime-text ${spSkip.noOT}, other ${spSkip.other}; ${nameGames.filter((g) => g.sps.length).length} games have spreads`);
  } finally {
    pmRefreshing = false;
  }
}
(async () => { while (true) { try { await refreshPolymarket(); } catch (e: any) { console.error("polymarket catalogue refresh failed", e?.message ?? e); } await Bun.sleep(5000); } })();

function matchName(g: any): { ge: any; lid: string; sid: string; why?: string } | null {
  const gs = Date.parse(g.ev.startTime ?? "");
  let b1: any = null, b2 = 0;
  for (const ge of gtTeamList) {
    if (g.sport && !g.sport.test(ge.sport.name)) continue;
    const [c1, c2] = ge.comps;
    if (g.fem !== (isFem(c1.name) || isFem(c2.name))) continue;
    const gStart = Date.parse(ge.scheduled ?? "");
    if (Number.isFinite(gs) && Number.isFinite(gStart) && Math.abs(gs - gStart) > NAME_TIME_TOL_MS) continue;
    const l1 = bestSim(g.Ln, [c1.name]), s2 = bestSim(g.Sn, [c2.name]);
    const l2 = bestSim(g.Ln, [c2.name]), s1 = bestSim(g.Sn, [c1.name]);
    const straight = l1 + s2, flipped = l2 + s1;
    const flip = flipped > straight;
    const sc = Math.max(straight, flipped);
    const lo = flip ? Math.min(l2, s1) : Math.min(l1, s2);
    const amb = Math.abs(straight - flipped) < 0.2;
    if (!b1 || sc > b1.sc) { b2 = Math.max(b2, b1?.sc ?? 0); b1 = { ge, sc, lo, flip, amb }; } else b2 = Math.max(b2, sc);
  }
  if (!b1) return null;
  const [c1, c2] = b1.ge.comps;
  if (b1.lo >= 0.75 && b1.sc - b2 >= 0.12 && !b1.amb) {
    return { ge: b1.ge, lid: (b1.flip ? c2 : c1).id, sid: (b1.flip ? c1 : c2).id };
  }
  return { ge: b1.ge, lid: "", sid: "", why: `best "${c1.name}" vs "${c2.name}" sum=${b1.sc.toFixed(2)} min=${b1.lo.toFixed(2)} runnerUp=${b2.toFixed(2)}${b1.amb ? " ORIENTATION-AMBIGUOUS" : ""}` };
}
const matchCache = new Map<string, { at: number; mt: any }>();
function matchNameCached(g: any) {
  const k = g.wm.slug + "|" + gtCatAt;
  const c = matchCache.get(k);
  if (c && Date.now() - c.at < 90000) return c.mt;
  if (matchCache.size > 3000) matchCache.clear();
  const mt = matchName(g);
  matchCache.set(k, { at: Date.now(), mt });
  return mt;
}

type CrossEntry = { book: string; oddsA: number; oddsB: number; url?: string | null; league?: string; totals?: Map<number, { over?: number; under?: number }>; handA?: Map<number, number>; handB?: Map<number, number> };
async function crossBookArb(pmSlug: string, sport: string, teamA: string, teamB: string, start: number, live: boolean, entries: CrossEntry[]) {
  const keys = new Set<string>();
  const put = async (key: string, bookA: string, oddsA: number, bookB: string, oddsB: number, pct: number, market: string, pa: string, pb: string, uA: string | null, uB: string | null) => {
    keys.add(key);
    try {
      await upsertArb({ key, sport, league: `${teamA} vs ${teamB}`, market, pa, pb, start, live, A: { book: bookA, odds: oddsA, liq: null }, B: { book: bookB, odds: oddsB, liq: null }, pct, uA, uB });
      console.log(`ARB ${pct.toFixed(2)}% ${pa} / ${pb} ${teamA} vs ${teamB} (${sport}) CROSS ${bookA}/${bookB} ${market}`);
      alertCross(key, pct, sport, `${teamA} vs ${teamB}`, live, start, { book: bookA, name: pa, odds: oddsA, url: uA }, { book: bookB, name: pb, odds: oddsB, url: uB });
    } catch (e: any) { console.error("cross upsert failed", pmSlug, e?.message ?? e); }
  };
  for (const X of entries) for (const Y of entries) {
    if (X === Y) continue;
    if (X.oddsA > 1 && Y.oddsB > 1) {
      const pct = (1 / (1 / X.oddsA + 1 / Y.oddsB) - 1) * 100;
      if (pct > 0 && pct <= FEED_MAX_PCT) await put(`X|${pmSlug}|${X.book}|${Y.book}`, X.book, X.oddsA, Y.book, Y.oddsB, pct, "Moneyline", teamA, teamB, X.url ?? null, Y.url ?? null);
    }
    if (X.totals && Y.totals) {
      for (const [line, xt] of X.totals) {
        const yt = Y.totals.get(line);
        if (!xt.over || xt.over <= 1 || !yt?.under || yt.under <= 1) continue;
        const pct = (1 / (1 / xt.over + 1 / yt.under) - 1) * 100;
        if (pct > 0 && pct <= FEED_MAX_PCT) await put(`X|${pmSlug}|${X.book}|${Y.book}|T${line}`, X.book, xt.over, Y.book, yt.under, pct, "Total " + line, "Over " + line, "Under " + line, X.url ?? null, Y.url ?? null);
      }
    }
    if (X.handA && Y.handB) {
      for (const [h, oa] of X.handA) {
        const ob = Y.handB.get(-h);
        if (!(oa > 1) || !ob || ob <= 1) continue;
        const pct = (1 / (1 / oa + 1 / ob) - 1) * 100;
        if (pct > 0 && pct <= FEED_MAX_PCT) await put(`X|${pmSlug}|${X.book}|${Y.book}|S${h}`, X.book, oa, Y.book, ob, pct, "Spread " + fmtH(h), `${teamA} ${fmtH(h)}`, `${teamB} ${fmtH(-h)}`, X.url ?? null, Y.url ?? null);
      }
    }
  }
  try {
    const act: any = await sql`SELECT opp_key FROM arb_opps WHERE active AND opp_key LIKE ${"X|" + pmSlug + "|%"}`;
    for (const r of act ?? []) { const k = String(r.opp_key); if (!keys.has(k)) await sql`UPDATE arb_opps SET active = false WHERE opp_key = ${k} AND active`; }
  } catch (e: any) { console.error("cross retire failed", e?.message ?? e); }
}

const lastChecked = new Map<string, number>();
let cycle = 0;
const fmtH = (h: number) => (h > 0 ? "+" : "") + h;
const nz = (s: any) => String(s ?? "").trim().toLowerCase();
const jk = (j: any) => j.wm.slug + (j.sfx ?? "");
const glabel = (j: any) => FEED_LABEL[j.book ?? "goated"] ?? "Goated";
const sfxOf = (k: string) => (/~[a-z0-9]+$/.exec(k) ?? [""])[0];
const SPORT_NAME: Record<string, string> = { football: "American Football", basketball: "Basketball", baseball: "Baseball", tennis: "Tennis", hockey: "Hockey", esports: "Esports", soccer: "Soccer" };
// NOTE: the esports branch below tests the STRINGIFIED regex stored in g.sport (an odd design --
// g.sport is itself a regex object here, not a plain sport name), not a Goated sport name. That
// field was changed from /esports/i to /esport/i (singular) elsewhere to fix Goated-name matching
// (see the comment where g.sport is assigned), which silently broke this unrelated check: it used
// to test /esports/ against the stringified regex and match ("/esports/i" contains "esports"), but
// "/esport/i" (singular) does not contain "esports" (plural), so this always returned "" for esports
// after that fix -- which zeroes out addFeedJobs (its first line is `if (!kind) return out`) for
// every esports market, silently disabling Bovada/Bet105/Gemini matching for esports entirely. Fixed
// by matching the same singular convention here too.
const kindOf = (g: any) =>
  g.sport ? (/football/.test(String(g.sport)) ? "football" : /basketball/.test(String(g.sport)) ? "basketball" : /baseball/.test(String(g.sport)) ? "baseball" : /esport/.test(String(g.sport)) ? "esports" : /soccer/.test(String(g.sport)) ? "soccer" : "")
    : /tennis/i.test(g.t ?? "") ? "tennis" : /hockey|nhl/i.test(g.t ?? "") ? "hockey" : /esports/i.test(g.t ?? "") ? "esports" : /soccer/i.test(g.t ?? "") ? "soccer" : "";
async function upsertArb(r: { key: string; sport: string; league: string; market: string; pa: string; pb: string; start: number; live: boolean; A: any; B: any; pct: number; uA: string | null; uB: string | null }) {
  const up: any = await sql`
    INSERT INTO arb_opps (opp_key, sport, league, market, player_a, player_b, start_time, is_live,
                          book_a, odds_a, liq_a, book_b, odds_b, liq_b, profit_pct, first_seen, last_seen, active, url_a, url_b)
    VALUES (${r.key}, ${r.sport}, ${r.league}, ${r.market}, ${r.pa}, ${r.pb}, ${Number.isFinite(r.start) ? new Date(r.start) : null}, ${r.live},
            ${r.A.book}, ${r.A.odds}, ${r.A.liq}, ${r.B.book}, ${r.B.odds}, ${r.B.liq}, ${r.pct}, now(), now(), true, ${r.uA}, ${r.uB})
    ON CONFLICT (opp_key) DO UPDATE SET
      sport = EXCLUDED.sport, league = EXCLUDED.league, market = EXCLUDED.market, player_a = EXCLUDED.player_a, player_b = EXCLUDED.player_b,
      is_live = EXCLUDED.is_live, start_time = EXCLUDED.start_time,
      book_a = EXCLUDED.book_a, odds_a = EXCLUDED.odds_a, liq_a = EXCLUDED.liq_a,
      book_b = EXCLUDED.book_b, odds_b = EXCLUDED.odds_b, liq_b = EXCLUDED.liq_b,
      url_a = EXCLUDED.url_a, url_b = EXCLUDED.url_b,
      profit_pct = EXCLUDED.profit_pct, last_seen = now(),
      first_seen = CASE WHEN arb_opps.active THEN arb_opps.first_seen ELSE now() END, active = true
    RETURNING first_seen`;
  return up?.[0]?.first_seen;
}
async function scan(): Promise<number> {
  const myCycle = cycle++;
  const diag = myCycle % 10 === 0;
  const fullSweep = myCycle % 3 === 0;
  const live: any[] = [], pre: any[] = [];
  const matchedPer: Record<string, number> = {};
  const feedEvs: Record<string, FeedEv[]> = { bet105: feedLive("bet105"), bovada: feedLive("bovada"), gemini: feedLive("gemini") };
  const feedN: Record<string, number> = { bet105: 0, bovada: 0, gemini: 0 };
  let blockedN = 0, crossN = 0;
  const gmCache = new Map<string, Promise<{ winner: Record<string, number> | null; totals: GtTot; hand: GtHand }>>();
  const gmCached = (ge: any) => { let p = gmCache.get(ge.slug); if (!p) { p = gtMarkets(ge); gmCache.set(ge.slug, p); } return p; };
  const closeList: { pct: number; label: string }[] = [];
  const noteClose = (pct: number, label: string) => { closeList.push({ pct, label }); };
  const queue = (job: any, isLive: boolean) => {
    const mk = job.ge.sport.name + (job.book ? " (" + FEED_LABEL[job.book] + ")" : "");
    matchedPer[mk] = (matchedPer[mk] ?? 0) + 1;
    if (isLive) live.push(job);
    else if (Date.now() - (lastChecked.get(jk(job)) ?? 0) > PRE_RECHECK_MS) pre.push(job);
  };
  const addFeedJobs = async (g: any, startP: number, isLiveP: boolean) => {
    const kind = kindOf(g);
    const out: Record<string, { n0: string; n1: string; ml: Record<string, number>; url?: string; league?: string; totals: Map<number, { over?: number; under?: number }>; handA: Map<number, number>; handB: Map<number, number> } | null> = { bet105: null, bovada: null, gemini: null };
    if (!kind) return out;
    for (const bk of FEED_BOOKS) {
      if (!feedEvs[bk].length) continue;
      const mb = matchFeed(g, feedEvs[bk], startP, kind);
      if (!mb) continue;
      feedN[bk]++;
      const fev = bk === "bovada" ? await bvdEnrich(mb.ev) : mb.ev;
      const handA = new Map<number, number>(), handB = new Map<number, number>();
      for (const s of fev.spreads) { if (s.team === mb.n0) handA.set(s.line, s.odds); else if (s.team === mb.n1) handB.set(s.line, s.odds); }
      const totals = new Map<number, { over?: number; under?: number }>();
      for (const t of fev.totals) totals.set(t.line, { over: t.over, under: t.under });
      out[bk] = { n0: mb.n0, n1: mb.n1, ml: mb.ev.ml, url: fev.url, league: fev.league, totals, handA, handB };
      queue({
        ev: g.ev, wm: g.wm, L: { description: g.Lf || g.Ld || g.L?.description }, S: { description: g.Sf || g.Sd || g.S?.description }, lid: "0", sid: "1",
        ge: { slug: bk, status: isLiveP ? "live" : "", scheduled: g.ev.startTime, league: fev.league ?? FEED_LABEL[bk], sport: { name: SPORT_NAME[kind] }, comps: [{ id: "0", q: "home", name: mb.n0 }, { id: "1", q: "away", name: mb.n1 }], url: fev.url ?? (bk === "bet105" ? B105_URL : BVD_HOST + "/sports") },
        live: isLiveP, start: startP, byName: true, ptype: g.t, tots: g.tots, sps: g.sps, book: bk, sfx: FEED_SFX[bk], feed: fev,
      }, isLiveP);
    }
    return out;
  };
  await pool(pmGames, 6, async (g) => {
    const ge = gtEvents.get(pairKey(g.lid, g.sid));
    if (ge && !isBlocked(g.ev.slug, g.wm.slug, ge.league, g.t)) {
      const isLive = !!g.ev.live || ge.status === "live";
      const start = Date.parse(g.ev.startTime ?? ge.scheduled ?? "");
      if (isLive || (start > Date.now() - 600000 && start - Date.now() < PRE_WINDOW_MS)) queue({ ...g, ge, live: isLive, start }, isLive);
    } else if (ge) blockedN++;
    const sP = Date.parse(g.ev.startTime ?? ""), lP = !!g.ev.live;
    const kind = kindOf(g);
    if (kind && !isBlocked(g.ev.slug, g.wm.slug, ge?.league, g.t) && (lP || (sP > Date.now() - 600000 && sP - Date.now() < PRE_WINDOW_MS))) {
      const fb = await addFeedJobs(g, sP, lP);
      const cross: CrossEntry[] = [];
      if (ge) {
        try {
          const gm = await gmCached(ge);
          const oA = gm.winner?.[g.lid], oB = gm.winner?.[g.sid];
          if (oA && oA > 1 && oB && oB > 1) cross.push({ book: "goated", oddsA: oA, oddsB: oB, url: ge.url, league: ge.league });
        } catch (e: any) { console.error("goated cross fetch failed", e?.message ?? e); }
      }
      for (const bk of FEED_BOOKS) {
        const m = (fb as any)[bk];
        if (m && m.ml[m.n0] > 1 && m.ml[m.n1] > 1) cross.push({ book: bk, oddsA: m.ml[m.n0], oddsB: m.ml[m.n1], url: m.url, league: m.league });
      }
      if (cross.length >= 2) {
        crossN++;
        try { await crossBookArb(g.wm.slug, ge?.sport?.name ?? SPORT_NAME[kind] ?? kind, g.L.description, g.S.description, sP, lP, cross); }
        catch (e: any) { console.error("cross arb failed (id)", g.wm?.slug, e?.message ?? e); }
      }
    }
  });
  if (diag) {
    const tt = pmGames.filter((g) => /^table_tennis/i.test(String(g.t)));
    const anySide = tt.filter((g) => gtTtAllIds.has(g.lid) || gtTtAllIds.has(g.sid)).length;
    const bothSides = tt.filter((g) => gtTtAllIds.has(g.lid) && gtTtAllIds.has(g.sid)).length;
    console.log(`TT-ID-OVERLAP: ${tt.length} PM table tennis games | ${anySide} with >=1 side's id present in Goated's table tennis pool (${gtTtAllIds.size} ids) | ${bothSides} with both sides present | ${gtEvents.size ? "" : "(gtEvents empty)"}`);
  }
  let nmMatched = 0, nmUnmatched = 0, nmLogs = 0;
  await pool(pmNameGames, 6, async (g) => {
    const isLiveP = !!g.ev.live;
    const startP = Date.parse(g.ev.startTime ?? "");
    if (!isLiveP && !(startP > Date.now() - 600000 && startP - Date.now() < PRE_WINDOW_MS)) return;
    const fb = await addFeedJobs(g, startP, isLiveP);
    const mt = matchNameCached(g);
    const cross: CrossEntry[] = [];
    if (mt && mt.lid && !isBlocked(g.ev.slug, g.wm.slug, mt.ge?.league)) {
      try {
        const gm = await gmCached(mt.ge);
        const oA = gm.winner?.[mt.lid], oB = gm.winner?.[mt.sid];
        if (oA && oA > 1 && oB && oB > 1) {
          const isA = (name: string) => bestSim([name], g.Ln) > bestSim([name], g.Sn);
          const handA = new Map<number, number>(), handB = new Map<number, number>();
          for (const h of gm.hand) { (isA(h.team) ? handA : handB).set(h.h, h.odds); }
          cross.push({ book: "goated", oddsA: oA, oddsB: oB, url: mt.ge.url, league: mt.ge.league, totals: gm.totals, handA, handB });
        }
      } catch (e: any) { console.error("goated cross fetch failed", e?.message ?? e); }
    }
    for (const bk of FEED_BOOKS) {
      const m = (fb as any)[bk];
      if (!m) continue;
      const hasMl = m.ml[m.n0] > 1 && m.ml[m.n1] > 1;
      const hasTot = m.totals && m.totals.size > 0;
      // soccer books report hasMl=false here on purpose (stripped at ingestion -- see bvdParse etc.)
      // so this only ever forwards totals for soccer, never a moneyline pair.
      if (hasMl || hasTot) cross.push({ book: bk, oddsA: hasMl ? m.ml[m.n0] : NaN, oddsB: hasMl ? m.ml[m.n1] : NaN, url: m.url, league: m.league, totals: m.totals, handA: m.handA, handB: m.handB });
    }
    if (cross.length >= 2) {
      crossN++;
      try { await crossBookArb(g.wm.slug, SPORT_NAME[kindOf(g)] ?? g.t, g.Lf || g.Ld, g.Sf || g.Sd, startP, isLiveP, cross); }
      catch (e: any) { console.error("cross arb failed (name)", g.wm?.slug, e?.message ?? e); }
    }
    if (!mt || !mt.lid) {
      nmUnmatched++;
      if (diag && mt?.why && nmLogs++ < 5) console.log(`NAME-NOMATCH ${g.Lf} vs ${g.Sf} (${g.t}) | ${mt?.why}`);
      return;
    }
    if (isBlocked(g.ev.slug, g.wm.slug, mt.ge?.league)) { blockedN++; return; }
    nmMatched++;
    const isLive = isLiveP || mt.ge.status === "live";
    queue({ ev: g.ev, wm: g.wm, L: { description: g.Lf || g.Ld }, S: { description: g.Sf || g.Sd }, lid: mt.lid, sid: mt.sid, ge: mt.ge, live: isLive, start: startP, byName: true, ptype: g.t, tots: g.tots, sps: g.sps }, isLive);
  });
  // esports map-level moneylines vs Bovada, entirely separate from the shared jobs pipeline above --
  // deliberately isolated (own matching, own math, own opp_key prefix "ME|") so a mistake here can't
  // touch any other sport. Bovada-only: no other feed book has confirmed per-map esports data, and
  // Goated doesn't carry esports map lines at all.
  let mapMatchedN = 0;
  const bovadaEsports = feedLive("bovada").filter((e) => e.sport === "esports" && e.mapMl);
  await pool(pmMapGames, 6, async (pg) => {
    const isLiveP = pg.live;
    const startP = Date.parse(pg.startTime ?? "");
    if (!isLiveP && !(startP > Date.now() - 600000 && startP - Date.now() < PRE_WINDOW_MS)) return;
    let best: any = null, bestSc = 0, flip = false, bestAny: any = null, bestAnySc = 0;
    for (const e of bovadaEsports) {
      if (e.live !== isLiveP) continue;
      const [c1, c2] = e.teams;
      const l1 = bestSim(pg.Lv, [c1]), s2 = bestSim(pg.Sv, [c2]), l2 = bestSim(pg.Lv, [c2]), s1 = bestSim(pg.Sv, [c1]);
      const straight = l1 + s2, flipped = l2 + s1, sc = Math.max(straight, flipped);
      if (sc > bestAnySc) { bestAnySc = sc; bestAny = e; }
      if (!e.mapMl?.[pg.mapNum]) continue;
      const lo = (flipped > straight ? Math.min(l2, s1) : Math.min(l1, s2));
      if (lo < 0.75) continue;
      if (sc > bestSc) { bestSc = sc; best = e; flip = flipped > straight; }
    }
    if (!best) {
      if (!MAP_NOMATCH_LOGGED.has(pg.slug)) {
        MAP_NOMATCH_LOGGED.add(pg.slug);
        console.log(`MAP-NOMATCH ${pg.Ld} vs ${pg.Sd} · Map ${pg.mapNum} | live=${isLiveP} | bovadaEsports=${bovadaEsports.length} | best any-team-match="${bestAny?.teams?.join(" vs ") ?? "-"}" sc=${bestAnySc.toFixed(2)} hasMapMl(${pg.mapNum})=${!!bestAny?.mapMl?.[pg.mapNum]} mapMlKeys=${bestAny?.mapMl ? JSON.stringify(Object.keys(bestAny.mapMl)) : "-"}`);
      }
      return;
    }
    const [n0, n1] = flip ? [best.teams[1], best.teams[0]] : best.teams;
    const mapOdds = best.mapMl![pg.mapNum];
    const dGtL = mapOdds[n0], dGtS = mapOdds[n1];
    if (!(dGtL > 1) || !(dGtS > 1)) return;
    mapMatchedN++;
    const label = `${pg.Ld} vs ${pg.Sd} · Map ${pg.mapNum}`;
    try {
      const bbo = await pm.markets.bbo(pg.slug);
      const d = bbo?.marketData;
      if (d?.state !== "MARKET_STATE_OPEN") return;
      const ask = Number(d?.bestAsk?.value), bid = Number(d?.bestBid?.value);
      const pmUrl = pmEventUrl(pg.evSlug), gtUrl = best.url ?? null;
      const hits: string[] = [];
      const legs: { side: "a" | "b"; p: number; liq: number; dGt: number; pa: string; pb: string }[] = [];
      if (ask > 0.01 && ask < 0.99) legs.push({ side: "a", p: ask, liq: Number(d?.askShares ?? 0) * ask, dGt: dGtS, pa: pg.Ld, pb: pg.Sd });
      if (bid > 0.01 && bid < 0.99) legs.push({ side: "b", p: 1 - bid, liq: Number(d?.bidShares ?? 0) * (1 - bid), dGt: dGtL, pa: pg.Sd, pb: pg.Ld });
      for (const leg of legs) {
        const dPm = pmDecimal(leg.p);
        const pct = (1 / (1 / dPm + 1 / leg.dGt) - 1) * 100;
        noteClose(pct, label);
        if (pct <= 0 || pct > FEED_MAX_PCT) continue;
        const dp = await pmDepth(pg.slug, leg.side === "a", dPm, leg.dGt, leg.liq);
        if (!dp.ok) continue;
        const key = "ME|" + pg.slug + "|" + leg.side;
        hits.push(key);
        const pmLong = leg.side === "a";
        const rowPm = { book: "polymarket", odds: dPm, liq: dp.depth || null };
        const rowGt = { book: "bovada", odds: leg.dGt, liq: null };
        const A = pmLong ? rowPm : rowGt, B = pmLong ? rowGt : rowPm;
        const uA = pmLong ? pmUrl : gtUrl, uB = pmLong ? gtUrl : pmUrl;
        const fs = await upsertArb({ key, sport: "Esports", league: `Map ${pg.mapNum}`, market: "Map " + pg.mapNum + " Moneyline", pa: leg.pa, pb: leg.pb, start: startP, live: isLiveP, A, B, pct, uA, uB });
        console.log(`ARB ${pct.toFixed(2)}% ${label} (${leg.pa} on PM, other side on bovada) depth $${Math.round(dp.depth)}`);
        if (pct >= ALERT_ANY_PCT && fs && Date.now() - new Date(fs).getTime() < 20000) {
          const ia = 1 / dPm, ib = 1 / leg.dGt;
          alertArb({
            key, pct, sport: "Esports", league: `Map ${pg.mapNum} · ${pg.evTitle}`, live: isLiveP, start: startP,
            pmName: leg.pa, pmCents: Math.round(leg.p * 100), pmLiq: dp.depth,
            gtName: leg.pb, gtLabel: "Bovada", gtOdds: leg.dGt,
            stakePm: (ALERT_BANKROLL * ia) / (ia + ib), stakeGt: (ALERT_BANKROLL * ib) / (ia + ib), pmUrl, gtUrl,
          });
        }
      }
      for (const side of ["a", "b"]) {
        const key = "ME|" + pg.slug + "|" + side;
        if (!hits.includes(key)) await sql`UPDATE arb_opps SET active = false WHERE opp_key = ${key} AND active`;
      }
    } catch (e: any) { console.error("esports map-level arb failed", pg.slug, e?.message ?? e); }
  });
  pre.sort((a, b) => (lastChecked.get(jk(a)) ?? 0) - (lastChecked.get(jk(b)) ?? 0));
  const jobs = (fullSweep || !live.length ? [...live, ...pre] : live).slice(0, MAX_JOBS);
  if (diag) {
    const fe = (e: FeedEv) => `${e.teams.join(" v ")}|${e.sport ?? "-"}|${e.live ? "L" : "P"}|${e.start ? new Date(e.start).toISOString().slice(5, 16) : "-"}`;
    if (feedEvs.bet105.length) console.log(`FEED bet105 (${feedEvs.bet105.length}): ` + feedEvs.bet105.slice(0, 40).map(fe).join(" ; "));
  }

  let lqSkip = 0, capSkip = 0;
  const tstat = { games: 0, lines: 0, overlap: 0, cand: 0, live: 0, arbs: 0 };
  const sstat = { games: 0, lines: 0, overlap: 0, cand: 0, live: 0, arbs: 0, noOrient: 0 };

  const evalTotals = async (j: any, gT: GtTot) => {
    const keys = new Set<string>();
    let liveChecks = 0;
    const sfx: string = j.sfx ?? "", bk: string = j.book ?? "goated";
    const pmUrl = pmEventUrl(j.ev?.slug), gtUrl = j.ge?.url ?? null;
    tstat.games++;
    for (const t of j.tots as any[]) {
      tstat.lines++;
      const g = gT.get(t.line);
      if (!g || !((g.over ?? 0) > 1) || !((g.under ?? 0) > 1)) continue;
      tstat.overlap++;
      const gOver = g.over as number, gUnder = g.under as number;
      const fa = 1 / gOver, fb = 1 / gUnder, fairOver = fa / (fa + fb);
      const pmMid = (t.over + (1 - t.under)) / 2;
      if (Math.abs(pmMid - fairOver) > 0.15) {
        if (diag) console.log(`TOT-INSANE ${j.L.description} vs ${j.S.description} ${t.line}: PM over ${pmMid.toFixed(2)} vs ${bk} ${fairOver.toFixed(2)} (skipped)`);
        continue;
      }
      const combos: { side: "o" | "u"; p: number; gtOdds: number }[] = [
        { side: "o", p: t.over, gtOdds: gUnder },
        { side: "u", p: t.under, gtOdds: gOver },
      ];
      for (const c of combos) {
        if (!(c.p > 0.01 && c.p < 0.99) || !(c.gtOdds > 1)) continue;
        if ((1 / (1 / pmDecimal(c.p) + 1 / c.gtOdds) - 1) * 100 < -3) continue;
        tstat.cand++;
        if (liveChecks++ >= 6) continue;
        tstat.live++;
        const bb = await pm.markets.bbo(t.slug);
        const d2 = bb?.marketData;
        if (d2?.state !== "MARKET_STATE_OPEN") continue;
        const ask = Number(d2?.bestAsk?.value), bid = Number(d2?.bestBid?.value);
        const p = c.side === "o" ? ask : 1 - bid;
        if (!(p > 0.01 && p < 0.99)) continue;
        const liq = c.side === "o" ? Number(d2?.askShares ?? 0) * ask : Number(d2?.bidShares ?? 0) * (1 - bid);
        const dPm = pmDecimal(p);
        const pct = (1 / (1 / dPm + 1 / c.gtOdds) - 1) * 100;
        const matchup = `${j.L.description} vs ${j.S.description}`;
        noteClose(pct, `Total ${t.line}: ${matchup} (${j.ge.sport.name})`);
        if (pct <= 0) continue;
        if (j.feed && pct > FEED_MAX_PCT) { capSkip++; continue; }
        const dp = await pmDepth(t.slug, c.side === "o", dPm, c.gtOdds, liq);
        if (!dp.ok) { lqSkip++; continue; }
        const key = "T|" + t.slug + "|" + c.side + sfx;
        keys.add(key);
        tstat.arbs++;
        const pmOver = c.side === "o";
        const rowPm = { book: "polymarket", odds: dPm, liq: dp.depth || null };
        const rowGt = { book: bk, odds: c.gtOdds, liq: null };
        const A = pmOver ? rowPm : rowGt, B = pmOver ? rowGt : rowPm;
        const uA = pmOver ? pmUrl : gtUrl, uB = pmOver ? gtUrl : pmUrl;
        const fs = await upsertArb({ key, sport: j.ge.sport.name, league: matchup, market: "Total " + t.line, pa: "Over " + t.line, pb: "Under " + t.line, start: j.start, live: !!j.live, A, B, pct, uA, uB });
        console.log(`ARB ${pct.toFixed(2)}% TOTAL ${t.line} ${matchup} (${pmOver ? "Over" : "Under"} on PM, ${pmOver ? "Under" : "Over"} on ${bk}) depth $${Math.round(dp.depth)} (${j.ge.sport.name})`);
        if (pct >= ALERT_ANY_PCT && fs && Date.now() - new Date(fs).getTime() < 20000) {
          const ia = 1 / dPm, ib = 1 / c.gtOdds;
          alertArb({
            key, pct, sport: j.ge.sport.name, league: `Total ${t.line} · ${j.ge.league}`, live: !!j.live, start: j.start,
            pmName: `${pmOver ? "Over" : "Under"} ${t.line} (${matchup})`, pmCents: Math.round(p * 100), pmLiq: dp.depth,
            gtName: `${pmOver ? "Under" : "Over"} ${t.line}`, gtLabel: glabel(j), gtOdds: c.gtOdds,
            stakePm: (ALERT_BANKROLL * ia) / (ia + ib), stakeGt: (ALERT_BANKROLL * ib) / (ia + ib), pmUrl, gtUrl,
          });
        }
      }
    }
    try {
      const act: any = await sql`SELECT opp_key FROM arb_opps WHERE active AND opp_key LIKE ${"T|%" + j.ev.slug + "%"}`;
      for (const r of act ?? []) { const k = String(r.opp_key); if (sfxOf(k) === sfx && !keys.has(k)) await sql`UPDATE arb_opps SET active = false WHERE opp_key = ${k} AND active`; }
    } catch (e: any) { console.error("totals retire failed", e?.message ?? e); }
  };

  const evalSpreads = async (j: any, hand: GtHand) => {
    const keys = new Set<string>();
    let liveChecks = 0;
    const sfx: string = j.sfx ?? "", bk: string = j.book ?? "goated";
    const pmUrl = pmEventUrl(j.ev?.slug), gtUrl = j.ge?.url ?? null;
    const [c0, c1] = j.ge.comps;
    const matchup = `${j.L.description} vs ${j.S.description}`;
    sstat.games++;
    for (const t of j.sps as any[]) {
      sstat.lines++;
      const s0 = bestSim(t.lt, [c0.name]), s1 = bestSim(t.lt, [c1.name]), u0 = bestSim(t.st, [c0.name]), u1 = bestSim(t.st, [c1.name]);
      const straight = s0 + u1, flipped = s1 + u0;
      if (Math.abs(straight - flipped) < 0.2 || (straight > flipped ? Math.min(s0, u1) : Math.min(s1, u0)) < 0.75) { sstat.noOrient++; continue; }
      const T = straight > flipped ? c0 : c1, O = straight > flipped ? c1 : c0;
      const gT = hand.find((x) => nz(x.team) === nz(T.name) && x.h === t.hL);
      const gO = hand.find((x) => nz(x.team) === nz(O.name) && x.h === -t.hL);
      if (!gT || !gO) continue;
      sstat.overlap++;
      const fa = 1 / gT.odds, fb = 1 / gO.odds, fairT = fa / (fa + fb);
      const pmMid = (t.qL + (1 - t.qS)) / 2;
      if (Math.abs(pmMid - fairT) > 0.15) {
        if (diag) console.log(`SPR-INSANE ${matchup} ${T.name} ${fmtH(t.hL)}: PM ${pmMid.toFixed(2)} vs ${bk} ${fairT.toFixed(2)} (skipped)`);
        continue;
      }
      const combos: { side: "l" | "s"; p: number; gtOdds: number }[] = [
        { side: "l", p: t.qL, gtOdds: gO.odds },
        { side: "s", p: t.qS, gtOdds: gT.odds },
      ];
      for (const c of combos) {
        if (!(c.p > 0.01 && c.p < 0.99) || !(c.gtOdds > 1)) continue;
        if ((1 / (1 / pmDecimal(c.p) + 1 / c.gtOdds) - 1) * 100 < -3) continue;
        sstat.cand++;
        if (liveChecks++ >= 6) continue;
        sstat.live++;
        const bb = await pm.markets.bbo(t.slug);
        const d2 = bb?.marketData;
        if (d2?.state !== "MARKET_STATE_OPEN") continue;
        const ask = Number(d2?.bestAsk?.value), bid = Number(d2?.bestBid?.value);
        const pmLong = c.side === "l";
        const p = pmLong ? ask : 1 - bid;
        if (!(p > 0.01 && p < 0.99)) continue;
        const liq = pmLong ? Number(d2?.askShares ?? 0) * ask : Number(d2?.bidShares ?? 0) * (1 - bid);
        const dPm = pmDecimal(p);
        const pct = (1 / (1 / dPm + 1 / c.gtOdds) - 1) * 100;
        noteClose(pct, `Spread ${T.name} ${fmtH(t.hL)}: ${matchup} (${j.ge.sport.name})`);
        if (pct <= 0) continue;
        if (j.feed && pct > FEED_MAX_PCT) { capSkip++; continue; }
        const dp = await pmDepth(t.slug, pmLong, dPm, c.gtOdds, liq);
        if (!dp.ok) { lqSkip++; continue; }
        const key = "S|" + t.slug + "|" + c.side + sfx;
        keys.add(key);
        sstat.arbs++;
        const rowPm = { book: "polymarket", odds: dPm, liq: dp.depth || null };
        const rowGt = { book: bk, odds: c.gtOdds, liq: null };
        const A = pmLong ? rowPm : rowGt, B = pmLong ? rowGt : rowPm;
        const uA = pmLong ? pmUrl : gtUrl, uB = pmLong ? gtUrl : pmUrl;
        const nameA = `${T.name} ${fmtH(t.hL)}`, nameB = `${O.name} ${fmtH(-t.hL)}`;
        const fs = await upsertArb({ key, sport: j.ge.sport.name, league: matchup, market: "Spread " + fmtH(t.hL), pa: nameA, pb: nameB, start: j.start, live: !!j.live, A, B, pct, uA, uB });
        console.log(`ARB ${pct.toFixed(2)}% SPREAD ${nameA} / ${nameB} ${matchup} (${pmLong ? nameA : nameB} on PM, other side on ${bk}) depth $${Math.round(dp.depth)} (${j.ge.sport.name})`);
        if (pct >= ALERT_ANY_PCT && fs && Date.now() - new Date(fs).getTime() < 20000) {
          const ia = 1 / dPm, ib = 1 / c.gtOdds;
          alertArb({
            key, pct, sport: j.ge.sport.name, league: `Spread · ${j.ge.league}`, live: !!j.live, start: j.start,
            pmName: `${pmLong ? nameA : nameB} (${matchup})`, pmCents: Math.round(p * 100), pmLiq: dp.depth,
            gtName: pmLong ? nameB : nameA, gtLabel: glabel(j), gtOdds: c.gtOdds,
            stakePm: (ALERT_BANKROLL * ia) / (ia + ib), stakeGt: (ALERT_BANKROLL * ib) / (ia + ib), pmUrl, gtUrl,
          });
        }
      }
    }
    try {
      const act: any = await sql`SELECT opp_key FROM arb_opps WHERE active AND opp_key LIKE ${"S|%" + j.ev.slug + "%"}`;
      for (const r of act ?? []) { const k = String(r.opp_key); if (sfxOf(k) === sfx && !keys.has(k)) await sql`UPDATE arb_opps SET active = false WHERE opp_key = ${k} AND active`; }
    } catch (e: any) { console.error("spreads retire failed", e?.message ?? e); }
  };

  await pool(jobs, 4, async (j) => {
    try {
      lastChecked.set(jk(j), Date.now());
      const sfx: string = j.sfx ?? "", bk: string = j.book ?? "goated";
      const [bbo, gm] = await Promise.all([pm.markets.bbo(j.wm.slug), j.feed ? Promise.resolve(feedMarkets(j)) : gmCached(j.ge)]);
      const gOdds = gm.winner;
      const d = bbo?.marketData;
      const hits: string[] = [];
      if (d?.state === "MARKET_STATE_OPEN") {
        const ask = Number(d?.bestAsk?.value), bid = Number(d?.bestBid?.value);
        let sane = true;
        // soccer jobs reach here with gOdds === null on purpose (moneyline is stripped at ingestion),
        // so this sanity check -- and the moneyline leg/arb block further below -- simply never run for
        // them, while totals/spreads evaluation (which needs no moneyline odds at all) still does.
        if (gOdds && (j.byName || /^tennis$/i.test(j.ge.sport.name)) && gOdds[j.lid] && gOdds[j.sid]) {
          const pL = ask > 0 && bid > 0 ? (ask + bid) / 2 : ask > 0 ? ask : bid;
          const a = 1 / gOdds[j.lid], b = 1 / gOdds[j.sid];
          if (!(pL > 0) || Math.abs(pL - a / (a + b)) > 0.2) {
            sane = false;
            if (diag) console.log(`NAME-INSANE ${j.L.description} vs ${j.S.description} (${j.ge.sport.name}, ${bk}): PM ${pL?.toFixed?.(2)} vs fair ${(a / (a + b)).toFixed(2)} (skipped)`);
          }
        }
        if (sane && j.byName && j.tots?.length && gm.totals.size) {
          try { await evalTotals(j, gm.totals); } catch (e: any) { console.error("totals failed", j.wm?.slug, e?.message ?? e); }
        }
        if (sane && j.byName && j.sps?.length && gm.hand.length) {
          try { await evalSpreads(j, gm.hand); } catch (e: any) { console.error("spreads failed", j.wm?.slug, e?.message ?? e); }
        }
        if (gOdds) {
          const legs: { side: "a" | "b"; p: number; liq: number; other: string }[] = [];
          if (sane && ask > 0.01 && ask < 0.99) legs.push({ side: "a", p: ask, liq: Number(d?.askShares ?? 0) * ask, other: j.sid });
          if (sane && bid > 0.01 && bid < 0.99) legs.push({ side: "b", p: 1 - bid, liq: Number(d?.bidShares ?? 0) * (1 - bid), other: j.lid });
          const tieRisk = /cricket/i.test(j.ge.sport.name) || /^tennis$/i.test(j.ge.sport.name) || (/baseball/i.test(j.ge.sport.name) && !/mlb/i.test(String(j.ge.league)));
          const pmUrl = pmEventUrl(j.ev?.slug), gtUrl = j.ge?.url ?? null;
          for (const leg of legs) {
            const dPm = pmDecimal(leg.p), dGt = gOdds[leg.other];
            if (!dGt) continue;
            if (tieRisk && 1 / dPm >= CRICKET_MAX_PM_COST) continue;
            const pct = (1 / (1 / dPm + 1 / dGt) - 1) * 100;
            const label = `${j.L.description} vs ${j.S.description} (${j.ge.sport.name})`;
            noteClose(pct, label);
            if (pct <= 0) continue;
            if (j.feed && pct > FEED_MAX_PCT) { capSkip++; continue; }
            const dp = await pmDepth(j.wm.slug, leg.side === "a", dPm, dGt, leg.liq);
            if (!dp.ok) { lqSkip++; continue; }
            const key = j.wm.slug + "|" + leg.side + sfx;
            hits.push(key);
            const pmLong = leg.side === "a";
            const rowPm = { book: "polymarket", odds: dPm, liq: dp.depth || null };
            const rowGt = { book: bk, odds: dGt, liq: null };
            const A = pmLong ? rowPm : rowGt, B = pmLong ? rowGt : rowPm;
            const uA = pmLong ? pmUrl : gtUrl, uB = pmLong ? gtUrl : pmUrl;
            const fs = await upsertArb({ key, sport: j.ge.sport.name, league: j.ge.league, market: "Moneyline", pa: j.L.description, pb: j.S.description, start: j.start, live: !!j.live, A, B, pct, uA, uB });
            console.log(`ARB ${pct.toFixed(2)}% ${label} (${pmLong ? j.L.description : j.S.description} on PM${bk === "goated" ? "" : ", other side on " + bk}) depth $${Math.round(dp.depth)}` +
              (j.byName ? ` || PM[${j.ev.title} | ${j.ptype} | ${j.ev.slug} | ${j.ev.startTime}] OTHER[${j.ge.comps[0].name} vs ${j.ge.comps[1].name} | ${j.ge.league} | ${j.ge.slug} | ${j.ge.scheduled}]` : ""));
            if (pct >= ALERT_ANY_PCT && fs && Date.now() - new Date(fs).getTime() < 20000) {
              const ia = 1 / dPm, ib = 1 / dGt;
              alertArb({
                key, pct, sport: j.ge.sport.name, league: j.ge.league, live: !!j.live, start: j.start,
                pmName: pmLong ? j.L.description : j.S.description, pmCents: Math.round(leg.p * 100), pmLiq: dp.depth,
                gtName: pmLong ? j.S.description : j.L.description, gtLabel: glabel(j), gtOdds: dGt,
                stakePm: (ALERT_BANKROLL * ia) / (ia + ib), stakeGt: (ALERT_BANKROLL * ib) / (ia + ib), pmUrl, gtUrl,
              });
            }
          }
        }
      }
      for (const side of ["a", "b"]) {
        const key = j.wm.slug + "|" + side + sfx;
        if (!hits.includes(key)) await sql`UPDATE arb_opps SET active = false WHERE opp_key = ${key} AND active`;
      }
    } catch (e: any) { console.error("compare failed", j.wm?.slug, e?.message ?? e); }
  });
  if (diag) console.log(`Matched games by sport: ${JSON.stringify(matchedPer)} (live ${live.length}, pre due ${pre.length}, ${fullSweep ? "full sweep" : "live-only"}) | by name: ${nmMatched} matched, ${nmUnmatched} unmatched | bet105 ${feedEvs.bet105.length} games/${feedN.bet105} matched, bovada ${feedEvs.bovada.length} games/${feedN.bovada} matched, gemini ${feedEvs.gemini.length} games/${feedN.gemini} matched | esports maps: ${pmMapGames.length} PM/${mapMatchedN} matched vs bovada | cross-book games: ${crossN} | blocked: ${blockedN} | fill-check drops: ${lqSkip} | over-cap drops (>${FEED_MAX_PCT}%): ${capSkip} | mem ${Math.round(process.memoryUsage().rss / 1048576)}MB`);
  await sql`UPDATE arb_opps SET active = false WHERE active AND last_seen < now() - interval '3 minutes'`;
  closeList.sort((a, b) => b.pct - a.pct);
  const seenLabel = new Set<string>();
  const topClose: { pct: number; label: string }[] = [];
  for (const c of closeList) { if (seenLabel.has(c.label)) continue; seenLabel.add(c.label); topClose.push(c); if (topClose.length >= 8) break; }
  const totalMatched = Object.values(matchedPer).reduce((a, n) => a + n, 0);
  await sql`UPDATE arb_status SET last_scan = now(), compared = ${totalMatched}, pm_events = ${pmGames.length + pmNameGames.length}, gt_events = ${gtEvents.size},
            best_pct = COALESCE(${topClose[0] ? topClose[0].pct : null}, best_pct), best_label = COALESCE(${topClose[0] ? topClose[0].label : null}, best_label),
            closest_json = COALESCE(${topClose.length ? JSON.stringify(topClose) : null}::jsonb, closest_json), note = null WHERE id = 1`;
  return live.length;
}

(async () => {
  console.log("VeSTAX ARBS scanner running (Polymarket.us x Goated + Bet105 + Bovada + Gemini, plus cross-book winner/total/spread pairs)");
  while (true) {
    const t = Date.now();
    let liveCount = 0;
    try { liveCount = await scan(); } catch (e: any) {
      console.error("scan failed:", e?.message ?? e);
      try { await sql`UPDATE arb_status SET note = ${String(e?.message ?? e).slice(0, 200)} WHERE id = 1`; } catch {}
    }
    await Bun.sleep(Math.max(800, (liveCount > 0 ? LIVE_CYCLE_MS : IDLE_CYCLE_MS) - (Date.now() - t)));
  }
})();

async function logo(): Promise<Uint8Array | null> {
  if (logoCache) return logoCache;
  const rows = await sql`SELECT encode(data, 'base64') AS b64 FROM assets WHERE name = 'logo'`;
  if (rows.length) return (logoCache = Uint8Array.from(Buffer.from(rows[0].b64, "base64")));
  return null;
}
let pageCache: { at: number; html: string } | null = null;
async function getPage(): Promise<string | null> {
  if (pageCache && Date.now() - pageCache.at < 30000) return pageCache.html;
  try {
    const rows: any = await sql`SELECT convert_from(data, 'UTF8') AS html FROM assets WHERE name = 'arbs_page'`;
    const html = rows?.[0]?.html;
    if (html) { pageCache = { at: Date.now(), html: String(html) }; return pageCache.html; }
  } catch (e: any) { console.error("page load failed:", e?.message ?? e); }
  return pageCache?.html ?? null;
}
async function arbs() {
  const rows = await sql`
    SELECT id, sport, league, market, player_a, player_b, start_time, is_live,
           book_a, odds_a, liq_a, book_b, odds_b, liq_b, profit_pct, first_seen, last_seen, url_a, url_b
    FROM arb_opps WHERE active AND last_seen > now() - interval '3 minutes'
    ORDER BY profit_pct DESC LIMIT 100`;
  const [s] = await sql`SELECT last_scan, compared, best_pct, best_label, closest_json FROM arb_status WHERE id = 1`;
  return { rows, status: s ?? null, now: new Date().toISOString(), feeds: { bet105: feedLive("bet105").length, bovada: feedLive("bovada").length, gemini: feedLive("gemini").length }, trade: { enabled: TRADE_ON && !!trader, maxUsd: TRADE_MAX_USD, forcePct: Math.round((FORCE_MULT - 1) * 100) } };
}
const authed = (req: Request) => {
  if (!KEY) return false;
  const c = req.headers.get("cookie") ?? "";
  return c.split(/;\s*/).some((p) => p === "vxk=" + encodeURIComponent(KEY));
};

const TRACK_BOOKS = new Set(["polymarket", "goated", "bet105", "bovada", "gemini", "novig", "dexsport", "other"]);
const tStr = (x: any, max: number) => String(x ?? "").trim().slice(0, max);
const tNum = (x: any) => { const n = Number(x); return Number.isFinite(n) && n > 0 && n < 1e7 ? n : NaN; };
const tDate = (x: any) => { const n = Number(x); const t = Number.isFinite(n) && n > 1e11 ? n : Date.parse(String(x ?? "")); return Number.isFinite(t) ? new Date(t) : null; };
async function trackerRows() {
  return await sql`
    SELECT id, placed_at, sport, league, event, event_start, a_book, a_pick, a_odds, a_stake, a_payout,
           b_book, b_pick, b_odds, b_stake, b_payout, status, winner, returned, settled_at, note
    FROM arb_tracker ORDER BY (status = 'open') DESC, placed_at DESC LIMIT 200`;
}
async function trackerAdd(b: any) {
  const event = tStr(b?.event, 120);
  const legs = ["a", "b"].map((k) => {
    const l = b?.[k] ?? {};
    return { book: TRACK_BOOKS.has(l.book) ? String(l.book) : "other", pick: tStr(l.pick, 80), stake: tNum(l.stake), payout: tNum(l.payout) };
  });
  if (!event || legs.some((l) => !l.pick || !(l.stake > 0) || !(l.payout > l.stake))) throw new Error("Fill in the match, both picks, both stakes and what each pays if it wins.");
  const [x, y] = legs;
  const rows: any = await sql`
    INSERT INTO arb_tracker (sport, league, event, event_start, a_book, a_pick, a_odds, a_stake, a_payout, b_book, b_pick, b_odds, b_stake, b_payout, note)
    VALUES (${tStr(b?.sport, 40) || null}, ${tStr(b?.league, 80) || null}, ${event}, ${tDate(b?.event_start)},
            ${x.book}, ${x.pick}, ${x.payout / x.stake}, ${x.stake}, ${x.payout},
            ${y.book}, ${y.pick}, ${y.payout / y.stake}, ${y.stake}, ${y.payout}, ${tStr(b?.note, 300) || null})
    RETURNING id`;
  // both legs just got recorded as filled -- let the phone know this one is now locked in and tracked
  const total = x.stake + y.stake;
  const locked = Math.min(x.payout, y.payout) - total;
  void ntfy(
    `Tracking: ${event}`,
    `Both sides filled -- ${x.book}: ${x.pick} ($${x.stake.toFixed(2)}) + ${y.book}: ${y.pick} ($${y.stake.toFixed(2)}). Locked about $${locked.toFixed(2)} on $${total.toFixed(2)}.`,
    "default",
  );
  return { id: rows?.[0]?.id };
}
async function trackerSettle(b: any) {
  const id = Number(b?.id);
  if (!Number.isInteger(id)) throw new Error("bad id");
  const [t]: any = await sql`SELECT a_payout, b_payout FROM arb_tracker WHERE id = ${id} AND status = 'open'`;
  if (!t) throw new Error("That arb is not open.");
  let status = "won", winner: string | null = null, returned = 0;
  if (b.outcome === "a") { winner = "a"; returned = t.a_payout; }
  else if (b.outcome === "b") { winner = "b"; returned = t.b_payout; }
  else if (b.outcome === "other") {
    status = "other"; returned = Number(b.returned);
    if (!(returned >= 0 && returned < 1e7)) throw new Error("Enter how much came back in total.");
  } else throw new Error("bad outcome");
  await sql`UPDATE arb_tracker SET status = ${status}, winner = ${winner}, returned = ${returned}, settled_at = now() WHERE id = ${id}`;
  return { ok: true };
}
async function trackerDelete(b: any) {
  const id = Number(b?.id);
  if (!Number.isInteger(id)) throw new Error("bad id");
  await sql`DELETE FROM arb_tracker WHERE id = ${id}`;
  return { ok: true };
}

const SCAN_KEY = Bun.env.ANTHROPIC_API_KEY ?? "";
const SCAN_MODEL = Bun.env.ARB_SCAN_MODEL ?? "claude-sonnet-5-5";
const scanTimes: number[] = [];
const SCAN_PROMPT = [
  "You read screenshots of sports bets and pair them into arbitrage pairs (one Polymarket bet + one sportsbook bet on the same match covering opposite outcomes). Screenshots may be tilted photos of a monitor.",
  "- Polymarket: 'Cost' is the stake and 'To win' the total payout. 'X . Yes' means the bet is X; 'X . No' means the OPPOSITE of X (e.g. 'Over 38.5 . No' is Under 38.5; 'Team wins by over 21.5 . No' is the other team +21.5).",
  "- Goated: 'Your Stake' and 'Est. Payout' (total payout), the odds, the pick and the market name; read every bet shown.",
  "- Bet105 and Bovada: the slip shows the pick, American odds, 'Risk' (stake) and 'To Win' (profit; payout = Risk + To Win).",
  "Reply with ONLY JSON: " + '{"arbs":[{"event":"Team A vs Team B","sport":"Cricket","a":{"book":"polymarket","pick":"...","stake":0,"payout":0},"b":{"book":"goated","pick":"...","stake":0,"payout":0},"warn":""}],"unpaired":[{"book":"goated","event":"...","pick":"...","stake":0,"payout":0}],"notes":""}',
  "Stake and payout are plain dollar numbers (payout includes the stake). Polymarket bet goes in 'a', the sportsbook bet in 'b' (book is goated, bet105 or bovada). Name picks clearly ('Detroit Lions -21.5', 'Under 38.5', a team or player). sport is one of: American Football, Basketball, Baseball, Cricket, Tennis, Table Tennis, Soccer, Hockey, MMA, Other. Put doubtful numbers in 'warn'; bets with no partner go under 'unpaired'.",
].join("\n");
const scanBook = (s: any) => (/polymarket/i.test(String(s)) ? "polymarket" : /goated/i.test(String(s)) ? "goated" : /bet\s?105/i.test(String(s)) ? "bet105" : /bovada/i.test(String(s)) ? "bovada" : TRACK_BOOKS.has(String(s)) ? String(s) : "other");
const scanNum = (x: any) => { const n = Number(String(x ?? "").replace(/[$,]/g, "")); return Number.isFinite(n) && n > 0 && n < 1e6 ? Math.round(n * 100) / 100 : null; };
async function scanShots(body: any) {
  if (!SCAN_KEY) throw new Error("Screenshot reading needs an Anthropic API key. Add it as ANTHROPIC_API_KEY on the vestax-arb service in Railway, then try again.");
  const imgs: string[] = (Array.isArray(body?.images) ? body.images : []).filter((x: any) => typeof x === "string" && x.length > 1000).slice(0, 8);
  if (!imgs.length) throw new Error("Choose at least one screenshot first.");
  if (imgs.reduce((n, s) => n + s.length, 0) > 14_000_000) throw new Error("Those images are too large. Try fewer screenshots at a time.");
  const now = Date.now();
  while (scanTimes.length && now - scanTimes[0] > 3600e3) scanTimes.shift();
  if (scanTimes.length >= 30) throw new Error("Too many scans this hour. Try again later.");
  scanTimes.push(now);
  const content: any[] = imgs.map((data) => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data } }));
  content.push({ type: "text", text: SCAN_PROMPT });
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": SCAN_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: SCAN_MODEL, max_tokens: 2500, messages: [{ role: "user", content }] }),
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("The screenshot reader returned an error: " + String(j?.error?.message ?? r.status).slice(0, 160));
  const text = (j.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
  const m = /\{[\s\S]*\}/.exec(text);
  let out: any = null;
  try { out = m ? JSON.parse(m[0]) : null; } catch { out = null; }
  if (!out) throw new Error("Couldn't understand the reader's answer. Try again.");
  const leg = (l: any) => ({ book: scanBook(l?.book), pick: tStr(l?.pick, 80), stake: scanNum(l?.stake), payout: scanNum(l?.payout) });
  const arbs = (Array.isArray(out.arbs) ? out.arbs : []).slice(0, 12).map((a: any) => ({ event: tStr(a?.event, 120), sport: tStr(a?.sport, 40), a: leg(a?.a), b: leg(a?.b), warn: tStr(a?.warn, 200) }));
  const unpaired = (Array.isArray(out.unpaired) ? out.unpaired : []).slice(0, 12).map((u: any) => ({ ...leg(u), event: tStr(u?.event, 120) }));
  console.log(`SCAN ${imgs.length} image(s) -> ${arbs.length} arb(s), ${unpaired.length} unpaired`);
  return { arbs, unpaired, notes: tStr(out.notes, 300) };
}

const LOCK = `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"/><title>VeSTAX ARBS</title>
<link rel="icon" href="/logo.png"/><meta name="robots" content="noindex,nofollow"/>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0d12;color:#e8e8ea;font-family:system-ui,sans-serif}
form{background:#11141b;border:1px solid #23262f;border-radius:16px;padding:28px;width:min(340px,90vw);text-align:center}
img{width:56px;height:56px;border-radius:12px;object-fit:cover}h1{font-size:1.3rem;margin:12px 0 18px}
input{width:100%;box-sizing:border-box;background:#0b0d12;color:#e8e8ea;border:1px solid #23262f;border-radius:10px;padding:12px;font-size:1rem}
button{margin-top:12px;width:100%;padding:12px;border:0;border-radius:999px;background:#2e5cff;color:#fff;font-weight:700;font-size:1rem}</style></head>
<body><form method="GET" action="/"><img src="/logo.png" alt=""/><h1>VeSTAX ARBS</h1>
<input name="key" type="password" placeholder="Passcode" autocomplete="current-password"/><button>Enter</button></form></body></html>`;

Bun.serve({
  port: Number(Bun.env.PORT ?? 3000),
  async fetch(req) {
    const url = new URL(req.url);
    const isPost = req.method === "POST";
    if (req.method !== "GET" && req.method !== "HEAD" && !isPost) return new Response("Method not allowed", { status: 405 });
    if (isPost && !url.pathname.startsWith("/api/tracker") && url.pathname !== "/api/trade" && url.pathname !== "/api/scan" && url.pathname !== "/api/b105" && url.pathname !== "/api/dexsport-debug") return new Response("Method not allowed", { status: 405 });
    const sec = { "x-content-type-options": "nosniff", "x-frame-options": "DENY", "referrer-policy": "no-referrer", "x-robots-tag": "noindex, nofollow" };
    if (isPost && url.pathname === "/api/b105") {
      if (!B105_TOKEN || req.headers.get("x-b105-token") !== B105_TOKEN) return Response.json({ error: "locked" }, { status: 401, headers: sec });
      try { return Response.json(b105Store(await req.json()), { headers: { "cache-control": "no-store", ...sec } }); }
      catch { return Response.json({ error: "bad request" }, { status: 400, headers: sec }); }
    }
    if (isPost && url.pathname === "/api/dexsport-debug") {
      if (!DEXSPORT_DEBUG_TOKEN || req.headers.get("x-dexsport-token") !== DEXSPORT_DEBUG_TOKEN) return Response.json({ error: "locked" }, { status: 401, headers: sec });
      try { return Response.json(await dexsportDebugStore(await req.json()), { headers: { "cache-control": "no-store", ...sec } }); }
      catch (e: any) { return Response.json({ error: String(e?.message ?? "bad request").slice(0, 200) }, { status: 400, headers: sec }); }
    }
    if (url.pathname === "/logo.png" || url.pathname === "/favicon.ico") {
      const img = await logo();
      return img ? new Response(img, { headers: { "content-type": "image/png", "cache-control": "public, max-age=86400", ...sec } })
                 : new Response("", { status: 404, headers: sec });
    }
    const k = url.searchParams.get("key");
    if (url.pathname === "/" && KEY && k === KEY) {
      const dest = url.searchParams.has("demo") ? "/?demo=1" : "/";
      return new Response(null, { status: 303, headers: { location: dest, "set-cookie": "vxk=" + encodeURIComponent(KEY) + "; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax", ...sec } });
    }
    if (!authed(req)) {
      if (url.pathname.startsWith("/api/")) return Response.json({ error: "locked" }, { status: 401, headers: sec });
      return new Response(LOCK, { headers: { "content-type": "text/html; charset=utf-8", ...sec } });
    }
    if (isPost) {
      if (!(req.headers.get("content-type") ?? "").includes("application/json")) return Response.json({ error: "JSON only" }, { status: 415, headers: sec });
      try {
        const body = await req.json();
        let out: any;
        if (url.pathname === "/api/tracker") out = await trackerAdd(body);
        else if (url.pathname === "/api/tracker/settle") out = await trackerSettle(body);
        else if (url.pathname === "/api/tracker/delete") out = await trackerDelete(body);
        else if (url.pathname === "/api/trade") out = await trade(body);
        else if (url.pathname === "/api/scan") out = await scanShots(body);
        else return Response.json({ error: "not found" }, { status: 404, headers: sec });
        return Response.json(out, { headers: { "cache-control": "no-store", ...sec } });
      } catch (e: any) {
        return Response.json({ error: String(e?.message ?? "bad request").slice(0, 240) }, { status: 400, headers: sec });
      }
    }
    if (url.pathname === "/api/arbs") {
      try { return Response.json(await arbs(), { headers: { "cache-control": "no-store", ...sec } }); }
      catch { return Response.json({ error: "unavailable" }, { status: 500, headers: sec }); }
    }
    if (url.pathname === "/api/tracker") {
      try { return Response.json({ rows: await trackerRows() }, { headers: { "cache-control": "no-store", ...sec } }); }
      catch (e: any) { console.error("tracker load failed:", e?.message ?? e); return Response.json({ error: "unavailable" }, { status: 500, headers: sec }); }
    }
    if (url.pathname === "/api/test-alert") {
      const ok = await ntfy("VeSTAX ARBS test alert", "Test alert: if you can read this, phone alerts are working.", "default", PAGE_URL, `view, Arbs page, ${PAGE_URL}`);
      return Response.json({ sent: ok, topicSet: !!NTFY_TOPIC }, { headers: { "cache-control": "no-store", ...sec } });
    }
    if (url.pathname !== "/") return new Response("Not found", { status: 404, headers: sec });
    const html = await getPage();
    if (!html) return new Response("The page is not available right now. Refresh in a moment.", { status: 503, headers: { "content-type": "text/plain; charset=utf-8", ...sec } });
    return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...sec } });
  },
});
