import type { IncomingMetric } from "../sanity.js";

/**
 * Common connector contract. Connectors only fetch + normalize; storage,
 * sanity checking and event publishing happen in the Integration Worker.
 */
export interface ConnectorContext {
  tenantId: string;
  integrationId: string;
  /** Provider-side account/property id */
  externalAccountId: string;
  /** Decrypted credential blob (shape varies per provider) */
  credentials: Record<string, string>;
  config: Record<string, unknown>;
}

export interface FetchResult {
  metrics: IncomingMetric[];
  /** All provider request ids observed during the fetch */
  requestIds: string[];
}

export interface TokenRefreshResult {
  credentials: Record<string, string>;
  expiresAt: Date | null;
}

export interface Connector {
  provider: string;
  /** Pull normalized daily metrics for [since, until] (YYYY-MM-DD, inclusive). */
  fetchMetrics(ctx: ConnectorContext, since: string, until: string): Promise<FetchResult>;
  /** Refresh OAuth tokens when supported; null = provider has no refresh flow. */
  refreshToken?(ctx: ConnectorContext): Promise<TokenRefreshResult | null>;
  /** Lightweight credentials probe for the Integration Health Center. */
  testConnection(ctx: ConnectorContext): Promise<{ ok: boolean; detail: string }>;
}

export class ConnectorError extends Error {
  constructor(
    public provider: string,
    message: string,
    public retryable = true,
    public requestId: string | null = null
  ) {
    super(`[${provider}] ${message}`);
    this.name = "ConnectorError";
  }
}
