function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Census Tools')
    .addItem('Geocode & Fetch Population', 'runGeocodeAndPopulation')
    .addToUi();
}

function runGeocodeAndPopulation() {
  const sheet = SpreadsheetApp.getActiveSheet();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    SpreadsheetApp.getUi().alert('No data rows found. Please add City (A) and State (B).');
    return;
  }

  Logger.log('[RUN] Starting runGeocodeAndPopulation on sheet "%s" rows 2..%s', sheet.getName(), lastRow);

  const cityStateRange = sheet.getRange(2, 1, lastRow - 1, 2); // A2:B
  const cityStateValues = cityStateRange.getValues();
  Logger.log('[RUN] Loaded %s rows of city/state input', cityStateValues.length);

  const output = [];
  let processed = 0;
  let successes = 0;
  let failures = 0;

  for (let i = 0; i < cityStateValues.length; i++) {
    const row = cityStateValues[i];
    const city = String(row[0] || '').trim();
    const state = String(row[1] || '').trim();
    processed++;

    if (!city && !state) {
      Logger.log('[ROW %s] Empty row; skipping.', i + 2);
      output.push(['', '', '', '']);
      continue;
    }

    Logger.log('[ROW %s] Input city="%s" state="%s"', i + 2, city, state);

    try {
      const geocode = geocodeCityState(city, state);
      if (!geocode) {
        Logger.log('[ROW %s] Geocode returned no result', i + 2);
        failures++;
        output.push(['', '', '', '']);
        continue;
      }

      const { latitude, longitude, stateFips, placeCode } = geocode;
      Logger.log('[ROW %s] Geocode raw lat=%s lng=%s stateFips=%s place=%s', i + 2, latitude, longitude, stateFips, placeCode);

      let population = '';
      let income = '';
      let popNum = 0;
      let isNeighborhood = false;
      
      if (stateFips && placeCode) {
        const acsData = fetchPopulationAcs(stateFips, placeCode);
        if (acsData && typeof acsData === 'object') {
          population = acsData.population || '';
          income = acsData.income || '';
        } else {
          population = acsData || '';
        }
        
        // Validation: Check for city-level data for neighborhoods
        popNum = parseInt(population);
        isNeighborhood = geocode && geocode.googleTypes && geocode.googleTypes.includes('neighborhood');
        if (popNum > 100000 && isNeighborhood) {
          Logger.log('[ROW %s] WARNING: Possible city-level data for neighborhood. Population=%s (likely city-wide data)', i + 2, population);
        }
        
        Logger.log('[ROW %s] Population=%s Income=%s', i + 2, population, income);
      } else {
        Logger.log('[ROW %s] Missing stateFips/placeCode; skipping ACS lookup', i + 2);
        // Set indicators for missing data
        population = '❌ NO PLACE CODE';
        income = '❌ NO PLACE CODE';
      }

      // Google returns WGS84 coordinates directly, no conversion needed
      Logger.log('[ROW %s] Writing lat=%s lng=%s', i + 2, latitude, longitude);

      // Add warning indicator to population field if city-level data detected
      let displayPopulation = population;
      if (popNum > 100000 && isNeighborhood) {
        displayPopulation = `⚠️ ${population} (CITY DATA)`;
      }

      output.push([latitude, longitude, displayPopulation, income]);
      successes++;

      Utilities.sleep(120);
    } catch (err) {
      Logger.log('[ROW %s] ERROR: %s', i + 2, err && err.message ? err.message : String(err));
      output.push(['', '', '', '']);
      failures++;
    }
  }

  if (output.length > 0) {
    sheet.getRange(2, 3, output.length, 4).setValues(output);
  }

  const summary = `Done. Processed ${processed}. Success ${successes}. Fail ${failures}.`;
  Logger.log('[RUN] %s', summary);
  SpreadsheetApp.getActive().toast(summary, 'Census Tools', 5);
}

function getStateFipsFromAbbr(stateAbbr) {
  const map = {
    'AL': '01','AK': '02','AZ': '04','AR': '05','CA': '06','CO': '08','CT': '09','DE': '10','DC': '11',
    'FL': '12','GA': '13','HI': '15','ID': '16','IL': '17','IN': '18','IA': '19','KS': '20','KY': '21',
    'LA': '22','ME': '23','MD': '24','MA': '25','MI': '26','MN': '27','MS': '28','MO': '29','MT': '30',
    'NE': '31','NV': '32','NH': '33','NJ': '34','NM': '35','NY': '36','NC': '37','ND': '38','OH': '39',
    'OK': '40','OR': '41','PA': '42','RI': '44','SC': '45','SD': '46','TN': '47','TX': '48','UT': '49',
    'VT': '50','VA': '51','WA': '53','WV': '54','WI': '55','WY': '56','PR': '72'
  };
  const key = String(stateAbbr || '').toUpperCase();
  return map[key] || '';
}


function geocodeCityState(city, state) {
  const address = `${city}, ${state}`;
  const encodedAddress = encodeURIComponent(address);
  
  // Get Google API key from script properties
  const apiKey = PropertiesService.getScriptProperties().getProperty('GOOGLE_API_KEY');
  if (!apiKey) {
    Logger.log('[GOOGLE-GEOCODER] ERROR: GOOGLE_API_KEY not found in script properties');
    return null;
  }
  
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodedAddress}&key=${apiKey}`;
  Logger.log('[GOOGLE-GEOCODER] URL: %s', url);
  
  try {
    const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
    const status = resp.getResponseCode();
    Logger.log('[GOOGLE-GEOCODER] Status: %s', status);
    
    if (status !== 200) {
      Logger.log('[GOOGLE-GEOCODER] Non-200 response. Body: %s', safeSnippet(resp.getContentText()));
      return null;
    }
    
    const text = resp.getContentText();
    Logger.log('[GOOGLE-GEOCODER] Body snippet: %s', safeSnippet(text));
    
    const data = JSON.parse(text);
    if (data.status !== 'OK') {
      Logger.log('[GOOGLE-GEOCODER] API error: %s', data.status);
      return null;
    }
    
    const results = data.results || [];
    if (!results.length) {
      Logger.log('[GOOGLE-GEOCODER] No results for "%s"', address);
      return null;
    }
    
    const top = results[0];
    const location = top.geometry?.location;
    if (!location) {
      Logger.log('[GOOGLE-GEOCODER] No location in result');
      return null;
    }
    
    const latitude = location.lat;
    const longitude = location.lng;
    
    // Try to get state FIPS and place code from Google's result
    let stateFips = '';
    let placeCode = '';
    
    // Look for state FIPS in address components
    const addressComponents = top.address_components || [];
    for (let i = 0; i < addressComponents.length; i++) {
      const component = addressComponents[i];
      if (component.types.includes('administrative_area_level_1')) {
        // Try to get state FIPS from the short_name or long_name
        const stateName = component.short_name || component.long_name;
        stateFips = getStateFipsFromAbbr(stateName);
        break;
      }
    }
    
    // For place code, we'll need to use coordinates to get Census geography
    if (stateFips && latitude && longitude) {
      const geoByCoord = getGeographiesByCoordinates(longitude, latitude);
      if (geoByCoord && geoByCoord.placeCode) {
        placeCode = geoByCoord.placeCode;
      }
    }
    
    Logger.log('[GOOGLE-GEOCODER] Found lat=%s lng=%s stateFips=%s placeCode=%s', latitude, longitude, stateFips, placeCode);
    return { latitude, longitude, stateFips, placeCode, googleTypes: top.types || [] };
    
  } catch (e) {
    Logger.log('[GOOGLE-GEOCODER] ERROR: %s', e && e.message ? e.message : String(e));
    return null;
  }
}

function getGeographiesByCoordinates(lng, lat) {
  const url = `https://geocoding.geo.census.gov/geocoder/geographies/coordinates?x=${encodeURIComponent(lng)}&y=${encodeURIComponent(lat)}&benchmark=Public_AR_Current&vintage=Current_Current&format=json`;
  Logger.log('[GEO-BY-COORD] URL: %s', url);
  try {
    const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
    const status = resp.getResponseCode();
    Logger.log('[GEO-BY-COORD] Status: %s', status);
    if (status !== 200) {
      Logger.log('[GEO-BY-COORD] Non-200 response. Body: %s', safeSnippet(resp.getContentText()));
      return null;
    }
    const text = resp.getContentText();
    Logger.log('[GEO-BY-COORD] Body snippet: %s', safeSnippet(text));
    const json = JSON.parse(text);
    const result = (json || {}).result || {};
    const geogs = result.geographies || {};
    const placeCollections = Object.keys(geogs).filter(k => /Place/i.test(k));

    let place = null;
    for (let i = 0; i < placeCollections.length; i++) {
      const items = geogs[placeCollections[i]];
      if (Array.isArray(items) && items.length) {
        place = items[0];
        break;
      }
    }

    if (!place) {
      Logger.log('[GEO-BY-COORD] No Place geography found');
      return { stateFips: '', placeCode: '' };
    }

    const stateFips = String(place.STATE || place.STATEFP || '').trim();
    const placeCode = String(place.PLACE || place.PLACEFP || '').trim();
    return { stateFips, placeCode };
  } catch (e) {
    Logger.log('[GEO-BY-COORD] ERROR: %s', e && e.message ? e.message : String(e));
    return null;
  }
}

function fetchPopulationAcs(stateFips, placeCode) {
  // Use Census ACS API
  const year = '2023';
  const base = `https://api.census.gov/data/${year}/acs/acs5`;
  const params = `get=NAME,B01003_001E,B19013_001E&for=place:${encodeURIComponent(placeCode)}&in=state:${encodeURIComponent(stateFips)}`;
  const url = `${base}?${params}`;

  Logger.log('[ACS] URL: %s', url);
  try {
    const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
    const status = resp.getResponseCode();
    Logger.log('[ACS] Status: %s', status);
    
    if (status === 200) {
      const text = resp.getContentText();
      Logger.log('[ACS] Body snippet: %s', safeSnippet(text));
      
      const json = JSON.parse(text);
      if (!Array.isArray(json) || json.length < 2) {
        Logger.log('[ACS] Unexpected JSON shape');
        return { population: '', income: '' };
      }
      
      const headers = json[0];
      const rows = json.slice(1);
      
      const popIndex = headers.indexOf('B01003_001E');
      const incomeIndex = headers.indexOf('B19013_001E');
      
      if (popIndex === -1 || incomeIndex === -1) {
        Logger.log('[ACS] Missing required columns. Headers: %s', JSON.stringify(headers));
        return { population: '', income: '' };
      }
      
      const firstRow = rows[0];
      const population = firstRow[popIndex] || '';
      const income = firstRow[incomeIndex] || '';
      
      Logger.log('[ACS] Found population=%s income=%s', population, income);
      return { population, income };
    } else {
      Logger.log('[ACS] Non-200 response. Body: %s', safeSnippet(resp.getContentText()));
      return { population: '', income: '' };
    }
  } catch (e) {
    Logger.log('[ACS] ERROR: %s', e && e.message ? e.message : String(e));
    return { population: '', income: '' };
  }
}

function safeSnippet(text) {
  try {
    if (typeof text !== 'string') return '';
    const trimmed = text.replace(/\s+/g, ' ').trim();
    return trimmed.length > 400 ? trimmed.substring(0, 400) + '…' : trimmed;
  } catch (e) {
    return '';
  }
}
