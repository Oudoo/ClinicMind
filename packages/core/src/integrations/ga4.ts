import { JWT } from "google-auth-library";
import { rateLimitedFetch } from "../rate-limiter.js";
import { env } from "../env.js";
import {
  type Connector,
  type ConnectorContext,
  type FetchResult,
  ConnectorError,
} from "./types.js";
import type { IncomingMetric } from "../sanity.js";

const DATA_API = "https://analyticsdata.googleapis.com/v1beta";

/**
 * GA4 Data API connector. Two auth modes:
 *  1) Service account (recommended): GA4_SERVICE_ACCOUNT_JSON env (base64)
 *     with the SA email added as a Viewer on the GA4 property.
 *  2) Per-integration OAuth: credentials { refreshToken } using the
 *     platform Google OAuth app.
 * externalAccountId is the numeric GA4 property id.
 */
async function getAccessToken(ctx: ConnectorContext): Promise<string> {
  if (ctx.credentials.refreshToken && env.googleClientId && env.googleClientSecret) {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: env.googleClientId,
        client_secret: env.googleClientSecret,
        refresh_token: ctx.credentials.refreshToken,
        grant_type: "refresh_token",
      }),
    });
    if (!res.ok) throw new ConnectorError("ga4", `OAuth refresh failed: HTTP ${res.status}`, false);
    const body = (await res.json()) as { access_token: string };
    return body.access_token;
  }

  if (env.ga4ServiceAccountJson) {
    const sa = JSON.parse(Buffer.from(env.ga4ServiceAccountJson, "base64").toString("utf8"));
    const jwt = new JWT({
      email: sa.client_email,
      key: sa.private_key,
      scopes: ["https://www.googleapis.com/auth/analytics.readonly"],
    });
    const { access_token } = await jwt.authorize();
    if (!access_token) throw new ConnectorError("ga4", "Service account authorization failed", false);
    return access_token;
  }

  throw new ConnectorError(
    "ga4",
    "No GA4 credentials: configure GA4_SERVICE_ACCOUNT_JSON or connect via Google OAuth",
    false
  );
}

export const ga4Connector: Connector = {
  provider: "ga4",

  async fetchMetrics(ctx: ConnectorContext, since: string, until: string): Promise<FetchResult> {
    const token = await getAccessToken(ctx);
    const propertyId = ctx.externalAccountId.replace(/^properties\//, "");
    const url = `${DATA_API}/properties/${propertyId}:runReport`;

    const { response, requestId } = await rateLimitedFetch("ga4", ctx.tenantId, url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        dateRanges: [{ startDate: since, endDate: until }],
        dimensions: [{ name: "date" }, { name: "sessionDefaultChannelGroup" }],
        metrics: [
          { name: "sessions" },
          { name: "totalUsers" },
          { name: "conversions" },
          { name: "totalRevenue" },
          { name: "engagementRate" },
        ],
        limit: 100000,
      }),
    });

    const body = (await response.json()) as Ga4Report & { error?: { message: string; status: string } };
    if (!response.ok || body.error) {
      throw new ConnectorError(
        "ga4",
        body.error?.message ?? `HTTP ${response.status}`,
        body.error?.status !== "PERMISSION_DENIED",
        requestId
      );
    }

    const metrics: IncomingMetric[] = [];
    const refUrl = `https://analytics.google.com/analytics/web/#/p${propertyId}/reports/intelligenthome`;
    for (const row of body.rows ?? []) {
      const rawDate = row.dimensionValues?.[0]?.value ?? "";
      const date = `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6, 8)}`;
      const channel = row.dimensionValues?.[1]?.value ?? "unknown";
      const dims = { channel };
      const base = { date, dimensions: dims, sourceRequestId: requestId ?? undefined, sourceReferenceUrl: refUrl };
      const names = ["sessions", "total_users", "conversions", "revenue", "engagement_rate"];
      row.metricValues?.forEach((mv, i) => {
        const metricName = names[i];
        if (!metricName) return;
        metrics.push({
          ...base,
          metric: metricName,
          value: Number(mv.value ?? 0),
          currency: metricName === "revenue" ? "USD" : undefined,
        });
      });
    }
    return { metrics, requestIds: requestId ? [requestId] : [] };
  },

  async testConnection(ctx: ConnectorContext) {
    try {
      const token = await getAccessToken(ctx);
      const propertyId = ctx.externalAccountId.replace(/^properties\//, "");
      const { response } = await rateLimitedFetch(
        "ga4",
        ctx.tenantId,
        `${DATA_API}/properties/${propertyId}/metadata`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      return response.ok
        ? { ok: true, detail: `Connected to GA4 property ${propertyId}` }
        : { ok: false, detail: `GA4 metadata probe failed: HTTP ${response.status}` };
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
  },
};

interface Ga4Report {
  rows?: {
    dimensionValues?: { value?: string }[];
    metricValues?: { value?: string }[];
  }[];
}
