/**
 * Rezkyoo AI Restaurant Assistant
 * Full backend: Telnyx Call Control + Google Maps + OpenAI (Whisper/GPT-4o) + Firestore
 *
 * Includes:
 * - Static serving of /.well-known (plugin manifest + openapi)
 * - MCP adapter mount (mcp_adapter.js)
 * - Probe endpoints for connector validation (GET/POST /, GET /call)
 * - Full routes for search_and_call, search_more, status, webhook, etc.
 */

require('dotenv').config();
const express = require('express');
const Telnyx = require('telnyx');
const { Client } = require("@googlemaps/google-maps-services-js");
const { OpenAI } = require("openai");
const path = require('path');
const fetch = require('node-fetch');
const fs = require('fs');
const os = require('os');
const admin = require('firebase-admin');
const cors = require('cors');

// ===== Firebase Admin Setup =====
let db;
try {
  admin.initializeApp({
    credential: admin.credential.cert(require('./serviceAccountKey.json'))
  });
  db = admin.firestore();
  console.log("✅ Connected to Firestore");
} catch (error) {
  console.error("🔥 Firestore initialization failed. Make sure 'serviceAccountKey.json' is present.", error);
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cors()); // permissive CORS for ChatGPT access

// ===== Define PORT early so adapter can use it if mounted =====
const PORT = process.env.PORT || 3000;

// ===== Configuration & Clients =====
const telnyx = Telnyx(process.env.TELNYX_API_KEY);
const googleMapsClient = new Client({});
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ** BUG FIX: Use logical OR (||) instead of bitwise OR (|) **
const TELNYX_APP_PORT = process.env.TELNYX_APP_PORT || 3000;
const NGROK_URL = process.env.NGROK_URL || process.env.PUBLIC_BASE_URL;
const TELNYX_CALL_CONTROL_ID = process.env.TELNYX_CONNECTION_ID;
const TELNYX_PHONE_NUMBER = process.env.TELNYX_PHONE_NUMBER;
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

const MAX_CALLS_DEFAULT = parseInt(process.env.MAX_CALLS_DEFAULT || '5', 10);
const MAX_CALLS_HARD = parseInt(process.env.MAX_CALLS_HARD || '8', 10);

const DO_NOT_CALL_TYPES = [
  'meal_takeaway', 'meal_delivery', 'bar', 'cafe', 'fast_food',
  'store', 'supermarket', 'bakery'
];

// ===== Global Request Logger =====
app.use((req, _res, next) => {
  console.log(`[REQ] ${req.method} ${req.path}`);
  next();
});

//================================================================//
// ===== Serve ChatGPT Plugin static files from /.well-known ======
//================================================================//
app.use('/.well-known', express.static(path.join(__dirname, '.well-known')));

// ===== Helpful probe endpoints so connector health checks don't get 404 =====
app.get('/', (_req, res) => {
  res.json({
    ok: true,
    message: 'RezKyoo MCP & Plugin endpoint. Available endpoints: /tools, /call (POST), /.well-known/*, /health'
  });
});

// Accept POST to root — some connector validation flows POST to the base URL.
app.post('/', (_req, res) => {
  res.json({
    ok: true,
    info: 'This endpoint is a probe. Use /tools to list tools and POST /call to execute a tool.',
    tools: `${NGROK_URL || `http://localhost:${PORT}`}/tools`,
    call: `${NGROK_URL || `http://localhost:${PORT}`}/call`,
  });
});

// Accept GET on /call so external health/probe requests get 200 instead of 404.
app.get('/call', (_req, res) => {
  res.json({
    ok: true,
    methods: ['POST'],
    info: 'POST to /call with { tool_id, input } to execute an MCP tool'
  });
});

//================================================================//
// ===== HELPER: Geocoding & Timezone ============================
//================================================================//
async function getCoordsForLocation(location) {
  try {
    const geocodeResponse = await googleMapsClient.geocode({
      params: { address: location, key: GOOGLE_MAPS_API_KEY },
    });
    if (geocodeResponse.data.results && geocodeResponse.data.results.length > 0) {
      return geocodeResponse.data.results[0].geometry.location; // { lat, lng }
    }
  } catch (error) {
    console.error("Geocoding API error:", error.response?.data || error.message);
  }
  return null;
}

async function getTimezoneForLocation(lat, lng, timestamp) {
  try {
    const timezoneResponse = await googleMapsClient.timezone({
      params: {
        location: { lat, lng },
        timestamp: Math.floor(timestamp / 1000), // requires seconds
        key: GOOGLE_MAPS_API_KEY,
      },
    });
    if (timezoneResponse.data.status === 'OK') {
      console.log(`🌍 Found timezone ${timezoneResponse.data.timeZoneId} for ${lat},${lng}`);
      return timezoneResponse.data.timeZoneId; // e.g., "America/Denver"
    } else {
      console.warn(`Timezone API failed for ${lat},${lng}: ${timezoneResponse.data.status}`);
      return null;
    }
  } catch (error) {
    console.error(`❌ Error fetching timezone for ${lat},${lng}:`, error.message || error);
    return null; // Return null on error
  }
}

//================================================================//
// ===== HELPER: Restaurant Filtering & Open Check ===============
//================================================================//
function isEligibleForReservation(place) {
  if (!place.types || !place.business_status || !place.vicinity || !place.international_phone_number) {
    return false;
  }
  if (place.business_status !== 'OPERATIONAL' || place.permanently_closed) {
    return false;
  }
  const isRestaurant = place.types.includes('restaurant');
  if (!isRestaurant) {
    return false;
  }
  const hardExclusions = ['fast_food', 'meal_takeaway', 'meal_delivery'];
  const hasHardExclusion = place.types.some(type => hardExclusions.includes(type));
  if (hasHardExclusion) {
    return false;
  }
  return true;
}

function isRestaurantOpenAt(opening_hours, date, time, timeZoneId) {
  if (!opening_hours || !opening_hours.periods) {
    return true; // Assume open if no data
  }

  try {
    let targetDate = new Date();
    if (timeZoneId) {
      try {
        const formatter = new Intl.DateTimeFormat('en-US', { timeZone: timeZoneId, year: 'numeric', month: 'numeric', day: 'numeric' });
        const parts = formatter.formatToParts(targetDate).reduce((acc, part) => { acc[part.type] = part.value; return acc; }, {});
        targetDate = new Date(Date.UTC(parseInt(parts.year), parseInt(parts.month) - 1, parseInt(parts.day)));
      } catch (tzError) {
        console.warn(`Invalid timeZoneId '${timeZoneId}'. Using server local time.`);
        timeZoneId = undefined;
        targetDate = new Date();
      }
    }

    if (date && date.toLowerCase() !== 'tonight' && date.toLowerCase() !== 'today') {
      const dateParts = date.match(/(\d{4})-(\d{2})-(\d{2})/); // YYYY-MM-DD
      if (dateParts) {
        targetDate = new Date(Date.UTC(parseInt(dateParts[1]), parseInt(dateParts[2]) - 1, parseInt(dateParts[3])));
      } else {
        const slashDateParts = date.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
        if (slashDateParts) {
          targetDate = new Date(Date.UTC(parseInt(slashDateParts[3]), parseInt(slashDateParts[1]) - 1, parseInt(slashDateParts[2])));
        } else {
          console.warn(`Could not parse date string: ${date}. Defaulting to today.`);
        }
      }
    }

    let hour = 0, minute = 0;
    const timeParts = time.match(/(\d{2}):(\d{2})/); // HH:mm
    if (timeParts) {
      hour = parseInt(timeParts[1], 10);
      minute = parseInt(timeParts[2], 10);
    } else {
      const timeLower = time.toLowerCase();
      if (timeLower.includes('pm') || timeLower.includes('am')) {
        let [timePart, modifier] = timeLower.split(/(am|pm)/);
        let [h, m] = timePart.trim().split(':');
        hour = parseInt(h, 10);
        minute = parseInt(m) || 0;
        if (modifier === 'pm' && hour !== 12) hour += 12;
        if (modifier === 'am' && hour === 12) hour = 0;
      } else {
        console.error(`Invalid time format provided: ${time}. Assuming closed.`);
        return false;
      }
    }

    if (isNaN(hour) || isNaN(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
      console.error(`Invalid time parsed: ${time}. Assuming closed.`);
      return false;
    }

    const targetDateTimeUTC = new Date(targetDate);
    targetDateTimeUTC.setUTCHours(hour, minute, 0, 0);

    let requestDayOfWeek;
    let requestTime; // HHMM format

    if (timeZoneId) {
      try {
        const formatter = new Intl.DateTimeFormat('en-CA', {
          timeZone: timeZoneId, weekday: 'short',
          hour: 'numeric', hour12: false, minute: 'numeric'
        });
        const parts = formatter.formatToParts(targetDateTimeUTC).reduce((acc, part) => { acc[part.type] = part.value; return acc; }, {});
        const dayMap = { 'Sun': 0, 'Mon': 1, 'Tue': 2, 'Wed': 3, 'Thu': 4, 'Fri': 5, 'Sat': 6 };
        requestDayOfWeek = dayMap[parts.weekday];
        const formattedHour = parts.hour === '24' ? '00' : parts.hour.padStart(2, '0');
        const formattedMinute = parts.minute.padStart(2, '0');
        requestTime = formattedHour + formattedMinute;
      } catch (tzError) {
        console.warn(`Invalid timeZoneId '${timeZoneId}'. Falling back to server time.`);
        const localDate = targetDateTimeUTC;
        requestDayOfWeek = localDate.getDay();
        requestTime = localDate.getHours().toString().padStart(2, '0') + localDate.getMinutes().toString().padStart(2, '0');
      }
    } else {
      const localDate = targetDateTimeUTC;
      requestDayOfWeek = localDate.getDay();
      requestTime = localDate.getHours().toString().padStart(2, '0') + localDate.getMinutes().toString().padStart(2, '0');
    }

    if (requestDayOfWeek === undefined || !requestTime) {
      console.error(`Failed to determine request day/time. Date: ${date}, Time: ${time}, Zone: ${timeZoneId}`);
      return true; // Fail open
    }

    for (const period of opening_hours.periods) {
      if (period.open && !period.close && period.open.day === 0 && period.open.time === "0000") return true; // 24/7
      if (!period.open || !period.close || !period.open.time || !period.close.time) continue; // Malformed

      const openDay = period.open.day, openTime = period.open.time;
      const closeDay = period.close.day, closeTime = period.close.time;

      if (openDay === requestDayOfWeek && closeDay === requestDayOfWeek) { // Same day
        if (requestTime >= openTime && requestTime < closeTime) return true;
      } else if (closeDay === (openDay + 1) % 7) { // Overnight
        if (requestDayOfWeek === openDay && requestTime >= openTime) return true;
        if (requestDayOfWeek === closeDay && requestTime < closeTime) return true;
      }
    }
    return false; // No matching period
  } catch (e) {
    console.error("❌ Error in isRestaurantOpenAt:", e);
    return true; // Fail safe
  }
}

//================================================================//
// ===== HELPER: Google Maps Static Image ========================
//================================================================//
function generateStaticMapUrl(locations) {
  if (!locations || locations.length === 0) return null;
  const markers = locations
    .map((loc, i) => {
      const lat = loc?.geometry?.location?.lat ?? loc?.lat;
      const lng = loc?.geometry?.location?.lng ?? loc?.lng;
      if (lat != null && lng != null) {
        return `markers=color:red%7Clabel:${i + 1}%7C${lat},${lng}`;
      }
      return null;
    })
    .filter(Boolean).join('&');
  if (!markers) return null;
  return `https://maps.googleapis.com/maps/api/staticmap?size=600x400&${markers}&key=${GOOGLE_MAPS_API_KEY}`;
}

//================================================================//
// ===== HELPER: Call Handling (Audio Download, Transcription) ====
//================================================================//
async function downloadAudio(mediaUrl) {
  try {
    const response = await fetch(mediaUrl, {
      headers: { 'Authorization': `Bearer ${process.env.TELNYX_API_KEY}` }
    });
    if (!response.ok) throw new Error(`Failed to fetch audio (${response.status})`);
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const tempFilePath = path.join(os.tmpdir(), `recording_${Date.now()}.wav`);
    fs.writeFileSync(tempFilePath, buffer);
    return tempFilePath;
  } catch (error) {
    console.error("Error downloading audio:", error);
    return null;
  }
}

async function transcribeAudio(filePath) {
  if (!filePath) return null;
  try {
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(filePath),
      model: "whisper-1",
    });
    fs.unlinkSync(filePath); // Clean up
    return transcription.text;
  } catch (error) {
    console.error("Error during transcription:", error.response?.data || error.message);
    try { fs.unlinkSync(filePath); } catch {}
    return null;
  }
}

//================================================================//
// ===== HELPER: NLU (GPT-4o) ====================================
//================================================================//
async function getNluResult(transcript, queryContext) {
  const { party_size, date, time } = queryContext;
  const systemPrompt = `
You are an AI assistant parsing a phone call transcript. The call's goal was to ask: "Do you have a reservation for ${party_size} people on ${date} at ${time}?"
Analyze the provided transcript and return a JSON object with this *exact* structure:
{
  "outcome": "string",
  "ai_summary": "string",
  "credit_card_required": boolean
}
... (see README for details)
`;
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Here is the transcript:\n\n${transcript}` }
      ],
      temperature: 0.1,
    });

    let result = JSON.parse(response.choices[0].message.content);
    result.outcome = result.outcome || "other";
    result.ai_summary = result.ai_summary || "Could not determine outcome.";
    result.credit_card_required = result.credit_card_required === true;
    if (result.outcome === 'credit_card_required') {
      result.credit_card_required = true;
    }
    if (!['available', 'alternative_offered', 'credit_card_required'].includes(result.outcome)) {
      result.credit_card_required = false;
    }
    return result;
  } catch (error) {
    console.error("Error from OpenAI NLU:", error);
    return {
      outcome: "other",
      ai_summary: "Failed to parse the call outcome.",
      credit_card_required: false
    };
  }
}

async function getDtmfDigit(transcript) {
  const systemPrompt = `
You are an AI analyzing an IVR (phone menu) recording transcript. The user needs to make a reservation.
Identify which single DTMF digit (0-9) corresponds to "reservations", "speak to a host", "make a booking", or similar.
Respond with ONLY the single digit.
- If menu says "For reservations, press 1", respond: 1
- If no option for reservations is mentioned, respond: 0
- If the transcript is empty or unintelligible, respond: 0
`;
  try {
    if (!transcript || transcript.trim() === '') return '0';
    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Transcript: "${transcript}"` }
      ],
      max_tokens: 2,
      temperature: 0.0,
    });
    const digit = response.choices[0].message.content.trim();
    if (/^\d$/.test(digit)) return digit;
    console.warn(`DTMF model returned non-digit: "${digit}"`);
    return '0';
  } catch (error) {
    console.error("Error from OpenAI DTMF analysis:", error.response?.data || error.message);
    return '0';
  }
}

//================================================================//
// ===== HELPER: Get & Rank Place Details ========================
//================================================================//
async function getAndRankPlaceDetails(places, limit) {
  const doNotCallList = await getDoNotCallList();
  let detailedPlaces = [];
  for (const place of places) {
    if (!place.place_id) continue;
    try {
      const detailsResponse = await googleMapsClient.placeDetails({
        params: {
          place_id: place.place_id,
          fields: [
            'name', 'international_phone_number', 'opening_hours', 'types',
            'business_status', 'rating', 'user_ratings_total', 'vicinity',
            'permanently_closed', 'geometry', 'place_id'
          ],
          key: GOOGLE_MAPS_API_KEY,
        },
      });
      const detailedPlace = detailsResponse.data.result;
      if (isEligibleForReservation(detailedPlace)) {
        if (doNotCallList.has(detailedPlace.international_phone_number)) {
          console.log(`[Filter] Skipping ${detailedPlace.name} (on DNC list)`);
        } else {
          detailedPlaces.push(detailedPlace);
        }
      }
    } catch (err) {
      console.warn(`Could not get details for ${place.name}: ${err.message}`);
    }
  }
  detailedPlaces.sort((a, b) => (b.rating || 0) - (a.rating || 0));
  return detailedPlaces.slice(0, limit);
}

//================================================================//
// ===== HELPER: Start Batch Call Function =======================
//================================================================//
async function startBatchCall(restaurantsToCall, query, batchId, ngrokUrl) {
  if (!ngrokUrl) {
    console.error("FATAL: NGROK_URL is not set. Cannot create webhooks.");
    return;
  }
  const callPromises = restaurantsToCall.map(restaurant => {
    const callRef = db.collection('calls').doc();
    const callControlId = callRef.id;
    const callData = {
      id: callControlId,
      batchId: batchId,
      restaurantName: restaurant.name,
      phone: restaurant.international_phone_number,
      status: 'initiated',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      query: query,
      raw: null,
      result: {
        outcome: 'pending',
        ai_summary: 'Call is being initiated.',
        credit_card_required: false
      }
    };
    return callRef.set(callData)
      .then(() => {
        return telnyx.calls.create({
          connection_id: TELNYX_CALL_CONTROL_ID,
          to: restaurant.international_phone_number,
          from: TELNYX_PHONE_NUMBER,
          webhook_url: `${ngrokUrl}/voice/webhook`, // Use the full URL from .env
          webhook_url_method: "POST",
          call_control_id: callControlId
        });
      })
      .catch(err => {
        console.error(`[Call Start Error] Failed to initiate call to ${restaurant.name}:`, err.response?.data?.errors || err.message);
        return callRef.update({
          status: 'failed',
          'result.outcome': 'no_reservation_line',
          'result.ai_summary': 'Failed to initiate the call (e.g., invalid number).'
        });
      });
  });
  return Promise.allSettled(callPromises);
}

//================================================================//
// ===== ROUTE 1: Search & Start Calls ===========================
//================================================================//
app.post('/restaurants/search_and_call', async (req, res) => {
  console.log('➡️ [API Action] /restaurants/search_and_call');
  const {
    cuisine, location, party_size, time, date, // date is YYYY-MM-DD, time is HH:mm
    intent = 'specific_time',
    max_calls = MAX_CALLS_DEFAULT
  } = req.body;

  if (!cuisine || !location || !party_size || !date)
    return res.status(400).json({ ok: false, error: "Missing required parameters." });
  if (intent === 'specific_time' && !time)
    return res.status(400).json({ ok: false, error: "Missing 'time' for 'specific_time' intent." });

  const actualMaxCalls = Math.min(max_calls, MAX_CALLS_HARD);

  try {
    let timeZoneId;
    const isNearMeSearch = location.toLowerCase().trim() === 'near me';
    let searchCoords = null;

    if (isNearMeSearch) {
      console.log("Conducting 'near me' search. Skipping timezone lookup.");
      timeZoneId = undefined;
    } else {
      console.log(`Looking up coordinates and timezone for: ${location}`);
      searchCoords = await getCoordsForLocation(location);
      if (searchCoords) {
        const targetTimestamp = new Date(`${date}T${time || '12:00'}:00Z`).getTime(); // Use provided time or default
        timeZoneId = await getTimezoneForLocation(searchCoords.lat, searchCoords.lng, targetTimestamp);
        if (!timeZoneId) {
          console.warn(`Could not determine timezone for ${location}, using server default.`);
        }
      } else {
        console.warn(`Could not geocode ${location}, using server default timezone.`);
      }
    }

    const searchResponse = await googleMapsClient.textSearch({
      params: { query: `${cuisine} restaurants in ${location}`, key: GOOGLE_MAPS_API_KEY }
    });
    let places = searchResponse.data.results || [];
    if (!places.length) return res.status(404).json({ ok: false, message: "No restaurants found matching criteria." });

    const detailedPlaces = await getAndRankPlaceDetails(places, 20);
    if (!detailedPlaces.length) return res.status(404).json({ ok: false, message: "Found restaurants, but none seem suitable for reservations or have phone numbers." });

    let filteredPlaces = detailedPlaces;
    if (intent === 'specific_time') {
      const originalCount = filteredPlaces.length;
      filteredPlaces = filteredPlaces.filter(p => isRestaurantOpenAt(p.opening_hours, date, time, timeZoneId));
      console.log(`Open-hour filter: ${originalCount} -> ${filteredPlaces.length}`);
      if (!filteredPlaces.length) {
        return res.status(404).json({ ok: false, message: "No restaurants found open at the requested time." });
      }
    }

    const restaurantsToCall = filteredPlaces.slice(0, actualMaxCalls);
    const mapUrl = generateStaticMapUrl(restaurantsToCall);
    const query = { intent, cuisine, party_size, date, time, location, timeZoneId };

    const batchRef = db.collection('batches').doc();
    const batchId = batchRef.id;

    await batchRef.set({
      batchId: batchId,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      status: 'calling',
      query: query,
      called_count: 0,
      all_restaurants_found_count: detailedPlaces.length
    });

    const allRestaurantsRef = batchRef.collection('all_restaurants_found');
    await Promise.all(
      detailedPlaces.map((place, index) =>
        allRestaurantsRef.doc(place.place_id).set({ ...place, rank: index })
      )
    );

    await startBatchCall(restaurantsToCall, query, batchId, NGROK_URL);
    await batchRef.update({ called_count: restaurantsToCall.length });

    res.json({
      ok: true,
      message: `Found ${detailedPlaces.length} eligible restaurants. Calling the top ${restaurantsToCall.length}...`,
      batchId: batchId,
      mapUrl,
      restaurants: restaurantsToCall,
      query
    });
  } catch (err) {
    console.error("❌ Error in /restaurants/search_and_call:", err);
    const errorMessage = err.response?.data?.error_message || err.message || "An internal server error occurred.";
    res.status(500).json({ ok: false, error: errorMessage });
  }
});

//================================================================//
// ===== ROUTE 2: Search More Restaurants ========================
//================================================================//
app.post('/restaurants/search_more', async (req, res) => {
  console.log('➡️ [API Action] /restaurants/search_more');
  const { batchId } = req.body;
  if (!batchId) return res.status(400).json({ ok: false, error: "Missing batchId." });

  try {
    const batchRef = db.collection('batches').doc(batchId);
    const batchDoc = await batchRef.get();
    if (!batchDoc.exists) return res.status(404).json({ ok: false, error: "Original search not found." });

    const { query, called_count } = batchDoc.data();
    if (!query || !query.location) return res.status(500).json({ ok: false, error: "Original search query is missing data." });

    const allRestaurantsSnapshot = await batchRef.collection('all_restaurants_found').orderBy('rank').get();
    const all_restaurants_found = allRestaurantsSnapshot.docs.map(doc => doc.data());
    let nextRestaurantsToFilter = all_restaurants_found.slice(called_count, called_count + MAX_CALLS_DEFAULT);

    if (!nextRestaurantsToFilter.length) {
      return res.status(404).json({ ok: false, message: "No more restaurants found matching criteria." });
    }

    let nextRestaurantsToCall = nextRestaurantsToFilter;
    if (query.intent === 'specific_time') {
      const originalCount = nextRestaurantsToFilter.length;
      const timeZoneId = query.timeZoneId;
      nextRestaurantsToCall = nextRestaurantsToFilter.filter(place => isRestaurantOpenAt(place.opening_hours, query.date, query.time, timeZoneId));
      console.log(`Follow-up open-hour filter: ${originalCount} -> ${nextRestaurantsToCall.length}`);
    }

    if (!nextRestaurantsToCall.length) {
      const remainingAfterSlice = all_restaurants_found.slice(called_count + nextRestaurantsToFilter.length);
      if (remainingAfterSlice.length > 0) {
        return res.status(404).json({ ok: false, message: "No more restaurants open at the requested time in the next batch." });
      } else {
        return res.status(404).json({ ok: false, message: "No more restaurants found matching criteria." });
      }
    }

    await startBatchCall(nextRestaurantsToCall, query, batchId, NGROK_URL);
    await batchRef.update({
      called_count: called_count + nextRestaurantsToCall.length,
      status: 'calling'
    });

    const newMapUrl = generateStaticMapUrl(nextRestaurantsToCall);
    res.json({
      ok: true,
      message: `Searching ${nextRestaurantsToCall.length} more restaurants...`,
      batchId: batchId,
      mapUrl: newMapUrl,
      restaurants: nextRestaurantsToCall,
      query
    });

  } catch (err) {
    console.error("❌ Error in /restaurants/search_more:", err);
    const errorMessage = err.message || "An internal server error occurred.";
    res.status(500).json({ ok: false, error: errorMessage });
  }
});

//================================================================//
// ===== ROUTE 3: Get Batch Status ===============================
//================================================================//
app.get('/status/:batchId', async (req, res) => {
  const { batchId } = req.params;
  try {
    const callsSnapshot = await db.collection('calls').where('batchId', '==', batchId).get();
    const batchDoc = await db.collection('batches').doc(batchId).get();
    if (!batchDoc.exists && callsSnapshot.empty) {
      return res.status(404).json({ ok: false, error: "Batch ID not found." });
    }

    const items = callsSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    let batchStatus = 'calling';
    let calledCount = 0;

    if (batchDoc.exists) {
      batchStatus = batchDoc.data().status || 'calling';
      calledCount = batchDoc.data().called_count || 0;
    }

    const finalStates = ['completed', 'failed', 'machine_detected', 'opt_out', 'no_reservation_line', 'booked', 'other'];
    const finishedCallCount = items.filter(item => finalStates.includes(item.result.outcome)).length;
    const isDone = (finishedCallCount >= calledCount) && (calledCount > 0);

    if (isDone && batchStatus !== 'completed') {
      batchStatus = 'completed';
      if (batchDoc.exists) {
        await db.collection('batches').doc(batchId).update({ status: 'completed', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
        console.log(`🏁 Batch ${batchId} marked as completed.`);
      }
    } else if (!isDone && batchStatus === 'completed') {
      batchStatus = 'calling';
    }

    res.json({
      ok: true,
      status: batchStatus,
      items: items
    });
  } catch (err) {
    console.error(`❌ Error getting status for batch ${batchId}:`, err);
    res.status(500).json({ ok: false, error: "Internal server error." });
  }
});

//================================================================//
// ===== ROUTE 4: Booking (Stubbed) ==============================
//================================================================//
app.post('/reservations/book', async (req, res) => {
  console.log('➡️ [API Action] /reservations/book (STUB)');
  const { batchId, restaurant_id, user_name, user_phone } = req.body;
  res.status(501).json({ ok: false, message: "Booking flow not yet implemented." });
});

//================================================================//
// ===== ROUTE 5: Telnyx Webhook =================================
//================================================================//
app.post('/voice/webhook', async (req, res) => {
  res.status(200).send(); // Respond immediately
  const event = req.body.data;
  const eventType = event.event_type;

  if (!event.payload || !event.payload.call_control_id) {
    console.warn("[Webhook] Received event with no call_control_id");
    return;
  }
  const callControlId = event.payload.call_control_id;

  try {
    const callRef = db.collection('calls').doc(callControlId);
    const callDoc = await callRef.get();
    if (!callDoc.exists) {
      console.warn(`[Webhook] Received event for unknown call: ${callControlId}`);
      return;
    }
    const callData = callDoc.data();
    const call = new telnyx.Call({ call_control_id: callControlId });

    if (eventType === 'call.initiated') {
      console.log(`[Call ${callData.restaurantName}] Initiated. Answering.`);
      await call.answer();
    } else if (eventType === 'call.answered') {
      console.log(`[Call ${callData.restaurantName}] Answered. Detecting machine/human.`);
      await callRef.update({ status: 'in_progress' });
      await call.amd({
        command: "amd_start", beep_timeout: 5000,
        initial_timeout: 5000, machine_greeting_end_timeout: 5000
      });
    } else if (eventType === 'call.amd.detection_ended') {
      const { result } = event.payload;
      console.log(`[Call ${callData.restaurantName}] AMD Result: ${result}`);
      const { date, time, party_size } = callData.query;
      const question = `Hi, I was wondering if you have any reservations available for ${party_size} people on ${date} at ${time}?`;

      if (result === 'machine_greeting_ended' || result === 'silence_detected' || result === 'beep_detected') {
        console.log(`[Call ${callData.restaurantName}] Machine detected. Leaving message.`);
        const msg = `Hi, this is a message about a reservation request for ${party_size} on ${date} at ${time}. Please call us back at ${TELNYX_PHONE_NUMBER.replace("+1", "")} if you have availability[...]`;
        await call.speak({ language: "en-US", payload: msg, voice: "female" });
        await callRef.update({
          status: 'completed',
          'result.outcome': 'left_message',
          'result.ai_summary': 'Left a voicemail with the request.'
        });
        await new Promise(resolve => setTimeout(resolve, 5000));
        await call.hangup();
      } else if (result === 'human_detected') {
        console.log(`[Call ${callData.restaurantName}] Human detected. Starting initial recording for IVR.`);
        await call.record_start({ channels: "single", format: "wav", play_beep: false });
        await new Promise(resolve => setTimeout(resolve, 4000));
        const recordStopResponse = await call.record_stop();
        const mediaUrl = recordStopResponse.data.media_url;
        const tempFilePath = await downloadAudio(mediaUrl);
        const transcript = await transcribeAudio(tempFilePath);
        console.log(`[Call ${callData.restaurantName}] IVR Transcript: "${transcript}"`);
        const digit = await getDtmfDigit(transcript);

        if (digit !== '0') {
          console.log(`[Call ${callData.restaurantName}] Found DTMF digit: ${digit}. Sending...`);
          await call.dtmf({ digits: digit });
          await new Promise(resolve => setTimeout(resolve, 3000));
        } else {
          console.log(`[Call ${callData.restaurantName}] No DTMF digit. Proceeding directly.`);
        }

        await call.speak({ language: "en-US", payload: question, voice: "female" });
        await call.record_start({
          channels: "single", format: "wav",
          play_beep: false, end_silence_timeout_secs: 3
        });
        console.log(`[Call ${callData.restaurantName}] Asked question, now recording answer...`);

      } else {
        console.log(`[Call ${callData.restaurantName}] Unknown AMD result. Proceeding as human.`);
        await call.speak({ language: "en-US", payload: question, voice: "female" });
        await call.record_start({
          channels: "single", format: "wav",
          play_beep: false, end_silence_timeout_secs: 3
        });
      }
    } else if (eventType === 'call.record.stopped') {
      const mediaUrl = event.payload.media_url;
      if (callData.status === 'in_progress') {
        console.log(`[Call ${callData.restaurantName}] Got FINAL answer media: ${mediaUrl}`);
        const tempFilePath = await downloadAudio(mediaUrl);
        const transcript = await transcribeAudio(tempFilePath);
        console.log(`[Call ${callData.restaurantName}] Final Transcript: "${transcript}"`);
        const nluResult = await getNluResult(transcript || "", callData.query);
        console.log(`[Call ${callData.restaurantName}] NLU Result:`, nluResult);

        await callRef.update({
          status: 'completed',
          raw: transcript,
          result: nluResult
        });

        if (nluResult.outcome === 'opt_out') {
          await db.collection('dnc').doc(callData.phone).set({
            name: callData.restaurantName,
            addedAt: admin.firestore.FieldValue.serverTimestamp()
          });
          console.log(`[DNC] Added ${callData.restaurantName} to Do Not Call list.`);
        }

        await call.speak({ language: "en-US", payload: "Great, thank you so much for your time. Goodbye.", voice: "female" });
        await new Promise(resolve => setTimeout(resolve, 3000));
        await call.hangup();
      }
    } else if (eventType === 'call.hangup') {
      console.log(`[Call ${callData.restaurantName}] Hangup event received.`);
      const finalDoc = await callRef.get();
      const finalData = finalDoc.data();
      if (finalData.status === 'initiated' || finalData.status === 'in_progress') {
        await callRef.update({
          status: 'completed',
          'result.outcome': 'no_reservation_line',
          'result.ai_summary': 'Call was hung up before a response was recorded.'
        });
      }
    }
  } catch (error) {
    console.error(`[Webhook Error] Failed to process event ${eventType} for ${callControlId}:`, error);
  }
});

//================================================================//
// ===== HELPER: Get DNC List ====================================
//================================================================//
async function getDoNotCallList() {
  const dncSnapshot = await db.collection('dnc').get();
  const dncSet = new Set();
  dncSnapshot.forEach(doc => dncSet.add(doc.id)); // doc.id is the phone number
  return dncSet;
}

//================================================================//
// ===== MCP Adapter Mount (if present) ==========================
//================================================================//
// Try to mount MCP adapter if available. This keeps your existing endpoints unchanged
// and exposes a minimal MCP surface (GET /tools, POST /call, GET /components).
try {
  const localBase = NGROK_URL || `http://localhost:${PORT}`;
  const mountMcp = require('./mcp_adapter');
  if (typeof mountMcp === 'function') {
    mountMcp(app, { localBaseUrl: localBase });
  } else {
    console.warn("⚠️ ./mcp_adapter did not export a function. Skipping MCP mounting.");
  }
} catch (err) {
  console.warn("⚠️ MCP adapter not found or failed to mount. To enable MCP, add mcp_adapter.js to the project root.");
}

//================================================================//
// ===== Health & Server Start ===================================
//================================================================//
app.get('/health', (_req, res) => res.json({ ok: true, message: 'Rezkyoo server is running 🎉' }));

// Quiet the favicon 404s
app.get(['/favicon.ico', '/favicon.png', '/favicon.svg'], (_, res) => res.status(204).end());

const server = app.listen(PORT, () => {
  console.log(`✅ Rezkyoo server running at http://localhost:${PORT}`);

  if (NGROK_URL) {
    console.log('---');
    console.log(`Plugin Manifest: ${NGROK_URL}/.well-known/ai-plugin.json`);
    console.log(`OpenAPI Spec:    ${NGROK_URL}/.well-known/openapi.json`);
    console.log('---');
  } else {
    console.warn('⚠️ NGROK_URL not set in .env. You will not be able to connect from ChatGPT.');
  }
});

// Set server timeouts to 0 (disabled)
server.keepAliveTimeout = 0;
server.headersTimeout = 0;
// Set server timeouts to 0 (disabled)
server.keepAliveTimeout = 0;

server.headersTimeout = 0;
