# Spec: Resolve "City, State" → Lat/Lng + Population + Median Household Income (Census‑only)

This document defines a small, deterministic workflow to accept **City** and **State** strings and return:

- `lat` (latitude)
- `lng` (longitude)
- `population` (place‑level total population)
- `median_household_income` (place‑level)
- `geo` (Census identifiers used to produce the numbers)

No paid geocoder is required. We rely solely on **U.S. Census Bureau** services.

---

## High‑level Flow
1. **Geocode (onelineaddress)** → normalize the `City, State` string and obtain:
   - Best match coordinates → `lat`, `lng`
   - Containing **Place** (city/town/CDP) → `GEOID` (2‑digit state FIPS + 5‑digit place code)
2. **Query ACS 5‑year** for that Place → fetch **Population** and **Median Household Income**.
3. **Assemble** a unified response object.

---

## Endpoints

### 1) Census Geocoder (onelineaddress)
**Method:** GET  
**URL:**
```
https://geocoding.geo.census.gov/geocoder/locations/onelineaddress
  ?address={CITY}%2C%20{STATE}
  &benchmark=Public_AR_Current
  &format=json
```
**Notes:**
- Input is a single text string, e.g., `address=Sarasota, FL` (URL‑encoded).
- `benchmark=Public_AR_Current` uses the most current public reference.
- The response includes `result.addressMatches[0].coordinates` and `result.addressMatches[0].geographies`.
- Within `geographies`, prefer the **`Places`** array to obtain **place‑level GEOID**.

**Successful response shape (trimmed example):**
```json
{
  "result": {
    "addressMatches": [
      {
        "coordinates": { "x": -82.5307, "y": 27.3364 },
        "geographies": {
          "Places": [
            {
              "GEOID": "1264000",
              "NAME": "Sarasota city",
              "STATE": "12",
              "PLACE": "64000"
            }
          ]
        }
      }
    ]
  }
}
```

> If `Places` is empty (not an incorporated city), check `County Subdivisions` or `Census Designated Places (CDP)` and decide your fallback (see **Edge Cases**).

---

### 2) Census Data API — ACS 5‑year (latest available year)
**Method:** GET  
**URL template:**
```
https://api.census.gov/data/{YEAR}/acs/acs5
  ?get=NAME,{POP_VAR},{INCOME_VAR}
  &for=place:{PLACE_CODE_5}
  &in=state:{STATE_FIPS_2}
  &key={CENSUS_API_KEY}
```
**Variables:**
- **Population (total):** `B01003_001E`  
  (Alternative also seen in some pipelines: `B01001_001E` → total across sex‑by‑age; use one consistently.)
- **Median household income:** `B19013_001E`

**Example (Florida, place code 64000, year 2023):**
```
https://api.census.gov/data/2023/acs/acs5
  ?get=NAME,B01003_001E,B19013_001E
  &for=place:64000
  &in=state:12
  &key=YOUR_CENSUS_KEY
```
**Successful response shape:**
```json
[
  ["NAME","B01003_001E","B19013_001E","state","place"],
  ["Sarasota city, Florida","54145","72355","12","64000"]
]
```

---

## Orchestrated Steps (Deterministic)
1. **Build query string**: `q = `${city}, ${state}`` (state can be 2‑letter or full name; prefer 2‑letter abbr.)
2. **Call Geocoder** with `onelineaddress`:
   - Parse `result.addressMatches[0]` (fail fast if missing).
   - Extract `lng = coordinates.x`, `lat = coordinates.y`.
   - From `geographies.Places[0]`, extract:
     - `geoid` (e.g., `1264000`)
     - `state_fips = geoid.slice(0, 2)` (e.g., `12`)
     - `place_code = geoid.slice(2)` (e.g., `64000`)
   - If `Places` missing → see **Edge Cases**.
3. **Call ACS** (same year across your environment, e.g., `2023`):
   - `get=NAME,B01003_001E,B19013_001E`
   - `for=place:{place_code}`
   - `in=state:{state_fips}`
   - Include `key` when available.
4. **Assemble response**:
```json
{
  "city": "<input>",
  "state": "<input>",
  "lat": <number>,
  "lng": <number>,
  "population": <number>,
  "median_household_income": <number>,
  "geo": {
    "state_fips": "<2-digit>",
    "place": "<5-digit>",
    "geoid": "<7-digit>",
    "dataset": "ACS 5-year <YEAR>"
  }
}
```

---

## Pseudo‑code (TypeScript / fetch)
```ts
async function resolveCityState(city: string, state: string) {
  const q = `${city}, ${state}`;

  // 1) Census Geocoder → coordinates + Place GEOID
  const geoRes = await fetch(
    `https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?address=${encodeURIComponent(q)}&benchmark=Public_AR_Current&format=json`
  );
  if (!geoRes.ok) throw new Error(`Geocoder HTTP ${geoRes.status}`);
  const geo = await geoRes.json();

  const match = geo?.result?.addressMatches?.[0];
  if (!match) throw new Error("No geocoder match for City, State");

  const { x: lng, y: lat } = match.coordinates || {};
  const place = match?.geographies?.Places?.[0];
  if (!place) throw new Error("No Census 'Place' found (consider CDP/County Subdivision fallback)");

  const geoid: string = place.GEOID; // 7 digits
  const stateFips = geoid.slice(0, 2);
  const placeCode = geoid.slice(2);

  // 2) ACS pull → population + median household income
  const YEAR = "2023"; // make configurable
  const POP_VAR = "B01003_001E";
  const INC_VAR = "B19013_001E";
  const acsUrl = `https://api.census.gov/data/${YEAR}/acs/acs5?get=NAME,${POP_VAR},${INC_VAR}&for=place:${placeCode}&in=state:${stateFips}&key=${process.env.CENSUS_API_KEY ?? ""}`;

  const acsRes = await fetch(acsUrl);
  if (!acsRes.ok) throw new Error(`ACS HTTP ${acsRes.status}`);
  const acs = await acsRes.json();
  if (!Array.isArray(acs) || acs.length < 2) throw new Error("ACS response missing data row");

  const header = acs[0] as string[];
  const row = acs[1] as string[];
  const idxPop = header.indexOf(POP_VAR);
  const idxInc = header.indexOf(INC_VAR);

  const population = Number(row[idxPop]);
  const medianHHI = Number(row[idxInc]);

  return {
    city,
    state,
    lat,
    lng,
    population,
    median_household_income: medianHHI,
    geo: {
      state_fips: stateFips,
      place: placeCode,
      geoid,
      dataset: `ACS 5-year ${YEAR}`,
    },
  } as const;
}
```

---

## cURL Examples (copy/paste)
**Geocoder:**
```bash
curl "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?address=Sarasota%2C%20FL&benchmark=Public_AR_Current&format=json"
```
**ACS (replace with codes from geocoder):**
```bash
curl "https://api.census.gov/data/2023/acs/acs5?get=NAME,B01003_001E,B19013_001E&for=place:64000&in=state:12&key=YOUR_CENSUS_KEY"
```

---

## Edge Cases & Fallbacks
1. **Not a Place:** If `Places` is empty, try these in order:
   - `Census Tracts`/`Block Groups` (finer but income/pop available via ACS; requires tract codes)
   - `County Subdivisions` (MCDs in some states)
   - `County`
   Decide and document which level you’ll return if no Place exists.
2. **Ambiguous names:** The geocoder resolves common ambiguities with state specified. For collisions (e.g., multiple matches), pick the top score or add a simple disambiguation rule.
3. **ACS Year:** Use the latest 5‑year year available system‑wide. Expose via config. Keep population/income variables consistent.
4. **Margins of Error:** If you need MoE, also request `B19013_001M` etc., and expose alongside estimates.
5. **Rate limiting:** Cache geocoder + ACS results by `geoid` to avoid repeat calls.

---

## Validation Rules
- Throw on: no `addressMatches`, no `Places`, or missing coordinates.
- Ensure `geoid.length === 7`, `stateFips.length === 2`, `placeCode.length === 5`.
- Ensure numeric coercion for ACS values before returning.

---

## Output Contract (canonical)
```ts
export type CityLookupResult = {
  city: string;
  state: string;         // 2-letter preferred
  lat: number;
  lng: number;
  population: number;    // ACS 5-year, integer
  median_household_income: number; // ACS 5-year, USD
  geo: {
    state_fips: string;  // 2 digits
    place: string;       // 5 digits
    geoid: string;       // 7 digits (state+place)
    dataset: string;     // e.g., "ACS 5-year 2023"
  };
};
```

---

## Environment & Ops
- **Config:** `CENSUS_API_KEY`, `ACS_YEAR` (e.g., `2023`).
- **Timeouts:** 5–10s per request, with 2–3 retries (exponential backoff).
- **Caching:** Key by `geoid` and `ACS_YEAR` for ACS; by `city|state` for geocoder.
- **Logging:** Log raw URLs on debug only (keys redacted). Log `geoid`, timings, and final values.

---

## QA Checklist
- [ ] City/State with spaces and punctuation (e.g., "St. Louis, MO")
- [ ] Ambiguous names (e.g., "Springfield, IL")
- [ ] CDP vs. incorporated Place (e.g., communities in FL/CA)
- [ ] Non‑US or typos → graceful error
- [ ] Income/pop parsed as numbers; not strings
- [ ] Deterministic year across envs

---

## Nice‑to‑have Extensions
- Add MoE fields (`B19013_001M`) to surface confidence.
- Add population density using Land Area from Gazetteer files.
- Accept `lat/lng` input path (reverse geocode endpoint) and reuse the same ACS query logic.