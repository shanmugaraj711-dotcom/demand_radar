# Demand Radar (Topic Radar)

Type any topic. Get thousands of real phrases people search for, find the businesses that serve it, and follow up with them one by one.

No dependencies to install. Needs [Node.js 22.5 or newer](https://nodejs.org).

```bash
node --disable-warning=ExperimentalWarning server.js
```

Then open http://localhost:4173. On Windows you can double-click `start.bat`.

## What it does

| Tab | What you get |
|---|---|
| **Radar** | Type a topic (any language). It asks Google, Bing, YouTube and DuckDuckGo what people type (Yahoo, eBay and Amazon are optional), and gives you thousands of phrases grouped by who is asking: find a provider, app, price, training, resources, language and so on. Filter by intent, word or place. Shows which other cities people search in, flags phrases that probably mean something else, and lists competing apps from the App Store. |
| **Leads** | Find businesses for a phrase across a whole city (Google Places API, your own key), or import a CSV, or add by hand. Each lead gets a readable score. "Check websites" reads each business site for WhatsApp numbers, emails and whether they already have an app. |
| **Follow-ups** | Today's list: who to message, with the text ready. Opens WhatsApp with the message filled in. You press send. Cadence: first message, follow-up next day, one call on day 4, then stop. Daily cap protects your number. |
| **Funnel** | Found, reachable, contacted, replied, pilot, won. Shows the weakest step. |
| **Settings** | Keys, your name and offer, message templates (English and Tamil). |

The keyword part needs **no account and no key**.

## Finding businesses

Two ways, use either:

1. **Google Places API (built in).** Settings → paste your key. Google Cloud Console → enable "Places API (New)" → turn on billing → create a key. Requests are billed by Google, so the app shows an estimate first and stops at a daily cap you set.
2. **Use an existing scraper and import the CSV.** For example [gosom/google-maps-scraper](https://github.com/gosom/google-maps-scraper) exports name, phone, website, rating and email without an API key. Leads → Import CSV. Column names from Outscraper, Apify and similar exports are recognised. Check the tool's and Google's terms before scraping.

## Use it on a phone (PWA) and put it on a server

The app is installable ("Add to Home Screen"), has a phone layout with a bottom tab bar, asks "Did you send it?" when you come back from WhatsApp, and can save a lead as a phone contact. To run it on a server behind a login, set `APP_PIN` and `ALLOWED_HOSTS` (the app refuses to listen beyond localhost without a PIN). Step-by-step for AWS Amazon Linux + Cloudflare Tunnel: [deploy/DEPLOY.md](deploy/DEPLOY.md).

## Rules the app keeps

- It never sends a message for you. WhatsApp opens with the text filled in; you press send.
- It uses a neutral greeting until you know the person's name.
- Score is a ranking aid, not a prediction. The keyword score shows how strongly search engines suggest a phrase. It is **not** monthly search volume.
- Keys and data stay on your computer (`data/`). By default the server only listens on `localhost`; it will not listen wider, or serve a public hostname, without a PIN.

## Optional

`GOOGLE_PLACES_API_KEY` and `ANTHROPIC_API_KEY` can be set as environment variables instead of in Settings. The Anthropic key enables the "AI brief" button, which writes an opportunity summary from your phrases (not covered by the automated tests).

## Test

```bash
npm test
```

Runs login/security checks, then the whole stack. Google Places, the geocoder and websites are faked locally; keyword collection uses the real network. If the real network is blocked, the live part is detected in 5 seconds and skipped, and the summary says so. `npm run test:local` skips the live part on purpose; `npm run probe` shows which keyword sources this machine can reach.

## Known limits

- Search-suggestion endpoints are unofficial. If one blocks you it is switched off for that scan and the scan continues with the others.
- Google Play has no open search, so only the App Store is used for competing apps.
- Place names in phrases are guessed, then checked with OpenStreetMap's geocoder, so tiny villages may be dropped.
- Message templates in Tamil were written quickly. Have a native speaker check them before sending.
