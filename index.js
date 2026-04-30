const express = require('express');
const fetch = require('node-fetch');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3000;

let cachedFlights = [];
let lastUpdated = null;

const AIRPORTS = [
  'KJFK','KMIA','KLAX','KATL','KORD',
  'MDSD','MDPC','MDST',
  'TJSJ',
  'MMMX','MMUN',
  'SKBO','SKCL',
  'SBGR','SBGL',
  'CYYZ','CYUL',
  'MPTO',
  'LEMD','LEBL',
  'EGLL','EGCC'
];

const ICAO_TO_IATA = {
  KJFK:'JFK',KMIA:'MIA',KLAX:'LAX',KATL:'ATL',KORD:'ORD',
  MDSD:'SDQ',MDPC:'PUJ',MDST:'STI',
  TJSJ:'SJU',
  MMMX:'MEX',MMUN:'CUN',
  SKBO:'BOG',SKCL:'CLO',
  SBGR:'GRU',SBGL:'GIG',
  CYYZ:'YYZ',CYUL:'YUL',
  MPTO:'PTY',
  LEMD:'MAD',LEBL:'BCN',
  EGLL:'LHR',EGCC:'MAN'
};

async function fetchAirport(icao) {
  const iata = ICAO_TO_IATA[icao] || icao;
  const now = new Date();
  const from = now.toISOString().slice(0, 16);
  const to = new Date(now.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 16);
  const url = `https://aerodatabox.p.rapidapi.com/flights/airports/icao/${icao}/${from}/${to}`;

  const res = await fetch(url, {
    headers: {
      'x-rapidapi-host': 'aerodatabox.p.rapidapi.com',
      'x-rapidapi-key': process.env.AERODATABOX_KEY
    }
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();

  const flights = [];

  for (const f of (data.departures || [])) {
    if (!f.number) continue;
    flights.push({
      id: f.number.replace(/\s/g, '') + '_dep',
      flightNumber: f.number,
      airline: f.airline?.name || 'Unknown',
      from: iata,
      to: f.arrival?.airport?.iata || f.arrival?.airport?.icao?.slice(1) || f.arrival?.airport?.name || '???',
      fromCity: f.departure?.airport?.municipalityName || f.departure?.airport?.name || iata,
      toCity: f.arrival?.airport?.municipalityName || f.arrival?.airport?.name || '???',
      status: f.status || 'Scheduled',
      departure: f.departure?.scheduledTime?.utc,
      arrival: f.arrival?.scheduledTime?.utc,
      lat: null, lon: null, altitude: 35000, speed: 480, heading: 0
    });
  }

  for (const f of (data.arrivals || [])) {
    if (!f.number) continue;
    flights.push({
      id: f.number.replace(/\s/g, '') + '_arr',
      flightNumber: f.number,
      airline: f.airline?.name || 'Unknown',
      from: f.departure?.airport?.iata || f.departure?.airport?.icao?.slice(1) || f.departure?.airport?.name || '???',
      to: iata,
      fromCity: f.departure?.airport?.municipalityName || f.departure?.airport?.name || '???',
      toCity: f.arrival?.airport?.municipalityName || f.arrival?.airport?.name || iata,
      status: f.status || 'Scheduled',
      departure: f.departure?.scheduledTime?.utc,
      arrival: f.arrival?.scheduledTime?.utc,
      lat: null, lon: null, altitude: 35000, speed: 480, heading: 0
    });
  }

  console.log(`[ADB] ${icao}: ${flights.length} flights`);
  return flights;
}

async function fetchAll() {
  console.log('Fetching all airports...');
  const all = [];
  for (const icao of AIRPORTS) {
    try {
      const flights = await fetchAirport(icao);
      all.push(...flights);
    } catch (e) {
      console.log(`[ADB] ${icao} failed:`, e.message);
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  const unique = [...new Map(all.map(f => [f.id, f])).values()];
  cachedFlights = unique;
  lastUpdated = new Date().toISOString();
  console.log(`Cached ${cachedFlights.length} flights`);
}

cron.schedule('*/5 * * * *', fetchAll);
fetchAll();

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  next();
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', flights_cached: cachedFlights.length, last_updated: lastUpdated, uptime_seconds: Math.floor(process.uptime()) });
});

app.get('/flights', (req, res) => {
  res.json({ count: cachedFlights.length, last_updated: lastUpdated, flights: cachedFlights });
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
