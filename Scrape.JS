const { chromium } = require('playwright');
const fs = require('fs');

const TARGET_URL = 'https://riyasewana.com/search/honda/civic-fd/2008-2015';
const OUTPUT_PATH = 'data/riyasewana.json';

// Basic stealth: hide the most obvious automation fingerprints. Cloudflare's
// "Attention Required" / "I'm Under Attack Mode" challenge mainly checks
// that a real browser executes its JS and waits a few seconds — it does NOT
// require solving a visible CAPTCHA in most cases, so a real browser with
// these signals cleaned up should pass it without needing residential IPs.
const STEALTH_INIT_SCRIPT = `
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
  Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
  window.chrome = { runtime: {} };
`;

async function scrape() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled']
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    locale: 'en-US'
  });

  await context.addInitScript(STEALTH_INIT_SCRIPT);
  const page = await context.newPage();

  console.log('Navigating to', TARGET_URL);
  await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // Try to see real listing cards. If we're still on Cloudflare's challenge
  // page, give it time to auto-resolve and reload once before giving up.
  try {
    await page.waitForSelector('.v-card', { timeout: 20000 });
  } catch (e) {
    const title = await page.title();
    console.log('No listing cards yet after 20s. Page title:', title);
    if (/Attention Required|Just a moment/i.test(title)) {
      console.log('Looks like the Cloudflare challenge page — waiting and retrying once...');
      await page.waitForTimeout(8000);
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForSelector('.v-card', { timeout: 20000 });
    } else {
      throw e;
    }
  }

  const listings = await page.$$eval('.v-card', (cards) =>
    cards.map((card) => {
      const linkEl = card.querySelector('a[href*="/buy/"]');
      const url = linkEl ? linkEl.href : null;
      const title = linkEl ? linkEl.getAttribute('title') : '';

      const priceEl = card.querySelector('.v-card-price');
      const priceText = priceEl ? priceEl.textContent.trim() : '';

      const yearEl = card.querySelector('.v-card-year');
      const year = yearEl ? yearEl.textContent.trim() : '';

      const metaEl = card.querySelector('.v-card-meta');
      let location = '';
      let mileage = '';
      if (metaEl) {
        const metaText = metaEl.textContent.trim(); // e.g. "Wattala·116,353 km"
        const parts = metaText.split('\u00b7'); // '·'
        location = (parts[0] || '').trim();
        const mileageMatch = (parts[1] || '').match(/[\d,]+/);
        mileage = mileageMatch ? mileageMatch[0] : '';
      }

      const dateEl = card.querySelector('.v-card-date');
      const postedDate = dateEl ? dateEl.textContent.trim() : '';

      const priceMatch = priceText.match(/Rs\.\s*([\d,]+)/);
      const price = priceMatch ? priceMatch[1] : (priceText.includes('Negotiable') ? 'Negotiable' : '');

      return { url, title, price, year, mileage, location, postedDate };
    })
  );

  const validListings = listings.filter((l) => l.url);
  console.log('Extracted', validListings.length, 'listings');

  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync(
    OUTPUT_PATH,
    JSON.stringify({ scrapedAt: new Date().toISOString(), listings: validListings }, null, 2)
  );

  await browser.close();
}

scrape().catch((err) => {
  console.error('Scrape failed:', err);
  process.exit(1);
});