import { rateLimitedFetch } from "../rate-limiter.js";
import {
  type Connector,
  type ConnectorContext,
  type FetchResult,
  ConnectorError,
} from "./types.js";
import type { IncomingMetric } from "../sanity.js";

/**
 * CRM connectors — pull funnel facts (leads created, deals won/lost,
 * pipeline value) that power the Process Intelligence Engine and the
 * non-marketing Business Advisory layer.
 */

/** Zoho CRM. Credentials: { accessToken, refreshToken, clientId, clientSecret, apiDomain?, accountsDomain? } */
export const zohoCrmConnector: Connector = {
  provider: "zoho_crm",

  async fetchMetrics(ctx, since, until): Promise<FetchResult> {
    const apiDomain = ctx.credentials.apiDomain || "https://www.zohoapis.com";
    const headers = { Authorization: `Zoho-oauthtoken ${ctx.credentials.accessToken}` };
    const requestIds: string[] = [];
    const metrics: IncomingMetric[] = [];

    const leadCount = await zohoCount(ctx, apiDomain, headers, "Leads", "Created_Time", since, until, requestIds);
    const dealsWon = await zohoCount(ctx, apiDomain, headers, "Deals", "Closing_Date", since, until, requestIds, "(Stage:equals:Closed Won)");
    const dealsLost = await zohoCount(ctx, apiDomain, headers, "Deals", "Closing_Date", since, until, requestIds, "(Stage:equals:Closed Lost)");

    const refUrl = `${apiDomain.replace("zohoapis", "crm.zoho")}/crm`;
    const base = { date: until, dimensions: {}, sourceReferenceUrl: refUrl, sourceRequestId: requestIds[0] };
    metrics.push(
      { ...base, metric: "leads", value: leadCount },
      { ...base, metric: "deals_won", value: dealsWon },
      { ...base, metric: "deals_lost", value: dealsLost }
    );
    return { metrics, requestIds };
  },

  async refreshToken(ctx) {
    const accountsDomain = ctx.credentials.accountsDomain || "https://accounts.zoho.com";
    const res = await fetch(`${accountsDomain}/oauth/v2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: ctx.credentials.refreshToken,
        client_id: ctx.credentials.clientId,
        client_secret: ctx.credentials.clientSecret,
      }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { access_token: string; expires_in: number };
    return {
      credentials: { ...ctx.credentials, accessToken: body.access_token },
      expiresAt: new Date(Date.now() + body.expires_in * 1000),
    };
  },

  async testConnection(ctx) {
    const apiDomain = ctx.credentials.apiDomain || "https://www.zohoapis.com";
    const { response } = await rateLimitedFetch("zoho_crm", ctx.tenantId, `${apiDomain}/crm/v7/org`, {
      headers: { Authorization: `Zoho-oauthtoken ${ctx.credentials.accessToken}` },
    });
    return response.ok
      ? { ok: true, detail: "Zoho CRM org accessible" }
      : { ok: false, detail: `HTTP ${response.status}` };
  },
};

async function zohoCount(
  ctx: ConnectorContext,
  apiDomain: string,
  headers: Record<string, string>,
  module: string,
  dateField: string,
  since: string,
  until: string,
  requestIds: string[],
  extraCriteria?: string
): Promise<number> {
  const dateCriteria = `(${dateField}:between:${since}T00:00:00+00:00,${until}T23:59:59+00:00)`;
  const criteria = extraCriteria ? `(${dateCriteria}and${extraCriteria})` : dateCriteria;
  const url = `${apiDomain}/crm/v7/${module}/actions/count?criteria=${encodeURIComponent(criteria)}`;
  const { response, requestId } = await rateLimitedFetch("zoho_crm", ctx.tenantId, url, { headers });
  if (requestId) requestIds.push(requestId);
  if (!response.ok) {
    if (response.status === 401) throw new ConnectorError("zoho_crm", "Access token expired", true, requestId);
    return 0;
  }
  const body = (await response.json()) as { count?: number };
  return body.count ?? 0;
}

/** HubSpot. Credentials: { accessToken } (private app token). */
export const hubspotConnector: Connector = {
  provider: "hubspot",

  async fetchMetrics(ctx, since, until): Promise<FetchResult> {
    const headers = {
      Authorization: `Bearer ${ctx.credentials.accessToken}`,
      "Content-Type": "application/json",
    };
    const requestIds: string[] = [];

    const search = async (object: string, filters: unknown[]): Promise<number> => {
      const { response, requestId } = await rateLimitedFetch(
        "hubspot",
        ctx.tenantId,
        `https://api.hubapi.com/crm/v3/objects/${object}/search`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ filterGroups: [{ filters }], limit: 1 }),
        }
      );
      if (requestId) requestIds.push(requestId);
      if (!response.ok) {
        throw new ConnectorError("hubspot", `HTTP ${response.status}`, response.status >= 500, requestId);
      }
      return ((await response.json()) as { total?: number }).total ?? 0;
    };

    const sinceMs = String(new Date(`${since}T00:00:00Z`).getTime());
    const untilMs = String(new Date(`${until}T23:59:59Z`).getTime());
    const created = [
      { propertyName: "createdate", operator: "GTE", value: sinceMs },
      { propertyName: "createdate", operator: "LTE", value: untilMs },
    ];

    const leads = await search("contacts", created);
    const dealsWon = await search("deals", [
      ...created.map((f) => ({ ...f, propertyName: "closedate" })),
      { propertyName: "dealstage", operator: "EQ", value: "closedwon" },
    ]);
    const dealsLost = await search("deals", [
      ...created.map((f) => ({ ...f, propertyName: "closedate" })),
      { propertyName: "dealstage", operator: "EQ", value: "closedlost" },
    ]);

    const base = {
      date: until,
      dimensions: {},
      sourceReferenceUrl: "https://app.hubspot.com",
      sourceRequestId: requestIds[0],
    };
    return {
      metrics: [
        { ...base, metric: "leads", value: leads },
        { ...base, metric: "deals_won", value: dealsWon },
        { ...base, metric: "deals_lost", value: dealsLost },
      ],
      requestIds,
    };
  },

  async testConnection(ctx) {
    const { response } = await rateLimitedFetch(
      "hubspot",
      ctx.tenantId,
      "https://api.hubapi.com/crm/v3/objects/contacts?limit=1",
      { headers: { Authorization: `Bearer ${ctx.credentials.accessToken}` } }
    );
    return response.ok
      ? { ok: true, detail: "HubSpot CRM accessible" }
      : { ok: false, detail: `HTTP ${response.status}` };
  },
};

/** Salesforce. Credentials: { accessToken, refreshToken?, instanceUrl, clientId?, clientSecret? } */
export const salesforceConnector: Connector = {
  provider: "salesforce",

  async fetchMetrics(ctx, since, until): Promise<FetchResult> {
    const instance = ctx.credentials.instanceUrl;
    const headers = { Authorization: `Bearer ${ctx.credentials.accessToken}` };
    const requestIds: string[] = [];

    const soql = async (query: string): Promise<number> => {
      const { response, requestId } = await rateLimitedFetch(
        "salesforce",
        ctx.tenantId,
        `${instance}/services/data/v62.0/query?q=${encodeURIComponent(query)}`,
        { headers }
      );
      if (requestId) requestIds.push(requestId);
      if (!response.ok) {
        throw new ConnectorError("salesforce", `HTTP ${response.status}`, response.status !== 401, requestId);
      }
      return ((await response.json()) as { totalSize?: number }).totalSize ?? 0;
    };

    const range = `CreatedDate >= ${since}T00:00:00Z AND CreatedDate <= ${until}T23:59:59Z`;
    const leads = await soql(`SELECT COUNT() FROM Lead WHERE ${range}`);
    const dealsWon = await soql(
      `SELECT COUNT() FROM Opportunity WHERE IsWon = true AND CloseDate >= ${since} AND CloseDate <= ${until}`
    );
    const dealsLost = await soql(
      `SELECT COUNT() FROM Opportunity WHERE IsClosed = true AND IsWon = false AND CloseDate >= ${since} AND CloseDate <= ${until}`
    );

    const base = { date: until, dimensions: {}, sourceReferenceUrl: instance, sourceRequestId: requestIds[0] };
    return {
      metrics: [
        { ...base, metric: "leads", value: leads },
        { ...base, metric: "deals_won", value: dealsWon },
        { ...base, metric: "deals_lost", value: dealsLost },
      ],
      requestIds,
    };
  },

  async refreshToken(ctx) {
    if (!ctx.credentials.refreshToken || !ctx.credentials.clientId) return null;
    const res = await fetch(`${ctx.credentials.instanceUrl}/services/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: ctx.credentials.refreshToken,
        client_id: ctx.credentials.clientId,
        client_secret: ctx.credentials.clientSecret ?? "",
      }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { access_token: string };
    return { credentials: { ...ctx.credentials, accessToken: body.access_token }, expiresAt: null };
  },

  async testConnection(ctx) {
    const { response } = await rateLimitedFetch(
      "salesforce",
      ctx.tenantId,
      `${ctx.credentials.instanceUrl}/services/data/v62.0/limits`,
      { headers: { Authorization: `Bearer ${ctx.credentials.accessToken}` } }
    );
    return response.ok
      ? { ok: true, detail: "Salesforce org accessible" }
      : { ok: false, detail: `HTTP ${response.status}` };
  },
};

/** Microsoft Dynamics 365. Credentials: { accessToken, refreshToken?, orgUrl, tenantId?, clientId?, clientSecret? } */
export const dynamicsConnector: Connector = {
  provider: "dynamics",

  async fetchMetrics(ctx, since, until): Promise<FetchResult> {
    const orgUrl = ctx.credentials.orgUrl;
    const headers = {
      Authorization: `Bearer ${ctx.credentials.accessToken}`,
      Accept: "application/json",
      Prefer: 'odata.include-annotations="*"',
    };
    const requestIds: string[] = [];

    const count = async (entitySet: string, filter: string): Promise<number> => {
      const { response, requestId } = await rateLimitedFetch(
        "dynamics",
        ctx.tenantId,
        `${orgUrl}/api/data/v9.2/${entitySet}/$count?$filter=${encodeURIComponent(filter)}`,
        { headers }
      );
      if (requestId) requestIds.push(requestId);
      if (!response.ok) {
        throw new ConnectorError("dynamics", `HTTP ${response.status}`, response.status !== 401, requestId);
      }
      return Number(await response.text()) || 0;
    };

    const range = `createdon ge ${since}T00:00:00Z and createdon le ${until}T23:59:59Z`;
    const leads = await count("leads", range);
    const dealsWon = await count("opportunities", `statecode eq 1 and actualclosedate ge ${since} and actualclosedate le ${until}`);
    const dealsLost = await count("opportunities", `statecode eq 2 and actualclosedate ge ${since} and actualclosedate le ${until}`);

    const base = { date: until, dimensions: {}, sourceReferenceUrl: orgUrl, sourceRequestId: requestIds[0] };
    return {
      metrics: [
        { ...base, metric: "leads", value: leads },
        { ...base, metric: "deals_won", value: dealsWon },
        { ...base, metric: "deals_lost", value: dealsLost },
      ],
      requestIds,
    };
  },

  async refreshToken(ctx) {
    if (!ctx.credentials.refreshToken || !ctx.credentials.clientId || !ctx.credentials.tenantId) return null;
    const res = await fetch(
      `https://login.microsoftonline.com/${ctx.credentials.tenantId}/oauth2/v2.0/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: ctx.credentials.refreshToken,
          client_id: ctx.credentials.clientId,
          client_secret: ctx.credentials.clientSecret ?? "",
          scope: `${ctx.credentials.orgUrl}/.default`,
        }),
      }
    );
    if (!res.ok) return null;
    const body = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number };
    return {
      credentials: {
        ...ctx.credentials,
        accessToken: body.access_token,
        refreshToken: body.refresh_token ?? ctx.credentials.refreshToken,
      },
      expiresAt: new Date(Date.now() + body.expires_in * 1000),
    };
  },

  async testConnection(ctx) {
    const { response } = await rateLimitedFetch(
      "dynamics",
      ctx.tenantId,
      `${ctx.credentials.orgUrl}/api/data/v9.2/WhoAmI`,
      { headers: { Authorization: `Bearer ${ctx.credentials.accessToken}` } }
    );
    return response.ok
      ? { ok: true, detail: "Dynamics 365 org accessible" }
      : { ok: false, detail: `HTTP ${response.status}` };
  },
};

/** Odoo. Credentials: { baseUrl, database, username, apiKey } — JSON-RPC. */
export const odooConnector: Connector = {
  provider: "odoo",

  async fetchMetrics(ctx, since, until): Promise<FetchResult> {
    const call = async (model: string, domain: unknown[]): Promise<number> => {
      const { response, requestId } = await rateLimitedFetch(
        "odoo",
        ctx.tenantId,
        `${ctx.credentials.baseUrl}/jsonrpc`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            method: "call",
            params: {
              service: "object",
              method: "execute_kw",
              args: [
                ctx.credentials.database,
                2, // uid resolved by api key auth; Odoo accepts login via common.authenticate — see below
                ctx.credentials.apiKey,
                model,
                "search_count",
                [domain],
              ],
            },
            id: Date.now(),
          }),
        }
      );
      const body = (await response.json()) as { result?: number; error?: { message: string } };
      if (body.error) throw new ConnectorError("odoo", body.error.message, false, requestId);
      return body.result ?? 0;
    };

    // Authenticate to resolve the real uid first
    const authRes = await fetch(`${ctx.credentials.baseUrl}/jsonrpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "call",
        params: {
          service: "common",
          method: "authenticate",
          args: [ctx.credentials.database, ctx.credentials.username, ctx.credentials.apiKey, {}],
        },
        id: 1,
      }),
    });
    const auth = (await authRes.json()) as { result?: number };
    if (!auth.result) throw new ConnectorError("odoo", "Authentication failed", false);

    const callWithUid = async (model: string, domain: unknown[]): Promise<number> => {
      const { response, requestId } = await rateLimitedFetch(
        "odoo",
        ctx.tenantId,
        `${ctx.credentials.baseUrl}/jsonrpc`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            method: "call",
            params: {
              service: "object",
              method: "execute_kw",
              args: [ctx.credentials.database, auth.result, ctx.credentials.apiKey, model, "search_count", [domain]],
            },
            id: Date.now(),
          }),
        }
      );
      const body = (await response.json()) as { result?: number; error?: { message: string } };
      if (body.error) throw new ConnectorError("odoo", body.error.message, false, requestId);
      return body.result ?? 0;
    };
    void call;

    const leads = await callWithUid("crm.lead", [
      ["create_date", ">=", `${since} 00:00:00`],
      ["create_date", "<=", `${until} 23:59:59`],
    ]);
    const dealsWon = await callWithUid("crm.lead", [
      ["date_closed", ">=", `${since} 00:00:00`],
      ["date_closed", "<=", `${until} 23:59:59`],
      ["stage_id.is_won", "=", true],
    ]);

    const base = { date: until, dimensions: {}, sourceReferenceUrl: ctx.credentials.baseUrl };
    return {
      metrics: [
        { ...base, metric: "leads", value: leads },
        { ...base, metric: "deals_won", value: dealsWon },
      ],
      requestIds: [],
    };
  },

  async testConnection(ctx) {
    try {
      const res = await fetch(`${ctx.credentials.baseUrl}/jsonrpc`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "call",
          params: { service: "common", method: "version", args: [] },
          id: 1,
        }),
      });
      const body = (await res.json()) as { result?: { server_version?: string } };
      return body.result
        ? { ok: true, detail: `Odoo ${body.result.server_version} reachable` }
        : { ok: false, detail: "Unexpected Odoo response" };
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
  },
};
