# Vehicle Listings Tracker — Project Context

## Goal
Automated tracker for used Honda Civic (FD generation, roughly 2007–2012) listings
in Sri Lanka, feeding a Google Sheet so listings can be reviewed without manually
checking multiple sites.

## Google Sheet
URL: https://docs.google.com/spreadsheets/d/1iGhWelFboI3SSotkoNPf7LCCzOcOJ-j-gflp-ZTW1mE/edit
Tab: "Listings"
Headers (in order): Date Found, Site, Title, Price (LKR), Year, Mileage (km),
Fuel Type, Transmission, Location, URL, Status, Posted Date, Owner Contact Number

The Apps Script writes by HEADER NAME (via `ensureHeaders()` / `colMap`), not fixed
column positions, so columns can be reordered/added without breaking it.

## Data sources — current status

### 1. ikman.lk — WORKING, reliable
- Apps Script function: `checkIkman()`, trigger: hourly
- Search URL: `https://ikman.lk/en/ads/q/sri-lanka/honda-civic`
- Parses the site's embedded `window.initialData` JSON directly (real JSON, not
  regex-guessing) — gives accurate price/mileage/location/postedDate.
- Filters to category "Cars" and year range 2007–2012.
- Best-effort contact-number scraping via `fetchIkmanContact()` (free, no proxy
  needed) — sometimes returns a real number, often blank (numbers are usually
  behind a "Show Number" click).

### 2. autolanka.com — WORKING but thin data
- Apps Script function: `checkAutolanka()`, trigger: daily
- Search URL: `https://www.autolanka.com/cars/honda/civic/`
- Only Title/Year/URL are available — price/mileage load via client-side JS and
  aren't in the static HTML a plain fetch sees. Location/posted date/contact are
  blank by design; not worth extra engineering for the little this site offers.

### 3. riyasewana.com — BLOCKED by Cloudflare, in progress
- Site returns HTTP 403 (Cloudflare's "Attention Required" bot-challenge page) to
  any plain server-side fetch — confirmed via testing. No header trick fixes this;
  it requires a real browser executing Cloudflare's JS challenge.
- Real HTML structure IS confirmed (via a working paid proxy, before we moved off
  it) — listing cards use classes `.v-card`, `.v-card-price`, `.v-card-year`,
  `.v-card-meta` (contains pin-icon + location + "·" separator + km-icon +
  mileage), `.v-card-date`. See `parseRiyasewana()` regex logic in the Apps
  Script for the exact patterns if useful.
- Search URL used: `https://riyasewana.com/search/honda/civic-fd/2008-2015`
  (this range already filters server-side, matched to buyer's actual criteria).

**Paid proxy attempts (abandoned by user's choice — wants no credit card, ever):**
scrape.do (worked, credits ran low), ScrapingBee (wrong account signed up),
WebScrapingAPI (wanted card), Bright Data (wanted card, even for its free
5,000/month tier). All of these "free tiers" eventually gate behind a card for
identity verification, even when the tier itself doesn't charge.

**Current approach: self-hosted, free, via GitHub Actions + Playwright.**
- Public repo: https://github.com/Kasuntharu/vehicle-scraper
- Files: `scrape.js` (Playwright script — launches real Chromium with basic
  stealth patches to navigator.webdriver/plugins/languages, navigates to the
  search URL, waits for `.v-card` to appear or retries once if still on the
  challenge page, extracts listings via DOM selectors, writes `data/riyasewana.json`),
  `package.json`, `.github/workflows/scrape.yml` (cron every 6 hours +
  manual `workflow_dispatch` trigger, commits results back to the repo).
- **Two bugs found and just fixed on GitHub's web UI:**
  1. `package.json` was created empty (0 bytes) — Playwright was never installed.
  2. Script file was accidentally named `Scrape.JS` (capitalized) while the
     workflow calls `node scrape.js` (lowercase) — GitHub Actions runs on Linux,
     which is case-sensitive, so this silently failed to find the file.
- **Status as of handoff: both bugs just fixed, a re-run was about to be tested.
  We do NOT yet know if Playwright successfully gets past Cloudflare's challenge**
  — that's the next real test. If `.v-card` never appears after the retry, the
  workflow will fail/throw, and the log output is needed to debug further
  (could mean Cloudflare escalated to a harder challenge, or GitHub Actions'
  IP ranges are flagged, in which case residential-proxy-based options would
  need to be reconsidered).
- Once `data/riyasewana.json` is confirmed to contain real listings, the last
  step is wiring up `checkRiyasewanaFromGitHub()` (Apps Script function,
  already written, needs `GITHUB_RAW_URL` updated to point at
  `https://raw.githubusercontent.com/Kasuntharu/vehicle-scraper/main/data/riyasewana.json`)
  and pointing a trigger at it instead of the old `checkRiyasewana()`
  (which still exists in the script, using scrape.do — can be removed once
  the GitHub-based version is confirmed working).

## Apps Script — trigger setup (target end state)
- `checkIkman` — Time-driven, hourly
- `checkAutolanka` — Time-driven, daily
- `checkRiyasewanaFromGitHub` — Time-driven, can run as often as desired since
  it's free (just reads a JSON file); the actual scraping happens on GitHub's
  own 6-hour schedule independently
- (Old `checkRiyasewana` scrape.do-based trigger should be deleted once the
  GitHub-based version is confirmed working)

## Known limitations / accepted tradeoffs
- Owner Contact Number is best-effort everywhere and often blank — these sites
  gate phone numbers behind a click-to-reveal action by design.
- riyasewana.com was intentionally left OUT of automated scraping for a while
  due to the Cloudflare block, before the GitHub Actions approach was built.
- Facebook Marketplace was discussed early on and deliberately excluded from
  automation (login-gated, heavy anti-bot, not worth the fragility) — user
  checks it manually.