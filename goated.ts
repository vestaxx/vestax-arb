// goated.ts - drop into the vestax-arb repo next to server.ts
// Needs Node 18+ (built-in fetch). No dependencies.
//
// Railway env vars (never hardcode these):
//   GOATED_ACCESS_TOKEN   Bearer token (expires ~24h)
//   GOATED_REFRESH_TOKEN  refresh_token cookie value (valid ~90 days)
//   GOATED_DEVICE_ID      the x-device-id header value from your browser
//   GOATED_REFRESH_URL    OPTIONAL until we capture the real refresh request
//
// IMPORTANT: Goated needs a VPN. If this runs on Railway, requests must leave
// from an allowed region/IP. Test with a $0.50 bet first.

import { randomUUID } from "node:crypto";

const BET_URL = "https://apis.goated.com/sportsbook/bet";

let accessToken = process.env.GOATED_ACCESS_TOKEN || "";
const refreshToken = process.env.GOATED_REFRESH_TOKEN || "";
const deviceId = process.env.GOATED_DEVICE_ID || "";
const sessionId = randomUUID();

export interface GoatedSelection {
  eventId: string;
  marketKey: string; // includes the trailing "|", copy exactly as seen
  outcomeId: string;
  odds: string; // decimal odds as a string, e.g. "6.382"
  // optional display-only fields from the browser request; try without first,
  // add them if Goated rejects the minimal body
  eventDetails?: unknown[];
  outcomeDetails?: unknown[];
}

function jwtExpiry(token: string): number {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
    return (payload.exp || 0) * 1000;
  } catch {
    return 0;
  }
}

async function refreshAccessToken(): Promise<void> {
  const url = process.env.GOATED_REFRESH_URL;
  if (!url) {
    throw new Error(
      "Access token expired and GOATED_REFRESH_URL is not set. Capture the refresh request in DevTools (filter 'refresh' or 'token') and set it."
    );
  }
  // Best guess at the shape; adjust once the real request is captured.
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://www.goated.com",
      referer: "https://www.goated.com/",
      cookie: `refresh_token=${refreshToken}`,
      "x-device-id": deviceId,
    },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Goated refresh failed ${res.status}: ${text.slice(0, 300)}`);
  const json = JSON.parse(text);
  const next = json.access_token || json.accessToken || json.token;
  if (!next) throw new Error(`Refresh response had no token field: ${text.slice(0, 300)}`);
  accessToken = next;
}

async function ensureFreshToken(): Promise<void> {
  const exp = jwtExpiry(accessToken);
  if (!accessToken || exp - Date.now() < 5 * 60 * 1000) await refreshAccessToken();
}

function buildBody(sel: GoatedSelection, amount: number) {
  const id = `${sel.eventId}-${sel.marketKey}-${sel.outcomeId}`;
  const bet: Record<string, unknown> = {
    key: "0",
    type: "single",
    currency: "USDC",
    fiat_currency: "USD",
    amount,
    selections: [
      {
        event_id: sel.eventId,
        market_key: sel.marketKey,
        outcome_id: sel.outcomeId,
        odds: sel.odds,
      },
    ],
    odds_accept_type: "NONE", // exact odds only; the bet is rejected if they moved
    id,
    amount_pre_fill: String(amount),
    total_odds: sel.odds,
  };
  if (sel.eventDetails) bet.event_details = sel.eventDetails;
  if (sel.outcomeDetails) bet.outcome_details = sel.outcomeDetails;
  return { bets: [bet], lang: "en" };
}

export interface GoatedResult {
  ok: boolean;
  status: number;
  raw: string; // always logged so we can see the exact response format
  json?: unknown;
}

async function post(body: unknown, retried = false): Promise<GoatedResult> {
  await ensureFreshToken();
  const res = await fetch(BET_URL, {
    method: "POST",
    headers: {
      accept: "application/json, text/plain, */*",
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      origin: "https://www.goated.com",
      referer: "https://www.goated.com/",
      cookie: `refresh_token=${refreshToken}`,
      "x-device-id": deviceId,
      "x-analytics-session-id": sessionId,
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36",
    },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  if (res.status === 401 && !retried) {
    await refreshAccessToken();
    return post(body, true);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {}
  return { ok: res.ok, status: res.status, raw, json };
}

/** Place a real bet. Fire this at the same moment as the Polymarket leg with Promise.all. */
export async function placeGoatedBet(sel: GoatedSelection, amountUsd: number): Promise<GoatedResult> {
  return post(buildBody(sel, amountUsd));
}

/**
 * Limit probe. Sends an oversized stake so the response reveals the max-stake error/field.
 * SAFETY: the amount must be MORE than your Goated balance so that it can never fill
 * even if the limit isn't enforced. If the error says "insufficient balance" instead of a
 * limit, lower PROBE_AMOUNT in steps (e.g. 50000, 20000) while keeping it above balance.
 */
export async function probeGoatedLimit(sel: GoatedSelection, probeAmount = 1_000_000): Promise<GoatedResult> {
  const result = await post(buildBody(sel, probeAmount));
  console.log("[goated probe]", result.status, result.raw);
  return result;
}

// Example wiring (adapt to your server framework):
//
// app.get("/probe", async (req, res) => {
//   const r = await probeGoatedLimit({
//     eventId: "<live event id>",
//     marketKey: "<market key with trailing |>",
//     outcomeId: "<outcome id>",
//     odds: "<current odds>",
//   });
//   res.json(r); // paste this back so I can parse the max-stake field
// });
