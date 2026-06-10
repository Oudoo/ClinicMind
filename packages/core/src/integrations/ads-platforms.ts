import { rateLimitedFetch } from "../rate-limiter.js";
import { env } from "../env.js";
import {
  type Connector,
  type ConnectorContext,
  type FetchResult,
  ConnectorError,
} from "./types.js";
import type { IncomingMetric } from "../sanity.js";

/**
 * Google Ads connector — REST searchStream with GAQL.
 * Credentials: { refreshToken, customerId?, loginCustomerId? }.
 * Requires GOOGLE_ADS_DEVELOPER_TOKEN + platform Google OAuth app.
 */
export const googleAdsConnector: Connector = {
  provider: "google_ads",

  async fetchMetrics(ctx: ConnectorContext, since: string, until: string): Promise<FetchResult> {
    const token = await googleOAuthAccessToken(ctx.credentials.refreshToken);
    const customerId = ctx.externalAccountId.replace(/-/g, "");
    const query = `
      SELECT segments.date, campaign.id, campaign.name,
             metrics.cost_micros, metrics.impressions, metrics.clicks,
             metrics.conversions, metrics.conversions_value
      FROM campaign
      WHERE segments.date BETWEEN '${since}' AND '${until}'`;

    const { response, requestId } = await rateLimitedFetch(
      "google_ads",
      ctx.tenantId,
      `https://googleads.googleapis.com/v18/customers/${customerId}/googleAds:searchStream`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "developer-token": env.googleAdsDeveloperToken,
          ...(ctx.credentials.loginCustomerId
            ? { "login-customer-id": ctx.credentials.loginCustomerId.replace(/-/g, "") }
            : {}),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query }),
      }
    );
    if (!response.ok) {
      const text = await response.text();
      throw new ConnectorError("google_ads", `HTTP ${response.status}: ${text.slice(0, 300)}`, response.status >= 500, requestId);
    }
    const batches = (await response.json()) as { results?: GoogleAdsRow[] }[];
    const metrics: IncomingMetric[] = [];
    const refUrl = `https://ads.google.com/aw/overview?ocid=${customerId}`;
    for (const batch of batches) {
      for (const row of batch.results ?? []) {
        const base = {
          date: row.segments?.date ?? since,
          dimensions: {
            campaign_id: String(row.campaign?.id ?? ""),
            campaign_name: row.campaign?.name ?? "",
          },
          sourceRequestId: requestId ?? undefined,
          sourceReferenceUrl: refUrl,
        };
        metrics.push(
          { ...base, metric: "spend", value: Number(row.metrics?.costMicros ?? 0) / 1_000_000, currency: "USD" },
          { ...base, metric: "impressions", value: Number(row.metrics?.impressions ?? 0) },
          { ...base, metric: "clicks", value: Number(row.metrics?.clicks ?? 0) },
          { ...base, metric: "conversions", value: Number(row.metrics?.conversions ?? 0) },
          { ...base, metric: "revenue", value: Number(row.metrics?.conversionsValue ?? 0), currency: "USD" }
        );
      }
    }
    return { metrics, requestIds: requestId ? [requestId] : [] };
  },

  async testConnection(ctx: ConnectorContext) {
    try {
      await googleOAuthAccessToken(ctx.credentials.refreshToken);
      return { ok: true, detail: "Google OAuth token valid" };
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
  },
};

async function googleOAuthAccessToken(refreshToken: string): Promise<string> {
  if (!env.googleClientId || !env.googleClientSecret) {
    throw new ConnectorError("google_ads", "Google OAuth app not configured", false);
  }
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.googleClientId,
      client_secret: env.googleClientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new ConnectorError("google_ads", `OAuth refresh failed: HTTP ${res.status}`, false);
  return ((await res.json()) as { access_token: string }).access_token;
}

interface GoogleAdsRow {
  segments?: { date?: string };
  campaign?: { id?: number; name?: string };
  metrics?: {
    costMicros?: string;
    impressions?: string;
    clicks?: string;
    conversions?: number;
    conversionsValue?: number;
  };
}

/**
 * TikTok Marketing API connector. Credentials: { accessToken }.
 * externalAccountId = advertiser_id.
 */
export const tiktokConnector: Connector = {
  provider: "tiktok",

  async fetchMetrics(ctx: ConnectorContext, since: string, until: string): Promise<FetchResult> {
    const url =
      "https://business-api.tiktok.com/open_api/v1.3/report/integrated/get/?" +
      new URLSearchParams({
        advertiser_id: ctx.externalAccountId,
        report_type: "BASIC",
        data_level: "AUCTION_CAMPAIGN",
        dimensions: JSON.stringify(["campaign_id", "stat_time_day"]),
        metrics: JSON.stringify(["spend", "impressions", "clicks", "conversion", "total_complete_payment_rate", "total_purchase_value"]),
        start_date: since,
        end_date: until,
        page_size: "1000",
      }).toString();

    const { response, requestId } = await rateLimitedFetch("tiktok", ctx.tenantId, url, {
      headers: { "Access-Token": ctx.credentials.accessToken },
    });
    const body = (await response.json()) as {
      code: number;
      message: string;
      request_id?: string;
      data?: { list?: TikTokRow[] };
    };
    const rid = body.request_id ?? requestId;
    if (body.code !== 0) {
      throw new ConnectorError("tiktok", body.message, body.code >= 50000, rid);
    }
    const metrics: IncomingMetric[] = [];
    const refUrl = `https://ads.tiktok.com/i18n/dashboard?aadvid=${ctx.externalAccountId}`;
    for (const row of body.data?.list ?? []) {
      const base = {
        date: (row.dimensions?.stat_time_day ?? since).slice(0, 10),
        dimensions: { campaign_id: row.dimensions?.campaign_id ?? "" },
        sourceRequestId: rid ?? undefined,
        sourceReferenceUrl: refUrl,
      };
      metrics.push(
        { ...base, metric: "spend", value: Number(row.metrics?.spend ?? 0), currency: "USD" },
        { ...base, metric: "impressions", value: Number(row.metrics?.impressions ?? 0) },
        { ...base, metric: "clicks", value: Number(row.metrics?.clicks ?? 0) },
        { ...base, metric: "conversions", value: Number(row.metrics?.conversion ?? 0) },
        { ...base, metric: "revenue", value: Number(row.metrics?.total_purchase_value ?? 0), currency: "USD" }
      );
    }
    return { metrics, requestIds: rid ? [rid] : [] };
  },

  async testConnection(ctx: ConnectorContext) {
    const { response } = await rateLimitedFetch(
      "tiktok",
      ctx.tenantId,
      `https://business-api.tiktok.com/open_api/v1.3/advertiser/info/?advertiser_ids=${encodeURIComponent(JSON.stringify([ctx.externalAccountId]))}`,
      { headers: { "Access-Token": ctx.credentials.accessToken } }
    );
    const body = (await response.json()) as { code: number; message: string };
    return body.code === 0
      ? { ok: true, detail: "TikTok advertiser accessible" }
      : { ok: false, detail: body.message };
  },
};

interface TikTokRow {
  dimensions?: { campaign_id?: string; stat_time_day?: string };
  metrics?: Record<string, string | number>;
}

/**
 * LinkedIn Marketing API connector. Credentials: { accessToken, refreshToken? }.
 * externalAccountId = sponsored ad account URN id (numeric).
 */
export const linkedinConnector: Connector = {
  provider: "linkedin",

  async fetchMetrics(ctx: ConnectorContext, since: string, until: string): Promise<FetchResult> {
    const s = new Date(since);
    const u = new Date(until);
    const dateRange = `(start:(year:${s.getUTCFullYear()},month:${s.getUTCMonth() + 1},day:${s.getUTCDate()}),end:(year:${u.getUTCFullYear()},month:${u.getUTCMonth() + 1},day:${u.getUTCDate()}))`;
    const url =
      `https://api.linkedin.com/rest/adAnalytics?q=analytics&pivot=CAMPAIGN&timeGranularity=DAILY` +
      `&dateRange=${dateRange}` +
      `&accounts=List(urn%3Ali%3AsponsoredAccount%3A${ctx.externalAccountId})` +
      `&fields=dateRange,pivotValues,costInLocalCurrency,impressions,clicks,externalWebsiteConversions`;

    const { response, requestId } = await rateLimitedFetch("linkedin", ctx.tenantId, url, {
      headers: {
        Authorization: `Bearer ${ctx.credentials.accessToken}`,
        "LinkedIn-Version": "202411",
        "X-Restli-Protocol-Version": "2.0.0",
      },
    });
    if (!response.ok) {
      const text = await response.text();
      throw new ConnectorError("linkedin", `HTTP ${response.status}: ${text.slice(0, 300)}`, response.status >= 500, requestId);
    }
    const body = (await response.json()) as { elements?: LinkedInRow[] };
    const metrics: IncomingMetric[] = [];
    const refUrl = `https://www.linkedin.com/campaignmanager/accounts/${ctx.externalAccountId}`;
    for (const row of body.elements ?? []) {
      const dr = row.dateRange?.start;
      const date = dr
        ? `${dr.year}-${String(dr.month).padStart(2, "0")}-${String(dr.day).padStart(2, "0")}`
        : since;
      const base = {
        date,
        dimensions: { campaign: row.pivotValues?.[0] ?? "" },
        sourceRequestId: requestId ?? undefined,
        sourceReferenceUrl: refUrl,
      };
      metrics.push(
        { ...base, metric: "spend", value: Number(row.costInLocalCurrency ?? 0), currency: "USD" },
        { ...base, metric: "impressions", value: Number(row.impressions ?? 0) },
        { ...base, metric: "clicks", value: Number(row.clicks ?? 0) },
        { ...base, metric: "conversions", value: Number(row.externalWebsiteConversions ?? 0) }
      );
    }
    return { metrics, requestIds: requestId ? [requestId] : [] };
  },

  async refreshToken(ctx: ConnectorContext) {
    if (!ctx.credentials.refreshToken || !env.linkedinClientId || !env.linkedinClientSecret) return null;
    const res = await fetch("https://www.linkedin.com/oauth/v2/accessToken", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: ctx.credentials.refreshToken,
        client_id: env.linkedinClientId,
        client_secret: env.linkedinClientSecret,
      }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { access_token: string; expires_in: number; refresh_token?: string };
    return {
      credentials: {
        ...ctx.credentials,
        accessToken: body.access_token,
        refreshToken: body.refresh_token ?? ctx.credentials.refreshToken,
      },
      expiresAt: new Date(Date.now() + body.expires_in * 1000),
    };
  },

  async testConnection(ctx: ConnectorContext) {
    const { response } = await rateLimitedFetch(
      "linkedin",
      ctx.tenantId,
      `https://api.linkedin.com/rest/adAccounts/${ctx.externalAccountId}`,
      {
        headers: {
          Authorization: `Bearer ${ctx.credentials.accessToken}`,
          "LinkedIn-Version": "202411",
        },
      }
    );
    return response.ok
      ? { ok: true, detail: "LinkedIn ad account accessible" }
      : { ok: false, detail: `HTTP ${response.status}` };
  },
};

interface LinkedInRow {
  dateRange?: { start?: { year: number; month: number; day: number } };
  pivotValues?: string[];
  costInLocalCurrency?: string;
  impressions?: number;
  clicks?: number;
  externalWebsiteConversions?: number;
}

/**
 * X (Twitter) Ads API connector. Credentials: { accessToken, accessTokenSecret }
 * via OAuth 2.0 bearer where available. externalAccountId = ads account id.
 */
export const xConnector: Connector = {
  provider: "x",

  async fetchMetrics(ctx: ConnectorContext, since: string, until: string): Promise<FetchResult> {
    const url =
      `https://ads-api.twitter.com/12/stats/accounts/${ctx.externalAccountId}?` +
      new URLSearchParams({
        entity: "CAMPAIGN",
        granularity: "DAY",
        metric_groups: "BILLING,ENGAGEMENT,WEB_CONVERSION",
        start_time: `${since}T00:00:00Z`,
        end_time: `${until}T23:59:59Z`,
        placement: "ALL_ON_TWITTER",
      }).toString();

    const { response, requestId } = await rateLimitedFetch("x", ctx.tenantId, url, {
      headers: { Authorization: `Bearer ${ctx.credentials.accessToken}` },
    });
    if (!response.ok) {
      const text = await response.text();
      throw new ConnectorError("x", `HTTP ${response.status}: ${text.slice(0, 300)}`, response.status >= 500, requestId);
    }
    const body = (await response.json()) as { data?: XStatsEntity[] };
    const metrics: IncomingMetric[] = [];
    const days = enumerateDays(since, until);
    for (const entity of body.data ?? []) {
      const series = entity.id_data?.[0]?.metrics ?? {};
      days.forEach((date, i) => {
        const base = {
          date,
          dimensions: { campaign_id: entity.id ?? "" },
          sourceRequestId: requestId ?? undefined,
          sourceReferenceUrl: `https://ads.x.com/campaign_form/${ctx.externalAccountId}`,
        };
        const spendMicro = Number(series.billed_charge_local_micro?.[i] ?? 0);
        metrics.push(
          { ...base, metric: "spend", value: spendMicro / 1_000_000, currency: "USD" },
          { ...base, metric: "impressions", value: Number(series.impressions?.[i] ?? 0) },
          { ...base, metric: "clicks", value: Number(series.clicks?.[i] ?? 0) }
        );
      });
    }
    return { metrics, requestIds: requestId ? [requestId] : [] };
  },

  async testConnection(ctx: ConnectorContext) {
    const { response } = await rateLimitedFetch(
      "x",
      ctx.tenantId,
      `https://ads-api.twitter.com/12/accounts/${ctx.externalAccountId}`,
      { headers: { Authorization: `Bearer ${ctx.credentials.accessToken}` } }
    );
    return response.ok
      ? { ok: true, detail: "X ads account accessible" }
      : { ok: false, detail: `HTTP ${response.status}` };
  },
};

interface XStatsEntity {
  id?: string;
  id_data?: { metrics?: Record<string, (number | null)[] | undefined> }[];
}

function enumerateDays(since: string, until: string): string[] {
  const out: string[] = [];
  const d = new Date(`${since}T00:00:00Z`);
  const end = new Date(`${until}T00:00:00Z`);
  while (d <= end) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}
