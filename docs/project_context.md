# Vehicle Listings Tracker — Project Context

## Goal
Automated tracker for used Honda Civic (FD generation, roughly 2007–2012) listings
in Sri Lanka, feeding a Google Sheet so listings can be reviewed without manually
checking multiple sites.

> **Inconsistent year range — needs a decision.** `checkIkman()` filters to
> 2007–2012, but the riyasewana search URL is `/2008-2015`. So the two sources
> are not tracking the same set of cars: a 2007 car shows up only from ikman, and
> a 2013–2015 car only from riyasewana. Pick one range and apply it to both.

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
- Site returns HTTP 403 with the "Attention Required! | Cloudflare" page to any
  plain server-side fetch — confirmed via testing. No header trick fixes this.

**Correction (2026-07-30): this is a WAF block, not a JS challenge.**
Earlier notes here assumed the 403 was Cloudflare's "I'm Under Attack" interstitial,
which a real browser clears by executing its JS. Testing with real Chromium via
Playwright disproved that. The page served is *"Sorry, you have been blocked"* —
a firewall-rule rejection. It contains no `challenge-platform` script, no
`__cf_chl` token and no Turnstile widget, so there is nothing for a browser to
solve. Waiting, reloading, and stealth patches cannot change the outcome; only a
different source IP can. The two cases are worth keeping straight:

| Page | Meaning | Does a real browser help? |
|---|---|---|
| "Just a moment..." | JS challenge (IUAM) | Yes — it self-resolves in a few seconds |
| "Sorry, you have been blocked" | WAF firewall rule | No — the IP was rejected outright |

`scrape.js` now classifies these (`classifyBlock()`) and fails fast on a hard
block instead of retrying a host that already refused.

**The developer's own IP is currently WAF-blocked.** Testing on 2026-07-30 from
the dev machine (Dialog Axiata residential, Colombo — `175.157.15.79`) got 403 on
*every* path including the bare homepage, via real Chromium, plain `curl`, and
`curl` with a browser UA alike. Since this is a residential Sri Lankan IP — the
exact thing paid residential-proxy services sell — the most likely cause is that
the earlier round of scraping from this machine tripped a rule and got the
address banned. Practical consequences:
  - riyasewana.com cannot be tested locally until that block ages out. Use the
    parser fixture approach instead (see README) to verify extraction logic.
  - This says nothing definitive about GitHub Actions, which runs from entirely
    different (Azure datacenter) IPs. That remains the open question below.
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
- Files: `scrape.js` (Playwright script — launches real Chromium in new-headless
  mode, patches `navigator.webdriver`, navigates to the search URL, waits for
  `.v-card`, retries a JS challenge up to `MAX_ATTEMPTS` times but fails fast on
  a hard WAF block, extracts listings via DOM selectors, writes
  `data/riyasewana.json`), `package.json`, `.github/workflows/scrape.yml` (cron
  every 6 hours + manual `workflow_dispatch` trigger, commits results back to
  the repo).
- The script deliberately does **not** override the user-agent. An earlier version
  pinned `Chrome/124`, which contradicted the `Sec-CH-UA` client-hint headers the
  real browser sends — a mismatch that is itself a strong bot signal. It also no
  longer fakes `navigator.plugins` unconditionally; new-headless Chromium already
  reports realistic values, and a cruder fake is easier to detect than the real one.
- The script never writes an empty listing array over a previous good result — an
  empty page nearly always means "blocked", not "no cars for sale".
- **Two bugs were identified earlier:**
  1. `package.json` was created empty (0 bytes) — Playwright was never installed.
     This one really was fixed.
  2. Script file was named `Scrape.JS` (capitalized) while the workflow calls
     `node scrape.js` (lowercase). GitHub Actions runs on Linux, which is
     case-sensitive, so the workflow could never find the file.
- **Bug 2 was NOT actually fixed** despite the earlier note here saying it was —
  `git ls-tree origin/main` still showed `Scrape.JS` on 2026-07-30. The rename
  most likely never took on a case-insensitive filesystem (macOS/Windows treat
  `Scrape.JS` and `scrape.js` as the same path, so a plain rename is a no-op that
  git does not record). Fixed properly on 2026-07-30 with a two-step
  `git mv Scrape.JS scrape.js.tmp && git mv scrape.js.tmp scrape.js`. If this
  ever needs redoing, use the two-step form — a direct `git mv` will silently
  do nothing here.
- **Status as of 2026-07-30: the workflow has still never had a clean run**, since
  until now it was failing at `node scrape.js` (file not found) before Cloudflare
  was ever reached. **Whether GitHub Actions' IPs can reach riyasewana.com remains
  genuinely untested.** The next Actions run is the first real test. Read its
  outcome as follows:
  - Listings written → done; wire up the Apps Script side.
  - `"Sorry, you have been blocked"` → Azure/GitHub IP ranges are WAF-banned.
    This is not fixable with stealth or retries. The realistic options are a
    residential proxy (rejected: all want a card), running the scraper from a
    machine on the user's own connection once that IP unbans, or dropping
    riyasewana from automation and checking it manually.
  - `"Just a moment..."` that never clears → a real JS challenge is being served
    and stealth tuning is worth pursuing.
  The workflow uploads `debug/` (full-page screenshot + HTML of whatever page it
  got stuck on) as a build artifact on failure, which is what distinguishes these
  three cases. Download it from the failed run's summary page.
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