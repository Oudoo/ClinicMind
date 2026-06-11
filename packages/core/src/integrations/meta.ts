import { rateLimitedFetch } from "../rate-limiter.js";
import { env } from "../env.js";
import {
  type Connector,
  type ConnectorContext,
  type FetchResult,
  ConnectorError,
} from "./types.js";
import type { IncomingMetric } from "../sanity.js";

const GRAPH = "https://graph.facebook.com/v21.0";

/**
 * Meta Marketing API connector. Credentials: { accessToken } — a long-lived
 * system-user or user token with ads_read. externalAccountId is the ad
 * account id ("act_..." prefix added automatically).
 */
export const metaConnector: Connector = {
  provider: "meta",

  async fetchMetrics(ctx: ConnectorContext, since: string, until: string): Promise<FetchResult> {
    const account = ctx.externalAccountId.startsWith("act_")
      ? ctx.externalAccountId
      : `act_${ctx.externalAccountId}`;
    const fields = [
      "spend",
      "impressions",
      "clicks",
      "reach",
      "actions",
      "action_values",
      "campaign_id",
      "campaign_name",
    ].join(",");

    const metrics: IncomingMetric[] = [];
    const requestIds: string[] = [];
    let url: string | null =
      `${GRAPH}/${account}/insights?` +
      new URLSearchParams({
        level: "campaign",
        time_increment: "1",
        time_range: JSON.stringify({ since, until }),
        fields,
        access_token: ctx.credentials.accessToken,
        limit: "500",
      }).toString();

    while (url) {
      const { response, requestId } = await rateLimitedFetch("meta", ctx.tenantId, url);
      if (requestId) requestIds.push(requestId);
      const body = (await response.json()) as {
        data?: MetaInsightRow[];
        paging?: { next?: string };
        error?: { message: string; code: number };
      };
      if (!response.ok || body.error) {
        const code = body.error?.code ?? response.status;
        throw new ConnectorError(
          "meta",
          body.error?.message ?? `HTTP ${response.status}`,
          ![100, 190, 200].includes(code),
          requestId
        );
      }

      for (const row of body.data ?? []) {
        const dims = { campaign_id: row.campaign_id ?? "", campaign_name: row.campaign_name ?? "" };
        const date = row.date_start;
        const refUrl = `https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=${account.replace("act_", "")}`;
        const base = { date, dimensions: dims, sourceRequestId: requestId ?? undefined, sourceReferenceUrl: refUrl };

        metrics.push(
          { ...base, metric: "spend", value: Number(row.spend ?? 0), currency: "USD" },
          { ...base, metric: "impressions", value: Number(row.impressions ?? 0) },
          { ...base, metric: "clicks", value: Number(row.clicks ?? 0) },
          { ...base, metric: "reach", value: Number(row.reach ?? 0) }
        );
        const purchases = (row.actions ?? []).find((a) => a.action_type === "purchase" || a.action_type === "offsite_conversion.fb_pixel_purchase");
        const leads = (row.actions ?? []).find((a) => a.action_type === "lead");
        const revenue = (row.action_values ?? []).find((a) => a.action_type === "purchase" || a.action_type === "offsite_conversion.fb_pixel_purchase");
        if (purchases) metrics.push({ ...base, metric: "conversions", value: Number(purchases.value) });
        if (leads) metrics.push({ ...base, metric: "leads", value: Number(leads.value) });
        if (revenue) metrics.push({ ...base, metric: "revenue", value: Number(revenue.value), currency: "USD" });
      }
      url = body.paging?.next ?? null;
    }

    return { metrics, requestIds };
  },

  async refreshToken(ctx: ConnectorContext) {
    if (!env.metaAppId || !env.metaAppSecret) return null;
    const url =
      `${GRAPH}/oauth/access_token?` +
      new URLSearchParams({
        grant_type: "fb_exchange_token",
        client_id: env.metaAppId,
        client_secret: env.metaAppSecret,
        fb_exchange_token: ctx.credentials.accessToken,
      }).toString();
    const { response } = await rateLimitedFetch("meta", ctx.tenantId, url);
    if (!response.ok) return null;
    const body = (await response.json()) as { access_token: string; expires_in?: number };
    return {
      credentials: { ...ctx.credentials, accessToken: body.access_token },
      expiresAt: body.expires_in ? new Date(Date.now() + body.expires_in * 1000) : null,
    };
  },

  async testConnection(ctx: ConnectorContext) {
    const account = ctx.externalAccountId.startsWith("act_")
      ? ctx.externalAccountId
      : `act_${ctx.externalAccountId}`;
    const { response } = await rateLimitedFetch(
      "meta",
      ctx.tenantId,
      `${GRAPH}/${account}?fields=name,account_status&access_token=${encodeURIComponent(ctx.credentials.accessToken)}`
    );
    const body = (await response.json()) as { name?: string; error?: { message: string } };
    return response.ok
      ? { ok: true, detail: `Connected to ad account "${body.name}"` }
      : { ok: false, detail: body.error?.message ?? `HTTP ${response.status}` };
  },
};

interface MetaInsightRow {
  date_start: string;
  date_stop: string;
  spend?: string;
  impressions?: string;
  clicks?: string;
  reach?: string;
  campaign_id?: string;
  campaign_name?: string;
  actions?: { action_type: string; value: string }[];
  action_values?: { action_type: string; value: string }[];
}
