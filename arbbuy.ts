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

// ---- auto-fire settings (OFF after every restart unless ARB_AUTO=1; the /auto page switches it on and off) ----
const AUTO_PCT = Number(Bun.env.ARB_AUTO_PCT ?? 5); // only arbs at or above this edge fire by themselves
const AUTO_BANK = Number(Bun.env.ARB_AUTO_BANKROLL ?? DEFAULT_BANK);
const AUTO_MAX_PER_DAY = Number(Bun.env.ARB_AUTO_MAX_PER_DAY ?? 10); // most auto-buys in any 24 hours
const AUTO_SKIP = /tennis|boxing|mma|ufc|darts/i; // settlement-rule mismatches on retirements/no-shows; table tennis is exempt below
const ROUTINE = /isn't active|No fresh Goated|only .* edge|edge is only|no longer|above the break-even|already running|just bought|no open price|no usable price/i;

export function makeArbBuy(d: Deps) {
  const { sql } = d;
  const recent = new Map<string, number>();
  const busy = new Set<number>();

  async function arbBuy(body: any) {
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
    const tradeBody: any = { id, cash: sp, stake: sg, payout: sg * dGt };
    if (body?.triggeredBy === "auto") tradeBody.triggeredBy = "auto"; // manual clicks stay untagged so the per-tap cap still applies
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
      const m = /^([^|~]+)\|([ab])$/.exec(key);
      if (!m) return;
      if (autoBusy.has(key) || Date.now() - (autoLast.get(key) ?? 0) < 20000) return; // don't hammer the same arb every scan
      autoLast.set(key, Date.now());
      autoBusy.add(key);
      try {
        // once per game, and never the opposite side of one already bought
        const [done]: any = await sql`SELECT 1 AS x FROM arb_trades WHERE (opp_key = ${m[1] + "|a"} OR opp_key = ${m[1] + "|b"}) AND filled_shares > 0 AND created_at > now() - interval '12 hours' LIMIT 1`;
        if (done) return;
        const [cnt]: any = await sql`SELECT count(*)::int AS n FROM arb_trades WHERE triggered_by = 'auto' AND filled_shares > 0 AND created_at > now() - interval '24 hours'`;
        if ((cnt?.n ?? 0) >= AUTO_MAX_PER_DAY) return;
        const [row]: any = await sql`SELECT id FROM arb_opps WHERE opp_key = ${key} AND active`;
        if (!row) return;
        note(`trying ${key} at ${pct.toFixed(1)}%`);
        const r: any = await arbBuy({ id: row.id, bankroll: AUTO_BANK, dry: false, triggeredBy: "auto" });
        const clean = r?.goated?.ok && r?.polymarket?.done;
        note(`${r?.plan?.match ?? key}: Goated ${r?.goated?.ok ? "ok" : "FAILED"}, Polymarket ${r?.polymarket?.done ? "done" : "NOT done"}`);
        if (!clean) {
          autoOn = false; // anything short of two clean legs stops auto-fire until you switch it back on
          void d.ntfy("Auto-fire switched itself OFF", `The last auto-buy (${r?.plan?.match ?? key}) was not clean: Goated ${r?.goated?.ok ? "ok" : "failed (" + (r?.goated?.error ?? "?") + ")"}, Polymarket ${r?.polymarket?.done ? "done" : "incomplete"}. Check your positions, then switch it back on at the /auto page.`, "urgent");
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

  const autoPage = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>VeSTAX auto-fire</title>
<style>body{margin:0;background:#0b0d12;color:#e8e8ea;font-family:system-ui,sans-serif}main{max-width:460px;margin:0 auto;padding:24px 16px}
h1{font-size:1.25rem;margin:0 0 4px}p{color:#9aa0ad;margin:6px 0}button{width:100%;padding:22px;border:0;border-radius:16px;font-size:1.3rem;font-weight:800;color:#fff;margin:18px 0}
.on{background:#1f9d55}.off{background:#c0392b}.card{background:#11141b;border:1px solid #23262f;border-radius:14px;padding:12px 14px;margin-top:12px;font-size:.92rem}
.log div{padding:4px 0;border-bottom:1px solid #1b1e27}.log div:last-child{border:0}small{color:#7b8190}</style></head><body><main>
<h1>VeSTAX auto-fire</h1><p id="s">Loading...</p><button id="b" class="off" disabled>...</button>
<div class="card" id="i"></div><div class="card log" id="l"></div>
<script>
var cur=false;
function show(d){cur=!!d.on;var b=document.getElementById("b");b.disabled=false;b.className=cur?"on":"off";b.textContent=cur?"AUTO-FIRE IS ON (tap to turn off)":"AUTO-FIRE IS OFF (tap to turn on)";
document.getElementById("s").textContent=cur?"Buying by itself on Goated vs Polymarket moneyline arbs.":"Nothing will be bought by itself.";
document.getElementById("i").textContent="Fires at "+d.minPct+"% or better, $"+d.bankroll+" per buy, max "+d.perDayCap+" per 24h. Done in last 24h: "+(d.todayCount===null?"?":d.todayCount)+".";
var l=document.getElementById("l");l.innerHTML="";if(!d.log.length){l.textContent="No activity yet since the last restart.";}
d.log.forEach(function(x){var e=document.createElement("div");e.textContent=new Date(x.at).toLocaleTimeString()+"  "+x.text;l.appendChild(e);});}
function load(){fetch("/api/auto").then(function(r){return r.json()}).then(show).catch(function(){document.getElementById("s").textContent="Could not load. Are you logged in?";});}
document.getElementById("b").onclick=function(){this.disabled=true;fetch("/api/tracker/auto",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({on:!cur})}).then(function(r){return r.json()}).then(show).catch(load);};
load();setInterval(load,15000);
</script></main></body></html>`;

  return Object.assign(arbBuy, { autoTry, autoStatus, autoSet, autoPage });
}
