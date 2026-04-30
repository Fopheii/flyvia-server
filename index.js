const express = require('express');
const fetch   = require('node-fetch');
const https   = require('https');
const cron    = require('node-cron');

const app  = express();
const PORT = process.env.PORT || 3000;

const httpsAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });

// ── Credentials ───────────────────────────────────────────────────────────────
const AERODATABOX_KEY  = process.env.AERODATABOX_KEY;
const OPENSKY_USERNAME = process.env.OPENSKY_USERNAME;
const OPENSKY_PASSWORD = process.env.OPENSKY_PASSWORD;

// ── Config ────────────────────────────────────────────────────────────────────
const AIRPORTS = [
  'KJFK', 'KMIA', 'KLAX', 'KATL', 'KORD',
  'MDSD', 'MDPC', 'MDST',
  'TJSJ',
  'MMMX', 'MMUN',
  'SKBO', 'SKCL',
  'SBGR', 'SBGL',
  'CYYZ', 'CYUL',
  'MPTO',
  'LEMD', 'LEBL',
  'EGLL', 'EGCC',
];

const OPENSKY_ZONES = [
  'lamin=-60&lamax=90&lomin=-180&lomax=-60',
  'lamin=-60&lamax=90&lomin=-60&lomax=0',
  'lamin=-60&lamax=90&lomin=0&lomax=60',
  'lamin=-60&lamax=90&lomin=60&lomax=180',
];

// ICAO → IATA for all hub airports
const ICAO_TO_IATA = {
  KJFK: 'JFK', KMIA: 'MIA', KLAX: 'LAX', KATL: 'ATL', KORD: 'ORD',
  MDSD: 'SDQ', MDPC: 'PUJ', MDST: 'STI',
  TJSJ: 'SJU',
  MMMX: 'MEX', MMUN: 'CUN',
  SKBO: 'BOG', SKCL: 'CLO',
  SBGR: 'GRU', SBGL: 'GIG',
  CYYZ: 'YYZ', CYUL: 'YUL',
  MPTO: 'PTY',
  LEMD: 'MAD', LEBL: 'BCN',
  EGLL: 'LHR', EGCC: 'MAN',
};

// Airport coords keyed by IATA — used by resolvePosition
const AIRPORT_COORDS = {
  JFK: { lat: 40.6413,  lon: -73.7781  },
  MIA: { lat: 25.7959,  lon: -80.2870  },
  LAX: { lat: 33.9425,  lon: -118.4081 },
  ATL: { lat: 33.6407,  lon: -84.4277  },
  ORD: { lat: 41.9742,  lon: -87.9073  },
  SDQ: { lat: 18.4297,  lon: -69.6689  },
  PUJ: { lat: 18.5674,  lon: -68.3634  },
  STI: { lat: 19.4061,  lon: -70.6047  },
  SJU: { lat: 18.4394,  lon: -66.0018  },
  MEX: { lat: 19.4363,  lon: -99.0721  },
  CUN: { lat: 21.0365,  lon: -86.8771  },
  BOG: { lat:  4.7016,  lon: -74.1469  },
  CLO: { lat:  3.5432,  lon: -76.3816  },
  GRU: { lat: -23.4356, lon: -46.4731  },
  GIG: { lat: -22.8100, lon: -43.2506  },
  YYZ: { lat: 43.6777,  lon: -79.6248  },
  YUL: { lat: 45.4706,  lon: -73.7408  },
  PTY: { lat:  9.0714,  lon: -79.3835  },
  MAD: { lat: 40.4936,  lon:  -3.5668  },
  BCN: { lat: 41.2971,  lon:   2.0785  },
  LHR: { lat: 51.4775,  lon:  -0.4614  },
  MAN: { lat: 53.3537,  lon:  -2.2750  },
};

// ── State ─────────────────────────────────────────────────────────────────────
let cachedFlights = [];
let lastUpdated   = null;

// ── Helpers ───────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));


function bearing(dep, arr) {
  const dLon = (arr.lon - dep.lon) * Math.PI / 180;
  const φ1   = dep.lat * Math.PI / 180;
  const φ2   = arr.lat * Math.PI / 180;
  const y = Math.sin(dLon) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dLon);
  return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
}


// ── AeroDataBox ───────────────────────────────────────────────────────────────
async function fetchAirport(icao) {
  const iata = ICAO_TO_IATA[icao] || icao.slice(1);

  const now  = new Date();
  const from = now.toISOString().slice(0, 16);
  const to   = new Date(now.getTime() + 6 * 60 * 60 * 1000).toISOString().slice(0, 16);

  const url = `https://aerodatabox.p.rapidapi.com/flights/airports/icao/${icao}/${from}/${to}`;
  const res = await fetch(url, {
    headers: {
      'x-rapidapi-host': 'aerodatabox.p.rapidapi.com',
      'x-rapidapi-key':  AERODATABOX_KEY,
    },
    timeout: 15000,
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();

  const flights = [];

  // DEPARTURES: this airport is the origin
  for (const f of data.departures || []) {
    if (!f.number || !f.arrival?.airport?.iata) continue;
    flights.push({
      id:           f.number.replace(' ', ''),
      callsign:     f.callSign?.trim() || f.number.replace(' ', ''),
      flightNumber: f.number,
      airline:      f.airline?.name || 'Unknown',
      from:         iata,
      to:           f.arrival.airport.iata,
      fromCity:     f.departure?.airport?.name || iata,
      toCity:       f.arrival.airport.name     || f.arrival.airport.iata,
      status:       f.status || 'Scheduled',
      departure:    f.departure?.scheduledTime?.utc || null,
      arrival:      f.arrival?.scheduledTime?.utc   || null,
    });
  }

  // ARRIVALS: this airport is the destination
  for (const f of data.arrivals || []) {
    if (!f.number || !f.departure?.airport?.iata) continue;
    flights.push({
      id:           f.number.replace(' ', '') + '_arr',
      callsign:     f.callSign?.trim() || f.number.replace(' ', ''),
      flightNumber: f.number,
      airline:      f.airline?.name || 'Unknown',
      from:         f.departure.airport.iata,
      to:           iata,
      fromCity:     f.departure.airport.name || f.departure.airport.iata,
      toCity:       f.arrival?.airport?.name || iata,
      status:       f.status || 'Scheduled',
      departure:    f.departure?.scheduledTime?.utc || null,
      arrival:      f.arrival?.scheduledTime?.utc   || null,
    });
  }

  return flights;
}

async function fetchAllAeroDataBox() {
  console.log(`\n[ADB] Fetching ${AIRPORTS.length} airports (departures + arrivals)`);
  const flightMap = new Map(); // callsign → flight metadata

  for (let i = 0; i < AIRPORTS.length; i++) {
    const icao = AIRPORTS[i];
    try {
      const flights = await fetchAirport(icao);

      let added = 0;
      for (const f of flights) {
        if (!f.from || !f.to) continue;

        // Skip flights clearly not in the air
        const status = (f.status || '').toLowerCase();
        if (['cancelled', 'diverted', 'landed'].includes(status)) continue;

        const depMs = f.departure ? new Date(f.departure).getTime() : null;
        const arrMs = f.arrival   ? new Date(f.arrival).getTime()   : null;
        const now   = Date.now();

        if (depMs && depMs > now) continue;                    // not yet departed
        if (arrMs && arrMs < now - 30 * 60 * 1000) continue;  // landed >30 min ago

        flightMap.set(f.callsign, {
          callsign: f.callsign,
          airline:  f.airline,
          from:     f.from,
          to:       f.to,
          fromCity: f.fromCity,
          toCity:   f.toCity,
          depMs,
          arrMs,
        });
        added++;
      }

      console.log(`[ADB] ${icao}: ${flights.length} movements → ${added} in-flight | map: ${flightMap.size}`);
    } catch (e) {
      console.log(`[ADB] ${icao} failed:`, e.message);
    }

    if (i < AIRPORTS.length - 1) await sleep(2000);
  }

  console.log(`[ADB] Done — ${flightMap.size} unique callsigns`);
  return flightMap;
}

// ── OpenSky ───────────────────────────────────────────────────────────────────
async function fetchOpenSkyZone(url) {
  const headers = {};
  if (OPENSKY_USERNAME && OPENSKY_PASSWORD) {
    headers['Authorization'] =
      'Basic ' + Buffer.from(`${OPENSKY_USERNAME}:${OPENSKY_PASSWORD}`).toString('base64');
  }
  const res = await fetch(url, { headers, agent: httpsAgent, timeout: 15000 });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchAllOpenSky() {
  console.log(`[OpenSky] Fetching ${OPENSKY_ZONES.length} zones`);
  const stateMap = new Map(); // callsign → raw state array

  for (let i = 0; i < OPENSKY_ZONES.length; i++) {
    const url = `https://opensky-network.org/api/states/all?${OPENSKY_ZONES[i]}`;
    try {
      const data = await fetchOpenSkyZone(url);
      if (data?.states) {
        for (const s of data.states) {
          const cs = s[0]?.trim();
          if (cs && s[5] != null && s[6] != null) stateMap.set(cs, s);
        }
        console.log(`[OpenSky] Zone ${i}: ${data.states.length} states`);
      }
    } catch (e) {
      console.log(`[OpenSky] Zone ${i} failed:`, e.message);
    }

    if (i < OPENSKY_ZONES.length - 1) await sleep(15000);
  }

  console.log(`[OpenSky] Done — ${stateMap.size} unique callsigns`);
  return stateMap;
}

// ── Position from AeroDataBox data alone ─────────────────────────────────────
function resolvePosition(flight) {
  const dep = AIRPORT_COORDS[flight.from];
  const arr = AIRPORT_COORDS[flight.to];

  // Best case: interpolate between known airports using timing
  if (dep && arr && flight.depMs && flight.arrMs) {
    const now      = Date.now();
    const duration = flight.arrMs - flight.depMs;
    const elapsed  = now - flight.depMs;

    // Clamp progress 0..1 — include flights slightly before dep or past arr
    const t = Math.min(1, Math.max(0, elapsed / duration));

    return {
      lat:     dep.lat + (arr.lat - dep.lat) * t,
      lon:     dep.lon + (arr.lon - dep.lon) * t,
      heading: Math.round(bearing(dep, arr)),
    };
  }

  // Have origin + dest but no timing — use midpoint
  if (dep && arr) {
    return {
      lat:     (dep.lat + arr.lat) / 2,
      lon:     (dep.lon + arr.lon) / 2,
      heading: Math.round(bearing(dep, arr)),
    };
  }

  // Only origin known — place at origin
  if (dep) {
    return { lat: dep.lat, lon: dep.lon, heading: 0 };
  }

  // Only dest known — place at dest
  if (arr) {
    return { lat: arr.lat, lon: arr.lon, heading: 0 };
  }

  // No coords at all — drop this flight (truly unplaceable)
  return null;
}

// ── Build flight list from AeroDataBox map ────────────────────────────────────
function buildFlightsFromAdb(flightMap, stateMap = new Map()) {
  const flights = [];
  let gpsMatches = 0, estimated = 0, dropped = 0;

  for (const [callsign, flight] of flightMap) {
    const state = stateMap.get(callsign);

    let lat, lon, altitude, speed, heading;

    if (state) {
      if (state[8]) continue;                                    // on_ground — skip
      lat      = state[6];
      lon      = state[5];
      altitude = state[7] ? Math.round(state[7] * 3.28084) : 0; // m → ft
      speed    = state[9] ? Math.round(state[9] * 1.94384) : 0; // m/s → knots
      heading  = state[10] ? Math.round(state[10]) : 0;
      gpsMatches++;
    } else {
      // No OpenSky — estimate from AeroDataBox route data
      const pos = resolvePosition(flight);
      if (!pos) { dropped++; continue; }                        // no coords at all — skip
      lat      = pos.lat;
      lon      = pos.lon;
      altitude = 35000; // cruise assumption (ft)
      speed    = 480;   // cruise assumption (knots)
      heading  = pos.heading;
      estimated++;
    }

    flights.push({
      id:        callsign,
      callsign,
      lat,
      lon,
      altitude,
      speed,
      heading,
      on_ground: false,
      from:      flight.from,
      to:        flight.to,
      airline:   flight.airline,
    });
  }

  console.log(
    `[Build] ${flights.length} flights — ${gpsMatches} GPS, ${estimated} estimated, ${dropped} dropped (no coords)`
  );
  return flights;
}

// ── Merge & cache ─────────────────────────────────────────────────────────────
async function fetchAndMerge() {
  console.log('\n[Cycle] Starting at', new Date().toISOString());

  // Step 1 — AeroDataBox (routes + airline names)
  const flightMap = await fetchAllAeroDataBox();

  // Cache immediately after AeroDataBox — don't wait for OpenSky
  const adbFlights = buildFlightsFromAdb(flightMap);
  if (adbFlights.length > 0) {
    cachedFlights = adbFlights;
    lastUpdated   = new Date().toISOString();
    console.log(`[ADB] Cached ${cachedFlights.length} flights immediately`);
  } else {
    console.log('[ADB] No flights built — keeping existing cache of', cachedFlights.length);
  }

  // Step 2 — OpenSky (optional GPS enrichment — if it fails, ADB cache stays)
  try {
    const stateMap = await fetchAllOpenSky();
    const enriched = buildFlightsFromAdb(flightMap, stateMap);
    if (enriched.length > 0) {
      cachedFlights = enriched;
      lastUpdated   = new Date().toISOString();
      console.log(`[OpenSky] Cache enriched → ${cachedFlights.length} flights with GPS`);
    }
  } catch (e) {
    console.log('[OpenSky] Failed — keeping AeroDataBox cache:', e.message);
  }
}

// ── Schedule: every 5 minutes ─────────────────────────────────────────────────
cron.schedule('*/5 * * * *', fetchAndMerge);
fetchAndMerge();

// ── HTTP ──────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  next();
});

app.get('/health', (req, res) => {
  res.json({
    status:         'ok',
    flights_cached: cachedFlights.length,
    last_updated:   lastUpdated,
    uptime_seconds: Math.floor(process.uptime()),
  });
});

app.get('/flights', (req, res) => {
  const limit   = req.query.limit ? parseInt(req.query.limit, 10) : null;
  const flights = limit > 0 ? cachedFlights.slice(0, limit) : cachedFlights;
  res.json({
    count:        flights.length,
    total:        cachedFlights.length,
    last_updated: lastUpdated,
    flights,
  });
});

app.listen(PORT, () => {
  console.log(`Flyvia server running on port ${PORT}`);
});
