# Baggage Damage Claim

An Etihad Airways-branded web app that lets a traveler report damaged checked baggage, upload evidence photos, get an AI damage/authenticity assessment, and receive compensation — entirely self-serve, with no human agent in the loop for the common case.

The frontend is a single-page React app. The backend is a Google Apps Script Web App bound to a Google Sheet, which doubles as both the traveler database and the claims log, and which calls the Anthropic API to analyze uploaded photos.

## How it works

1. **Identify the traveler.** The user either scans the PDF417 barcode on their boarding pass with their camera, or manually types in their booking reference and last name.
2. **Confirm the flight and bag details.** The app looks up the booking in a "Recent travelers details" Google Sheet tab and shows the flight, route, and bag count.
3. **Upload evidence, per bag.** For each damaged bag the user uploads three photos: the baggage tag, the brand label, and a close-up of the damage. Only the damage photo is sent for deep analysis — the tag and label photos are used only so a human reviewer can see which bag is which.
4. **AI assessment.** The backend sends the damage photo to Claude (Opus, for image analysis) with a damage-assessment + image-authenticity system prompt. Claude returns structured JSON: damage classification (major/minor/uncertain), confidence, damaged parts, an authenticity rating, anomalies, and a recommended action.
5. **Branch on the result:**
   - **Minor damage, likely genuine** → an instant compensation offer (Etihad Money or bank transfer).
   - **Major damage, likely genuine** → a higher compensation offer, with a formal receipt/claim reference.
   - **Flagged** (uncertain damage or suspicious authenticity) → routed to "Referred for manual review" instead of an automatic offer.
6. **Repeat per bag, then submit.** The user can claim for multiple bags in one session; finalized bags are locked so back-navigation can't create duplicates. On submission, all bag photos are uploaded to a Google Drive folder and every bag's outcome is logged to a "Submissions" sheet tab.
7. **Every AI call is logged**, successful or not, to a "Baggage damage" sheet tab as a readable plain-text report (not raw JSON), for audit and tuning.

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | React 19, TypeScript 5.7, Vite 8, Tailwind CSS v4 |
| Barcode scanning | [`@zxing/library`](https://github.com/zxing-js/library) (`BrowserMultiFormatReader`, constrained to PDF417) for IATA Resolution 792 boarding-pass barcodes |
| Backend | Google Apps Script (serverless, bound to the Google Sheet) |
| Data store | Google Sheets (traveler records, submissions, AI assessment log) |
| File storage | Google Drive (uploaded claim photos) |
| AI | Anthropic Claude API (`claude-opus-5-5`) for image-based damage and authenticity analysis |

## Project structure

```
src/
  main.tsx       React entrypoint; mounts App.tsx and imports index.css
  App.tsx        The entire app: types, API calls, every screen component, and the top-level state machine
  index.css      Global styles and the Tailwind v4 import
index.html       Vite HTML shell
apps-script/
  Code.gs        Backend source of truth — kept in sync with the live Apps Script project by hand (see below)
vite.config.ts   Vite config (React + Tailwind v4 + Figma Make plugins, `@` alias for `src`)
```

## Frontend

### Screens (state machine)

The app is one component tree driven by a `Screen` union type, with no router:

`home → manual (or scan) → details → upload (per bag) → analysing → flagged | minor | offer → accepted → receipt (major) | transfer → success`

Key pieces in `src/App.tsx`:

- `TravelerRecord`, `BagClaim`, `DamageStatus` — core data types.
- `findTraveler()` — looks up a booking by reference + last name against the Sheet (falls back to local demo data if `SHEET_API_URL` is blank).
- `analyseDamage()` — uploads a bag's three photos for AI assessment; throws `DamageFlaggedError` when the AI recommends manual review.
- `submitClaim()` — uploads all finalized bags and their photos in one submission.
- `parseBoardingPass()` — extracts booking reference + last name from a scanned PDF417 payload.
- `nextBagId()` / `finalizeActiveBag()` / `finishSession()` / `locked` — the multi-bag claim state machine, including the guard that prevents phantom duplicate bags from back-navigation after a bag is finalized.

### Compensation amounts

| Scenario | Etihad Money | Bank transfer |
|---|---|---|
| Instant offer (minor damage) | $100.00 | $50.00 |
| Post-receipt / major damage | $150.00 | $100.00 |

### Running locally

```bash
pnpm install
pnpm dev       # start the Vite dev server
pnpm build     # production build
pnpm preview   # preview the production build
pnpm format    # oxfmt
```

## Backend (Google Apps Script)

`apps-script/Code.gs` is the **source of truth in this repo**, but Apps Script has no CLI deploy from a local checkout — it's edited and deployed by hand in the browser at script.google.com. After changing `Code.gs` here, paste the full file into the Apps Script editor, save, and deploy a new version from the same deployment (so the Web App URL stays the same and the frontend doesn't need updating).

### Setup (new environment)

1. Create a Google Sheet with these tabs (created automatically on first use if missing, but can be pre-created): `Recent travelers details`, `Submissions`, `Baggage damage`.
2. Open **Extensions → Apps Script** in that Sheet and paste in `apps-script/Code.gs`.
3. **Project Settings → Script Properties** → add `ANTHROPIC_API_KEY` = your Anthropic API key. Never put this key in the frontend — it stays server-side here.
4. **Deploy → New deployment → Web app** → Execute as "Me", who has access "Anyone" → Deploy → copy the Web App URL.
5. Paste that URL into `SHEET_API_URL` in `src/App.tsx`.

### Endpoints

The Web App exposes one URL with two verbs:

- `GET ?bookingRef=...&lastName=...` — traveler lookup against the `Recent travelers details` tab.
- `POST` — a JSON body routed by shape:
  - `{ action: "analyse", bookingRef, bagId, images: [...] }` — runs the AI damage/authenticity assessment for one bag.
  - anything else — treated as a final claim submission (`{ bookingRef, firstName, lastName, flightNumber, bags: [...] }`), which uploads photos to Drive and appends one row per bag to `Submissions`.

### AI damage + authenticity analysis

`handleAnalyse()` sends three labeled photos to Claude per bag — `Baggage Tag`, `Brand Label`, `Close-up of Damage` (plus any further `Additional damage evidence #N`). The system prompt (`DAMAGE_SYSTEM_PROMPT`) explicitly restricts analysis to the damage photo(s); the tag and label photos are for identification only.

Claude is asked to return **only** a JSON object, with each object's fields listed in a specific order — evidence, then reasoning, then the verdict that follows from it:

```json
{
  "damage": {
    "damaged_parts": [{ "part": "", "damage_type": "", "severity": "" }],
    "possible_hidden_damage": [],
    "reasoning": "",
    "classification": "minor | major | uncertain",
    "confidence": "high | medium | low"
  },
  "authenticity": {
    "anomalies": [{ "category": "", "location": "", "description": "" }],
    "supporting_signs": [],
    "limitations": [],
    "rating": "likely_genuine | suspicious | likely_manipulated_or_ai | cannot_determine",
    "confidence": "high | medium | low"
  },
  "additional_photos_needed": [],
  "verification_steps": [],
  "summary": "",
  "recommended_action": "process | request_more_evidence | escalate_to_human | hold"
}
```

The field order is deliberate, not cosmetic: Claude generates JSON fields in the order the schema lists them, so listing `damaged_parts`/`anomalies` and `reasoning` before `classification`/`rating` forces the model to lay out evidence and reasoning before it commits to a verdict, instead of deciding first and rationalizing afterward. The prompt's `OUTPUT` section spells this out explicitly. This costs nothing extra (no additional photos or tokens) and is the main lever for improving reasoning quality and reducing snap-judgment misclassification.

`reasoning` and `summary` are plain natural-language text, not further nested JSON — the JSON wrapper exists only to keep the machine-parseable fields (`classification`, `confidence`, `rating`, `recommended_action`) separate from the AI's free-text explanation.

`mapAssessment()` collapses that into the simple shape the frontend branches on:

- `recommended_action: "process"` + damage `major`/`minor` → `{ status: "major" | "minor", ... }` → an automatic offer.
- `recommended_action: "request_more_evidence"` → `{ error: ... }` → the user is asked to retake photos.
- anything else (`escalate_to_human`, `hold`, or an `uncertain` damage classification) → `{ flagged: true, ... }` → "Referred for manual review".

`max_tokens` is set to **4096**, not a smaller number: Claude Opus can spend part of its token budget on internal reasoning before producing visible text, and a smaller budget can be exhausted before any output is produced (`stop_reason: "max_tokens"` with empty text), which otherwise shows up as every single claim being incorrectly flagged for manual review regardless of photo content.

### Logging

Every analysis call — success, flagged, parse failure, or API error — is appended as a row to the `Baggage damage` sheet tab:

| Column | Contents |
|---|---|
| Timestamp, Booking Reference, Bag ID | Claim identifiers |
| Result | `error`, `flagged`, `major`, or `minor` — the frontend-facing outcome, not Claude's literal `recommended_action` value |
| Damage Classification, Damage Confidence | Outcome summary |
| Authenticity Rating, Authenticity Confidence | Authenticity summary |
| Summary | Claude's one-paragraph summary |
| Full AI Report | A human-readable plain-text report (`formatReportAsText()`), not raw JSON |

## Known limitations / things to revisit

- `apps-script/Code.gs` in this repo and the live deployed script must be kept in sync by hand — there's no automated deploy step.
- `SHEET_API_URL` is a plaintext constant in `src/App.tsx`; the Anthropic API key is the only secret, and it lives server-side in Apps Script Script Properties (never in frontend code).
- The AI's "major vs minor" and "authenticity" calls are a single model pass with no human-in-the-loop confirmation for the automatic-offer path — only the flagged path gets manual review.
