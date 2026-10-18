// goated-probe.ts - put next to server.ts and goated.ts (replaces the earlier version)
// Read-only limit probe. Sends an oversized stake that can never fill, and returns Goated's reply.
// Never calls placeGoatedBet.
import { probeGoatedLimit } from "./goated";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function goatedProbeRoute(
  url: URL,
  sec: Record<string, string>,
  gtEvents: Map<string, any>,
  gt: (path: string) => Promise<any>,
): Promise<Response> {
  try {
    const q = url.searchParams;
    let sel: any = q.get("eventId")
      ? { eventId: q.get("eventId")!, marketKey: q.get("marketKey") ?? "", outcomeId: q.get("outcomeId") ?? "", odds: q.get("odds") ?? "" }
      : null;
    let sample: any = null;

    if (!sel) {
      // live events first, then upcoming ones; the scanner is also hitting Goated hard, so a 429 is
      // retried with a growing pause and a different event each time
      const all: any[] = [...gtEvents.values()];
      const cands = [...all.filter((e) => e.status === "live"), ...all.filter((e) => e.status !== "live")].slice(0, 8);
      if (!cands.length) return Response.json({ error: "Goated catalogue is empty right now, try again in a minute" }, { headers: sec });
      let lastErr = "";
      for (let i = 0; i < cands.length && !sel; i++) {
        const ev = cands[i];
        try {
          const mk: any[] = (await gt(`/event/${ev.slug}/formatted-markets?lang=en&category=all`)) ?? [];
          const w = mk.find((x: any) => x.id === ev.sport.winnerId) ?? mk[0];
          const s = (w?.selectionGroups ?? []).flatMap((g: any) => g.selections ?? []).find((x: any) => x.active && Number(x.odds) > 1);
          if (!s) continue;
          // included in the response so we can see Goated's real field names if the guess below is wrong
          sample = { event: ev.slug, status: ev.status, marketTitle: w?.title, selection: s };
          sel = {
            eventId: String(s?.event_id ?? w?.event_id ?? ev.slug ?? ""),
            marketKey: String(s?.market_key ?? ""),
            outcomeId: String(s?.outcome_id ?? s?.id ?? ""),
            odds: String(s?.odds ?? ""),
          };
        } catch (e: any) {
          lastErr = String(e?.message ?? e);
          await sleep(1500 * (i + 1));
        }
      }
      if (!sel) return Response.json({ error: "couldn't load any Goated market (last error: " + lastErr + ")", tried: cands.length }, { headers: sec });
    }

    if (!sel.eventId || !sel.marketKey || !sel.outcomeId || !sel.odds) {
      return Response.json(
        { error: "couldn't build a selection automatically; pass eventId, marketKey, outcomeId, odds as query params", sample },
        { headers: sec },
      );
    }

    const r = await probeGoatedLimit(sel);
    return Response.json(
      { sel, sample, status: r.status, raw: r.raw.slice(0, 2000) },
      { headers: { "cache-control": "no-store", ...sec } },
    );
  } catch (e: any) {
    return Response.json({ error: String(e?.message ?? e).slice(0, 300) }, { status: 500, headers: sec });
  }
}
