// arbbuy.ts - one-click "buy both legs" for Goated-vs-Polymarket MONEYLINE arbs.
// Fires the Polymarket buy and the Goated bet (through the VPS) at the same moment.
// Safe by default: it only PLANS (dry run) unless the request says dry:false AND ARB_BUY_ON=1 is set.

type Deps = {
  sql: any;
  trade: (body: any) => Promise<any>;
  tradeQuote: (slug: string, long: boolean) => Promise<number | null>;
  pmDecimal: (p: number) => number;
  wholePair: (bank: number, oA: number, oB: number) => [number, number] | null;
  ntfy: (title: string, body: string, priority?: string) => Promise<boolean>;
  trackerAdd: (b: any) => Promise<any>;
  legs: Map<string, any>; // arb key -> which Goated game/outcome that arb's Goated leg is, filled in by the scanner
  bvdLegs: Map<string, any>; // same for Bovada arbs: arb key -> the Bovada outcome id to bet
};

const BETTOR_URL = (Bun.env.BETTOR_URL ?? "").replace(/\/+$/, "");
const BETTOR_KEY = Bun.env.BETTOR_KEY ?? "";
const MAX_USD = Number(Bun.env.ARB_BUY_MAX_USD ?? 25); // most that can be spent across both legs in one click
const DEFAULT_BANK = Number(Bun.env.ARB_BUY_BANKROLL ?? 10);
// Auto-fire needs a bigger edge than a manual tap on the FRESH prices (the buy re-reads both prices right before any money moves).
// Thin edges are what flipped to a small loss before; live Bovada candidates come from a ~50 s old price list, so this is the real gate.
const AUTO_MIN_VERIFIED_PCT = Number(Bun.env.ARB_AUTO_MIN_VERIFIED_PCT ?? 1.0);
// Boxing / MMA can end in a draw. Polymarket settles a draw at 50c per share and the sportsbook (when it refunds a draw) pays the stake back, so a draw
// only works out when the Polymarket side is the UNDERDOG (a 50c payout beats a low price; it loses on a favorite). Auto-fire only buys those fights when
// the Polymarket price is at or under this (default 45c, a 5c margin under 50c). ARB_FIGHT_MAX_PM_PRICE=1 switches the rule off.
const FIGHT_MAX_PM_PRICE = Number(Bun.env.ARB_FIGHT_MAX_PM_PRICE ?? 0.45);
// Auto-fire skips a buy that shrinks below this many dollars in total across both legs (when the book only fits a few dollars, the edge isn't worth the risk).
const AUTO_MIN_TOTAL = Number(Bun.env.ARB_AUTO_MIN_TOTAL ?? 10);
const MIN_PCT = Number(Bun.env.ARB_BUY_MIN_PCT ?? 0.5); // refuse if the fresh prices no longer clear this

// ---- auto-fire settings (OFF after every restart unless ARB_AUTO=1; the /auto page switches it on and off) ----
const AUTO_PCT = Number(Bun.env.ARB_AUTO_PCT ?? 5); // only arbs at or above this edge fire by themselves
// Auto-fire sizes every buy off a $100 bankroll (about $40-60 on each side) and is allowed to exceed the usual per-click cap to do it.
const AUTO_BANK = Number(Bun.env.ARB_AUTO_BANKROLL ?? 100);
// Table tennis arbs: auto-fire only buys them from 11 PM to 5 AM Pacific. The strategy bot trades table tennis on the same Polymarket account
// from 6 AM to 10 PM (opposite sides would net against each other), so there is a one-hour gap on each side of it so nothing overlaps.
// Even inside the window, an arb is skipped if the strategy bot still holds an open position on that market.
// ARB_TT_NIGHT_ONLY=0 allows table tennis arbs all day; ARB_TT_START_HOUR / ARB_TT_END_HOUR move the window.
const TT_NIGHT_ONLY = Bun.env.ARB_TT_NIGHT_ONLY !== "0";
const TT_START_HOUR = Number(Bun.env.ARB_TT_START_HOUR ?? 23);
const TT_END_HOUR = Number(Bun.env.ARB_TT_END_HOUR ?? 5);
const ptHour = () => Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", hourCycle: "h23" }).format(new Date()));
const AUTO_MAX_PER_DAY = Number(Bun.env.ARB_AUTO_MAX_PER_DAY ?? 10); // most auto-buys in any 24 hours
const AUTO_SKIP = new RegExp(Bun.env.ARB_AUTO_SKIP ?? "darts", "i"); // sports auto-fire never buys (live-only now, so tennis/boxing/MMA are allowed; set ARB_AUTO_SKIP=darts|boxing|... to change); table tennis is exempt below
const ROUTINE = /isn't active|No fresh Goated|only .* edge|edge is only|no longer|above the break-even|already running|just bought|no open price|no usable price/i;

export function makeArbBuy(d: Deps) {
  const { sql } = d;
  const recent = new Map<string, number>();
  const busy = new Set<number>();
  // Bovada answers "not logged in" when its login has expired: tell the phone once, and have auto-fire stop retrying for a while
  let bvdLoginBadUntil = 0, bvdLoginAlertAt = 0;
  // Auto-fire only buys games that start within this many hours (or are already live). The scanner still lists everything.
  const AUTO_MAX_HOURS = Number(Bun.env.ARB_AUTO_MAX_HOURS ?? 12);
  // Auto-fire buys LIVE games only (pre-match arbs still show up on the page; you can still tap them yourself). ARB_AUTO_LIVE_ONLY=0 goes back
  // to the old rule of "live, or starting within ARB_AUTO_MAX_HOURS hours".
  const AUTO_LIVE_ONLY = Bun.env.ARB_AUTO_LIVE_ONLY !== "0";
  const farNoted = new Map<string, number>();
  const isLoginErr = (e: string) => /NotLoggedIn|Please log in|log in to place/i.test(e);

  async function arbBuy(body: any) {
    const id = Number(body?.id);
    if (!Number.isInteger(id)) throw new Error("bad id");
    if (!BETTOR_URL || !BETTOR_KEY) throw new Error("BETTOR_URL and BETTOR_KEY are not set on this service.");
    const dry = body?.dry !== false; // anything except an explicit dry:false is a dry run
    if (!dry && Bun.env.ARB_BUY_ON !== "1") throw new Error("Real buying is switched off. Set ARB_BUY_ON=1 on this service to allow it.");
    // only auto-fire may raise the per-buy cap (never a tap on the page)
    const capUsd = body?.triggeredBy === "auto" && Number(body?.maxUsd) > 0 ? Number(body.maxUsd) : MAX_USD;
    const bankroll = Math.min(capUsd, Math.max(2, Math.round(Number(body?.bankroll ?? DEFAULT_BANK) || DEFAULT_BANK)));

    const [row]: any = await sql`SELECT opp_key, sport, league, player_a, player_b, profit_pct FROM arb_opps WHERE id = ${id} AND active`;
    if (!row) throw new Error("That arb isn't active any more.");
    const key = String(row.opp_key);
    const m = /^([^|~]+)\|([ab])(~bvd)?$/.exec(key);
    if (!m) throw new Error("Only Goated-vs-Polymarket and Bovada-vs-Polymarket moneyline arbs can be bought this way.");
    const pmSlug = m[1], long = m[2] === "a";
    const book = m[3] ? "bovada" : "goated", BK = book === "bovada" ? "Bovada" : "Goated";
    const leg = (book === "bovada" ? d.bvdLegs : d.legs).get(key);
    if (!leg || Date.now() - leg.at > 120000) throw new Error(`No fresh ${BK} details for this arb yet. Wait a few seconds for the next scan and try again.`);

    // Three things that don't depend on each other run AT THE SAME TIME, so the click waits for the slowest one instead of the sum:
    //  - the sportsbook's fresh price (and, for Goated, the ids), read from the VPS
    //  - the fresh Polymarket price
    //  - the opposite-side check: Polymarket nets opposite sides of the same market, so buying the other side of a game you already hold
    //    would cancel the hedge you bought before (same rule auto-fire follows)
    const lookupSportsbook = async (): Promise<{ sel: any; dGt: number }> => {
      if (book === "bovada") {
        const pr = await fetch(`${BETTOR_URL}/bvd-price?outcomeId=${encodeURIComponent(String(leg.outcomeId))}`, { headers: { "x-bettor-key": BETTOR_KEY }, signal: AbortSignal.timeout(20000) });
        const pj: any = await pr.json().catch(() => ({}));
        if (!pr.ok || pj?.error) throw new Error("Bovada lookup failed: " + String(pj?.error ?? pr.status));
        if (pj.http !== 200 || pj.status !== "AVAILABLE") throw new Error(`Bovada says that price is not available right now (${pj.status || "HTTP " + pj.http}).`);
        return { sel: { name: leg.name }, dGt: Number(pj.price) };
      }
      const qs = new URLSearchParams({ slug: String(leg.slug), q: String(leg.q ?? ""), name: String(leg.name ?? "") });
      const sr = await fetch(`${BETTOR_URL}/selection?${qs}`, { headers: { "x-bettor-key": BETTOR_KEY }, signal: AbortSignal.timeout(20000) });
      const sel: any = await sr.json().catch(() => ({}));
      if (!sr.ok || sel?.error) throw new Error("Goated lookup failed: " + String(sel?.error ?? sr.status));
      return { sel, dGt: Number(sel.odds) };
    };
    const [flipRows, sb, p0]: any[] = await Promise.all([
      sql`SELECT 1 AS x FROM arb_trades WHERE opp_key LIKE ${pmSlug + "|" + (long ? "b" : "a") + "%"} AND filled_shares > 0 AND created_at > now() - interval '12 hours' LIMIT 1`,
      lookupSportsbook(),
      d.tradeQuote(pmSlug, long),
    ]);
    if (flipRows?.[0]) throw new Error("You already bought the opposite side of this game on Polymarket. Polymarket nets opposite sides, so this would cancel that hedge. Nothing was bought.");
    const sel: any = sb.sel;
    const dGt: number = sb.dGt;
    if (!(dGt > 1)) throw new Error(`${BK} has no usable price for that outcome right now.`);
    if (p0 == null) throw new Error("Polymarket has no open price for this market right now.");
    if (body?.triggeredBy === "auto" && /boxing|mma|ufc|martial/i.test(String(row.sport ?? "")) && p0 > FIGHT_MAX_PM_PRICE)
      throw new Error(`Fight with a possible draw: auto-fire only buys the Polymarket side when it is the underdog (at or under ${Math.round(FIGHT_MAX_PM_PRICE * 100)}c), and it is ${(p0 * 100).toFixed(1)}c. Nothing was bought.`);
    const dPm = d.pmDecimal(p0);
    const pct = (1 / (1 / dPm + 1 / dGt) - 1) * 100;
    const needPct = body?.triggeredBy === "auto" ? Math.max(MIN_PCT, AUTO_MIN_VERIFIED_PCT) : MIN_PCT;
    if (pct < needPct) throw new Error(`The edge is only ${pct.toFixed(2)}% on the fresh prices (needs ${needPct}%). Nothing was bought.`);

    // Size to Polymarket's order book: the Polymarket cash shrinks to what the book can fill at an acceptable price, and the sportsbook stake is re-split so
    // both outcomes still win, never above the bankroll. (If the book can't be read at all, fall back to the plain bankroll split.)
    let w: [number, number] | null;
    const sized: any = d.sizeStakes ? await d.sizeStakes(pmSlug, long, dGt, dPm, bankroll) : undefined;
    if (sized === null) throw new Error("Polymarket's order book is too thin for even a small safe bet here right now. Nothing was bought.");
    w = sized ? [sized.sg, sized.sp] : d.wholePair(bankroll, dGt, dPm);
    if (!w) throw new Error("Couldn't find whole-dollar stakes that win either way at this bankroll.");
    const [sg, sp] = w; // sg = sportsbook stake, sp = Polymarket cash
    if (sg < 1 || sp < 1) throw new Error("Stakes came out under $1. Try a bigger bankroll.");
    if (body?.triggeredBy === "auto" && sg + sp < AUTO_MIN_TOTAL)
      throw new Error(`Only $${sg + sp} fits Polymarket's depth here (auto-fire needs at least $${AUTO_MIN_TOTAL} in total). Nothing was bought.`);
    const sizedByDepth = !!sized && sg + sp < bankroll * 0.9;

    // check the Polymarket leg is buyable at these exact numbers BEFORE touching the sportsbook
    const tradeBody: any = { id, cash: sp, stake: sg, payout: sg * dGt };
    if (body?.triggeredBy === "auto") tradeBody.triggeredBy = "auto"; // manual clicks stay untagged so the per-tap cap still applies
    const q: any = await d.trade({ ...tradeBody, mode: "quote" });
    if (!q?.ok) throw new Error(`Polymarket's price (${(q?.p0 * 100).toFixed(1)}c) is above the break-even for these stakes. Nothing was bought.`);

    const pmPick = long ? row.player_a : row.player_b;
    const gPick = String(sel.name || leg.name);
    const plan = {
      dry, book: BK, match: `${row.player_a} vs ${row.player_b}`, goated: { pick: gPick, stake: sg, odds: dGt }, // 'goated' is the sportsbook leg, whichever book it is
      polymarket: { pick: pmPick, cash: sp, priceCents: Math.round(p0 * 1000) / 10 }, edgePct: Math.round(pct * 100) / 100,
      expectedProfitUsd: Math.round((q.profitNow ?? 0) * 100) / 100, bankroll, sizedByDepth, totalStaked: sg + sp,
    };
    if (dry) return plan;

    if (busy.has(id)) throw new Error("A buy for this arb is already running.");
    if (Date.now() - (recent.get(key) ?? 0) < 60000) throw new Error("This arb was just bought. Wait a minute before buying it again.");
    busy.add(id); recent.set(key, Date.now());
    try {
      // 1) The sportsbook (Goated or Bovada) goes FIRST. If it says no, Polymarket is never touched, so nothing is left exposed.
      let gOk = false, gErr = "", gUnknown = false;
      try {
        const r = await fetch(`${BETTOR_URL}${book === "bovada" ? "/bvd-bet" : "/bet"}`, {
          method: "POST", headers: { "content-type": "application/json", "x-bettor-key": BETTOR_KEY },
          body: JSON.stringify(book === "bovada" ? { outcomeId: String(leg.outcomeId), amount: sg } : { selection: sel, amount: sg }), signal: AbortSignal.timeout(book === "bovada" ? 45000 : 30000),
        });
        const j: any = await r.json().catch(() => ({}));
        gErr = String(j?.error ?? "");
        if (typeof j?.success === "boolean") { // the VPS reads Goated's full reply and tells us directly
          gOk = j.success; if (!gOk) { gErr = String(j?.error || gErr || "bet rejected"); if (j?.unknown) gUnknown = true; }
        } else { // older VPS version: its reply was cut at 2000 chars, so a good bet could look unreadable
          try { const e = JSON.parse(String(j?.raw ?? ""))?.data?.[0]; gOk = e?.success === true; if (!gOk) gErr = String(e?.error ?? gErr ?? "bet rejected"); }
          catch { gUnknown = true; gErr = gErr || "unreadable reply from Goated (it may still have been placed -- check Goated)"; }
        }
      } catch (e: any) {
        gUnknown = true; gErr = String(e?.message ?? e) + ` (the ${BK} bet may or may not have been placed -- check ${BK})`;
      }

      if (book === "bovada") {
        if (gOk) bvdLoginBadUntil = 0;
        else if (isLoginErr(gErr)) {
          bvdLoginBadUntil = Date.now() + 15 * 60 * 1000;
          if (Date.now() - bvdLoginAlertAt > 30 * 60 * 1000) {
            bvdLoginAlertAt = Date.now();
            void d.ntfy("Bovada login expired", `Bovada says you are not logged in, so Bovada arbs cannot be bought (first seen on ${plan.match}). On the VPS run: setbovada  and paste a fresh Authorization value from Bovada.`, "urgent");
          }
        }
      }

      // 2) Only if Goated accepted: buy the Polymarket hedge. Goated is already placed, so being hedged matters more
      //    than the last cent: if the normal buy doesn't complete, retry once with the wider "force" price ceiling.
      let pm: any = { filled: 0, costEst: 0, done: false, stop: "" };
      if (gOk) {
        const step = async (mode: "buy" | "force") => {
          try { return await d.trade({ ...tradeBody, mode }); }
          catch (e: any) {
            const msg = String(e?.message ?? e);
            return /already fully hedged/i.test(msg) ? { done: true, filled: 0, costEst: 0, stop: "" } : { done: false, filled: 0, costEst: 0, stop: msg };
          }
        };
        const a1: any = await step("buy");
        let tot = { filled: Number(a1.filled ?? 0), cost: Number(a1.costEst ?? 0), done: !!a1.done, stop: String(a1.stop ?? "") };
        if (!tot.done) {
          const a2: any = await step("force");
          tot = { filled: tot.filled + Number(a2.filled ?? 0), cost: tot.cost + Number(a2.costEst ?? 0), done: !!a2.done, stop: String(a2.stop ?? tot.stop) };
        }
        pm = { filled: tot.filled, costEst: tot.cost, done: tot.done, stop: tot.stop };
      }
      const pmFilled = Number(pm.filled), pmDone = !!pm.done;
      const pmErr = String(pm.stop || (gOk ? "" : `not attempted (${BK} did not accept)`));

      if (gOk && !pmDone) {
        void d.ntfy(`${BK} placed, Polymarket NOT fully hedged: ${plan.match}`,
          `${BK} bet $${sg} on ${gPick} @ ${dGt} went through, but Polymarket filled only ${pmFilled.toFixed(2)} shares${pmErr ? " (" + pmErr + ")" : ""}. You are exposed -- finish the hedge by hand.`, "urgent");
      } else if (gUnknown) {
        void d.ntfy(`${BK} bet status unclear: ${plan.match}`,
          `Could not confirm whether the ${BK} bet ($${sg} on ${gPick}) was placed: ${gErr}. Polymarket was NOT bought. Check ${BK} bet history.`, "urgent");
      }
      let tracked = false;
      if (gOk && pmDone && pmFilled > 0) {
        try {
          await d.trackerAdd({
            event: plan.match, sport: row.sport, league: row.league,
            a: { book: "polymarket", pick: pmPick, stake: pm.costEst, payout: pmFilled },
            b: { book, pick: gPick, stake: sg, payout: sg * dGt },
          });
          tracked = true;
        } catch (e: any) { console.error("arb-buy tracker failed:", e?.message ?? e); }
      }
      console.log(`ARB-BUY id=${id} ${BK.toLowerCase()}=${gOk ? "ok" : "FAIL " + gErr} pm=${pmFilled.toFixed(2)}sh ${pmDone ? "done" : "partial/fail " + pmErr} tracked=${tracked}`);
      return { plan, goated: { ok: gOk, error: gOk ? null : gErr }, polymarket: { filledShares: pmFilled, done: pmDone, error: pmDone ? null : (pmErr || null) }, tracked };
    } finally {
      busy.delete(id);
    }
  }

  // ---------------- auto-fire ----------------
  let autoOn = Bun.env.ARB_AUTO === "1";
  const autoLog: { at: number; text: string }[] = [];
  const note = (text: string) => { autoLog.unshift({ at: Date.now(), text }); autoLog.length = Math.min(autoLog.length, 12); console.log("AUTO " + text); };
  const autoBusy = new Set<string>();
  const autoLast = new Map<string, number>();

  // called by the scanner every time it sees a Goated-vs-Polymarket moneyline arb
  async function autoTry(key: string, pct: number, _live: boolean, sport: string) {
    try {
      if (!autoOn || !(pct >= AUTO_PCT)) return;
      if (AUTO_SKIP.test(sport) && !/table tennis/i.test(sport)) return;
      const isTT = /table tennis/i.test(sport);
      const hr = ptHour();
      const inTtWindow = hr >= TT_START_HOUR || hr < TT_END_HOUR;
      if (isTT && TT_NIGHT_ONLY && !inTtWindow) {
        // outside the night window, table tennis is only off-limits while the strategy bot is switched on (it trades the same market on the same account)
        const [stg]: any = await sql`SELECT enabled FROM settings WHERE id = 1`;
        if (stg?.enabled !== false) return;
      }
      const m = /^([^|~]+)\|([ab])(~bvd)?$/.exec(key);
      if (!m) return;
      if (m[3] && Date.now() < bvdLoginBadUntil) return; // Bovada's login is expired: no retrying every minute until it has been fixed
      if (autoBusy.has(key) || Date.now() - (autoLast.get(key) ?? 0) < 20000) return; // don't hammer the same arb every scan
      autoLast.set(key, Date.now());
      autoBusy.add(key);
      try {
        // These four database checks don't depend on each other, so they run together instead of one after another:
        // once per game (never a second buy of it, by auto-fire OR a tap on the page, on either sportsbook), the strategy bot's
        // open position on this market (table tennis only: Polymarket would net the sides), the daily auto-buy count, and the arb itself.
        const [doneRows, heldRows, cntRows, rowRows]: any[] = await Promise.all([
          sql`SELECT 1 AS x FROM arb_trades WHERE opp_key LIKE ${m[1] + "|%"} AND filled_shares > 0 AND created_at > now() - interval '14 days' LIMIT 1`,
          isTT ? sql`SELECT 1 AS x FROM live_trades l JOIN matches m ON m.id = l.match_id WHERE m.market_slug = ${m[1]} AND l.status = 'open' LIMIT 1` : Promise.resolve([]),
          sql`SELECT count(*)::int AS n FROM arb_trades WHERE triggered_by = 'auto' AND filled_shares > 0 AND created_at > now() - interval '24 hours'`,
          sql`SELECT id, start_time, is_live, player_a, player_b FROM arb_opps WHERE opp_key = ${key} AND active`,
        ]);
        if (doneRows?.[0]) return;
        if (isTT && heldRows?.[0]) return;
        if ((cntRows?.[0]?.n ?? 0) >= AUTO_MAX_PER_DAY) return;
        const row: any = rowRows?.[0];
        if (!row) return;
        // not live (live-only mode), or too far ahead / no known start time (old mode) -> don't auto-buy; pre-match money sits locked for days
        const startMs = row.start_time ? new Date(row.start_time).getTime() : NaN;
        const hoursAway = (startMs - Date.now()) / 3600e3;
        const blocked = AUTO_LIVE_ONLY ? !row.is_live : !row.is_live && !(Number.isFinite(hoursAway) && hoursAway <= AUTO_MAX_HOURS);
        if (blocked) {
          if (Date.now() - (farNoted.get(key) ?? 0) > 6 * 3600e3) {
            farNoted.set(key, Date.now());
            note(`skipped ${key}: ${AUTO_LIVE_ONLY ? "not live yet (auto-fire only buys live games)" : (Number.isFinite(hoursAway) ? "starts in " + Math.round(hoursAway) + " h" : "no start time known") + " (auto-fire only buys games starting within " + AUTO_MAX_HOURS + " h)"}`);
          }
          return;
        }
        // an arb you placed by hand and logged in the tracker (or any earlier buy logged there) counts too: same two names AND the same game.
        // With a start time on the tracker row the game must start within 18 hours of this one (so a rematch next week isn't blocked);
        // a row with no start time ("live bet") counts if it was logged in the last 4 days.
        const startIso = Number.isFinite(startMs) ? new Date(startMs).toISOString() : new Date().toISOString();
        const nameA = String(row.player_a ?? ""), nameB = String(row.player_b ?? "");
        const [tracked]: any = await sql`SELECT 1 AS x FROM arb_tracker t
          WHERE t.placed_at > now() - interval '14 days'
            AND length(${nameA}) > 2 AND length(${nameB}) > 2
            AND position(lower(${nameA}) in lower(t.event)) > 0 AND position(lower(${nameB}) in lower(t.event)) > 0
            AND ( (t.event_start IS NOT NULL AND abs(extract(epoch from (t.event_start - ${startIso}::timestamptz))) < 64800)
               OR (t.event_start IS NULL AND t.placed_at > now() - interval '4 days') )
          LIMIT 1`;
        if (tracked) return;
        note(`trying ${key} at ${pct.toFixed(1)}%`);
        const r: any = await arbBuy({ id: row.id, bankroll: AUTO_BANK, maxUsd: AUTO_BANK, dry: false, triggeredBy: "auto" });
        const nothingPlaced = !r?.goated?.ok && !(Number(r?.polymarket?.filledShares ?? 0) > 0) && !/may (still )?have been placed|may or may not|unclear|unreadable/i.test(String(r?.goated?.error ?? ""));
        if (nothingPlaced) { // Goated said no before any money moved: harmless, just wait a bit before trying this arb again
          note(`${r?.plan?.match ?? key}: ${r?.plan?.book ?? "Goated"} said no (${String(r?.goated?.error ?? "").slice(0, 80)}), nothing bought`);
          autoLast.set(key, Date.now() + 40000);
          return;
        }
        const clean = r?.goated?.ok && r?.polymarket?.done;
        note(`${r?.plan?.match ?? key}: ${r?.plan?.book ?? "Goated"} ${r?.goated?.ok ? "ok" : "FAILED"}, Polymarket ${r?.polymarket?.done ? "done" : "NOT done"}`);
        if (!clean) {
          autoOn = false; // anything short of two clean legs stops auto-fire until you switch it back on
          void d.ntfy("Auto-fire switched itself OFF", `The last auto-buy (${r?.plan?.match ?? key}) was not clean: ${r?.plan?.book ?? "Goated"} ${r?.goated?.ok ? "ok" : "failed (" + (r?.goated?.error ?? "?") + ")"}, Polymarket ${r?.polymarket?.done ? "done" : "incomplete"}. Check your positions, then switch it back on at the /auto page.`, "urgent");
        }
      } finally {
        autoBusy.delete(key);
      }
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (!ROUTINE.test(msg)) note(`skipped ${key}: ${msg.slice(0, 140)}`);
    }
  }

  async function autoStatus() {
    let todayCount: number | null = null;
    try { const [c]: any = await sql`SELECT count(*)::int AS n FROM arb_trades WHERE triggered_by = 'auto' AND filled_shares > 0 AND created_at > now() - interval '24 hours'`; todayCount = c?.n ?? 0; } catch {}
    return { on: autoOn, minPct: AUTO_PCT, bankroll: AUTO_BANK, perDayCap: AUTO_MAX_PER_DAY, todayCount, log: autoLog.map((l) => ({ at: l.at, text: l.text })) };
  }
  async function autoSet(body: any) {
    autoOn = body?.on === true;
    note(autoOn ? "switched ON from the page" : "switched OFF from the page");
    return autoStatus();
  }

  const autoPage = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>VeSTAX buy</title>
<style>body{margin:0;background:#0b0d12;color:#e8e8ea;font-family:system-ui,sans-serif}main{max-width:480px;margin:0 auto;padding:20px 14px 40px}
h1{font-size:1.25rem;margin:0 0 4px}h2{font-size:1.05rem;margin:22px 0 4px}p{color:#9aa0ad;margin:6px 0}
button{width:100%;border:0;border-radius:14px;font-weight:800;color:#fff}#b{padding:20px;font-size:1.15rem;margin:14px 0}
.on{background:#1f9d55}.off{background:#c0392b}.card{background:#11141b;border:1px solid #23262f;border-radius:14px;padding:12px 14px;margin-top:10px;font-size:.92rem}
.t{font-weight:700;font-size:1rem;margin-bottom:2px}.buy{background:#2e5cff;padding:16px;font-size:1.05rem;margin-top:10px}.buy:disabled{background:#3a4258}
.out{white-space:pre-line;margin-top:8px;color:#cfd3dc;font-size:.88rem}.log div{padding:4px 0;border-bottom:1px solid #1b1e27}.log div:last-child{border:0}small{color:#7b8190}</style></head><body><main>
<h1>VeSTAX</h1><button id="b" class="off" disabled>...</button><p id="s">Loading...</p>
<h2>Goated / Bovada vs Polymarket arbs</h2><p id="hint">Tap BUY to place both bets from here. Nothing opens.</p><div id="arbs">Loading...</div>
<h2>Auto-fire</h2><div class="card" id="i"></div><div class="card log" id="l"></div>
<script>
var cur=false,bank=5,results={},busy={};
function $(i){return document.getElementById(i)}
function show(d){cur=!!d.on;bank=d.bankroll||bank;var b=$("b");b.disabled=false;b.className=cur?"on":"off";
b.textContent=cur?"AUTO-FIRE IS ON (tap to turn off)":"AUTO-FIRE IS OFF (tap to turn on)";
$("s").textContent=cur?"Buying by itself on Goated vs Polymarket moneyline arbs.":"Nothing will be bought by itself.";
$("i").textContent="Fires at "+d.minPct+"% or better, $"+d.bankroll+" per buy, max "+d.perDayCap+" per 24h. Done in last 24h: "+(d.todayCount===null?"?":d.todayCount)+".";
var l=$("l");l.innerHTML="";if(!d.log.length){l.textContent="No activity yet since the last restart.";}
d.log.forEach(function(x){var e=document.createElement("div");e.textContent=new Date(x.at).toLocaleTimeString()+"  "+x.text;l.appendChild(e);});}
function loadStatus(){fetch("/api/auto").then(function(r){return r.json()}).then(show).catch(function(){$("s").textContent="Could not load. Are you logged in?";});}
$("b").onclick=function(){this.disabled=true;fetch("/api/tracker/auto",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({on:!cur})}).then(function(r){return r.json()}).then(show).catch(loadStatus);};
function summ(j){if(j.error)return "Not bought: "+j.error;var p=j.plan||{},g=j.goated||{},m=j.polymarket||{};
if(!g.ok&&!(m.filledShares>0))return "Nothing was bought. "+(p.book||"Goated")+" said no: "+g.error;
return (p.book||"Goated")+" $"+(p.goated?p.goated.stake:"?")+" @ "+(p.goated?p.goated.odds:"?")+": "+(g.ok?"OK":"FAILED ("+g.error+")")+"\\nPolymarket $"+(p.polymarket?p.polymarket.cash:"?")+": "+(m.done?"OK":"NOT FULLY FILLED"+(m.error?" ("+m.error+")":""))+(j.tracked?"\\nLogged to tracker.":"");}
function buy(id,btn,out){if(busy[id])return;busy[id]=true;btn.disabled=true;btn.textContent="Buying...";out.textContent="";
fetch("/api/tracker/arb-buy",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({id:id,bankroll:bank,dry:false})})
.then(function(r){return r.json()}).then(function(j){results[id]=summ(j)}).catch(function(e){results[id]="Network error: "+e})
.then(function(){busy[id]=false;loadArbs();});}
function card(r){var c=document.createElement("div");c.className="card";
var t=document.createElement("div");t.className="t";t.textContent=r.player_a+" vs "+r.player_b;
var m=document.createElement("small");m.textContent=(r.is_live?"LIVE | ":"")+(r.book_a==="polymarket"?r.book_b:r.book_a)+" | "+r.sport+" | "+r.league+" | "+Number(r.profit_pct).toFixed(2)+"%";
var btn=document.createElement("button");btn.className="buy";var out=document.createElement("div");out.className="out";
if(busy[r.id]){btn.disabled=true;btn.textContent="Buying...";}else{btn.textContent="BUY $"+bank+" (both legs)";}
out.textContent=results[r.id]||"";btn.onclick=function(){buy(r.id,btn,out)};
c.appendChild(t);c.appendChild(m);c.appendChild(btn);c.appendChild(out);return c;}
function isGP(r){return r.market==="Moneyline"&&((r.book_a==="polymarket")!==(r.book_b==="polymarket"))&&(r.book_a==="goated"||r.book_b==="goated"||r.book_a==="bovada"||r.book_b==="bovada");}
function loadArbs(){fetch("/api/arbs").then(function(r){return r.json()}).then(function(d){var el=$("arbs");el.innerHTML="";var list=(d.rows||[]).filter(isGP);
if(!list.length){el.textContent="No Goated or Bovada arbs vs Polymarket right now.";}list.forEach(function(r){el.appendChild(card(r));});})
.catch(function(){$("arbs").textContent="Could not load arbs. Are you logged in?";});}
loadStatus();loadArbs();setInterval(loadStatus,15000);setInterval(loadArbs,4000);
</script></main></body></html>`;

  // The same controls as /auto, as a floating panel that can be injected into the main arbs page without touching its own code.
  const extrasJs = `(function(){
if(window.__vxExtras)return;window.__vxExtras=1;
var bank=5,cur=false,results={},busy={},isOpen=false,arbTimer=null;
function el(t,c,x){var e=document.createElement(t);if(c)e.className=c;if(x!==undefined)e.textContent=x;return e;}
var st=document.createElement("style");
st.textContent="#vxf{position:fixed;right:14px;bottom:14px;z-index:2147483000;border:0;border-radius:999px;padding:14px 22px;font:800 15px system-ui,sans-serif;color:#fff;background:#c0392b;box-shadow:0 4px 18px rgba(0,0,0,.45)}#vxf.on{background:#1f9d55}"+
"#vxp{position:fixed;left:8px;right:8px;bottom:70px;max-height:78vh;overflow:auto;z-index:2147483000;background:#0b0d12;color:#e8e8ea;border:1px solid #2a2e3a;border-radius:16px;padding:14px;font:14px system-ui,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.6)}"+
"@media(min-width:700px){#vxp{left:auto;width:440px}}#vxp h3{margin:0 0 6px;font-size:16px}#vxp p{color:#9aa0ad;margin:4px 0}#vxp button{border:0;border-radius:12px;color:#fff;font-weight:800;width:100%}"+
"#vxp .tg{padding:16px;font-size:15px;margin:8px 0;background:#c0392b}#vxp .tg.on{background:#1f9d55}#vxp .cd{background:#11141b;border:1px solid #23262f;border-radius:12px;padding:10px 12px;margin-top:8px}"+
"#vxp .t{font-weight:700;margin-bottom:2px}#vxp .by{background:#2e5cff;padding:14px;font-size:15px;margin-top:8px}#vxp .by:disabled{background:#3a4258}#vxp .ot{white-space:pre-line;margin-top:6px;color:#cfd3dc;font-size:13px}#vxp small{color:#7b8190}#vxp .x{position:absolute;right:10px;top:8px;width:auto;background:none;font-size:18px;color:#9aa0ad}";
document.head.appendChild(st);
var fab=el("button",null,"BUY");fab.id="vxf";
var pn=el("div");pn.id="vxp";pn.style.display="none";
var xb=el("button","x","x");var ttl=el("h3",null,"VeSTAX buy");
var tg=el("button","tg","...");tg.disabled=true;var sl=el("p",null,"Loading...");
var h2=el("h3",null,"Goated / Bovada vs Polymarket arbs");var hint=el("p",null,"Tap BUY to place both bets from here. The sportsbook goes first.");
var list=el("div",null,"Loading...");var info=el("p");
[xb,ttl,tg,sl,h2,hint,list,info].forEach(function(n){pn.appendChild(n);});
document.body.appendChild(pn);document.body.appendChild(fab);
function show(d){cur=!!d.on;bank=d.bankroll||bank;tg.disabled=false;tg.className="tg"+(cur?" on":"");fab.className=cur?"on":"";
tg.textContent=cur?"AUTO-FIRE IS ON (tap to turn off)":"AUTO-FIRE IS OFF (tap to turn on)";
sl.textContent=cur?"Buying by itself on Goated vs Polymarket moneyline arbs.":"Nothing will be bought by itself.";
info.textContent="Auto-fire: "+d.minPct+"% or better, $"+d.bankroll+" per buy, max "+d.perDayCap+" per 24h. Done in last 24h: "+(d.todayCount===null?"?":d.todayCount)+"."+(d.log&&d.log[0]?" Last: "+d.log[0].text:"");}
function loadStatus(){fetch("/api/auto").then(function(r){return r.json()}).then(show).catch(function(){sl.textContent="Could not load. Are you logged in?";});}
tg.onclick=function(){tg.disabled=true;fetch("/api/tracker/auto",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({on:!cur})}).then(function(r){return r.json()}).then(show).catch(loadStatus);};
function summ(j){if(j.error)return "Not bought: "+j.error;var p=j.plan||{},g=j.goated||{},m=j.polymarket||{};
if(!g.ok&&!(m.filledShares>0))return "Nothing was bought. "+(p.book||"Goated")+" said no: "+g.error;
return (p.book||"Goated")+" $"+(p.goated?p.goated.stake:"?")+" @ "+(p.goated?p.goated.odds:"?")+": "+(g.ok?"OK":"FAILED ("+g.error+")")+"\\nPolymarket $"+(p.polymarket?p.polymarket.cash:"?")+": "+(m.done?"OK":"NOT FULLY FILLED"+(m.error?" ("+m.error+")":""))+(j.tracked?"\\nLogged to tracker.":"");}
function buy(id,btn,out){if(busy[id])return;busy[id]=true;btn.disabled=true;btn.textContent="Buying...";out.textContent="";
fetch("/api/tracker/arb-buy",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({id:id,bankroll:bank,dry:false})})
.then(function(r){return r.json()}).then(function(j){results[id]=summ(j)}).catch(function(e){results[id]="Network error: "+e})
.then(function(){busy[id]=false;loadArbs();});}
function card(r){var c=el("div","cd");c.appendChild(el("div","t",r.player_a+" vs "+r.player_b));
c.appendChild(el("small",null,(r.is_live?"LIVE | ":"")+(r.book_a==="polymarket"?r.book_b:r.book_a)+" | "+r.sport+" | "+r.league+" | "+Number(r.profit_pct).toFixed(2)+"%"));
var b=el("button","by");var o=el("div","ot",results[r.id]||"");
if(busy[r.id]){b.disabled=true;b.textContent="Buying...";}else{b.textContent="BUY $"+bank+" (both legs)";}
b.onclick=function(){buy(r.id,b,o)};c.appendChild(b);c.appendChild(o);return c;}
function isGP(r){return r.market==="Moneyline"&&((r.book_a==="polymarket")!==(r.book_b==="polymarket"))&&(r.book_a==="goated"||r.book_b==="goated"||r.book_a==="bovada"||r.book_b==="bovada");}
function loadArbs(){fetch("/api/arbs").then(function(r){return r.json()}).then(function(d){list.innerHTML="";var a=(d.rows||[]).filter(isGP);
if(!a.length){list.textContent="No Goated or Bovada arbs vs Polymarket right now.";}a.forEach(function(r){list.appendChild(card(r));});})
.catch(function(){list.textContent="Could not load arbs. Are you logged in?";});}
function toggle(v){isOpen=v;pn.style.display=v?"block":"none";fab.textContent=v?"CLOSE":"BUY";
if(v){loadStatus();loadArbs();arbTimer=setInterval(loadArbs,4000);}else if(arbTimer){clearInterval(arbTimer);arbTimer=null;}}
fab.onclick=function(){toggle(!isOpen)};xb.onclick=function(){toggle(false)};
loadStatus();setInterval(loadStatus,20000);
})();`;

  return Object.assign(arbBuy, { autoTry, autoStatus, autoSet, autoPage, extrasJs });
}
