/**
 * Sephora Turkey Scraping Engine
 *
 * Extraction cascade (most reliable → least):
 *   1. JSON-LD  (<script type="application/ld+json">)
 *   2. OpenGraph / meta tags
 *   3. DOM selectors (with scroll-triggered lazy-image capture)
 *
 * Catalog scraper handles pagination and bulk URL extraction.
 */

import { chromium, Browser, BrowserContext, Page } from "playwright";
import { AppError } from "../utils/errors";
// ── Public types ───────────────────────────────────────────────────────────

export interface ScrapedVariant {
  label:     string;
  price_try: number;
  sku?:      string;
  stock:     number;
}

export interface ScrapedProduct {
  name:         string;
  description:  string;
  brand:        string;
  price_try:    number;
  images:       string[];
  variants:     ScrapedVariant[];
  sku?:         string;
  stock_status: "in_stock" | "low_stock" | "out_of_stock";
  original_url: string;
}

export interface CatalogScrapeResult {
  product_urls: string[];
  total_pages:  number;
  scraped_pages: number;
}

// ── User-agent pool ────────────────────────────────────────────────────────

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.82 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.6312.122 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.82 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.60 Safari/537.36",
];

function randomUA(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function jitter(min = 800, max = 2400): Promise<void> {
  return new Promise((r) => setTimeout(r, min + Math.random() * (max - min)));
}

// ── Browser singleton ──────────────────────────────────────────────────────
// launchPromise prevents a race where two concurrent scrape calls both see
// browser===null and both call chromium.launch(), leaking a browser instance.

let browser:        Browser | null         = null;
let launchPromise:  Promise<Browser> | null = null;

const BROWSER_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--disable-blink-features=AutomationControlled",
  "--disable-features=IsolateOrigins,site-per-process",
  "--window-size=1440,900",
];

async function getBrowser(): Promise<Browser> {
  if (browser?.isConnected()) return browser;

  if (!launchPromise) {
    launchPromise = chromium.launch({ headless: true, args: BROWSER_ARGS })
      .then((b) => { browser = b; launchPromise = null; return b; })
      .catch((err) => { launchPromise = null; throw err; });
  }

  return launchPromise;
}

export async function closeBrowser(): Promise<void> {
  if (browser) { await browser.close(); browser = null; }
}

// ── Stealth context factory ────────────────────────────────────────────────

async function newStealthContext(b: Browser): Promise<BrowserContext> {
  const ua = randomUA();

  const ctx = await b.newContext({
    userAgent: ua,
    locale:    "tr-TR",
    timezoneId: "Europe/Istanbul",
    viewport:  { width: 1440, height: 900 },
    extraHTTPHeaders: {
      "Accept-Language":           "tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7",
      "Accept":                    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Encoding":           "gzip, deflate, br",
      "Cache-Control":             "no-cache",
      "Pragma":                    "no-cache",
      "Sec-Ch-Ua":                 '"Chromium";v="124","Google Chrome";v="124","Not-A.Brand";v="99"',
      "Sec-Ch-Ua-Mobile":          "?0",
      "Sec-Ch-Ua-Platform":        '"Windows"',
      "Sec-Fetch-Dest":            "document",
      "Sec-Fetch-Mode":            "navigate",
      "Sec-Fetch-Site":            "none",
      "Sec-Fetch-User":            "?1",
      "Upgrade-Insecure-Requests": "1",
    },
  });

  await ctx.addInitScript(() => {
    // Mask automation fingerprints
    Object.defineProperty(navigator, "webdriver",         { get: () => undefined });
    Object.defineProperty(navigator, "plugins",           { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, "languages",         { get: () => ["tr-TR", "tr", "en-US"] });
    Object.defineProperty(navigator, "platform",          { get: () => "Win32" });
    Object.defineProperty(navigator, "hardwareConcurrency",{ get: () => 8 });
    Object.defineProperty(navigator, "deviceMemory",      { get: () => 8 });
    (window as any).chrome = { runtime: {} };

    // Overwrite permission query to look normal
    const origQuery = window.navigator.permissions?.query;
    if (origQuery) {
      (window.navigator.permissions as any).query = (params: any) =>
        params.name === "notifications"
          ? Promise.resolve({ state: "default" } as unknown as PermissionStatus)
          : origQuery.call(window.navigator.permissions, params);
    }
  });

  return ctx;
}

// ── Resource filter (block fonts/ads/analytics, allow images) ─────────────

async function applyResourceFilter(page: Page): Promise<void> {
  await page.route("**/*", (route) => {
    const type = route.request().resourceType();
    const url  = route.request().url();

    // Block non-essential resources
    if (type === "font" || type === "media") return route.abort();
    if (type === "script" && /google-analytics|gtag|facebook|hotjar|tealium|analytics/.test(url))
      return route.abort();
    if (type === "image" && /doubleclick|google-analytics|facebook/.test(url))
      return route.abort();

    return route.continue();
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// EXTRACTION STRATEGIES
// ══════════════════════════════════════════════════════════════════════════════

// ── Strategy 1: JSON-LD structured data ───────────────────────────────────
//
// Sephora and most e-commerce sites embed machine-readable product data
// in <script type="application/ld+json">. This is the most reliable.

async function extractJsonLd(page: Page): Promise<Partial<ScrapedProduct> | null> {
  return page.evaluate(() => {
    const scripts = document.querySelectorAll('script[type="application/ld+json"]');

    for (const script of scripts) {
      try {
        const data = JSON.parse(script.textContent ?? "");

        // May be an array or a single object
        const items: any[] = Array.isArray(data) ? data : [data];

        for (const item of items) {
          // Handle @graph arrays
          const nodes: any[] = item["@graph"] ? item["@graph"] : [item];

          for (const node of nodes) {
            if (node["@type"] !== "Product") continue;

            const name  = node.name ?? "";
            const brand = typeof node.brand === "object"
              ? node.brand?.name ?? ""
              : node.brand ?? "";
            const description = node.description ?? "";
            const sku   = node.sku ?? node.productID ?? "";

            // Price — may be in 'offers' (single or array)
            let price_try = 0;
            const offers = node.offers
              ? (Array.isArray(node.offers) ? node.offers : [node.offers])
              : [];
            for (const offer of offers) {
              const p = parseFloat(String(offer.price ?? "0").replace(",", "."));
              if (p > 0) { price_try = p; break; }
            }

            // Images — may be string or array
            const rawImgs: string[] = Array.isArray(node.image)
              ? node.image
              : (node.image ? [node.image] : []);

            // Normalize images to high-res by removing size suffixes
            const images = rawImgs
              .map((img: string) => {
                // Convert thumbnail to original quality
                return img
                  .replace(/_\d+x\d+\.(jpg|webp|png)/gi, ".$1")   // remove size suffix
                  .replace(/[?&](width|height|w|h|size)=\d+/gi, "") // remove resize params
                  .trim();
              })
              .filter((u: string) => u.startsWith("http"));

            // Stock status from offers
            const availability = offers[0]?.availability ?? "";
            const stock_status: ScrapedProduct["stock_status"] =
              /OutOfStock/i.test(availability) ? "out_of_stock" :
              /LimitedAvailability/i.test(availability) ? "low_stock" :
              "in_stock";

            if (name) {
              return { name, brand, description, price_try, images, sku, stock_status, variants: [] };
            }
          }
        }
      } catch { /* bad JSON in this script tag */ }
    }
    return null;
  });
}

// ── Strategy 2: OpenGraph + meta tags ────────────────────────────────────

async function extractMeta(page: Page): Promise<Partial<ScrapedProduct> | null> {
  return page.evaluate(() => {
    function meta(property: string): string {
      return (
        (document.querySelector(`meta[property="${property}"]`) as HTMLMetaElement)?.content ||
        (document.querySelector(`meta[name="${property}"]`) as HTMLMetaElement)?.content ||
        ""
      );
    }

    const name  = meta("og:title") || meta("twitter:title");
    if (!name) return null;

    const description = meta("og:description") || meta("description") || meta("twitter:description");
    const priceRaw    = meta("product:price:amount") || meta("og:price:amount");
    const price_try   = priceRaw ? parseFloat(priceRaw.replace(",", ".")) : 0;

    // Collect all og:image tags (there can be multiple)
    const imgMetas = document.querySelectorAll('meta[property="og:image"]');
    const images   = Array.from(imgMetas)
      .map((m) => (m as HTMLMetaElement).content)
      .filter((u) => u.startsWith("http"));

    return { name, description, price_try, images, variants: [] };
  });
}

// ── Strategy 3: DOM extraction with scroll ───────────────────────────────

async function extractDom(page: Page): Promise<Partial<ScrapedProduct>> {
  // Scroll to trigger lazy-loaded images before extraction
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => {
      let totalHeight = 0;
      const distance  = 400;
      const timer = setInterval(() => {
        window.scrollBy(0, distance);
        totalHeight += distance;
        if (totalHeight >= document.body.scrollHeight) {
          clearInterval(timer);
          window.scrollTo(0, 0); // scroll back to top
          resolve();
        }
      }, 120);
    });
  });

  await page.waitForTimeout(600); // let images settle

  return page.evaluate(() => {
    // ── Price parser ────────────────────────────────────────────────────────
    function parsePrice(raw: string): number {
      // Handle Turkish number format: "1.299,99 TL" → 1299.99
      const cleaned = raw
        .replace(/[^\d,.]/g, "")
        .replace(/\.(?=\d{3})/g, "")  // remove thousands dot
        .replace(",", ".");            // decimal comma → dot
      const n = parseFloat(cleaned);
      return isNaN(n) ? 0 : n;
    }

    // ── Generic text/attr helpers ────────────────────────────────────────────
    function text(selectors: string[], root: Element | Document = document): string {
      for (const sel of selectors) {
        const t = root.querySelector(sel)?.textContent?.trim() ?? "";
        if (t) return t;
      }
      return "";
    }

    function attr(selectors: string[], attrName: string, root: Element | Document = document): string {
      for (const sel of selectors) {
        const v = (root.querySelector(sel) as HTMLElement)?.getAttribute(attrName) ?? "";
        if (v) return v;
      }
      return "";
    }

    // ── Name ─────────────────────────────────────────────────────────────────
    const name = text([
      '[class*="product-name"] h1',
      '[class*="productName"] h1',
      '[class*="product-title"] h1',
      '[data-testid="product-name"]',
      '[data-testid="product-title"]',
      '[class*="PdpProductName"]',
      '[class*="pdp-product-name"]',
      'h1[itemprop="name"]',
      'h1[class*="title"]',
      'h1',
    ]);

    // ── Brand ─────────────────────────────────────────────────────────────────
    const brand = text([
      '[class*="brand-name"]',
      '[class*="brandName"]',
      '[data-testid="brand-name"]',
      '[itemprop="brand"] [itemprop="name"]',
      '[itemprop="brand"]',
      'a[class*="brand"]',
      '[class*="product-brand"]',
    ]);

    // ── Description ──────────────────────────────────────────────────────────
    const description = text([
      '[itemprop="description"]',
      '[class*="product-description"] p',
      '[class*="productDescription"]',
      '[data-testid="product-description"]',
      '[class*="description-content"]',
      '[class*="product-detail"] p',
      '[class*="pdp-description"]',
    ]);

    // ── Price ─────────────────────────────────────────────────────────────────
    // Try sale price first, then regular price
    const priceRaw = text([
      '[class*="price-sales"]',
      '[class*="priceSales"]',
      '[class*="sale-price"]',
      '[class*="current-price"]',
      '[class*="finalPrice"]',
      '[itemprop="price"]',
      '[data-testid="product-price"]',
      '[class*="product-price"] [class*="value"]',
      '[class*="price"] [class*="value"]',
      '[class*="priceValue"]',
      '[class*="price"]',
    ]);
    const price = parsePrice(priceRaw);

    // ── Images ───────────────────────────────────────────────────────────────
    // Multiple selector passes; for each img try srcset, data-src, src in order

    function bestImageSrc(el: Element): string {
      const img = el.tagName === "IMG" ? el as HTMLImageElement : el.querySelector("img");
      if (!img) return "";

      // srcset — pick the highest resolution (last or highest descriptor)
      const srcset = img.getAttribute("srcset") || img.getAttribute("data-srcset") || "";
      if (srcset) {
        const entries = srcset.split(",")
          .map((s) => s.trim().split(/\s+/))
          .filter((p) => p[0]?.startsWith("http"));

        if (entries.length > 0) {
          // Sort by width descriptor descending
          entries.sort((a, b) => {
            const aw = parseFloat(a[1] ?? "0");
            const bw = parseFloat(b[1] ?? "0");
            return bw - aw;
          });
          const best = entries[0][0];
          if (best) return best;
        }
      }

      // data-zoom-src / data-large — usually highest quality
      const zoom = img.getAttribute("data-zoom-src") ||
                   img.getAttribute("data-zoom") ||
                   img.getAttribute("data-large-src") ||
                   img.getAttribute("data-full");
      if (zoom && zoom.startsWith("http")) return zoom;

      // data-src (lazy loading)
      const lazy = img.getAttribute("data-src") ||
                   img.getAttribute("data-lazy-src") ||
                   img.getAttribute("data-original");
      if (lazy && lazy.startsWith("http")) return lazy;

      // src fallback
      const src = img.src;
      if (src && src.startsWith("http") && !src.includes("placeholder") && src.length > 20) return src;

      return "";
    }

    const gallerySelectors = [
      '[class*="product-image-carousel"]',
      '[class*="product-gallery"]',
      '[class*="productGallery"]',
      '[class*="pdp-gallery"]',
      '[class*="image-gallery"]',
      '[class*="media-gallery"]',
      '[class*="product-images"]',
      '[class*="productImages"]',
      '[class*="carousel__slide"] img',
      '[class*="swiper-slide"] img',
      '[class*="thumbnail"] img',
      'figure img',
    ];

    const imageSet = new Set<string>();
    for (const sel of gallerySelectors) {
      for (const el of document.querySelectorAll(sel)) {
        const src = bestImageSrc(el);
        if (src) imageSet.add(src);
      }
    }

    // Remove size suffixes to get original quality
    const images = Array.from(imageSet)
      .map((url) =>
        url
          .replace(/_\d+x\d+\.(jpg|webp|png)/gi, ".$1")
          .replace(/[?&](width|height|w|h|size|quality)=\d+/gi, "")
          .replace(/\?$/, "")
      )
      .filter((u) => u.startsWith("http") && !u.includes("data:"))
      .slice(0, 15);

    // ── Variants ──────────────────────────────────────────────────────────────
    function parseVariant(el: Element) {
      const label =
        el.getAttribute("data-display-value") ||
        el.getAttribute("data-value") ||
        el.getAttribute("title") ||
        el.getAttribute("aria-label") ||
        el.textContent?.trim() ||
        "";

      const priceAttr =
        el.getAttribute("data-price") ||
        el.getAttribute("data-sale-price") ||
        el.getAttribute("data-product-price") ||
        "";

      const outOfStock =
        el.classList.contains("out-of-stock") ||
        el.classList.contains("is-unavailable") ||
        el.classList.contains("disabled") ||
        el.getAttribute("data-available") === "false" ||
        el.getAttribute("aria-disabled") === "true" ||
        el.hasAttribute("disabled");

      return {
        label,
        price_try: parsePrice(priceAttr),
        stock: outOfStock ? 0 : 10,
      };
    }

    const variantSelectors = [
      '[class*="size-selector"] [class*="option"]',
      '[class*="size-selector"] button',
      '[class*="variant"] [class*="item"]',
      '[class*="swatch-container"] [class*="swatch"]',
      '[class*="color-swatch"]',
      '[data-testid*="variant"]',
      '[data-testid="size-option"]',
      '[class*="size-option"]',
      'button[data-size]',
      'li[data-sku-id]',
    ];

    const variantSet  = new Map<string, { label: string; price_try: number; stock: number }>();
    for (const sel of variantSelectors) {
      for (const el of document.querySelectorAll(sel)) {
        const v = parseVariant(el);
        if (v.label && !variantSet.has(v.label)) variantSet.set(v.label, v);
      }
    }
    const variants = Array.from(variantSet.values()).filter((v) => v.label.length > 0);

    // ── SKU ───────────────────────────────────────────────────────────────────
    const sku =
      attr(['[data-product-id]'], "data-product-id") ||
      attr(['[data-sku]'], "data-sku") ||
      attr(['[data-sku-id]'], "data-sku-id") ||
      attr(['[data-item-id]'], "data-item-id") ||
      text(['[class*="product-id"]', '[class*="productId"]', '[itemprop="productID"]']);

    // ── Stock status ──────────────────────────────────────────────────────────
    const outOfStock =
      !!document.querySelector('[class*="out-of-stock"]') ||
      !!document.querySelector('[class*="outOfStock"]') ||
      !!document.querySelector('[class*="sold-out"]') ||
      !!document.querySelector('[data-testid="out-of-stock"]') ||
      !!document.querySelector('[class*="unavailable"]');

    const lowStock =
      !!document.querySelector('[class*="low-stock"]') ||
      !!document.querySelector('[class*="limited-stock"]') ||
      !!document.querySelector('[class*="limitedStock"]');

    const stock_status: ScrapedProduct["stock_status"] =
      outOfStock ? "out_of_stock" : lowStock ? "low_stock" : "in_stock";

    return { name, brand, description, price_try: price, images, variants, sku, stock_status };
  });
}

// ── Blocked-page detector ─────────────────────────────────────────────────

const BLOCK_KEYWORDS = [
  "access denied", "403 forbidden", "just a moment",
  "checking your browser", "robot or human",
  "captcha", "cloudflare", "enable javascript",
];

async function isBlocked(page: Page): Promise<boolean> {
  const title = (await page.title()).toLowerCase();
  const h1    = await page.locator("h1").first().textContent({ timeout: 2000 }).catch(() => "");
  const check = `${title} ${h1}`.toLowerCase();
  return BLOCK_KEYWORDS.some((kw) => check.includes(kw));
}

// ── Merge extraction results ──────────────────────────────────────────────
// JSON-LD is most authoritative; DOM fills in anything it missed.

function mergeResults(
  jsonLd:  Partial<ScrapedProduct> | null,
  meta:    Partial<ScrapedProduct> | null,
  dom:     Partial<ScrapedProduct>,
): ScrapedProduct {
  // Priority: jsonLd > dom > meta
  const name        = jsonLd?.name         || dom.name         || meta?.name         || "";
  const brand       = jsonLd?.brand        || dom.brand        || "";
  const description = jsonLd?.description  || dom.description  || meta?.description  || "";
  const sku         = jsonLd?.sku          || dom.sku          || "";
  const stock_status = jsonLd?.stock_status || dom.stock_status || "in_stock";

  // Price: prefer JSON-LD, then DOM
  const price_try   = jsonLd?.price_try || dom.price_try || meta?.price_try || 0;

  // Variants: DOM always has more detail
  const variants    = (dom.variants?.length ? dom.variants : jsonLd?.variants) ?? [];

  // Images: merge all, dedup, JSON-LD and DOM sources first
  const allImages = [
    ...(jsonLd?.images ?? []),
    ...(dom.images    ?? []),
    ...(meta?.images  ?? []),
  ];
  const seen    = new Set<string>();
  const images  = allImages.filter((u) => {
    const clean = u.split("?")[0]; // ignore query string for dedup key
    if (seen.has(clean)) return false;
    seen.add(clean);
    return u.startsWith("http");
  });

  return { name, brand, description, price_try, images, variants, sku: sku || undefined, stock_status, original_url: "" };
}

// ══════════════════════════════════════════════════════════════════════════════
// SINGLE PRODUCT SCRAPER
// ══════════════════════════════════════════════════════════════════════════════

const MAX_RETRIES = 3;

export async function scrapeSephoraProduct(url: string): Promise<ScrapedProduct> {
  validateSephoraUrl(url);

  let lastError: Error = new Error("Unknown scrape failure");
  // ── HTTP-first: try plain fetch before launching browser ──────────────────
  try {
    const _key = process.env.SCRAPERAPI_KEY;
    const _fetchUrl = _key ? `https://api.scraperapi.com/?api_key=${_key}&url=${encodeURIComponent(url)}&render=true` : url;
    const httpRes = await fetch(_fetchUrl, {
     signal: AbortSignal.timeout(30000),
      headers: {
        "User-Agent": randomUA(),
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "tr-TR,tr;q=0.9,en;q=0.7",
        "Cache-Control": "no-cache",
        "Upgrade-Insecure-Requests": "1",
      },
    });
    if (httpRes.ok) {
      const html = await httpRes.text();
      const clean = html.toLowerCase();
      const isOk = html.length > 5000 && !BLOCK_KEYWORDS.some(kw => clean.includes(kw));
      if (isOk) {
        const m = html.match(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/i);
        if (m) {
          const ld = JSON.parse(m[1]);
          const p: Record<string, unknown> = ld["@type"] === "Product" ? ld :
            (Array.isArray(ld) ? ld.find((d: Record<string, unknown>) => d["@type"] === "Product") : null) ?? {};
          if (p.name) {
            const offers = (p.offers as Record<string, unknown>) || {};
            const imgs: string[] = Array.isArray(p.image) ? p.image as string[] : p.image ? [p.image as string] : [];
            console.log(`[HTTP] Scraped via HTTP: ${String(p.name)}`);
            return {
              name: String(p.name),
              brand: String((p.brand as Record<string, unknown>)?.name ?? ""),
              description: String(p.description ?? ""),
              price_try: parseFloat(String(offers.price ?? offers.lowPrice ?? "0")),
              sku: p.sku ? String(p.sku) : undefined,
              images: imgs.filter((i: string) => i.startsWith("http")),
              stock_status: String(offers.availability ?? "").includes("InStock") ? "in_stock" : "out_of_stock",
              variants: [],
              original_url: url,
            };
          }
        }
      }
    }
  } catch { /* fall through to Playwright */ }
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const b   = await getBrowser();
    const ctx = await newStealthContext(b);
    const page = await ctx.newPage();

    try {
      await applyResourceFilter(page);

      // Random delay before navigate (looks more human)
      if (attempt > 1) await jitter(2000, 5000);

      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 35_000 });

      // If still loading (SPA), wait for product name to appear
      await Promise.race([
        page.waitForSelector(
          'h1, [class*="product-name"], [class*="productName"], [itemprop="name"]',
          { timeout: 15_000 }
        ),
        page.waitForLoadState("networkidle", { timeout: 15_000 }),
      ]).catch(() => {}); // non-fatal — carry on

      if (await isBlocked(page)) {
        lastError = new AppError(
          `Sephora blocked the request (attempt ${attempt}/${MAX_RETRIES}). Try again later.`,
          503,
          "SCRAPER_BLOCKED"
        );
        continue; // retry
      }

      // Allow JS to hydrate
      await page.waitForTimeout(1200 + Math.random() * 800);

      // Run all three strategies in parallel
      const [jsonLdResult, metaResult, domResult] = await Promise.all([
        extractJsonLd(page),
        extractMeta(page),
        extractDom(page),
      ]);

      const product = mergeResults(jsonLdResult, metaResult, domResult);

      if (!product.name) {
        lastError = new Error(`Could not extract product name from: ${url}`);
        continue; // retry
      }

      if (product.price_try <= 0) {
        // Warn in log but don't fail — price may be variant-level only
        console.warn(`⚠  No base price extracted for: ${product.name}`);
      }

      product.original_url = url;
      return product;

    } catch (err: any) {
      lastError = err;
      console.warn(`Scrape attempt ${attempt}/${MAX_RETRIES} failed: ${err.message}`);
    } finally {
      await page.close().catch(() => {});
      await ctx.close().catch(() => {});
    }
  }

  throw lastError;
}

// ══════════════════════════════════════════════════════════════════════════════
// CATALOG SCRAPER (pagination + bulk URL extraction)
// ══════════════════════════════════════════════════════════════════════════════

export interface CatalogOptions {
  maxPages?:    number;  // default 20
  delayMs?:     number;  // ms between pages, default 1500
}

export async function scrapeSephoraCatalog(
  categoryUrl: string,
  options: CatalogOptions = {}
): Promise<CatalogScrapeResult> {
  validateSephoraUrl(categoryUrl);

  const maxPages  = options.maxPages ?? 20;
  const delayMs   = options.delayMs  ?? 1500;
  const allUrls   = new Set<string>();
  let   page_num  = 1;
  let   totalPages = 1;

  const b   = await getBrowser();
  const ctx = await newStealthContext(b);
  const page = await ctx.newPage();

  try {
    await applyResourceFilter(page);

    while (page_num <= maxPages) {
      // Build paged URL
      const pageUrl = buildPageUrl(categoryUrl, page_num);

      console.log(`  Catalog page ${page_num}: ${pageUrl}`);

      await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.waitForTimeout(delayMs + Math.random() * 800);

      if (await isBlocked(page)) {
        console.warn(`  Blocked at page ${page_num} — stopping catalog scrape`);
        break;
      }

      // Extract product links from this page
      const pageUrls = await extractProductLinks(page);

      if (pageUrls.length === 0) {
        console.log(`  No products on page ${page_num} — reached end`);
        break;
      }

      for (const u of pageUrls) allUrls.add(u);
      console.log(`  Found ${pageUrls.length} products (total: ${allUrls.size})`);

      // Detect total pages from pagination element
      if (page_num === 1) {
        totalPages = await detectTotalPages(page);
        console.log(`  Total pages detected: ${totalPages}`);
      }

      // Check for next page availability
      const hasNext = await detectNextPage(page, page_num);
      if (!hasNext || page_num >= totalPages) break;

      page_num++;
    }
  } finally {
    await page.close().catch(() => {});
    await ctx.close().catch(() => {});
  }

  return {
    product_urls:  Array.from(allUrls),
    total_pages:   totalPages,
    scraped_pages: page_num,
  };
}

// ── Build paged URL ───────────────────────────────────────────────────────

function buildPageUrl(base: string, pageNum: number): string {
  if (pageNum === 1) return base;

  try {
    const u = new URL(base);
    // Sephora Turkey uses ?page=N or ?sayfa=N
    u.searchParams.set("page", String(pageNum));
    return u.toString();
  } catch {
    return `${base}?page=${pageNum}`;
  }
}

// ── Extract product URLs from a listing page ──────────────────────────────

async function extractProductLinks(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const base = window.location.origin;

    const linkSelectors = [
      'a[href*="/p/"]',
      '[class*="product-tile"] a',
      '[class*="product-item"] a',
      '[class*="productCard"] a',
      '[class*="product-card"] a',
      '[class*="ProductCard"] a',
      '[class*="product-grid"] a[href]',
      '[class*="product-list"] a[href]',
      'article a[href]',
    ];

    const urls = new Set<string>();

    for (const sel of linkSelectors) {
      for (const el of document.querySelectorAll(sel)) {
        const href = (el as HTMLAnchorElement).href || el.getAttribute("href") || "";
        if (!href) continue;

        // Make absolute
        let absolute: string;
        try {
          absolute = href.startsWith("http") ? href : new URL(href, base).toString();
        } catch { continue; }

        // Must contain product path pattern
        if (/\/p\/[^\/]+/.test(absolute) || /\/urun\//.test(absolute)) {
          // Strip query params except essential
          try {
            const u = new URL(absolute);
            // Keep only the path
            urls.add(`${u.origin}${u.pathname}`);
          } catch { urls.add(absolute); }
        }
      }
    }

    return Array.from(urls);
  });
}

// ── Detect total pages ────────────────────────────────────────────────────

async function detectTotalPages(page: Page): Promise<number> {
  return page.evaluate(() => {
    // Strategy 1: last page number in pagination
    const pageLinks = [
      ...document.querySelectorAll('[class*="pagination"] a'),
      ...document.querySelectorAll('[class*="Pagination"] a'),
      ...document.querySelectorAll('[aria-label*="Sayfa"] a'),
      ...document.querySelectorAll('[class*="page-link"]'),
    ];

    let max = 1;
    for (const el of pageLinks) {
      const t = el.textContent?.trim() ?? "";
      const n = parseInt(t, 10);
      if (!isNaN(n) && n > max) max = n;
    }
    if (max > 1) return max;

    // Strategy 2: total product count / items per page
    const countEl = document.querySelector(
      '[class*="total-count"], [class*="result-count"], [class*="product-count"], [data-testid="product-count"]'
    );
    if (countEl) {
      const match = countEl.textContent?.match(/(\d+)/);
      if (match) {
        const total = parseInt(match[1], 10);
        if (total > 0) return Math.ceil(total / 24); // assume 24/page
      }
    }

    return 1;
  });
}

// ── Detect if next page exists ────────────────────────────────────────────

async function detectNextPage(page: Page, currentPage: number): Promise<boolean> {
  return page.evaluate((cur) => {
    // Look for a "next" button that's not disabled
    const nextBtns = [
      ...document.querySelectorAll('[class*="next"] a, [aria-label="Sonraki"] a, [rel="next"]'),
      ...document.querySelectorAll('a[class*="next"]:not([class*="disabled"])'),
      ...document.querySelectorAll('[class*="pagination-next"]:not(.disabled)'),
    ];

    for (const el of nextBtns) {
      if (!el.hasAttribute("disabled") && !el.classList.contains("disabled")) {
        return true;
      }
    }

    // Fallback: check if there's a page link for cur+1
    const pageLinks = document.querySelectorAll('[class*="pagination"] a, [class*="page-link"]');
    for (const el of pageLinks) {
      const n = parseInt(el.textContent?.trim() ?? "", 10);
      if (n === cur + 1) return true;
    }

    return false;
  }, currentPage);
}

// ── URL validation ────────────────────────────────────────────────────────

export function validateSephoraUrl(url: string): void {
  let parsed: URL;
  try { parsed = new URL(url); }
  catch {
    throw new AppError("Invalid URL format — must start with https://", 400, "VALIDATION_ERROR");
  }
  const allowed = ["www.sephora.com.tr", "sephora.com.tr", "m.sephora.com.tr"];
  if (!allowed.includes(parsed.hostname)) {
    throw new AppError(
      `Only Sephora Turkey URLs are accepted (sephora.com.tr) — got: ${parsed.hostname}`,
      400,
      "INVALID_URL"
    );
  }
}
