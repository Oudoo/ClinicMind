import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * The inbox webhook's outbound URL is typed in by a clinic owner and then
 * fetched by the server, so it must never become a way into the server's own
 * network (SSRF). In production only https URLs to public addresses are
 * accepted: the literal host is checked when the URL is saved, the resolved
 * addresses again before every send, and redirects are not followed.
 * Development and tests may use http and local receivers.
 */
export interface UrlPolicy {
  /** Production rules: https only, public addresses only. */
  strict: boolean;
}

export function defaultUrlPolicy(): UrlPolicy {
  return { strict: process.env.NODE_ENV === "production" };
}

function isPrivateV4(ip: string): boolean {
  const [a = 0, b = 0, c = 0] = ip.split(".").map(Number);
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a === 169 && b === 254) return true; // link-local, cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  return a >= 224; // multicast, reserved, broadcast
}

function isPrivateV6(ip: string): boolean {
  const lower = ip.toLowerCase().replace(/%.*$/, "");
  if (lower === "::" || lower === "::1") return true;
  const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower);
  if (dotted) return isPrivateV4(dotted[1]!);
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hex) {
    const hi = Number.parseInt(hex[1]!, 16);
    const lo = Number.parseInt(hex[2]!, 16);
    return isPrivateV4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  if (lower.startsWith("64:ff9b:") || lower.startsWith("2001:db8:")) return true; // NAT64, documentation
  const first = Number.parseInt(lower.split(":")[0] || "0", 16);
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  return (first & 0xff00) === 0xff00; // multicast
}

/** True for loopback, private, link-local, reserved and multicast addresses (anything that is not an IP too). */
export function isPrivateAddress(ip: string): boolean {
  const version = isIP(ip.replace(/%.*$/, ""));
  if (version === 4) return isPrivateV4(ip);
  if (version === 6) return isPrivateV6(ip);
  return true;
}

function hostOf(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
}

/** What is wrong with an outbound URL on its face (no DNS), or null when it is acceptable. Pure. */
export function outboundUrlProblem(raw: string, policy: UrlPolicy = defaultUrlPolicy()): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "Not a valid URL";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return "Use an http(s) URL";
  if (url.username || url.password) return "Leave credentials out of the URL; every request is signed instead";
  if (!policy.strict) return null;
  if (url.protocol !== "https:") return "Use an https URL";
  const host = hostOf(url);
  if (isIP(host)) return isPrivateAddress(host) ? "The URL must point to a public address" : null;
  if (host === "localhost" || /\.(localhost|local|internal|lan|home|corp)$/.test(host) || !host.includes(".")) {
    return "The URL must point to a public host";
  }
  return null;
}

export type Resolver = (host: string) => Promise<string[]>;

const systemResolver: Resolver = async (host) => (await lookup(host, { all: true })).map((a) => a.address);

/** `outboundUrlProblem` plus, under the strict policy, the addresses the host resolves to right now. */
export async function resolvedUrlProblem(raw: string, policy: UrlPolicy = defaultUrlPolicy(), resolve: Resolver = systemResolver): Promise<string | null> {
  const problem = outboundUrlProblem(raw, policy);
  if (problem || !policy.strict) return problem;
  const host = hostOf(new URL(raw));
  if (isIP(host)) return null;
  try {
    const addresses = await resolve(host);
    if (!addresses.length) return "The host does not resolve";
    return addresses.some(isPrivateAddress) ? "The host resolves to a private address" : null;
  } catch {
    return "The host does not resolve";
  }
}
