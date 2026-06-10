import type { Connector } from "./types.js";
import { metaConnector } from "./meta.js";
import { ga4Connector } from "./ga4.js";
import {
  googleAdsConnector,
  tiktokConnector,
  linkedinConnector,
  xConnector,
} from "./ads-platforms.js";
import {
  zohoCrmConnector,
  hubspotConnector,
  salesforceConnector,
  dynamicsConnector,
  odooConnector,
} from "./crm.js";

const registry = new Map<string, Connector>(
  [
    metaConnector,
    ga4Connector,
    googleAdsConnector,
    tiktokConnector,
    linkedinConnector,
    xConnector,
    zohoCrmConnector,
    hubspotConnector,
    salesforceConnector,
    dynamicsConnector,
    odooConnector,
  ].map((c) => [c.provider, c])
);

export function getConnector(provider: string): Connector {
  const connector = registry.get(provider);
  if (!connector) throw new Error(`No connector registered for provider "${provider}"`);
  return connector;
}

export function listProviders(): string[] {
  return [...registry.keys()];
}
