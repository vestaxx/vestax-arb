"""
VeSTAX SNIPER — Python bot (table tennis, Polymarket US)

Live strategies (same rules as the Floot version):
  MAIN     A player goes up 2-0 -> buy him if the price is <= main_max_price (80c) or between 85c and 95c. No rebets.
  DECIDER  At 2-2, a player leads the 5th set by 4+ points -> buy him if <= decider_max_price (90c).

Every entry is ALWAYS recorded on paper. Real orders only happen when BOTH:
  - the environment variable LIVE_TRADING=true, and
  - settings.enabled = true in the database.

Safety rules: blocked leagues, 15c floor, no buying the opposite side of a match we hold,
no new entries once anyone has 3 sets, per-match dollar limit, daily loss cap.

SPEED (Oct 2026): scores are checked every SCAN_SECONDS (0.5 s recommended); match rows, paper-trade history and settings are cached in memory so a
scan costs almost no database work; a live order is sent FIRST (the paper record is written right after) on a worker thread, so a slow or
retrying order never stops scanning; prices can come from Polymarket's live order-book stream (WS_MODE=live) instead of a slow REST call,
and in WS_MODE=shadow the stream is only compared against REST in the logs. Every signal logs a TIMING line.

ORDER FILLING (Oct 2026): the first order goes out immediately. If nothing fills (the book can be empty for a
moment after a point is played) it keeps trying for ATTEMPT_SECONDS at a FIXED price ceiling set at signal time:
the lower of the strategy's max price and the signal quote + MAX_CHASE. It never chases past that ceiling, never
buys if the price fell more than MAX_DROP below the signal quote (the signal is stale), and never sends a new order
until the previous one is confirmed finished (no double buys). Fills are recorded with the real shares and cost.
"""

import asyncio
import gc
import json
import os
import re
import sys
import time
import threading
import traceback
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

import psycopg
from psycopg.rows import dict_row
from polymarket_us import PolymarketUS

DATABASE_URL = os.environ["DATABASE_URL"]
LIVE_TRADING = os.environ.get("LIVE_TRADING", "false").lower() == "true"
SCAN_SECONDS = float(os.environ.get("SCAN_SECONDS", "2"))
PT = ZoneInfo("America/Los_Angeles")

# Leagues where real-money bets are blocked, per strategy (matched against the market slug).
# WTT re-blocked for decider on Oct 5 2026 after a WTT loss (owner's choice).
BLOCKED_LEAGUES = {
    "main": ["czechligapro", "wtt"],
    "decider": ["czechligapro", "wtt"],
}
MIN_PRICE = 0.15
DECIDER_MIN_LEAD = 4
EVENTS_LIMIT = 200
SLIPPAGE_BIPS = 600                         # old fixed tolerance, now only a fallback if the API refuses a custom one
# The VeSTAX (main) strategy has TWO price bands: up to main_max_price (80c) and HI_MIN..HI_MAX (85c-95c). The 80-85c band is skipped on purpose (paper results since
# Sep 29: about breakeven before fees, negative after). In the high band the edge is only ~1-3c a share, so the bot never pays more than HI_CHASE over the signal there.
HI_MIN = float(os.environ.get("HI_MIN", "0.85"))
HI_MAX = float(os.environ.get("HI_MAX", "0.95"))
HI_CHASE = float(os.environ.get("HI_CHASE", "0.02"))
MAX_CHASE = float(os.environ.get("MAX_CHASE", "0.08"))              # pay at most this much (in dollars/share) above the signal quote
MAX_DROP = float(os.environ.get("MAX_DROP", "0.06"))                # stop if the price falls this far below the signal quote
ATTEMPT_SECONDS = float(os.environ.get("ATTEMPT_SECONDS", "6"))     # keep trying this long
ATTEMPT_GAP = 0.35                                                  # seconds between attempts
ORDER_THREADS = os.environ.get("ORDER_THREADS", "1") == "1"         # send live orders from a worker thread so scanning never stops
WS_MODE = os.environ.get("WS_MODE", "shadow").lower()               # off | shadow (stream runs, only compared with REST in logs) | live (use fresh stream quotes)
WS_FRESH_SECONDS = float(os.environ.get("WS_FRESH_SECONDS", "1.5")) # a stream quote older than this is ignored
SCORE_LOG = os.environ.get("SCORE_LOG", "1") == "1"                  # write every score change / price jump to score_log for the score-race comparison


# ---------------------------------------------------------------- helpers
def g(obj, *path, default=None):
    """Read nested fields from SDK responses whether they are dicts or objects."""
    cur = obj
    for key in path:
        if cur is None:
            return default
        if isinstance(cur, dict):
            cur = cur.get(key)
        else:
            cur = getattr(cur, key, None)
    return default if cur is None else cur


def num(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def market_type(m):
    return g(m, "sportsMarketType") or g(m, "marketSportType") or ""


def is_table_tennis(ev):
    blob = " ".join(
        str(x)
        for x in [g(ev, "slug"), g(ev, "title"), g(ev, "seriesSlug"), g(ev, "category")]
        + [f"{market_type(m)} {g(m, 'slug')} {g(m, 'question')}" for m in (g(ev, "markets") or [])]
    )
    return re.search(r"table[-_ ]?tennis", blob, re.I) is not None


def parse_score(raw):
    """'11-7, 9-11, 5-3' -> sets won (a, b), list of completed sets, current set points or None."""
    if not isinstance(raw, str) or not raw.strip():
        return None, [], None
    a = b = 0
    done, current = [], None
    for part in [p.strip() for p in raw.split(",") if p.strip()]:
        m = re.search(r"(\d+)\D+(\d+)", part)
        if not m:
            continue
        x, y = int(m.group(1)), int(m.group(2))
        if max(x, y) >= 11 and abs(x - y) >= 2:
            done.append((x, y))
            if x > y:
                a += 1
            else:
                b += 1
        else:
            current = (x, y)
    return (a, b), done, current


def side_price(bbo, side):
    """Real buy price for a side: A = best ask; B = 1 - best bid."""
    d = g(bbo, "marketData") or bbo
    ask, bid = num(g(d, "bestAsk", "value")), num(g(d, "bestBid", "value"))
    p = (ask if ask and ask > 0 else None) if side == "a" else (1 - bid if bid and bid > 0 else None)
    return p if p is not None and 0 < p < 1 else None


def ms(t0):
    return int((time.time() - t0) * 1000)


# ---- score-lag measurement (logging only): how long after the MARKET moves does Polymarket's score field change? ----
LAG_LOCK = threading.Lock()
LAG = {"scores": {}, "stats": [], "last_print": 0.0}     # scores: market slug -> recent score changes we saw
JUMP_MIN = 0.03                                           # a move of 3 cents in the mid price within ~4 s counts as "the market reacted"


def lag_note_score(slug, old_raw, new_raw, ts):
    with LAG_LOCK:
        lst = LAG["scores"].setdefault(slug, [])
        lst.append({"ts": ts, "old": old_raw, "new": new_raw, "matched": False})
        del lst[:-20]
    lag_try_match(slug)


def lag_try_match(slug):
    """Pair each score change with the nearest unmatched price jump within 12 s. d = score time - jump time:
    positive means the market moved FIRST (Polymarket's score was late by that much)."""
    with LAG_LOCK:
        jumps = FEED.jumps.get(slug, []) if FEED else []
        for sc in LAG["scores"].get(slug, []):
            if sc["matched"]:
                continue
            best = None
            for j in jumps:
                if j["matched"]:
                    continue
                d = sc["ts"] - j["ts"]
                if abs(d) <= 12 and (best is None or abs(d) < abs(best[0])):
                    best = (d, j)
            if best:
                d, j = best
                sc["matched"] = j["matched"] = True
                LAG["stats"].append(d)
                short = slug.replace("aec-", "")[:34]
                print(f"SCORELAG {short}: score {sc['old']} -> {sc['new']} | price moved {abs(d):.1f}s {'BEFORE' if d >= 0 else 'AFTER'} the score update ({j['delta']:+.2f})")


def lag_summary():
    now = time.time()
    if now - LAG["last_print"] < 300:
        return
    LAG["last_print"] = now
    with LAG_LOCK:
        d = sorted(LAG["stats"])
        LAG["stats"].clear()
    if not d:
        return
    n = len(d)
    first = sum(1 for x in d if x >= 0) * 100 // n
    print(f"SCORELAG summary (last 5 min): {n} paired events | median {d[n // 2]:+.1f}s | middle half {d[n // 4]:+.1f}s to {d[(3 * n) // 4]:+.1f}s | "
          f"market moved first in {first}% (positive = the market moved before Polymarket's score changed)")


class QuoteFeed:
    """Polymarket's live order-book stream (markets websocket) on a background thread. Keeps the latest best ask / best bid per market.
    Never raises into the bot: if anything goes wrong it logs, waits, reconnects and re-subscribes."""

    def __init__(self):
        self.quotes = {}
        self.known = set()
        self.pending = set()
        self.lock = threading.Lock()
        self.msgs = 0
        self.parsed = 0
        self.samples = 0
        self.cmp_n = 0
        self.cmp_close = 0
        self.last_stats = time.time()
        self.mids = {}     # market slug -> recent (time, mid price) points
        self.jumps = {}    # market slug -> recent price jumps we saw
        self.logged = {}   # market slug -> (time, mid) of the last price row written to score_log
        self.reset = False  # set when Polymarket says we hit the subscription limit: reconnect and subscribe to the current markets in one go
        self.sub_n = 0
        self.err_at = 0.0

    def get(self, slug):
        return self.quotes.get(slug)

    def ensure(self, slug):
        if slug and slug not in self.known:
            with self.lock:
                self.known.add(slug)
                self.pending.add(slug)

    def discard(self, slug):
        """A match is over: forget its market so we never resubscribe to it."""
        with self.lock:
            self.known.discard(slug)
            self.pending.discard(slug)
        for d in (self.quotes, self.mids, self.jumps, self.logged):
            d.pop(slug, None)

    def _on_error(self, e):
        if "max subscriptions" in str(e).lower():
            self.reset = True                     # the next loop tick reconnects and subscribes to everything still live, in one subscription
        if time.time() - self.err_at > 30:        # at most one error line every 30 s
            self.err_at = time.time()
            print(f"WS error: {e}")

    def start(self):
        threading.Thread(target=self._run, daemon=True, name="ws-quotes").start()

    def _run(self):
        fails = 0
        while True:
            started = time.time()
            try:
                asyncio.run(self._main())
            except Exception as e:
                print(f"WS stopped: {e}")
            fails = 0 if time.time() - started > 60 else fails + 1      # a connection that lasted a minute counts as healthy
            time.sleep(min(60, 5 * max(1, fails)))                       # back off if it keeps failing, so a bad setup can't spam the logs
            with self.lock:
                self.pending |= set(self.known)   # after a reconnect, subscribe to everything again

    async def _main(self):
        client = PolymarketUS(key_id=os.environ.get("POLYMARKET_KEY_ID"), secret_key=os.environ.get("POLYMARKET_SECRET_KEY"))
        ws = client.ws.markets()
        closed = asyncio.Event()
        ws.on("market_data", self._on_data)
        ws.on("market_data_lite", self._on_data)
        ws.on("error", self._on_error)
        ws.on("close", lambda *a: closed.set())
        await ws.connect()
        print("WS connected")
        self.reset = False
        self.sub_n = 0
        while not closed.is_set() and not self.reset:
            with self.lock:
                todo = list(self.pending)
                self.pending.clear()
            # ONE subscription can carry many markets, so new markets go out together instead of one subscription each
            # (Polymarket limits how many subscriptions a connection may hold)
            for i in range(0, len(todo), 25):
                self.sub_n += 1
                await ws.subscribe(f"md-{int(time.time())}-{self.sub_n}", "SUBSCRIPTION_TYPE_MARKET_DATA", todo[i:i + 25])
            await asyncio.sleep(0.2)
        raise RuntimeError("websocket closed" if closed.is_set() else "reconnecting to clear the subscription limit")

    def _on_data(self, d):
        try:
            self.msgs += 1
            if self.samples < 3:
                self.samples += 1
                print(f"WS sample: {str(d)[:700]}")
            md = (d.get("marketData") if isinstance(d, dict) else None) or d
            slug = g(md, "marketSlug") or g(md, "slug") or g(md, "symbol")

            def px(level):
                for path in (("px", "value"), ("price", "value"), ("px",), ("price",)):
                    v = num(g(level, *path))
                    if v:
                        return v
                return None

            asks = [px(l) for l in (g(md, "offers") or g(md, "asks") or []) if px(l)]
            bids = [px(l) for l in (g(md, "bids") or []) if px(l)]
            ask = min(asks) if asks else num(g(md, "bestAsk", "value"))
            bid = max(bids) if bids else num(g(md, "bestBid", "value"))
            if slug and (ask or bid):
                now = time.time()
                self.quotes[str(slug)] = {"ask": ask, "bid": bid, "ts": now}
                self.parsed += 1
                self._note_price(str(slug), ask, bid, now)
        except Exception as e:
            print(f"WS parse problem: {e}")

    def _note_price(self, slug, ask, bid, now):
        """Remember recent mid prices; when it moves JUMP_MIN or more within ~4 s, record a jump (once per 2.5 s per market)."""
        mid = (ask + bid) / 2 if (ask and bid) else (ask or bid)
        if not mid:
            return
        # price history for the score-race analysis: one row whenever the mid price has moved 1 cent or more (at most ~2 per second per market)
        lg = self.logged.get(slug)
        if lg is None or (abs(mid - lg[1]) >= 0.01 and now - lg[0] >= 0.4):
            self.logged[slug] = (now, mid)
            log_score("quote", slug, "", f"{ask or 0:.2f}/{bid or 0:.2f}", now)
        hist = self.mids.setdefault(slug, [])
        hist.append((now, mid))
        while hist and now - hist[0][0] > 4.0:
            hist.pop(0)
        base = hist[0] if (hist and now - hist[0][0] >= 0.3) else None
        if base is not None and abs(mid - base[1]) >= JUMP_MIN:
            with LAG_LOCK:
                js = self.jumps.setdefault(slug, [])
                if not js or now - js[-1]["ts"] > 2.5:
                    js.append({"ts": now, "delta": mid - base[1], "matched": False})
                    del js[:-20]
            hist[:] = [(now, mid)]
            lag_try_match(slug)
            log_score("jump", slug, "", f"{mid - base[1]:+.2f}", now)

    def note_compare(self, slug, side, rest, ws, age):
        if rest is None or ws is None:
            return
        self.cmp_n += 1
        if abs(rest - ws) <= 0.03:
            self.cmp_close += 1
        print(f"WSCHECK {slug} side {side}: rest {rest:.2f} stream {ws:.2f} (stream quote {int(age * 1000)} ms old)")

    def stats(self):
        lag_summary()
        if time.time() - self.last_stats >= 60:
            self.last_stats = time.time()
            print(f"WS stats: {self.msgs} messages, {self.parsed} usable quotes, {len(self.known)} markets, "
                  f"{self.cmp_close}/{self.cmp_n} comparisons within 3c")


FEED = None
CONN = None


def ws_price(q, side):
    ask, bid = q.get("ask"), q.get("bid")
    p = (ask if ask and ask > 0 else None) if side == "a" else (1 - bid if bid and bid > 0 else None)
    return p if p is not None and 0 < p < 1 else None


def get_quote(client, slug, side):
    """(price, source, milliseconds). The live stream when WS_MODE=live and its quote is fresh; otherwise the REST call (and, in shadow mode,
    a comparison line against the stream)."""
    q = FEED.get(slug) if FEED else None
    if WS_MODE == "live" and q and time.time() - q["ts"] <= WS_FRESH_SECONDS:
        p = ws_price(q, side)
        if p is not None:
            return p, "stream", 0
    t0 = time.time()
    rest = side_price(client.markets.bbo(slug), side)
    dt = ms(t0)
    if WS_MODE == "shadow" and q and FEED:
        FEED.note_compare(slug, side, rest, ws_price(q, side), time.time() - q["ts"])
    return rest, "rest", dt


def settlement_value(client, slug):
    """1 = side A won, 0 = side B won, None = not resolved yet."""
    try:
        d = g(client.markets.bbo(slug), "marketData")
        v = num(g(d, "settlementPx", "value"))
        if v is not None:
            return v
    except Exception:
        pass
    try:
        s = client.markets.settlement(slug)
        v = g(s, "settlement")
        return num(g(v, "value") if not isinstance(v, (int, float, str)) else v)
    except Exception:
        return None


def today_pt():
    return datetime.now(PT).date()


# ---------------------------------------------------------------- database
def db():
    # prepare_threshold=None: never use server-side prepared statements, so database schema changes
    # (new columns) can't break queries with "cached plan must not change result type".
    return psycopg.connect(DATABASE_URL, row_factory=dict_row, autocommit=True, prepare_threshold=None)


_settings_cache = {"s": None, "ts": 0.0}


def settings(conn, max_age=0.0):
    """max_age > 0 lets the hot path reuse a copy read that recently; everything that must be exact calls it with no max_age."""
    now = time.time()
    c = _settings_cache
    if max_age and c["s"] is not None and now - c["ts"] < max_age and c["s"].get("net_day") == today_pt():
        return dict(c["s"])
    s = conn.execute("SELECT * FROM settings WHERE id=1").fetchone()
    if s["net_day"] != today_pt():  # new Pacific day -> reset the daily counter
        conn.execute("UPDATE settings SET net_today=0, net_day=%s WHERE id=1", (today_pt(),))
        s["net_today"] = 0
    c["s"], c["ts"] = dict(s), now
    return s


def upsert_match(conn, ev, slug):
    names = [g(p, "name") or g(p, "title") or str(p) for p in (g(ev, "participants") or [])]
    if len(names) < 2:
        names = re.split(r"\s+vs\.?\s+", str(g(ev, "title") or ""), flags=re.I) + ["", ""]
    conn.execute(
        """INSERT INTO matches (event_id, player_a, player_b, market_slug)
           VALUES (%s,%s,%s,%s) ON CONFLICT (event_id) DO NOTHING""",
        (str(g(ev, "id")), names[0] or "Player A", names[1] or "Player B", slug),
    )
    return conn.execute("SELECT * FROM matches WHERE event_id=%s", (str(g(ev, "id")),)).fetchone()


_match_cache = {}      # event id -> (match row, time read)
_state = {}            # match id -> {"main_rows": [...] or None, "decider": bool or None}
_last_score = {}       # match id -> last raw score string written to the database
_recheck_at = {}       # event id -> next time we look up a match that dropped off the live list
_held_cache = {}       # match id -> (live positions, time read)
_dbl_cache = {}        # market slug -> (open Doubles rows, time read)
_scan_ts = 0.0         # when the latest score data arrived (start of the TIMING clock)


def get_match(conn, ev, slug):
    eid = str(g(ev, "id"))
    hit = _match_cache.get(eid)
    if hit and hit[0]["status"] == "live" and time.time() - hit[1] < 20:
        return hit[0]
    row = upsert_match(conn, ev, slug)
    _match_cache[eid] = (row, time.time())
    return row


def match_state(match_id):
    return _state.setdefault(match_id, {"main_rows": None, "decider": None})


def held_rows(conn, match_id):
    hit = _held_cache.get(match_id)
    if hit and time.time() - hit[1] < 2.0:
        return hit[0]
    rows = conn.execute("SELECT side, stake FROM live_trades WHERE match_id=%s", (match_id,)).fetchall()
    _held_cache[match_id] = (rows, time.time())
    return rows


def doubles_rows(conn, slug):
    hit = _dbl_cache.get(slug)
    if hit and time.time() - hit[1] < 5.0:
        return hit[0]
    rows = conn.execute("SELECT side FROM martingale_live_trades WHERE market_slug=%s AND status='open'", (slug,)).fetchall()
    _dbl_cache[slug] = (rows, time.time())
    return rows


_EXEC = ThreadPoolExecutor(max_workers=4, thread_name_prefix="order")
_inflight = set()
_inflight_lock = threading.Lock()


def launch(fn, key, *args):
    """Run fn(*args) on a worker thread (inline when ORDER_THREADS=0). `key` = (match id, strategy): never two at once."""
    with _inflight_lock:
        if key in _inflight:
            return False
        _inflight.add(key)

    def run():
        try:
            fn(*args)
        except Exception as e:
            print(f"order worker failed {key}: {e}")
            traceback.print_exc()
        finally:
            with _inflight_lock:
                _inflight.discard(key)

    if ORDER_THREADS:
        _EXEC.submit(run)
    else:
        run()
    return True


def log_score(src, key, names, score, ts):
    """One row into score_log, written on a worker thread so it can never slow scanning (score-race comparison data)."""
    if not SCORE_LOG:
        return

    def run():
        try:
            CONN.execute("INSERT INTO score_log (src, key, names, score, ts) VALUES (%s,%s,%s,%s,to_timestamp(%s))",
                         (src, key, names, str(score)[:240], ts))
        except Exception as e:
            print(f"score_log write failed: {e}")

    try:
        _EXEC.submit(run)
    except Exception:
        pass


_QX = ThreadPoolExecutor(max_workers=6, thread_name_prefix="rest")
_settle_at = {}        # match id -> next time we may try to settle it


def call_timeout(fn, *args, timeout=3.0):
    """Run a Polymarket REST call on a helper thread and give up after `timeout` seconds, so one stalled call can never freeze scanning.
    Returns (ok, value)."""
    try:
        return True, _QX.submit(fn, *args).result(timeout=timeout)
    except Exception as e:
        return False, e


def get_quote_safe(client, slug, side, timeout=2.5):
    ok, v = call_timeout(get_quote, client, slug, side, timeout=timeout)
    return v if ok else (None, "timeout", int(timeout * 1000))


def settle_async(client, match):
    """Settling asks Polymarket for the result, which can stall for ~10 s on a finished market. Do it on a worker thread, at most once
    every 8 s per match, so a match ending can never freeze scanning (it used to cost 8-10 s of missed signals each time)."""
    now = time.time()
    if now < _settle_at.get(match["id"], 0):
        return
    _settle_at[match["id"]] = now + 8
    launch(settle, ("settle", match["id"]), client, CONN, match)


# ---------------------------------------------------------------- orders
def to_plain(obj):
    """Turn SDK responses (pydantic models, objects, dicts, lists) into plain dicts/lists."""
    if obj is None or isinstance(obj, (str, int, float, bool)):
        return obj
    if isinstance(obj, dict):
        return {k: to_plain(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [to_plain(v) for v in obj]
    for attr in ("model_dump", "dict", "to_dict"):
        fn = getattr(obj, attr, None)
        if callable(fn):
            try:
                return to_plain(fn())
            except Exception:
                pass
    if hasattr(obj, "__dict__"):
        return {k: to_plain(v) for k, v in vars(obj).items() if not k.startswith("_")}
    return str(obj)


def read_fill(res):
    """Return (shares, average long-side price, order_id, status, plain data) from any order response shape."""
    data = to_plain(res)
    shares = 0.0
    notional = 0.0
    order_id = None
    status = ""

    def num_of(v):
        if isinstance(v, dict):
            v = v.get("value")
        try:
            return float(v)
        except (TypeError, ValueError):
            return None

    def walk(node):
        nonlocal shares, notional, order_id, status
        if isinstance(node, dict):
            if order_id is None:
                order_id = node.get("id") or node.get("orderId") or node.get("order_id")
            st = node.get("status") or node.get("state")
            if isinstance(st, str) and not status:
                status = st
            for key in ("executions", "fills", "trades"):
                items = node.get(key)
                if isinstance(items, list):
                    for f in items:
                        if not isinstance(f, dict):
                            continue
                        q = num_of(f.get("lastShares", f.get("last_shares", f.get("shares", f.get("quantity")))))
                        p = num_of(f.get("lastPx", f.get("last_px", f.get("price"))))
                        if q and p:
                            shares += q
                            notional += q * p
            for v in node.values():
                if isinstance(v, (dict, list)):
                    walk(v)
        elif isinstance(node, list):
            for v in node:
                walk(v)

    walk(data)
    avg = notional / shares if shares > 0 else None
    return shares, avg, order_id, status, data


def find_key(node, key):
    """First value stored under `key` anywhere inside a nested dict/list, or None."""
    if isinstance(node, dict):
        if key in node:
            return node[key]
        for v in node.values():
            r = find_key(v, key)
            if r is not None:
                return r
    elif isinstance(node, list):
        for v in node:
            r = find_key(v, key)
            if r is not None:
                return r
    return None


def order_finished(raw, status):
    """True once an order can no longer fill (an IOC order ends within moments)."""
    if re.search(r"FILLED|CANCEL|EXPIRE|REJECT", str(status or ""), re.I):
        return True
    leaves = num(find_key(raw, "leavesQuantity"))
    return leaves is not None and leaves == 0


def place_live(client, conn, match, side, price, sets, strategy, stake, max_price):
    """Records nothing on failure; every rule here is a reason to skip quietly."""
    s = settings(conn, max_age=1.0)
    who = match["player_a"] if side == "a" else match["player_b"]
    if not (LIVE_TRADING and s["enabled"]):
        return
    blocked = BLOCKED_LEAGUES.get(strategy, ["czechligapro", "wtt"])
    if any(f"-{lg}-" in match["market_slug"] for lg in blocked):
        return
    if price > max_price or price < MIN_PRICE:
        print(f"skip {strategy}: {who} at {price:.2f} outside {MIN_PRICE}-{max_price}")
        return
    if s["net_today"] <= -s["daily_loss_cap"]:
        conn.execute("UPDATE settings SET enabled=false, paused_reason=%s WHERE id=1",
                     (f"Daily loss cap of ${s['daily_loss_cap']:.0f} reached",))
        return
    held = held_rows(conn, match["id"])
    if any(h["side"] != side for h in held):          # Polymarket nets positions: never buy the other side
        return
    # Also never take the opposite side of an open Doubles bet in the same market (Polymarket would net them).
    # Fails closed: if this check can't run, skip the bet.
    try:
        dbl = doubles_rows(conn, match["market_slug"])
    except Exception as e:
        print(f"skip {strategy}: {who} — could not check Doubles positions: {e}")
        return
    if any(d["side"] != side for d in dbl):
        print(f"skip {strategy}: {who} — Doubles holds the other side of this match")
        return
    if sum(h["stake"] for h in held) + stake > s["max_per_match"]:
        return

    # The most we will ever pay per share, fixed now (the signal quote plus MAX_CHASE, never above the strategy's max price).
    hi_band = strategy == "main" and price > s["main_max_price"]
    cap = round(min(max_price, price + (HI_CHASE if hi_band else MAX_CHASE)), 2)

    def build(px, bips):
        return {
            "marketSlug": match["market_slug"],
            "intent": "ORDER_INTENT_BUY_LONG" if side == "a" else "ORDER_INTENT_BUY_SHORT",
            "type": "ORDER_TYPE_MARKET",
            "cashOrderQty": {"value": f"{stake:.2f}", "currency": "USD"},
            "tif": "TIME_IN_FORCE_IMMEDIATE_OR_CANCEL",
            "synchronousExecution": True,
            "manualOrderIndicator": "MANUAL_ORDER_INDICATOR_AUTOMATIC",
            "slippageTolerance": {
                # the quoted price of the side being bought, plus enough tolerance to reach (not pass) our ceiling
                "currentPrice": {"value": f"{px:.4f}", "currency": "USD"},
                "bips": bips,
            },
        }

    def lookup(order_id):
        for name in ("retrieve", "get"):
            fn = getattr(client.orders, name, None)
            if callable(fn):
                try:
                    return read_fill(fn(order_id))
                except Exception as e:
                    print(f"order lookup failed: {e}")
                    return None
        return None

    def submit(px):
        """One IOC order. Returns (shares, long_px, order_id, status, finished). Never returns until the order is finished
        or we have waited ~2 s (then finished=False and the caller stops, so we can never double-buy)."""
        bips = max(50, int(round((cap / px - 1) * 10000)))
        try:
            res = client.orders.create(build(px, bips))
        except Exception as e:
            if not any(k in str(e).lower() for k in ("slippage", "bips", "invalid", "validation")):
                raise
            print(f"order with {bips} bips was refused ({e}); retrying once with the old {SLIPPAGE_BIPS}")
            res = client.orders.create(build(px, SLIPPAGE_BIPS))
        shares, long_px, order_id, status, raw = read_fill(res)
        print(f"order response ({strategy} {who}, quote {px:.2f}, cap {cap:.2f}, {bips} bips): {str(raw)[:600]}")
        finished = shares > 0 or order_finished(raw, status)
        if shares <= 0 and order_id and not finished:
            for _ in range(8):                      # fills can be reported a moment later
                time.sleep(0.25)
                r2 = lookup(order_id)
                if not r2:
                    continue
                s2, px2, _, st2, raw2 = r2
                print(f"order lookup ({strategy} {who}): {str(raw2)[:300]}")
                if s2 > 0:
                    shares, long_px, status, finished = s2, px2, st2, True
                    break
                if order_finished(raw2, st2):
                    status, finished = st2, True
                    break
        return shares, long_px, order_id, status, finished

    try:
        t0 = time.time()
        quote = price
        attempts = 0
        why = "no order was sent"
        shares, long_px, order_id, status = 0.0, None, None, ""
        while True:
            if quote is not None and quote > cap:
                why = f"ask {quote:.2f} is above our ceiling {cap:.2f}"
            elif quote is not None and quote < price - MAX_DROP:
                why = f"price fell to {quote:.2f} (signal was {price:.2f}), so the signal is stale; stopped"
                break
            else:
                attempts += 1
                shares, long_px, order_id, status, finished = submit(quote if quote is not None else price)
                if shares > 0:
                    break
                if not finished:
                    why = "the order's final state was unclear, so it was not retried (check Polymarket)"
                    break
                why = (f"{attempts} order(s) found nothing to buy at or below {cap:.2f}"
                       + (f" (best ask {quote:.2f})" if quote is not None else " (no quote)"))
            if time.time() - t0 + 0.5 >= ATTEMPT_SECONDS:
                break
            time.sleep(ATTEMPT_GAP)
            fresh = get_quote_safe(client, match["market_slug"], side)[0]
            if fresh is not None:
                quote = fresh
        if shares <= 0 or long_px is None:
            # NOTHING FILLED: record nothing, but say exactly why.
            detail = f"{strategy} {sets[0]}-{sets[1]}, signal {price:.2f}, ceiling {cap:.2f}, tried {time.time() - t0:.1f}s: {why}"
            print(f"NOT FILLED {strategy}: {who} ({detail})")
            conn.execute("UPDATE settings SET paused_reason=%s WHERE id=1", (f"Last order did not fill: {who} | {detail}"[:400],))
            return
        paid = long_px if side == "a" else 1 - long_px
        cost = shares * paid
        conn.execute(
            """INSERT INTO live_trades (match_id, strategy, side, player, order_id, price, stake, sets_at_entry, shares, cost)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
            (match["id"], strategy, side, who, order_id, paid, round(cost, 2), f"{sets[0]}-{sets[1]}", shares, cost),
        )
        _held_cache.pop(match["id"], None)
        print(f"LIVE {strategy}: {who} ${cost:.2f} at {paid:.2f} (shares {shares:.2f}, status {status}, signal {price:.2f}, ceiling {cap:.2f}, {attempts} order(s) in {time.time() - t0:.1f}s)")
    except Exception as e:
        conn.execute("UPDATE settings SET paused_reason=%s WHERE id=1", (f"Order error: {e}"[:200],))


def record_paper(conn, match, strategy, side, price, sets, detail=None):
    who = match["player_a"] if side == "a" else match["player_b"]
    conn.execute(
        """INSERT INTO paper_trades (match_id, strategy, side, player, price, sets_at_entry, detail)
           VALUES (%s,%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING""",
        (match["id"], strategy, side, who, price, f"{sets[0]}-{sets[1]}", detail),
    )


# ---------------------------------------------------------------- strategies
def fire_live(client, match, strategy, side, price, sets, detail, stake_key, max_key, qms, src):
    """Runs on a worker thread: send the live order FIRST (all the safety rules live in place_live), then ALWAYS write the paper record."""
    conn = CONN
    who = match["player_a"] if side == "a" else match["player_b"]
    t_order = time.time()
    try:
        s = settings(conn, max_age=1.0)
        max_price = s[max_key]
        if strategy == "main" and price > max_price and HI_MIN <= price <= HI_MAX:
            max_price = HI_MAX                                   # the second (high) band; prices in the 80c-85c gap still fall through and are skipped
        place_live(client, conn, match, side, price, sets, strategy, s[stake_key], max_price)
    finally:
        try:
            record_paper(conn, match, strategy, side, price, sets, detail)
        except Exception as e:
            print(f"paper record failed ({strategy} {who}): {e}")
        since_scores = int((time.time() - _scan_ts) * 1000) if _scan_ts else -1
        print(f"TIMING {strategy} {who}: price from {src} in {qms} ms, order+checks {ms(t_order)} ms, "
              f"{since_scores} ms from the scores arriving to the order finishing")


def main_strategy(client, conn, match, sets):
    """First trigger at 2-0 -> paper + (maybe) live. Paper also logs 2-1 first entries and
    2-1 / 2-2 rebets after a 2-0 start, so they can keep being compared."""
    a, b = sets
    S = match_state(match["id"])
    if S["main_rows"] is None:
        S["main_rows"] = conn.execute(
            "SELECT * FROM paper_trades WHERE match_id=%s AND strategy='main' ORDER BY id", (match["id"],)
        ).fetchall()
    rows = S["main_rows"]
    if not rows:
        side = "a" if a >= 2 else "b" if b >= 2 else None
        if not side:
            return
    else:
        first, last = rows[0], rows[-1]
        side = first["side"]
        fa, fb = map(int, first["sets_at_entry"].split("-"))
        la, lb = map(int, last["sets_at_entry"].split("-"))
        mine_now, opp_now = (a, b) if side == "a" else (b, a)
        mine_last = la if side == "a" else lb
        started_20 = (fb if side == "a" else fa) == 0
        lost_a_set = (a + b) > (la + lb) and mine_now == mine_last == 2 and opp_now <= 2
        if not (started_20 and lost_a_set):
            return
    live_first = (a, b) in [(2, 0), (0, 2)] and not rows       # real money: 2-0 first entry only
    key = (match["id"], "main")
    if live_first and key in _inflight:
        return
    price, src, qms = get_quote_safe(client, match["market_slug"], side)
    if price is None:
        return
    entry = {"side": side, "sets_at_entry": f"{a}-{b}"}
    if live_first:
        S["main_rows"].append(entry)                            # taken now, so the next scan can't fire it again
        launch(fire_live, key, client, match, "main", side, price, sets, None, "main_stake", "main_max_price", qms, src)
    else:
        record_paper(conn, match, "main", side, price, sets)
        S["main_rows"].append(entry)


def decider_strategy(client, conn, match, sets, current):
    if sets != (2, 2) or not current or abs(current[0] - current[1]) < DECIDER_MIN_LEAD:
        return
    S = match_state(match["id"])
    if S["decider"] is None:
        S["decider"] = bool(conn.execute(
            "SELECT 1 FROM paper_trades WHERE match_id=%s AND strategy='decider'", (match["id"],)).fetchone())
    if S["decider"]:
        return
    key = (match["id"], "decider")
    if key in _inflight:
        return
    side = "a" if current[0] > current[1] else "b"
    price, src, qms = get_quote_safe(client, match["market_slug"], side)
    if price is None:
        return
    S["decider"] = True                                         # taken now, so the next scan can't fire it again
    launch(fire_live, key, client, match, "decider", side, price, sets, f"set 5 at {current[0]}-{current[1]}",
           "decider_stake", "decider_max_price", qms, src)


# ---------------------------------------------------------------- settlement
def settle(client, conn, match):
    v = settlement_value(client, match["market_slug"])
    if v is None:
        return
    winner = "a" if v >= 0.5 else "b"
    if FEED:
        FEED.discard(match["market_slug"])
    _match_cache.pop(match["event_id"], None)
    _state.pop(match["id"], None)
    _held_cache.pop(match["id"], None)
    _last_score.pop(match["id"], None)
    for table in ("paper_trades", "live_trades"):
        for t in conn.execute(f"SELECT * FROM {table} WHERE match_id=%s AND status='open'", (match["id"],)).fetchall():
            won = t["side"] == winner
            pnl = t["stake"] / t["price"] - t["stake"] if won else -t["stake"]
            conn.execute(f"UPDATE {table} SET status=%s, pnl=%s WHERE id=%s", ("won" if won else "lost", pnl, t["id"]))
    live_pnl = conn.execute(
        "SELECT COALESCE(SUM(pnl),0) AS p, COUNT(*) AS n FROM live_trades WHERE match_id=%s", (match["id"],)
    ).fetchone()
    conn.execute(
        "UPDATE matches SET status='done', winner=%s, real_pnl=%s, settled_at=now() WHERE id=%s",
        (winner, live_pnl["p"] if live_pnl["n"] else None, match["id"]),
    )
    if live_pnl["n"]:
        settings(conn)  # make sure the day is current before adding
        conn.execute("UPDATE settings SET net_today = net_today + %s WHERE id=1", (live_pnl["p"],))


# ---------------------------------------------------------------- scanning
def handle_event(client, conn, ev):
    markets = g(ev, "markets") or []
    wm = next((m for m in markets if re.search("table_tennis_match_winner", market_type(m), re.I)), None) or (
        markets[0] if markets else None
    )
    if not wm or not g(wm, "slug"):
        return
    match = get_match(conn, ev, g(wm, "slug"))
    if match["status"] != "live":
        return
    if FEED:
        FEED.ensure(match["market_slug"])
    sets, _, current = parse_score(g(ev, "score"))
    raw = g(ev, "score")
    if sets and _last_score.get(match["id"]) != raw:
        old_raw = _last_score.get(match["id"])
        conn.execute("UPDATE matches SET sets_a=%s, sets_b=%s, raw_score=%s WHERE id=%s",
                     (sets[0], sets[1], raw, match["id"]))
        _last_score[match["id"]] = raw
        if old_raw is not None:
            if FEED:
                lag_note_score(match["market_slug"], old_raw, raw, _scan_ts or time.time())
            log_score("pm", match["market_slug"], f"{match['player_a']} vs {match['player_b']}", raw, _scan_ts or time.time())
    is_over = bool(g(ev, "ended")) or bool(g(wm, "closed"))
    if is_over:
        settle_async(client, match)
        return
    if not sets or max(sets) >= 3:   # never enter once the match is decided
        return
    main_strategy(client, conn, match, sets)
    decider_strategy(client, conn, match, sets, current)


def scan(client, conn):
    global _scan_ts
    t_scan = time.time()
    # Ask for table tennis only (other sports can crowd it out of a capped list).
    ok, res = call_timeout(client.events.list, {"active": True, "live": True, "tagSlug": "table-tennis", "limit": EVENTS_LIMIT}, timeout=6.0)
    if not ok:
        raise res                                   # a stalled call is reported as an ordinary scan error and the next scan starts fresh
    if not (g(res, "events") or []):
        # Fallback in case the tag ever changes: wide sports list, filtered below.
        ok, res = call_timeout(client.events.list, {"active": True, "live": True, "categories": ["sports"], "limit": 500}, timeout=6.0)
        if not ok:
            raise res
    _scan_ts = time.time()
    ev_ms = ms(t_scan)
    events = [e for e in (g(res, "events") or []) if is_table_tennis(e)]
    seen = set()
    t_h = time.time()
    slowest = (0, "")
    for ev in events:
        seen.add(str(g(ev, "id")))
        t_e = time.time()
        try:
            handle_event(client, conn, ev)          # one bad match never stops the rest
        except Exception as e:
            print("match failed", g(ev, "id"), e)
        if ms(t_e) > slowest[0]:
            slowest = (ms(t_e), str(g(ev, "slug") or g(ev, "id")))
    handle_ms = ms(t_h)
    t_r = time.time()
    # Matches that dropped off the live list: look them up (at most every 5 s each) so they get settled
    for m in conn.execute("SELECT * FROM matches WHERE status='live'").fetchall():
        if m["event_id"] in seen:
            continue
        if time.time() < _recheck_at.get(m["event_id"], 0):
            continue
        _recheck_at[m["event_id"]] = time.time() + 5
        try:
            ok, r = call_timeout(client.events.retrieve, int(m["event_id"]), timeout=3.0)
            if not ok:
                continue
            ev = g(r, "event") or r
            if ev:
                handle_event(client, conn, ev)
        except Exception as e:
            print("recheck failed", m["event_id"], e)
    re_ms = ms(t_r)
    t_u = time.time()
    conn.execute("UPDATE settings SET last_scan_at=now(), last_error=NULL WHERE id=1")
    total = ms(t_scan)
    if total > 1500:
        print(f"SLOW scan {total} ms: events.list {ev_ms} ms, handling {len(events)} matches {handle_ms} ms (slowest {slowest[0]} ms: {slowest[1]}), "
              f"rechecks {re_ms} ms, settings update {ms(t_u)} ms")
    return len(events)


def rss_mb():
    """Current memory use of this process in MB (Linux)."""
    try:
        with open("/proc/self/status") as f:
            for line in f:
                if line.startswith("VmRSS:"):
                    return int(line.split()[1]) / 1024
    except Exception:
        pass
    return 0.0


# ---------------------------------------------------------------- tennis recorder (READ-ONLY, runs on its own thread)
# Places NO orders and touches no trading state. Every few seconds it lists Polymarket's live tennis events and writes a row to tennis_ticks whenever the score or the
# price changes (and every 30-60 s otherwise): the raw score / period / clock exactly as Polymarket sends them, plus the best bid / ask of the match-winner market.
# Right after a score change it samples every poll for 90 s, so the price's reaction can be measured. When a match is over, tennis_results gets the winner from the
# market's own settlement. That is the data a backtest of tennis ideas needs ("someone is up 2+ games in set 1 but still priced <= 45c"), none of which was saved before.
# It has its own Polymarket client, its own database connection and its own small thread pool, so it can never slow or block the table-tennis bot.
TENNIS_REC = os.environ.get("TENNIS_REC", "1") == "1"
TENNIS_REC_POLL = float(os.environ.get("TENNIS_REC_POLL", "4"))
_TEN_BAD = re.compile(r"set|game|total|spread|handicap|point|tiebreak|ace|prop")
_TQ = ThreadPoolExecutor(max_workers=3, thread_name_prefix="tenrec")


def ten_call(fn, *args, timeout=5.0):
    try:
        return True, _TQ.submit(fn, *args).result(timeout=timeout)
    except Exception as e:
        return False, e


def ten_winner_market(ev):
    """The full-match winner market of a tennis event (not a set, game, total or spread market)."""
    markets = g(ev, "markets") or []
    for m in markets:
        t = str(market_type(m)).lower()
        if "tennis" in t and re.search(r"(match_winner|match_result|moneyline|winner)", t) and not _TEN_BAD.search(re.sub(r"match_winner|match_result", "", t)):
            return m
    for m in markets:
        t = str(market_type(m)).lower()
        v2 = str(g(m, "sportsMarketTypeV2") or "").upper()
        if "MONEYLINE" in v2 and not _TEN_BAD.search(t) and len(g(m, "marketSides") or []) == 2:
            return m
    return None


class TennisRec:
    def __init__(self, client, conn):
        self.client, self.conn = client, conn
        self.state = {}               # market slug -> {key, last_row, burst, ask, bid}
        self.sample_logged = False
        self.rows = 0
        self.last_log = 0.0
        self.last_err = 0.0
        self.last_resolve = 0.0

    def err(self, msg, now):
        if now - self.last_err > 60:
            self.last_err = now
            print(f"TENNIS-REC {msg}")

    def step(self, now):
        ok, res = ten_call(self.client.events.list, {"active": True, "live": True, "tagSlug": "tennis", "limit": 100}, timeout=8.0)
        if not ok:
            self.err(f"event list failed: {str(res)[:140]}", now)
            return
        evs = list(g(res, "events") or [])
        if not evs:
            self.err("no live tennis events returned (tagSlug=tennis)", now)
            return
        if not self.sample_logged:
            self.sample_logged = True
            plain = to_plain(evs[0])
            markets = plain.pop("markets", None) or []
            print(f"TENNIS-REC sample event (markets removed): {json.dumps(plain, default=str)[:1600]}")
            types = [f"{m.get('sportsMarketType')}|{m.get('sportsMarketTypeV2')}" for m in markets if isinstance(m, dict)]
            wm0 = ten_winner_market(evs[0])
            print(f"TENNIS-REC sample market types: {json.dumps(types)[:700]} | winner pick: {g(wm0, 'slug') if wm0 else 'NONE'}")
        seen = set()
        for ev in evs:
            wm = ten_winner_market(ev)
            slug = g(wm, "slug") if wm else None
            if not slug:
                continue
            slug = str(slug)
            seen.add(slug)
            score, period, elapsed = str(g(ev, "score") or ""), str(g(ev, "period") or ""), str(g(ev, "elapsed") or "")
            key = score + "|" + period
            st = self.state.get(slug) or {"key": "\0", "last_row": 0.0, "burst": 0.0, "ask": -1.0, "bid": -1.0}
            changed = key != st["key"]
            if changed:
                st["burst"] = now + 90
            due = changed or now < st["burst"] or now - st["last_row"] >= 30
            if not due:
                self.state[slug] = st
                continue
            ok2, bb = ten_call(self.client.markets.bbo, slug, timeout=4.0)
            md = g(bb, "marketData") if ok2 else None
            ask, bid = num(g(md, "bestAsk", "value")), num(g(md, "bestBid", "value"))
            moved = ask is not None and bid is not None and (abs(ask - st["ask"]) >= 0.01 or abs(bid - st["bid"]) >= 0.01)
            if not (changed or now < st["burst"] or moved or now - st["last_row"] >= 60):
                st["key"] = key
                self.state[slug] = st
                continue
            sides = g(wm, "marketSides") or []
            long_name = next((g(s, "description") for s in sides if g(s, "long")), None)
            short_name = next((g(s, "description") for s in sides if s is not None and not g(s, "long")), None)
            plain = to_plain(ev)
            if isinstance(plain, dict):
                plain.pop("markets", None)
            extra = json.dumps(plain, default=str)[:900]
            try:
                self.conn.execute(
                    "INSERT INTO tennis_ticks (event_slug, market_slug, title, long_name, short_name, score, period, elapsed, ask, bid, ask_sh, bid_sh, state, extra) "
                    "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                    (str(g(ev, "slug") or ""), slug, str(g(ev, "title") or ""), long_name, short_name, score, period, elapsed, ask, bid,
                     num(g(md, "askShares")) or None, num(g(md, "bidShares")) or None, str(g(md, "state") or ""), extra))
                self.rows += 1
            except Exception as e:
                self.err(f"insert failed: {str(e)[:140]}", now)
                raise
            st.update(key=key, last_row=now, ask=ask if ask is not None else st["ask"], bid=bid if bid is not None else st["bid"])
            self.state[slug] = st
        for k in [k for k, v in self.state.items() if k not in seen and now - v["last_row"] > 3600]:
            del self.state[k]
        if now - self.last_log > 600:
            self.last_log = now
            print(f"TENNIS-REC: {len(evs)} live tennis events, {len(self.state)} tracked, {self.rows} rows written since start")

    def resolve(self, now):
        """The winner of each finished match, from the market's own settlement (markets that stopped ticking 25+ minutes ago)."""
        if now - self.last_resolve < 600:
            return
        self.last_resolve = now
        rows = self.conn.execute(
            "SELECT market_slug FROM tennis_ticks WHERE ts > now() - interval '10 days' AND market_slug NOT IN (SELECT market_slug FROM tennis_results) "
            "GROUP BY market_slug HAVING max(ts) < now() - interval '25 minutes' ORDER BY max(ts) LIMIT 40").fetchall()
        for r in rows:
            slug = r["market_slug"]
            ok, v = ten_call(settlement_value, self.client, slug, timeout=8.0)
            if not ok or v is None or not (abs(v - 1) < 0.01 or abs(v) < 0.01):
                continue
            nm = self.conn.execute("SELECT long_name, short_name FROM tennis_ticks WHERE market_slug=%s AND long_name IS NOT NULL ORDER BY ts DESC LIMIT 1", (slug,)).fetchone() or {}
            self.conn.execute("INSERT INTO tennis_results (market_slug, long_name, short_name, long_won) VALUES (%s,%s,%s,%s) ON CONFLICT (market_slug) DO NOTHING",
                              (slug, nm.get("long_name"), nm.get("short_name"), v >= 0.5))


def tennis_recorder():
    """Thread body: runs forever, survives any error, never touches trading."""
    print(f"Tennis recorder: ON (read-only, writes tennis_ticks / tennis_results), poll every {TENNIS_REC_POLL}s")
    rec, loops = None, 0
    while True:
        started = time.time()
        try:
            if rec is None:
                rec = TennisRec(make_client(), db())
            rec.step(started)
            rec.resolve(started)
            loops += 1
            if loops % 1500 == 0:                 # fresh client now and then, like the main loop does
                rec.client = make_client()
        except Exception as e:
            print(f"TENNIS-REC loop error (will retry): {str(e)[:160]}")
            try:
                if rec is not None:
                    rec.conn.close()
            except Exception:
                pass
            rec = None
            time.sleep(5)
        time.sleep(max(0.5, TENNIS_REC_POLL - (time.time() - started)))


def make_client():
    return PolymarketUS(
        key_id=os.environ.get("POLYMARKET_KEY_ID"),
        secret_key=os.environ.get("POLYMARKET_SECRET_KEY"),
    )


def main():
    global FEED, CONN
    client = make_client()
    print(f"VeSTAX bot starting. LIVE_TRADING={LIVE_TRADING}, scan every {SCAN_SECONDS}s, order threads={ORDER_THREADS}, ws={WS_MODE}")
    CONN = conn = db()
    if TENNIS_REC:
        threading.Thread(target=tennis_recorder, daemon=True, name="tennis-rec").start()
    if WS_MODE != "off":
        FEED = QuoteFeed()
        FEED.start()
    scans = 0
    last_n, last_print = -1, 0.0
    while True:
        started = time.time()
        try:
            n = scan(client, conn)
            if n != last_n or time.time() - last_print >= 10:      # at 2 scans a second, log once every 10 s (or when the count changes)
                print(f"{datetime.now(timezone.utc):%H:%M:%S} scanned {n} live matches")
                last_n, last_print = n, time.time()
        except Exception as e:
            traceback.print_exc()
            try:
                conn.execute("UPDATE settings SET last_error=%s WHERE id=1", (str(e)[:300],))
            except Exception:
                CONN = conn = db()  # reconnect if the database connection dropped
        scans += 1
        if FEED:
            FEED.stats()
        # Memory hygiene: free garbage often, and start a fresh API client regularly.
        if scans % 150 == 0:
            gc.collect()
        if scans % 1500 == 0:
            client = make_client()
            gc.collect()
        # Safety net: restart cleanly (between scans, never mid-order) before Railway's 1 GB limit kills us.
        mem = rss_mb()
        if mem > 700:
            if _inflight:
                time.sleep(0.5)
                continue
            print(f"memory {mem:.0f} MB — restarting cleanly")
            try:
                conn.close()
            except Exception:
                pass
            sys.exit(0)
        time.sleep(max(0.0, SCAN_SECONDS - (time.time() - started)))


if __name__ == "__main__":
    main()
