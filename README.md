# vehicle-scraper

Scrapes used Honda Civic (FD) listings from [riyasewana.com](https://riyasewana.com)
with Playwright, on a schedule, via GitHub Actions. Results are committed to this
repo as `data/riyasewana.json`, which a Google Apps Script reads to populate a
tracking spreadsheet.

This repo covers only the riyasewana source. The ikman.lk and autolanka.com
sources are scraped directly from Apps Script and live elsewhere. See
[docs/project_context.md](docs/project_context.md) for the full picture.

## Status

⚠️ **Not yet confirmed working.** riyasewana.com sits behind Cloudflare, and
whether GitHub Actions' IP ranges can reach it is still untested — see
[the status notes](docs/project_context.md) before assuming a failure is a new bug.

## Running it

```bash
npm install
npx playwright install --with-deps chromium
npm run scrape
```

Output lands in `data/riyasewana.json`:

```json
{
  "scrapedAt": "2026-07-30T00:00:00.000Z",
  "sourceUrl": "https://riyasewana.com/search/honda/civic-fd/2008-2015",
  "count": 2,
  "listings": [
    {
      "url": "https://riyasewana.com/buy/honda-civic-fd3-2010-123",
      "title": "Honda Civic FD3 2010",
      "price": "12,750,000",
      "year": "2010",
      "mileage": "116,353",
      "location": "Wattala",
      "postedDate": "2026-07-28"
    }
  ]
}
```

`price` is a digit string, or the literal `"Negotiable"` when the seller listed no
number. The script exits non-zero rather than writing an empty `listings` array,
so a blocked run can never overwrite good data with nothing.

### Configuration

All optional, via environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `TARGET_URL` | the Civic FD search URL | Page to scrape |
| `OUTPUT_PATH` | `data/riyasewana.json` | Where results are written |
| `DEBUG_DIR` | `debug` | Where failure screenshots/HTML go |
| `MAX_ATTEMPTS` | `3` | Retries for a Cloudflare JS challenge |

## When it fails

The script writes a full-page screenshot and the page HTML to `debug/` on every
failed attempt, and the workflow uploads that directory as a build artifact.
Download it from the failed run's summary page — the screenshot alone usually
identifies the problem:

- **"Sorry, you have been blocked"** — a Cloudflare WAF rule rejected the request.
  There is no challenge on the page to solve, so stealth tweaks and longer waits
  are wasted effort; the source IP is what got refused. The script detects this
  and fails fast rather than retrying.
- **"Just a moment..."** — a genuine JS challenge. A real browser normally clears
  it within seconds; raising `MAX_ATTEMPTS` may help.
- **A normal-looking page with no listings** — the site changed its markup. Update
  the `.v-card*` selectors in `scrape.js`.

## Testing the parser without hitting the site

Because riyasewana blocks aggressively, point the scraper at a local HTML fixture
to exercise the extraction logic on its own:

```bash
TARGET_URL="file://$PWD/fixture.html" OUTPUT_PATH=/tmp/out.json MAX_ATTEMPTS=1 npm run scrape
```

A fixture needs `.v-card` elements containing an `a[href*="/buy/"]` plus
`.v-card-price`, `.v-card-year`, `.v-card-meta` (`Location·123,456 km`) and
`.v-card-date`.

## Note on the filename

The entry point must stay lowercase `scrape.js`. It was once committed as
`Scrape.JS`, which works on macOS but not on the Linux runners, and a plain
`git mv` on a case-insensitive filesystem will not fix it — use the two-step
form via a temporary name.
