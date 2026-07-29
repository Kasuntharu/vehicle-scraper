const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const TARGET_URL =
  process.env.TARGET_URL || 'https://riyasewana.com/search/honda/civic-fd/2008-2015';
const OUTPUT_PATH = process.env.OUTPUT_PATH || 'data/riyasewana.json';
const DEBUG_DIR = process.env.DEBUG_DIR || 'debug';
const MAX_ATTEMPTS = Number(process.env.MAX_ATTEMPTS || 3);

const LISTING_SELECTOR = '.v-card';

// Cloudflare's "I'm Under Attack" interstitial mainly checks that a real browser
// executes its JS and waits a few seconds; it usually resolves itself without a
// visible CAPTCHA. These patches only hide signals that an automated Chromium
// leaks. Anything the browser already reports realistically is left alone on
// purpose — overwriting it with a cruder fake is easier to detect than the
// genuine value.
const STEALTH_INIT_SCRIPT = `
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  if (!window.chrome) { window.chrome = { runtime: {} }; }
  if (!navigator.plugins || navigator.plugins.length === 0) {
    Object.defineProperty(navigator, 'plugins', {
      get: () => [{ name: 'PDF Viewer' }, { name: 'Chrome PDF Viewer' }]
    });
  }
`;

// Cloudflare serves two very different pages, and telling them apart decides
// whether retrying is worth anything:
//
//   'challenge' — "Just a moment..." / IUAM. Ships a JS challenge that a real
//                 browser solves on its own after a few seconds. Retrying works.
//   'blocked'   — "Sorry, you have been blocked". A WAF/firewall rule rejected
//                 the request outright. There is no challenge on the page to
//                 solve, so no amount of stealth or waiting changes the answer;
//                 only a different source IP does. Retrying just hammers a host
//                 that has already said no.
function classifyBlock(title, html) {
  const t = title || '';
  const h = html || '';

  if (/cf-chl|challenge-platform|__cf_chl|turnstile/i.test(h) || /just a moment/i.test(t)) {
    return 'challenge';
  }
  if (/sorry, you have been blocked|error 10\d\d/i.test(h) || /attention required/i.test(t)) {
    return 'blocked';
  }
  return 'unknown';
}

async function extractListings(page) {
  return page.$$eval(LISTING_SELECTOR, (cards) =>
    cards.map((card) => {
      const linkEl = card.querySelector('a[href*="/buy/"]');
      const url = linkEl ? linkEl.href : null;
      const title = linkEl
        ? (linkEl.getAttribute('title') || linkEl.textContent || '').trim()
        : '';

      const text = (sel) => {
        const el = card.querySelector(sel);
        return el ? el.textContent.trim() : '';
      };

      const priceText = text('.v-card-price');
      const year = text('.v-card-year');
      const postedDate = text('.v-card-date');

      let location = '';
      let mileage = '';
      const metaText = text('.v-card-meta'); // e.g. "Wattala·116,353 km"
      if (metaText) {
        const parts = metaText.split('·'); // '·'
        location = (parts[0] || '').trim();
        const mileageMatch = (parts[1] || '').match(/[\d,]+/);
        mileage = mileageMatch ? mileageMatch[0] : '';
      }

      const priceMatch = priceText.match(/Rs\.?\s*([\d,]+)/i);
      const price = priceMatch
        ? priceMatch[1]
        : /negotiable/i.test(priceText)
          ? 'Negotiable'
          : '';

      return { url, title, price, year, mileage, location, postedDate };
    })
  );
}

async function dumpDebug(page, label) {
  try {
    fs.mkdirSync(DEBUG_DIR, { recursive: true });
    await page.screenshot({
      path: path.join(DEBUG_DIR, `${label}.png`),
      fullPage: true
    });
    fs.writeFileSync(path.join(DEBUG_DIR, `${label}.html`), await page.content());
    console.log(`Wrote debug snapshot to ${DEBUG_DIR}/${label}.{png,html}`);
  } catch (e) {
    console.warn('Could not write debug snapshot:', e.message);
  }
}

async function scrape() {
  // channel: 'chromium' selects Chromium's *new* headless mode, which shares a
  // binary and fingerprint with headed Chrome. The old headless build that a
  // bare `headless: true` used to give us is trivially detectable.
  const browser = await chromium.launch({
    channel: 'chromium',
    headless: true,
    args: ['--disable-blink-features=AutomationControlled']
  });

  try {
    // No userAgent override: the real one already matches the Sec-CH-UA client
    // hints Chromium sends. Pinning a stale string here contradicts those
    // headers, which is itself a bot signal.
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      locale: 'en-US',
      timezoneId: 'Asia/Colombo'
    });
    await context.addInitScript(STEALTH_INIT_SCRIPT);

    const page = await context.newPage();

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      console.log(`Attempt ${attempt}/${MAX_ATTEMPTS}: navigating to ${TARGET_URL}`);
      const response = await page.goto(TARGET_URL, {
        waitUntil: 'domcontentloaded',
        timeout: 60000
      });
      console.log('HTTP status:', response ? response.status() : 'unknown');

      try {
        await page.waitForSelector(LISTING_SELECTOR, { timeout: 20000 });
        const listings = (await extractListings(page)).filter((l) => l.url);
        console.log('Extracted', listings.length, 'listings');

        // Never overwrite a good previous run with an empty result — an empty
        // page almost always means we were blocked, not that the site is empty.
        if (listings.length === 0) {
          throw new Error('Listing cards were present but yielded zero usable listings');
        }
        return listings;
      } catch (e) {
        const title = await page.title();
        const html = await page.content();
        const kind = classifyBlock(title, html);
        console.log(`No listings. Page title: ${JSON.stringify(title)} (classified: ${kind})`);
        await dumpDebug(page, `attempt-${attempt}`);

        if (kind === 'blocked') {
          throw new Error(
            `Cloudflare WAF blocked this request outright (HTTP ${response ? response.status() : '?'}, ` +
              `${JSON.stringify(title)}). This is a firewall block, not a solvable challenge: the page ` +
              `carries no challenge for the browser to complete, so stealth settings and longer waits ` +
              `cannot help. The source IP is what got rejected. Not retrying.`
          );
        }

        if (attempt === MAX_ATTEMPTS) {
          throw new Error(
            `Gave up after ${MAX_ATTEMPTS} attempts. Last page title: ${JSON.stringify(title)} ` +
              `(classified: ${kind}). Underlying error: ${e.message}`
          );
        }

        if (kind === 'challenge') {
          console.log('Cloudflare JS challenge detected — waiting for it to resolve...');
        } else {
          console.log('Page matched no known block pattern; the layout may have changed. Retrying.');
        }
        await page.waitForTimeout(8000 * attempt);
      }
    }

    throw new Error('Unreachable: retry loop exited without a result');
  } finally {
    await browser.close();
  }
}

scrape()
  .then((listings) => {
    fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
    fs.writeFileSync(
      OUTPUT_PATH,
      JSON.stringify(
        {
          scrapedAt: new Date().toISOString(),
          sourceUrl: TARGET_URL,
          count: listings.length,
          listings
        },
        null,
        2
      )
    );
    console.log(`Wrote ${listings.length} listings to ${OUTPUT_PATH}`);
  })
  .catch((err) => {
    console.error('Scrape failed:', err);
    process.exit(1);
  });
