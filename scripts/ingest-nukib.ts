/**
 * NUKIB ingestion crawler — scrapes nukib.gov.cz for guidance, advisories,
 * and supporting materials, then writes them into the SQLite database.
 *
 * Sources crawled:
 *   1. /cs/infoservis/doporuceni/        — recommendations (→ guidance table)
 *   2. /cs/infoservis/hrozby/            — threats & warnings (→ advisories table)
 *   3. /cs/infoservis/aktuality/         — news / alerts (→ advisories table, filtered)
 *   4. /cs/kyberneticka-bezpecnost/regulace-a-kontrola/podpurne-materialy/
 *        metodiky-navody-doporuceni-a-standardy/  — standards & methodologies (→ guidance table)
 *
 * Usage:
 *   npx tsx scripts/ingest-nukib.ts [--resume] [--dry-run] [--force]
 *
 * Flags:
 *   --resume   Skip items already present in the database (by reference)
 *   --dry-run  Log what would be inserted without touching the database
 *   --force    Drop and recreate all tables before ingestion
 *
 * Environment:
 *   NUKIB_DB_PATH  — SQLite database path (default: data/nukib.db)
 */

import Database from "better-sqlite3";
import * as cheerio from "cheerio";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA_SQL } from "../src/db.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const BASE_URL = "https://nukib.gov.cz";
const RATE_LIMIT_MS = 1500;
const MAX_RETRIES = 3;
const RETRY_BACKOFF_MS = 2000;
const REQUEST_TIMEOUT_MS = 30_000;

const DB_PATH = process.env["NUKIB_DB_PATH"] ?? "data/nukib.db";

const FLAGS = {
  resume: process.argv.includes("--resume"),
  dryRun: process.argv.includes("--dry-run"),
  force: process.argv.includes("--force"),
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ListEntry {
  url: string;
  title: string;
  date: string | null;
}

interface GuidanceRecord {
  reference: string;
  title: string;
  title_en: string | null;
  date: string | null;
  type: string;
  series: string;
  summary: string | null;
  full_text: string;
  topics: string | null;
  status: string;
}

interface AdvisoryRecord {
  reference: string;
  title: string;
  date: string | null;
  severity: string | null;
  affected_products: string | null;
  summary: string | null;
  full_text: string;
  cve_references: string | null;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(url: string, attempt = 1): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "AnsvarNUKIBCrawler/1.0 (+https://ansvar.eu; contact: hello@ansvar.ai)",
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "cs,en;q=0.5",
      },
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} for ${url}`);
    }
    return await res.text();
  } catch (err) {
    if (attempt >= MAX_RETRIES) {
      throw new Error(
        `Failed after ${MAX_RETRIES} attempts: ${url} — ${(err as Error).message}`,
      );
    }
    const delay = RETRY_BACKOFF_MS * attempt;
    console.warn(
      `  [retry ${attempt}/${MAX_RETRIES}] ${url} — ${(err as Error).message}, waiting ${delay}ms`,
    );
    await sleep(delay);
    return fetchWithRetry(url, attempt + 1);
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Date parsing — Czech months
// ---------------------------------------------------------------------------

const CZ_MONTHS: Record<string, string> = {
  leden: "01",
  ledna: "01",
  únor: "02",
  února: "02",
  březen: "03",
  března: "03",
  duben: "04",
  dubna: "04",
  květen: "05",
  května: "05",
  červen: "06",
  června: "06",
  červenec: "07",
  července: "07",
  srpen: "08",
  srpna: "08",
  září: "09",
  říjen: "10",
  října: "10",
  listopad: "11",
  listopadu: "11",
  prosinec: "12",
  prosince: "12",
};

/**
 * Parse Czech date strings into ISO format (YYYY-MM-DD).
 * Handles:
 *   "2. srpen 2023"         → "2023-08-02"
 *   "20. červen 2023"       → "2023-06-20"
 *   "02.08.2023"            → "2023-08-02"
 *   "2023-08-02"            → pass-through
 */
function parseCzechDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();

  // ISO format pass-through
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  // DD.MM.YYYY numeric
  const numMatch = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (numMatch) {
    const [, d, m, y] = numMatch;
    return `${y}-${m!.padStart(2, "0")}-${d!.padStart(2, "0")}`;
  }

  // "D. monthname YYYY"
  const wordMatch = s.match(/^(\d{1,2})\.\s*(\S+)\s+(\d{4})$/);
  if (wordMatch) {
    const [, d, monthWord, y] = wordMatch;
    const m = CZ_MONTHS[monthWord!.toLowerCase()];
    if (m) {
      return `${y}-${m}-${d!.padStart(2, "0")}`;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Reference ID generation
// ---------------------------------------------------------------------------

/**
 * Extract the NUKIB numeric ID from a URL like
 * /cs/infoservis/doporuceni/1988-doporuceni-v-oblasti-...
 * and turn it into a reference like NUKIB-DOP-1988.
 */
function makeReference(url: string, prefix: string): string {
  const match = url.match(/\/(\d+)-/);
  const id = match?.[1] ?? url.replace(/\//g, "-").slice(1);
  return `${prefix}-${id}`;
}

// ---------------------------------------------------------------------------
// List-page scraping
// ---------------------------------------------------------------------------

/**
 * Scrape a NUKIB list page (doporuceni, hrozby, aktuality).
 * These pages use h3 headings with anchor links, preceded by date text.
 * The pattern is: date text followed by an h3 > a[href] element.
 */
async function scrapeListPage(listUrl: string): Promise<ListEntry[]> {
  console.log(`\n  Fetching list: ${listUrl}`);
  const html = await fetchWithRetry(listUrl);
  const $ = cheerio.load(html);
  const entries: ListEntry[] = [];

  // NUKIB list pages use various structures. Try multiple approaches.

  // Approach 1: Find all links inside headings (h3 a, h2 a) within the content area
  const contentArea =
    $(".item-page").length > 0
      ? $(".item-page")
      : $("#content").length > 0
        ? $("#content")
        : $("main").length > 0
          ? $("main")
          : $("body");

  contentArea.find("h3 a, h2 a").each((_i, el) => {
    const $a = $(el);
    const href = $a.attr("href");
    if (!href) return;

    // Skip external and non-article links
    if (href.startsWith("http") && !href.startsWith(BASE_URL)) return;
    if (href.includes("/download/")) return;

    const title = $a.text().trim();
    if (!title) return;

    // Try to extract the date from the preceding text node or sibling
    const $heading = $a.closest("h3, h2");
    let dateStr: string | null = null;

    // Date might be in text before the link within the heading
    const headingText = $heading.text().trim();
    const dateMatch = headingText.match(
      /(\d{1,2}\.\s*\d{1,2}\.\s*\d{4}|\d{1,2}\.\s*\S+\s+\d{4})/,
    );
    if (dateMatch) {
      dateStr = parseCzechDate(dateMatch[1]!);
    }

    // Date might be in a preceding element
    if (!dateStr) {
      const prevText = $heading.prev().text().trim();
      const prevMatch = prevText.match(
        /(\d{1,2}\.\s*\d{1,2}\.\s*\d{4}|\d{1,2}\.\s*\S+\s+\d{4})/,
      );
      if (prevMatch) {
        dateStr = parseCzechDate(prevMatch[1]!);
      }
    }

    const fullUrl = href.startsWith("/") ? `${BASE_URL}${href}` : href;
    entries.push({ url: fullUrl, title, date: dateStr });
  });

  // Approach 2: Look for plain links with NUKIB article URL pattern
  if (entries.length === 0) {
    contentArea
      .find('a[href*="/cs/infoservis/"], a[href*="/cs/kyberneticka-bezpecnost/"]')
      .each((_i, el) => {
        const $a = $(el);
        const href = $a.attr("href");
        if (!href || !href.match(/\/\d+-/)) return;
        if (href.includes("/download/")) return;

        const title = $a.text().trim();
        if (!title || title.length < 5) return;

        const fullUrl = href.startsWith("/") ? `${BASE_URL}${href}` : href;
        // Deduplicate
        if (entries.some((e) => e.url === fullUrl)) return;
        entries.push({ url: fullUrl, title, date: null });
      });
  }

  console.log(`  Found ${entries.length} entries`);
  return entries;
}

/**
 * Scrape the supporting materials page (metodiky-navody-doporuceni-a-standardy).
 * This page lists documents inline with PDF download links rather than
 * linking to sub-pages. We extract document metadata directly.
 */
async function scrapeSupportingMaterials(
  pageUrl: string,
): Promise<GuidanceRecord[]> {
  console.log(`\n  Fetching supporting materials: ${pageUrl}`);
  const html = await fetchWithRetry(pageUrl);
  const $ = cheerio.load(html);
  const records: GuidanceRecord[] = [];

  const contentArea =
    $(".item-page").length > 0
      ? $(".item-page")
      : $("#content").length > 0
        ? $("#content")
        : $("main").length > 0
          ? $("main")
          : $("body");

  // Find section headings that categorize documents
  let currentCategory = "standard";

  // Process bold titles and their following text
  contentArea.find("strong, b").each((_i, el) => {
    const $strong = $(el);
    const titleText = $strong.text().trim();

    // Skip section headings that are too short or are category labels
    if (!titleText || titleText.length < 5) return;

    // Detect category switches
    const lowerTitle = titleText.toLowerCase();
    if (lowerTitle === "technické" || lowerTitle === "netechnické") {
      currentCategory = lowerTitle === "technické" ? "standard" : "guideline";
      return;
    }

    // Look for a PDF link nearby
    const $parent = $strong.parent();
    const $links = $parent.find('a[href*=".pdf"]');
    const pdfLink =
      $links.length > 0
        ? $links.first().attr("href")
        : $parent.next().find('a[href*=".pdf"]').first().attr("href");

    // Extract the surrounding text as description
    const surroundingText = $parent.text().trim();
    const description = surroundingText
      .replace(titleText, "")
      .replace(/Stáhnout pdf/gi, "")
      .replace(/\(v[\d.]+[^)]*\)/g, "")
      .trim();

    // Extract version info
    const versionMatch = surroundingText.match(
      /v([\d.]+)\s+platn[áa]\s+ke\s+dni\s+(\d{1,2}\.\s*\d{1,2}\.\s*\d{4})/,
    );
    const version = versionMatch?.[1] ?? null;
    const dateStr = versionMatch ? parseCzechDate(versionMatch[2]!) : null;

    // Build a reference from the PDF filename or title
    const pdfFilename = pdfLink
      ? decodeURIComponent(pdfLink.split("/").pop() ?? "")
          .replace(/\.pdf$/i, "")
          .replace(/[%\s]+/g, "-")
      : null;
    const refSlug =
      pdfFilename ??
      titleText
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9]+/g, "-")
        .slice(0, 60);
    const reference = `NUKIB-MAT-${refSlug}${version ? `-v${version}` : ""}`;

    records.push({
      reference,
      title: titleText,
      title_en: null,
      date: dateStr,
      type: currentCategory,
      series: "podpurne-materialy",
      summary: description || null,
      full_text: [titleText, description, pdfLink ? `PDF: ${BASE_URL}${pdfLink}` : ""]
        .filter(Boolean)
        .join("\n\n"),
      topics: currentCategory === "standard" ? "standard,metodika" : "doporuceni,navod",
      status: "current",
    });
  });

  console.log(`  Extracted ${records.length} supporting material records`);
  return records;
}

// ---------------------------------------------------------------------------
// Detail-page scraping
// ---------------------------------------------------------------------------

/**
 * Scrape an individual article page and extract the body content.
 * Returns { body, date, summary }.
 */
async function scrapeDetailPage(
  url: string,
): Promise<{ body: string; date: string | null; summary: string | null }> {
  const html = await fetchWithRetry(url);
  const $ = cheerio.load(html);

  // Remove navigation, header, footer, sidebars
  $(
    "nav, header, footer, .sidebar, .nav, .menu, .breadcrumb, script, style, noscript",
  ).remove();

  // Find the main content area
  const contentArea =
    $(".item-page").length > 0
      ? $(".item-page")
      : $("article").length > 0
        ? $("article")
        : $("#content").length > 0
          ? $("#content")
          : $("main").length > 0
            ? $("main")
            : $(".content").length > 0
              ? $(".content")
              : $("body");

  // Extract date from the page
  let date: string | null = null;
  const pageText = contentArea.text();
  const datePatterns = [
    /(\d{1,2}\.\s*\S+\s+\d{4})/,
    /(\d{1,2}\.\s*\d{1,2}\.\s*\d{4})/,
  ];
  for (const pattern of datePatterns) {
    const match = pageText.match(pattern);
    if (match) {
      const parsed = parseCzechDate(match[1]!);
      if (parsed) {
        date = parsed;
        break;
      }
    }
  }

  // Get the body text — clean and structured
  const paragraphs: string[] = [];
  contentArea.find("h1, h2, h3, h4, p, li, blockquote, td").each((_i, el) => {
    const text = $(el).text().trim();
    if (!text) return;
    // Skip very short fragments that are probably navigation
    if (text.length < 3) return;
    paragraphs.push(text);
  });

  const body = paragraphs.join("\n\n");

  // First meaningful paragraph as summary (skip title and date)
  let summary: string | null = null;
  for (const p of paragraphs) {
    if (p.length > 40 && !p.match(/^\d{1,2}\.\s/) && !p.match(/^NÚKIB$/i)) {
      summary = p.length > 500 ? p.slice(0, 497) + "..." : p;
      break;
    }
  }

  return { body, date, summary };
}

// ---------------------------------------------------------------------------
// CVE extraction
// ---------------------------------------------------------------------------

function extractCVEs(text: string): string | null {
  const cves = text.match(/CVE-\d{4}-\d{4,}/g);
  if (!cves || cves.length === 0) return null;
  return [...new Set(cves)].join(", ");
}

// ---------------------------------------------------------------------------
// Severity classification
// ---------------------------------------------------------------------------

/**
 * Attempt to classify severity from the Czech text.
 * NUKIB uses terms like varování (warning), upozornění (alert),
 * and text clues about impact.
 */
function classifySeverity(title: string, body: string): string {
  const combined = `${title} ${body}`.toLowerCase();

  if (
    combined.includes("kritick") ||
    combined.includes("critical") ||
    combined.includes("okamžit") ||
    combined.includes("naléhav")
  ) {
    return "critical";
  }
  if (
    combined.includes("varování") ||
    combined.includes("warning") ||
    combined.includes("závažn") ||
    combined.includes("ransomware") ||
    combined.includes("vysoké riziko") ||
    combined.includes("zvýšené riziko")
  ) {
    return "high";
  }
  if (
    combined.includes("upozornění") ||
    combined.includes("upozorňujeme") ||
    combined.includes("phishing") ||
    combined.includes("vishing") ||
    combined.includes("podvodn")
  ) {
    return "medium";
  }
  return "informational";
}

// ---------------------------------------------------------------------------
// Guidance type classification
// ---------------------------------------------------------------------------

function classifyGuidanceType(title: string, url: string): string {
  const combined = `${title} ${url}`.toLowerCase();
  if (combined.includes("standard") || combined.includes("norma")) {
    return "standard";
  }
  if (
    combined.includes("metodika") ||
    combined.includes("methodology") ||
    combined.includes("návod")
  ) {
    return "methodology";
  }
  if (combined.includes("doporučení") || combined.includes("doporuceni")) {
    return "recommendation";
  }
  if (combined.includes("analýza") || combined.includes("analyza")) {
    return "analysis";
  }
  if (combined.includes("pokyn")) {
    return "guideline";
  }
  return "recommendation";
}

// ---------------------------------------------------------------------------
// Topic extraction
// ---------------------------------------------------------------------------

const TOPIC_KEYWORDS: Record<string, string[]> = {
  cloud: ["cloud", "cloudov"],
  "ICS/SCADA": ["ics", "scada", "průmyslov", "ot/it", "prumyslov"],
  ransomware: ["ransomware", "ransom"],
  phishing: ["phishing", "phishinkov"],
  vishing: ["vishing", "vishinkov", "telefonát"],
  kryptografie: ["kryptograf", "šifrov", "šifra", "postkvantov"],
  NIS2: ["nis2", "nis 2"],
  "5G": ["5g", "5 g"],
  AI: ["umělá inteligence", "umela inteligence", "ai act", "deepseek"],
  MFA: ["mfa", "vícefaktor", "multifaktor", "vicefaktor"],
  supply_chain: ["dodavatel", "supply chain", "dodavatelský řetězec"],
  DDoS: ["ddos"],
  Rusko: ["ruská federac", "rusko", "ruských"],
  Čína: ["čínsk", "china", "čína"],
  incident: ["incident", "incidentu"],
  certifikace: ["certifikac", "certifikát"],
  penetrační_testy: ["penetrační test", "pentest"],
  videokonference: ["videokonferenc", "vtc"],
};

function extractTopics(text: string): string | null {
  const lower = text.toLowerCase();
  const found: string[] = [];
  for (const [topic, keywords] of Object.entries(TOPIC_KEYWORDS)) {
    if (keywords.some((kw) => lower.includes(kw))) {
      found.push(topic);
    }
  }
  return found.length > 0 ? found.join(",") : null;
}

// ---------------------------------------------------------------------------
// Database operations
// ---------------------------------------------------------------------------

function openDb(): Database.Database {
  const dir = dirname(DB_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  if (FLAGS.force && existsSync(DB_PATH)) {
    unlinkSync(DB_PATH);
    console.log(`Deleted existing database: ${DB_PATH}`);
  }

  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  return db;
}

function guidanceExists(db: Database.Database, reference: string): boolean {
  const row = db
    .prepare("SELECT 1 FROM guidance WHERE reference = ?")
    .get(reference);
  return row !== undefined;
}

function advisoryExists(db: Database.Database, reference: string): boolean {
  const row = db
    .prepare("SELECT 1 FROM advisories WHERE reference = ?")
    .get(reference);
  return row !== undefined;
}

function insertGuidance(db: Database.Database, rec: GuidanceRecord): void {
  db.prepare(
    `INSERT OR REPLACE INTO guidance
       (reference, title, title_en, date, type, series, summary, full_text, topics, status)
     VALUES
       (@reference, @title, @title_en, @date, @type, @series, @summary, @full_text, @topics, @status)`,
  ).run(rec);
}

function insertAdvisory(db: Database.Database, rec: AdvisoryRecord): void {
  db.prepare(
    `INSERT OR REPLACE INTO advisories
       (reference, title, date, severity, affected_products, summary, full_text, cve_references)
     VALUES
       (@reference, @title, @date, @severity, @affected_products, @summary, @full_text, @cve_references)`,
  ).run(rec);
}

function upsertFramework(
  db: Database.Database,
  id: string,
  name: string,
  name_en: string | null,
  description: string | null,
  count: number,
): void {
  db.prepare(
    `INSERT INTO frameworks (id, name, name_en, description, document_count)
     VALUES (@id, @name, @name_en, @description, @document_count)
     ON CONFLICT(id) DO UPDATE SET document_count = @document_count`,
  ).run({ id, name, name_en, description, document_count: count });
}

// ---------------------------------------------------------------------------
// Crawl pipelines
// ---------------------------------------------------------------------------

/**
 * Crawl the /cs/infoservis/doporuceni/ section → guidance table.
 */
async function crawlDoporuceni(db: Database.Database): Promise<number> {
  console.log("\n=== Crawling: Doporučení (Recommendations) ===");
  const entries = await scrapeListPage(
    `${BASE_URL}/cs/infoservis/doporuceni/`,
  );

  let count = 0;
  for (const entry of entries) {
    const reference = makeReference(entry.url, "NUKIB-DOP");

    if (FLAGS.resume && guidanceExists(db, reference)) {
      console.log(`  [skip] ${reference} — ${entry.title}`);
      continue;
    }

    await sleep(RATE_LIMIT_MS);
    console.log(`  [fetch] ${entry.url}`);

    try {
      const detail = await scrapeDetailPage(entry.url);
      const fullText = detail.body || entry.title;
      const date = detail.date ?? entry.date;

      const rec: GuidanceRecord = {
        reference,
        title: entry.title,
        title_en: null,
        date,
        type: classifyGuidanceType(entry.title, entry.url),
        series: "doporuceni",
        summary: detail.summary,
        full_text: fullText,
        topics: extractTopics(`${entry.title} ${fullText}`),
        status: "current",
      };

      if (FLAGS.dryRun) {
        console.log(`  [dry-run] Would insert guidance: ${reference}`);
      } else {
        insertGuidance(db, rec);
        console.log(`  [ok] ${reference} — ${entry.title}`);
      }
      count++;
    } catch (err) {
      console.error(
        `  [error] Failed to process ${entry.url}: ${(err as Error).message}`,
      );
    }
  }

  return count;
}

/**
 * Crawl the /cs/infoservis/hrozby/ section → advisories table.
 */
async function crawlHrozby(db: Database.Database): Promise<number> {
  console.log("\n=== Crawling: Hrozby (Threats & Warnings) ===");
  const entries = await scrapeListPage(`${BASE_URL}/cs/infoservis/hrozby/`);

  let count = 0;
  for (const entry of entries) {
    const reference = makeReference(entry.url, "NUKIB-THR");

    if (FLAGS.resume && advisoryExists(db, reference)) {
      console.log(`  [skip] ${reference} — ${entry.title}`);
      continue;
    }

    await sleep(RATE_LIMIT_MS);
    console.log(`  [fetch] ${entry.url}`);

    try {
      const detail = await scrapeDetailPage(entry.url);
      const fullText = detail.body || entry.title;
      const date = detail.date ?? entry.date;

      const rec: AdvisoryRecord = {
        reference,
        title: entry.title,
        date,
        severity: classifySeverity(entry.title, fullText),
        affected_products: null,
        summary: detail.summary,
        full_text: fullText,
        cve_references: extractCVEs(fullText),
      };

      if (FLAGS.dryRun) {
        console.log(`  [dry-run] Would insert advisory: ${reference}`);
      } else {
        insertAdvisory(db, rec);
        console.log(`  [ok] ${reference} — ${entry.title}`);
      }
      count++;
    } catch (err) {
      console.error(
        `  [error] Failed to process ${entry.url}: ${(err as Error).message}`,
      );
    }
  }

  return count;
}

/**
 * Crawl /cs/infoservis/aktuality/ — filter for security-relevant news
 * and insert as advisories.
 */
async function crawlAktuality(db: Database.Database): Promise<number> {
  console.log("\n=== Crawling: Aktuality (News — security-relevant) ===");
  const entries = await scrapeListPage(`${BASE_URL}/cs/infoservis/aktuality/`);

  // Filter for security-relevant news (varování, zranitelnost, incident, etc.)
  const securityKeywords = [
    "varování",
    "varovani",
    "zranitelnost",
    "incident",
    "útok",
    "utok",
    "ransomware",
    "phishing",
    "ddos",
    "hrozb",
    "bezpečnost",
    "bezpecnost",
    "kybernetick",
    "deepseek",
    "sankc",
  ];

  const relevant = entries.filter((e) => {
    const lower = e.title.toLowerCase();
    return securityKeywords.some((kw) => lower.includes(kw));
  });

  console.log(
    `  Filtered ${relevant.length} security-relevant from ${entries.length} total news`,
  );

  let count = 0;
  for (const entry of relevant) {
    const reference = makeReference(entry.url, "NUKIB-NEWS");

    if (FLAGS.resume && advisoryExists(db, reference)) {
      console.log(`  [skip] ${reference} — ${entry.title}`);
      continue;
    }

    await sleep(RATE_LIMIT_MS);
    console.log(`  [fetch] ${entry.url}`);

    try {
      const detail = await scrapeDetailPage(entry.url);
      const fullText = detail.body || entry.title;
      const date = detail.date ?? entry.date;

      const rec: AdvisoryRecord = {
        reference,
        title: entry.title,
        date,
        severity: classifySeverity(entry.title, fullText),
        affected_products: null,
        summary: detail.summary,
        full_text: fullText,
        cve_references: extractCVEs(fullText),
      };

      if (FLAGS.dryRun) {
        console.log(`  [dry-run] Would insert advisory: ${reference}`);
      } else {
        insertAdvisory(db, rec);
        console.log(`  [ok] ${reference} — ${entry.title}`);
      }
      count++;
    } catch (err) {
      console.error(
        `  [error] Failed to process ${entry.url}: ${(err as Error).message}`,
      );
    }
  }

  return count;
}

/**
 * Crawl supporting materials (metodiky-navody-doporuceni-a-standardy)
 * → guidance table.
 */
async function crawlPodpurneMaterialy(
  db: Database.Database,
): Promise<number> {
  console.log("\n=== Crawling: Podpůrné materiály (Supporting Materials) ===");
  const records = await scrapeSupportingMaterials(
    `${BASE_URL}/cs/kyberneticka-bezpecnost/regulace-a-kontrola/podpurne-materialy/metodiky-navody-doporuceni-a-standardy/`,
  );

  let count = 0;
  for (const rec of records) {
    if (FLAGS.resume && guidanceExists(db, rec.reference)) {
      console.log(`  [skip] ${rec.reference} — ${rec.title}`);
      continue;
    }

    if (FLAGS.dryRun) {
      console.log(`  [dry-run] Would insert guidance: ${rec.reference}`);
    } else {
      insertGuidance(db, rec);
      console.log(`  [ok] ${rec.reference} — ${rec.title}`);
    }
    count++;
  }

  return count;
}

// ---------------------------------------------------------------------------
// Framework sync
// ---------------------------------------------------------------------------

function syncFrameworks(
  db: Database.Database,
  guidanceCount: number,
  advisoryCount: number,
): void {
  if (FLAGS.dryRun) {
    console.log("\n  [dry-run] Would sync framework metadata");
    return;
  }

  // Count guidance records by series
  const seriesCounts = db
    .prepare(
      "SELECT series, COUNT(*) as cnt FROM guidance GROUP BY series",
    )
    .all() as Array<{ series: string; cnt: number }>;

  const doporuceniCount =
    seriesCounts.find((s) => s.series === "doporuceni")?.cnt ?? 0;
  const materialyCount =
    seriesCounts.find((s) => s.series === "podpurne-materialy")?.cnt ?? 0;

  upsertFramework(
    db,
    "nukib-doporuceni",
    "Doporučení NÚKIB",
    "NUKIB Recommendations",
    "Bezpečnostní doporučení a pokyny vydané NÚKIB.",
    doporuceniCount,
  );

  upsertFramework(
    db,
    "nukib-hrozby",
    "Hrozby a varování NÚKIB",
    "NUKIB Threats and Warnings",
    "Bezpečnostní upozornění, varování a informace o hrozbách.",
    advisoryCount,
  );

  upsertFramework(
    db,
    "nukib-podpurne-materialy",
    "Podpůrné materiály NÚKIB",
    "NUKIB Supporting Materials",
    "Metodiky, návody, doporučení a standardy pro kybernetickou bezpečnost.",
    materialyCount,
  );

  upsertFramework(
    db,
    "nukib-framework",
    "Národní rámec kybernetické bezpečnosti",
    "National Cybersecurity Framework",
    "NÚKIB rámec pro ochranu informačních systémů kritické infrastruktury.",
    0,
  );

  upsertFramework(
    db,
    "nis2-cz",
    "Implementace NIS2 v ČR",
    "NIS2 Directive Implementation",
    "Pokyny pro implementaci směrnice NIS2 v České republice.",
    0,
  );

  console.log("\n  Frameworks synced");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("NUKIB Ingestion Crawler");
  console.log("=======================");
  console.log(`Database : ${DB_PATH}`);
  console.log(`Flags    : ${FLAGS.resume ? "--resume " : ""}${FLAGS.dryRun ? "--dry-run " : ""}${FLAGS.force ? "--force " : ""}`);
  console.log(`Rate limit: ${RATE_LIMIT_MS}ms between requests`);

  const db = FLAGS.dryRun ? null : openDb();

  // Use a no-op DB for dry-run mode
  const dbOrDummy = db ?? openDb();

  const startTime = Date.now();

  // Crawl all sections
  const doporuceniCount = await crawlDoporuceni(dbOrDummy);
  const hrozbyCount = await crawlHrozby(dbOrDummy);
  const aktualityCount = await crawlAktuality(dbOrDummy);
  const materialyCount = await crawlPodpurneMaterialy(dbOrDummy);

  // Sync frameworks
  const totalAdvisories = hrozbyCount + aktualityCount;
  const totalGuidance = doporuceniCount + materialyCount;
  syncFrameworks(dbOrDummy, totalGuidance, totalAdvisories);

  // Final counts
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  if (!FLAGS.dryRun) {
    const guidanceTotal = dbOrDummy
      .prepare("SELECT COUNT(*) as cnt FROM guidance")
      .get() as { cnt: number };
    const advisoryTotal = dbOrDummy
      .prepare("SELECT COUNT(*) as cnt FROM advisories")
      .get() as { cnt: number };
    const frameworkTotal = dbOrDummy
      .prepare("SELECT COUNT(*) as cnt FROM frameworks")
      .get() as { cnt: number };

    console.log("\n=======================");
    console.log("Ingestion complete");
    console.log(`  Guidance   : ${guidanceTotal.cnt} total (${totalGuidance} this run)`);
    console.log(`  Advisories : ${advisoryTotal.cnt} total (${totalAdvisories} this run)`);
    console.log(`  Frameworks : ${frameworkTotal.cnt}`);
    console.log(`  Duration   : ${elapsed}s`);
  } else {
    console.log("\n=======================");
    console.log("Dry-run complete (no data written)");
    console.log(`  Guidance candidates   : ${totalGuidance}`);
    console.log(`  Advisory candidates   : ${totalAdvisories}`);
    console.log(`  Duration              : ${elapsed}s`);
  }

  dbOrDummy.close();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
