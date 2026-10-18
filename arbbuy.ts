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
};

const BETTOR_URL = (Bun.env.BETTOR_URL ?? "").replace(/\/+$/, "");
const BETTOR_KEY = Bun.env.BETTOR_KEY ?? "";
const MAX_USD = Number(Bun.env.ARB_BUY_MAX_USD ?? 25); // most that can be spent across both legs in one click
const DEFAULT_BANK = Number(Bun.env.ARB_BUY_BANKROLL ?? 10);
const MIN_PCT = Number(Bun.env.ARB_BUY_MIN_PCT ?? 0.5); // refuse if the fresh prices no longer clear this

export function makeArbBuy(d: Deps) {
  const { sql } = d;
  const recent = new Map<string, number>();
  const busy = new Set<number>();

  return async function arbBuy(body: any) {
    const id = Number(body?.id);
    if (!Number.isInteger(id)) throw new Error("bad id");
    if (!BETTOR_URL || !BETTOR_KEY) throw new Error("BETTOR_URL and BETTOR_KEY are not set on this service.");
    const dry = body?.dry !== false; // anything except an explicit dry:false is a dry run
    if (!dry && Bun.env.ARB_BUY_ON !== "1") throw new Error("Real buying is switched off. Set ARB_BUY_ON=1 on this service to allow it.");
    const bankroll = Math.min(MAX_USD, Math.max(2, Math.round(Number(body?.bankroll ?? DEFAULT_BANK) || DEFAULT_BANK)));

    const [row]: any = await sql`SELECT opp_key, sport, league, player_a, player_b, profit_pct FROM arb_opps WHERE id = ${id} AND active`;
    if (!row) throw new Error("That arb isn't active any more.");
    const key = String(row.opp_key);
    const m = /^([^|~]+)\|([ab])$/.exec(key);
    if (!m) throw new Error("Only Goated-vs-Polymarket moneyline arbs can be bought this way.");
    const pmSlug = m[1], long = m[2] === "a";
    const leg = d.legs.get(key);
    if (!leg || Date.now() - leg.at > 120000) throw new Error("No fresh Goated details for this arb yet. Wait a few seconds for the next scan and try again.");

    // fresh Goated odds + ids, read from the VPS at click time
    const qs = new URLSearchParams({ slug: String(leg.slug), q: String(leg.q ?? ""), name: String(leg.name ?? "") });
    const sr = await fetch(`${BETTOR_URL}/selection?${qs}`, { headers: { "x-bettor-key": BETTOR_KEY }, signal: AbortSignal.timeout(20000) });
    const sel: any = await sr.json().catch(() => ({}));
    if (!sr.ok || sel?.error) throw new Error("Goated lookup failed: " + String(sel?.error ?? sr.status));
    const dGt = Number(sel.odds);
    if (!(dGt > 1)) throw new Error("Goated has no usable price for that outcome right now.");

    // fresh Polymarket price
    const p0 = await d.tradeQuote(pmSlug, long);
    if (p0 == null) throw new Error("Polymarket has no open price for this market right now.");
    const dPm = d.pmDecimal(p0);
    const pct = (1 / (1 / dPm + 1 / dGt) - 1) * 100;
    if (pct < MIN_PCT) throw new Error(`The edge is only ${pct.toFixed(2)}% on the fresh prices (needs ${MIN_PCT}%). Nothing was bought.`);

    const w = d.wholePair(bankroll, dGt, dPm);
    if (!w) throw new Error("Couldn't find whole-dollar stakes that win either way at this bankroll.");
    const [sg, sp] = w; // sg = Goated stake, sp = Polymarket cash
    if (sg < 1 || sp < 1) throw new Error("Stakes came out under $1. Try a bigger bankroll.");

    // check the Polymarket leg is buyable at these exact numbers BEFORE touching Goated
    const tradeBody = { id, cash: sp, stake: sg, payout: sg * dGt };
    const q: any = await d.trade({ ...tradeBody, mode: "quote" });
    if (!q?.ok) throw new Error(`Polymarket's price (${(q?.p0 * 100).toFixed(1)}c) is above the break-even for these stakes. Nothing was bought.`);

    const pmPick = long ? row.player_a : row.player_b;
    const gPick = String(sel.name || leg.name);
    const plan = {
      dry, match: `${row.player_a} vs ${row.player_b}`, goated: { pick: gPick, stake: sg, odds: dGt },
      polymarket: { pick: pmPick, cash: sp, priceCents: Math.round(p0 * 1000) / 10 }, edgePct: Math.round(pct * 100) / 100,
      expectedProfitUsd: Math.round((q.profitNow ?? 0) * 100) / 100, bankroll,
    };
    if (dry) return plan;

    if (busy.has(id)) throw new Error("A buy for this arb is already running.");
    if (Date.now() - (recent.get(key) ?? 0) < 60000) throw new Error("This arb was just bought. Wait a minute before buying it again.");
    busy.add(id); recent.set(key, Date.now());
    try {
      const goatedP = (async () => {
        const r = await fetch(`${BETTOR_URL}/bet`, {
          method: "POST", headers: { "content-type": "application/json", "x-bettor-key": BETTOR_KEY },
          body: JSON.stringify({ selection: sel, amount: sg }), signal: AbortSignal.timeout(30000),
        });
        const j: any = await r.json().catch(() => ({}));
        let ok = false, err = String(j?.error ?? "");
        try { const e = JSON.parse(String(j?.raw ?? ""))?.data?.[0]; ok = e?.success === true; if (!ok) err = String(e?.error ?? err ?? "bet rejected"); } catch { if (!err) err = "unreadable reply from Goated"; }
        return { ok, err };
      })();
      const pmP = d.trade({ ...tradeBody, mode: "buy" });
      const [g, p] = await Promise.allSettled([goatedP, pmP]);

      const gOk = g.status === "fulfilled" && g.value.ok;
      const gErr = g.status === "rejected" ? String((g.reason as any)?.message ?? g.reason) : g.value.err;
      const pm: any = p.status === "fulfilled" ? p.value : null;
      const pmErr = p.status === "rejected" ? String((p.reason as any)?.message ?? p.reason) : String(pm?.stop ?? "");
      const pmFilled = Number(pm?.filled ?? 0), pmDone = !!pm?.done;

      if (gOk && !pmDone) {
        void d.ntfy(`Goated placed, Polymarket NOT fully hedged: ${plan.match}`,
          `Goated bet $${sg} on ${gPick} @ ${dGt} went through, but Polymarket filled only ${pmFilled.toFixed(2)} shares${pmErr ? " (" + pmErr + ")" : ""}. You are exposed -- finish the hedge by hand.`, "urgent");
      } else if (!gOk && pmFilled > 0) {
        void d.ntfy(`Polymarket filled, Goated FAILED: ${plan.match}`,
          `Polymarket bought ${pmFilled.toFixed(2)} shares of ${pmPick} but the Goated bet failed: ${gErr}. You hold an unhedged Polymarket position.`, "urgent");
      }
      let tracked = false;
      if (gOk && pmDone && pmFilled > 0) {
        try {
          await d.trackerAdd({
            event: plan.match, sport: row.sport, league: row.league,
            a: { book: "polymarket", pick: pmPick, stake: pm.costEst, payout: pmFilled },
            b: { book: "goated", pick: gPick, stake: sg, payout: sg * dGt },
          });
          tracked = true;
        } catch (e: any) { console.error("arb-buy tracker failed:", e?.message ?? e); }
      }
      console.log(`ARB-BUY id=${id} goated=${gOk ? "ok" : "FAIL " + gErr} pm=${pmFilled.toFixed(2)}sh ${pmDone ? "done" : "partial/fail " + pmErr} tracked=${tracked}`);
      return { plan, goated: { ok: gOk, error: gOk ? null : gErr }, polymarket: { filledShares: pmFilled, done: pmDone, error: pmErr || null }, tracked };
    } finally {
      busy.delete(id);
    }
  };
}
