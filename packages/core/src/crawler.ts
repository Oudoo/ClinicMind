import * as cheerio from "cheerio";
import Parser from "rss-parser";
import { env } from "./env.js";

/**
 * Research crawler — fetch + Cheerio for HTML, rss-parser for feeds,
 * structured-data extraction for schema.org. Near-zero licensing cost.
 * ScraperAPI is used only as an explicit fallback when direct fetch is
 * blocked and a SCRAPERAPI_KEY is configured.
 */

const USER_AGENT =
  "Mozilla/5.0 (compatible; GrowEngineBot/1.0; +https://growengine.app/bot)";

export interface CrawledPage {
  url: string;
  status: number;
  title: string | null;
  metaDescription: string | null;
  headings: { level: number; text: string }[];
  /** Visible body text, whitespace-normalized */
  text: string;
  /** Parsed JSON-LD blocks */
  structuredData: unknown[];
  /** Microdata/RDFa itemtype values found */
  schemaTypes: string[];
  links: string[];
  wordCount: number;
}

export async function fetchPage(url: string): Promise<CrawledPage> {
  let res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
    redirect: "follow",
    signal: AbortSignal.timeout(30_000),
  }).catch((err: Error) => err);

  // Fallback through ScraperAPI only when direct access fails/blocked
  if ((res instanceof Error || (res as Response).status === 403) && env.scraperApiKey) {
    res = await fetch(
      `https://api.scraperapi.com/?api_key=${env.scraperApiKey}&url=${encodeURIComponent(url)}`,
      { signal: AbortSignal.timeout(60_000) }
    );
  }
  if (res instanceof Error) throw res;

  const status = res.status;
  const html = await res.text();
  const $ = cheerio.load(html);

  const structuredData: unknown[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      structuredData.push(JSON.parse($(el).text()));
    } catch {
      /* malformed JSON-LD is itself a finding; skip parse */
    }
  });

  const schemaTypes: string[] = [];
  $("[itemtype]").each((_, el) => {
    const t = $(el).attr("itemtype");
    if (t) schemaTypes.push(t);
  });

  const headings: { level: number; text: string }[] = [];
  $("h1, h2, h3").each((_, el) => {
    headings.push({ level: Number(el.tagName[1]), text: $(el).text().trim() });
  });

  $("script, style, nav, footer, noscript").remove();
  const text = $("body").text().replace(/\s+/g, " ").trim();

  const links: string[] = [];
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    try {
      const abs = new URL(href, url).toString();
      if (abs.startsWith("http")) links.push(abs.split("#")[0]);
    } catch {
      /* invalid URL */
    }
  });

  return {
    url,
    status,
    title: $("title").first().text().trim() || null,
    metaDescription: $('meta[name="description"]').attr("content") ?? null,
    headings,
    text,
    structuredData,
    schemaTypes,
    links: [...new Set(links)],
    wordCount: text.split(/\s+/).filter(Boolean).length,
  };
}

/**
 * Same-domain breadth-first crawl with politeness delay, honoring robots
 * "Disallow: /" at minimum.
 */
export async function crawlSite(
  startUrl: string,
  maxPages = 15,
  delayMs = 750
): Promise<CrawledPage[]> {
  const origin = new URL(startUrl).origin;

  let disallowedAll = false;
  try {
    const robots = await fetch(`${origin}/robots.txt`, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(10_000),
    });
    if (robots.ok) {
      const body = await robots.text();
      disallowedAll = /User-agent:\s*\*\s*[\s\S]*?Disallow:\s*\/\s*$/im.test(
        body.split(/User-agent:/i).find((b) => b.trim().startsWith("*")) ?? ""
      );
    }
  } catch {
    /* robots unavailable — proceed politely */
  }
  if (disallowedAll) {
    const single = await fetchPage(startUrl);
    return [single];
  }

  const visited = new Set<string>();
  const queue: string[] = [startUrl];
  const pages: CrawledPage[] = [];

  while (queue.length > 0 && pages.length < maxPages) {
    const url = queue.shift()!;
    if (visited.has(url)) continue;
    visited.add(url);
    try {
      const page = await fetchPage(url);
      pages.push(page);
      for (const link of page.links) {
        if (link.startsWith(origin) && !visited.has(link) && !/\.(pdf|jpg|png|zip|mp4)$/i.test(link)) {
          queue.push(link);
        }
      }
    } catch {
      /* unreachable page — skip */
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return pages;
}

const rssParser = new Parser({ headers: { "User-Agent": USER_AGENT } });

export interface FeedMention {
  source: string;
  title: string;
  link: string;
  publishedAt: string | null;
  snippet: string;
}

/** Monitor RSS feeds (incl. Google News RSS) for brand/competitor mentions. */
export async function searchMentions(
  query: string,
  extraFeeds: string[] = []
): Promise<FeedMention[]> {
  const feeds = [
    `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`,
    ...extraFeeds,
  ];
  const mentions: FeedMention[] = [];
  for (const feedUrl of feeds) {
    try {
      const feed = await rssParser.parseURL(feedUrl);
      for (const item of feed.items.slice(0, 25)) {
        mentions.push({
          source: feed.title ?? feedUrl,
          title: item.title ?? "",
          link: item.link ?? "",
          publishedAt: item.isoDate ?? item.pubDate ?? null,
          snippet: (item.contentSnippet ?? "").slice(0, 400),
        });
      }
    } catch {
      /* feed unavailable */
    }
  }
  return mentions;
}
