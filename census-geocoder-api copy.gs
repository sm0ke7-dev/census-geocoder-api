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
      output.push(['', '', '']);
      continue;
    }

    Logger.log('[ROW %s] Input city="%s" state="%s"', i + 2, city, state);

    try {
      const geocode = geocodeCityState(city, state);
      if (!geocode) {
        Logger.log('[ROW %s] Geocode returned no result', i + 2);
        failures++;
        output.push(['', '', '']);
        continue;
      }

      const { latitude, longitude, stateFips, placeCode } = geocode;
      Logger.log('[ROW %s] Geocode raw lat=%s lng=%s stateFips=%s place=%s', i + 2, latitude, longitude, stateFips, placeCode);

      let population = '';
      if (stateFips && placeCode) {
        population = fetchPopulationAcs(stateFips, placeCode) || '';
        Logger.log('[ROW %s] Population=%s', i + 2, population);
      } else {
        Logger.log('[ROW %s] Missing stateFips/placeCode; skipping population lookup', i + 2);
      }

      // Convert coordinates if they look like Web Mercator meters
      const { lat: wgsLat, lng: wgsLng } = toWgs84IfNeeded(longitude, latitude);
      Logger.log('[ROW %s] Writing WGS84 lat=%s lng=%s', i + 2, wgsLat, wgsLng);

      output.push([wgsLat, wgsLng, population]);
      successes++;

      Utilities.sleep(120);
    } catch (err) {
      Logger.log('[ROW %s] ERROR: %s', i + 2, err && err.message ? err.message : String(err));
      output.push(['', '', '']);
      failures++;
    }
  }

  if (output.length > 0) {
    sheet.getRange(2, 3, output.length, 3).setValues(output);
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

function normalizePlaceName(name) {
  let s = String(name || '').toLowerCase();
  s = s.replace(/^the\s+/i, '');
  s = s.replace(/[\.,']/g, '');
  s = s.replace(/\s+city$/i, '');
  s = s.replace(/\s+town$/i, '');
  s = s.replace(/\s+village$/i, '');
  s = s.replace(/\s+borough$/i, '');
  s = s.replace(/\s+cdp$/i, '');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

function centroidFromRings(geom) {
  try {
    const rings = geom && geom.rings;
    if (!rings || !rings.length) return { lat: '', lng: '' };
    let sx = 0, sy = 0, n = 0;
    for (let i = 0; i < rings.length; i++) {
      const ring = rings[i];
      for (let j = 0; j < ring.length; j++) {
        const pt = ring[j];
        if (Array.isArray(pt) && pt.length >= 2) {
          sx += pt[0];
          sy += pt[1];
          n++;
        }
      }
    }
    if (!n) return { lat: '', lng: '' };
    return { lat: sy / n, lng: sx / n };
  } catch (e) {
    return { lat: '', lng: '' };
  }
}

// Convert Web Mercator meters (EPSG:3857) to WGS84 degrees if inputs look like meters
function toWgs84IfNeeded(lngMeters, latMeters) {
  const x = Number(lngMeters);
  const y = Number(latMeters);
  if (!isFinite(x) || !isFinite(y)) return { lat: latMeters, lng: lngMeters };
  // Heuristic: meters magnitude ~1e6..2e7; degrees are within [-180,180] and [-90,90]
  const looksLikeMeters = Math.abs(x) > 1000 || Math.abs(y) > 1000;
  if (!looksLikeMeters) return { lat: latMeters, lng: lngMeters };
  const R = 6378137.0;
  const lon = (x / R) * (180 / Math.PI);
  const lat = (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * (180 / Math.PI);
  return { lat: lat, lng: lon };
}

function tigerwebFindPlace(city, stateAbbr) {
  const stateFips = getStateFipsFromAbbr(stateAbbr);
  const name = String(city || '').trim();
  if (!name) return null;

  const base = 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_Current/MapServer/find';
  // Search across BASENAME and NAME for better exact matching
  const params = {
    searchText: name,
    contains: 'true',
    layers: '28',
    searchFields: 'BASENAME,NAME',
    returnGeometry: 'true',
    outSR: '3857', // get in Web Mercator meters for consistent conversion
    f: 'json'
  };
  const q = Object.keys(params).map(k => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`).join('&');
  const url = `${base}?${q}`;
  Logger.log('[TIGERWEB-FIND] URL: %s', url);

  try {
    const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
    const status = resp.getResponseCode();
    Logger.log('[TIGERWEB-FIND] Status: %s', status);
    if (status !== 200) {
      Logger.log('[TIGERWEB-FIND] Non-200 response. Body: %s', safeSnippet(resp.getContentText()));
      return null;
    }
    const text = resp.getContentText();
    Logger.log('[TIGERWEB-FIND] Body snippet: %s', safeSnippet(text));
    const json = JSON.parse(text);
    const results = (json && json.results) || [];
    if (!results.length) return null;

    const targetNorm = normalizePlaceName(name);
    let best = null;
    let bestScore = -1;

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const attrs = r.attributes || {};
      const geom = r.geometry || {};
      const state = String(attrs.STATE || '').trim();
      if (stateFips && state !== stateFips) continue;

      const baseName = String(attrs.BASENAME || '').trim();
      const nameField = String(attrs.NAME || '').trim();
      const baseNorm = normalizePlaceName(baseName);
      const nameNorm = normalizePlaceName(nameField);

      let score = 0;
      if (baseNorm === targetNorm) score = 5; // best
      else if (nameNorm === targetNorm) score = 4;
      else if (baseNorm.startsWith(targetNorm)) score = 3;
      else if (nameNorm.startsWith(targetNorm)) score = 2;
      else if (baseNorm.indexOf(targetNorm) !== -1 || nameNorm.indexOf(targetNorm) !== -1) score = 1;

      if (score > bestScore) {
        best = { attrs: attrs, geom: geom };
        bestScore = score;
      }
    }

    if (!best) return null;

    let lat = '';
    let lng = '';
    if (best.geom && typeof best.geom.x === 'number' && typeof best.geom.y === 'number') {
      lng = best.geom.x;
      lat = best.geom.y;
    } else if (best.geom && best.geom.rings) {
      const c = centroidFromRings(best.geom);
      lat = c.lat;
      lng = c.lng;
    }

    const stateFipsOut = String(best.attrs.STATE || '').trim();
    const placeCode = String((best.attrs.PLACEFP !== undefined ? best.attrs.PLACEFP : best.attrs.PLACE) || '').trim();
    return { latitude: lat, longitude: lng, stateFips: stateFipsOut, placeCode: placeCode };
  } catch (e) {
    Logger.log('[TIGERWEB-FIND] ERROR: %s', e && e.message ? e.message : String(e));
    return null;
  }
}

function geocodeCityState(city, state) {
  const tiger = tigerwebFindPlace(city, state);
  if (tiger) {
    Logger.log('[GEOCODER] TIGERweb FIND hit for "%s, %s"', city, state);
    return tiger;
  }

  const address = `${city}, ${state}`;
  const encodedAddress = encodeURIComponent(address);
  const locUrl = `https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?address=${encodedAddress}&benchmark=Public_AR_Current&layers=Place&format=json`;
  Logger.log('[GEOCODER-LOC] URL: %s', locUrl);
  try {
    const locResp = UrlFetchApp.fetch(locUrl, { muteHttpExceptions: true, followRedirects: true });
    const locStatus = locResp.getResponseCode();
    Logger.log('[GEOCODER-LOC] Status: %s', locStatus);
    if (locStatus === 200) {
      const locText = locResp.getContentText();
      Logger.log('[GEOCODER-LOC] Body snippet: %s', safeSnippet(locText));
      const locJson = JSON.parse(locText);
      const matches = (((locJson || {}).result || {}).addressMatches) || [];
      if (matches.length) {
        const m = matches[0];
        const coords = (m.coordinates) || {};
        const lat = typeof coords.y === 'number' ? coords.y : '';
        const lng = typeof coords.x === 'number' ? coords.x : '';
        if (lat !== '' && lng !== '') {
          const geoByCoord = getGeographiesByCoordinates(lng, lat);
          if (geoByCoord && geoByCoord.stateFips && geoByCoord.placeCode) {
            return { latitude: lat, longitude: lng, stateFips: geoByCoord.stateFips, placeCode: geoByCoord.placeCode };
          }
          return { latitude: lat, longitude: lng, stateFips: '', placeCode: '' };
        }
      } else {
        Logger.log('[GEOCODER-LOC] No matches for "%s" with Place layer', address);
      }
    } else {
      Logger.log('[GEOCODER-LOC] Non-200 response. Body: %s', safeSnippet(locResp.getContentText()));
    }
  } catch (e) {
    Logger.log('[GEOCODER-LOC] ERROR: %s', e && e.message ? e.message : String(e));
  }

  const geoUrl = `https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress?address=${encodedAddress}&benchmark=Public_AR_Current&vintage=Current_Current&format=json`;
  Logger.log('[GEOCODER-GEO] URL: %s', geoUrl);
  try {
    const resp = UrlFetchApp.fetch(geoUrl, { muteHttpExceptions: true, followRedirects: true });
    const status = resp.getResponseCode();
    Logger.log('[GEOCODER-GEO] Status: %s', status);
    if (status !== 200) {
      Logger.log('[GEOCODER-GEO] Non-200 response. Body: %s', safeSnippet(resp.getContentText()));
      return null;
    }

    const text = resp.getContentText();
    Logger.log('[GEOCODER-GEO] Body snippet: %s', safeSnippet(text));

    const data = JSON.parse(text);
    const results = (((data || {}).result || {}).addressMatches) || [];
    if (!results.length) {
      Logger.log('[GEOCODER-GEO] No addressMatches for "%s"', address);
      return null;
    }

    const top = results[0];
    const coords = (top.coordinates) || {};

    const geogs = (top.geographies) || {};
    const placeCollections = Object.keys(geogs)
      .filter(k => /Place/i.test(k));

    let place = null;
    for (let i = 0; i < placeCollections.length; i++) {
      const items = geogs[placeCollections[i]];
      if (items && items.length) {
        place = items[0];
        break;
      }
    }

    const latitude = typeof coords.y === 'number' ? coords.y : '';
    const longitude = typeof coords.x === 'number' ? coords.x : '';

    let stateFips = '';
    let placeCode = '';

    if (place) {
      stateFips = String(place.STATE || place.STATEFP || '').trim();
      placeCode = String(place.PLACE || place.PLACEFP || '').trim();
    } else {
      Logger.log('[GEOCODER-GEO] No Place geography found for "%s"', address);
    }

    return { latitude, longitude, stateFips, placeCode };
  } catch (e2) {
    Logger.log('[GEOCODER-GEO] ERROR: %s', e2 && e2.message ? e2.message : String(e2));
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
  const year = '2023';
  const base = `https://api.census.gov/data/${year}/acs/acs5`;
  const params = `get=NAME,B01003_001E&for=place:${encodeURIComponent(placeCode)}&in=state:${encodeURIComponent(stateFips)}`;
  const url = `${base}?${params}`;

  Logger.log('[ACS] URL: %s', url);
  const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
  const status = resp.getResponseCode();
  Logger.log('[ACS] Status: %s', status);
  if (status !== 200) {
    Logger.log('[ACS] Non-200 response. Body: %s', safeSnippet(resp.getContentText()));
    return '';
  }

  const text = resp.getContentText();
  Logger.log('[ACS] Body snippet: %s', safeSnippet(text));

  const json = JSON.parse(text);
  if (!Array.isArray(json) || json.length < 2) {
    Logger.log('[ACS] Unexpected JSON shape');
    return '';
  }
  const headers = json[0];
  const rows = json.slice(1);

  const valueIndex = headers.indexOf('B01003_001E');
  if (valueIndex === -1) {
    Logger.log('[ACS] B01003_001E not found in headers: %s', JSON.stringify(headers));
    return '';
  }

  const firstRow = rows[0];
  const popValue = firstRow[valueIndex];
  return popValue || '';
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
