/**
 * Fetches population data for cities using GeoDB Cities API on RapidAPI
 * Processes cities row by row starting from row 2
 * City name in Column A, State in Column B
 * Latitude in Column C, Longitude in Column D, Population in Column E
 */

function checkCityPopulation() {
  const sheet = SpreadsheetApp.getActiveSheet();
  const apiKey = PropertiesService.getScriptProperties().getProperty('Census-API');

  if (!apiKey) {
    SpreadsheetApp.getUi().alert('API Key not found. Please set Census-API in Script Properties.');
    return;
  }

  // Get the last row with data
  const lastRow = sheet.getLastRow();

  // Start from row 2 and process each row
  for (let row = 2; row <= lastRow; row++) {
    const state = sheet.getRange(row, 2).getValue(); // Column B
    const city = sheet.getRange(row, 1).getValue();  // Column A

    // Skip if city or state is empty
    if (!city || !state) {
      continue;
    }

    // Fetch city data
    const cityData = getCityPopulation(city, state, apiKey);

    // Write data to columns
    sheet.getRange(row, 3).setValue(cityData.latitude);    // Column C
    sheet.getRange(row, 4).setValue(cityData.longitude);   // Column D
    sheet.getRange(row, 5).setValue(cityData.population);  // Column E

    // Add a small delay to avoid rate limiting
    Utilities.sleep(500);
  }

  SpreadsheetApp.getUi().alert('Population check complete!');
}

/**
 * Fetches city data from GeoDB Cities API
 * Returns object with latitude, longitude, and population
 */
function getCityPopulation(city, state, apiKey) {
  try {
    // Search for the city
    const searchUrl = `https://wft-geo-db.p.rapidapi.com/v1/geo/cities?namePrefix=${encodeURIComponent(city)}&countryIds=US&limit=10`;

    const options = {
      method: 'get',
      headers: {
        'X-RapidAPI-Key': apiKey,
        'X-RapidAPI-Host': 'wft-geo-db.p.rapidapi.com'
      },
      muteHttpExceptions: true
    };

    const response = UrlFetchApp.fetch(searchUrl, options);
    const data = JSON.parse(response.getContentText());

    if (data.data && data.data.length > 0) {
      // Try to find the best match by comparing city name and state
      for (let i = 0; i < data.data.length; i++) {
        const result = data.data[i];
        const cityName = result.name.toLowerCase();
        const region = result.region ? result.region.toLowerCase() : '';
        const regionCode = result.regionCode ? result.regionCode.toLowerCase() : '';

        // Check if city name matches and state matches (either full name or abbreviation)
        if (cityName === city.toLowerCase() &&
            (region.includes(state.toLowerCase()) || regionCode === state.toLowerCase())) {

          // Log the full result to see what data is available
          Logger.log(`Data for ${city}, ${state}: ${JSON.stringify(result)}`);

          return {
            latitude: result.latitude || 'N/A',
            longitude: result.longitude || 'N/A',
            population: result.population || 'Population not available'
          };
        }
      }

      // If no exact match, return the first result's data
      Logger.log(`First result for ${city}, ${state}: ${JSON.stringify(data.data[0])}`);
      const firstResult = data.data[0];
      return {
        latitude: firstResult.latitude || 'N/A',
        longitude: firstResult.longitude || 'N/A',
        population: firstResult.population || 'Population not available'
      };
    } else {
      return {
        latitude: 'City not found',
        longitude: 'City not found',
        population: 'City not found'
      };
    }

  } catch (error) {
    Logger.log(`Error fetching data for ${city}, ${state}: ${error.message}`);
    return {
      latitude: `Error: ${error.message}`,
      longitude: `Error: ${error.message}`,
      population: `Error: ${error.message}`
    };
  }
}

/**
 * Creates a custom menu in Google Sheets
 */
function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('Population Checker')
    .addItem('Check City Populations', 'checkCityPopulation')
    .addToUi();
}
