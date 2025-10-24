// This file defines the user interface for the Rezkyoo app inside ChatGPT.
// It uses the components provided by the OpenAI Apps SDK.

import {
  render,
  Form,
  TextField,
  Stepper,
  DatePicker,
  TimePicker,
  Button,
  Text,
  Card,
  Image,
  Spinner,
  Modal,
} from '@openai/apps-sdk';

// A simple in-memory store for our polling timer
let pollTimer = null;
let currentBatchState = null;
const initialDate = new Date().toISOString().split('T')[0];

let formState = {
  cuisine: 'any',
  cuisine_notes: '',
  location: 'near me',
  party_size: 2,
  date: initialDate,
  time: '19:00',
  intent: 'specific_time',
};

// ================================================================
// ===== SCREEN 1: THE INITIAL SEARCH FORM ========================
// ================================================================

async function main() {
  // Clear any existing timers when the app re-launches
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  currentBatchState = null;
  renderSearchForm();
}

function renderSearchForm(overrides = {}, options = {}) {
  formState = { ...formState, ...overrides };
  const { error } = options;

  render(
    <Form
      title="Find a Reservation with Rezkyoo"
      description="Provide a few details and we'll handle the outreach."
      onSubmit={(formData) => handleSearchSubmit(formData)}
    >
      {error && (
        <Text style={{ color: '#d92d20' }}>{error}</Text>
      )}

      <Card title="When would you like to dine?">
        <label htmlFor="intent">Timing preference</label>
        <select
          id="intent"
          name="intent"
          defaultValue={formState.intent}
          required
        >
          <option value="next_available">Next available table</option>
          <option value="specific_time">Book a specific time</option>
        </select>

        <DatePicker
          name="date"
          label="Date"
          defaultValue={formState.date}
          required
        />
        <TimePicker
          name="time"
          label="Preferred Time"
          defaultValue={formState.time}
        />
        <Text size="small">
          We only use the time field when “Book a specific time” is selected. Choose “Next available table” to let Rezkyoo find the soonest seating.
        </Text>
      </Card>

      <Card title="Party & cuisine">
        <Stepper
          name="party_size"
          label="Party Size"
          defaultValue={formState.party_size}
          min={1}
          max={20}
        />

        <label htmlFor="cuisine">Cuisine preference</label>
        <select
          id="cuisine"
          name="cuisine"
          defaultValue={formState.cuisine}
          required
        >
          <option value="any">Any cuisine / surprise me</option>
          <option value="steakhouse">Steakhouse</option>
          <option value="italian">Italian</option>
          <option value="seafood">Seafood</option>
          <option value="asian">Asian fusion</option>
          <option value="mexican">Mexican</option>
          <option value="vegetarian">Vegetarian / vegan friendly</option>
        </select>
        <TextField
          name="cuisine_notes"
          label="Need something specific?"
          placeholder="Optional: add dietary notes or a specific restaurant"
          defaultValue={formState.cuisine_notes}
        />
      </Card>

      <Card title="Where should we search?">
        <TextField
          name="location"
          label="Location"
          placeholder="e.g., Scottsdale, AZ"
          defaultValue={formState.location}
          required
        />
      </Card>

      <Button type="submit">Start calling restaurants</Button>
    </Form>,
  );
}

// ================================================================
// ===== STEP 2: SUBMIT SEARCH & START POLLING ====================
// ================================================================

async function handleSearchSubmit(formData) {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  currentBatchState = null;

  const locationInput = typeof formData.location === 'string' ? formData.location.trim() : '';
  const cuisineNotesInput = typeof formData.cuisine_notes === 'string' ? formData.cuisine_notes.trim() : '';
  const intentInput = typeof formData.intent === 'string' ? formData.intent : formState.intent;
  const timeInput = typeof formData.time === 'string' ? formData.time : '';
  const partySizeInput = parseInt(formData.party_size, 10);

  formState = {
    ...formState,
    cuisine: formData.cuisine || formState.cuisine,
    cuisine_notes: cuisineNotesInput,
    location: locationInput || formState.location,
    party_size: Number.isNaN(partySizeInput) ? formState.party_size : Math.max(1, partySizeInput),
    date: formData.date || formState.date,
    time: timeInput || formState.time,
    intent: intentInput === 'next_available' ? 'next_available' : 'specific_time',
  };

  if (!formState.location) {
    return renderSearchForm({}, { error: 'Please provide a location so we know where to search.' });
  }

  if (!formState.date) {
    return renderSearchForm({}, { error: 'Please choose the date you want to dine.' });
  }

  if (formState.intent === 'specific_time' && !formState.time) {
    return renderSearchForm({}, { error: 'Please choose a preferred dining time or switch to “Next available table”.' });
  }

  const payload = {
    cuisine: formState.cuisine_notes ? formState.cuisine_notes : formState.cuisine,
    location: formState.location,
    party_size: formState.party_size,
    date: formState.date,
    intent: formState.intent,
  };

  if (formState.intent === 'specific_time') {
    payload.time = formState.time;
  }

  render(<Spinner label="Finding restaurants and starting the calls..." />);

  try {
    const searchResponse = await fetch('/restaurants/search_and_call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!searchResponse.ok) {
      const error = await searchResponse.json();
      return render(<Text>Error: {error.message || 'Could not start search.'}</Text>);
    }

    // Store the static restaurant data and query data
    const { batchId, mapUrl, restaurants, query, hasMore } = await searchResponse.json();

    startPollingBatch({ batchId, mapUrl, restaurants, query, hasMore: Boolean(hasMore) });

  } catch (err) {
    render(<Text>Error: {err.message}</Text>);
  }
}

function startPollingBatch(state) {
  currentBatchState = state;
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  pollForResults(state);
  pollTimer = setInterval(() => {
    if (currentBatchState) {
      pollForResults(currentBatchState);
    }
  }, 2500);
}

// ================================================================
// ===== STEP 3: POLLING & RENDERING RESULTS ======================
// ================================================================

function normalizePhone(value) {
  if (!value || typeof value !== 'string') return null;
  const digits = value.replace(/[^+\d]/g, '');
  return digits || null;
}

async function pollForResults(state) {
  const { batchId, mapUrl, restaurants: staticRestaurants, query, hasMore } = state;
  try {
    const statusResponse = await fetch(`/status/${batchId}`);
    if (!statusResponse.ok) {
      clearInterval(pollTimer);
      pollTimer = null;
      return render(<Text>Error: Could not retrieve batch status.</Text>);
    }

    const { status: batchStatus, items: liveCallItems } = await statusResponse.json();

    // --- This is the key logic ---
    // Merge the static data (name, rating) with the live call data (status, result)
    const mergedItems = staticRestaurants.map(staticResto => {
      const staticPlaceId = staticResto.placeId || staticResto.place_id || null;
      const staticPhones = [
        staticResto.phone_normalized,
        staticResto.international_phone_number,
        staticResto.formatted_phone_number,
        staticResto.phone_display,
      ].map(normalizePhone).filter(Boolean);

      const liveData = liveCallItems.find(live => {
        if (staticPlaceId && (live.placeId === staticPlaceId || live.place_id === staticPlaceId)) {
          return true;
        }

        const livePhones = [live.phone_normalized, live.phone, live.phone_display]
          .map(normalizePhone)
          .filter(Boolean);
        return staticPhones.some(phone => livePhones.includes(phone));
      });

      return {
        ...staticResto,
        ...(liveData ? {
          id: liveData.id,
          status: liveData.status,
          result: liveData.result,
          raw: liveData.raw,
          placeId: liveData.placeId || staticPlaceId,
          phone_normalized: liveData.phone_normalized || staticResto.phone_normalized,
        } : {}),
      };
    });
    // -----------------------------

    currentBatchState = { ...state, restaurants: staticRestaurants, hasMore };
    renderResultsScreen(batchId, mapUrl, mergedItems, query, batchStatus, hasMore);

    if (batchStatus === 'completed') {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  } catch (err) {
    clearInterval(pollTimer);
    pollTimer = null;
    render(<Text>Error polling for results: {err.message}</Text>);
  }
}

// ================================================================
// ===== SCREEN 2: THE DYNAMIC RESULTS SCREEN =====================
// ================================================================

function renderResultsScreen(batchId, mapUrl, mergedItems, query, batchStatus, hasMore) {
  render(
    <Card>
      {mapUrl ? <Image src={mapUrl} alt="Map of restaurants" /> : null}
      {batchStatus !== 'completed' && <Spinner label="Live status: Calls in progress..." />}
      {batchStatus === 'completed' && <Text>✅ All calls are complete.</Text>}

      {mergedItems.map((item, index) => (
        <Card key={item.id || item.placeId || index} title={item.name}>
          <Text>{item.rating} ⭐ ({item.user_ratings_total} reviews)</Text>
          <Text>Status: {item.status || 'Pending...'}</Text>

          {/* A call is completed and has a result */}
          {item.status === 'completed' && item.result && (
            <Card>
              <Text>Outcome: {item.result.ai_summary}</Text>
              {item.result.outcome === 'available' && <Button onClick={() => renderBookingForm(item, query)}>Book Now</Button>}
              {item.result.outcome === 'alternative_offered' && <Text>Offered: {item.result.alternative_time}</Text>}
              {item.result.outcome === 'credit_card_required' && <Text>💳 Requires Credit Card to hold.</Text>}

              {/* Show Transcript Button */}
              {item.raw && (
                <Button
                  variant="secondary"
                  onClick={() => renderTranscript(item.name, item.raw)}
                >
                  View Transcript
                </Button>
              )}
            </Card>
          )}

          {/* Handle other statuses */}
          {item.status === 'machine_detected' && <Text>Outcome: Answering machine, skipped.</Text>}
          {item.status === 'error' && <Text>Outcome: Call failed.</Text>}
          {item.status === 'skipped' && <Text>Outcome: Skipped (on Do Not Call list).</Text>}
        </Card>
      ))}

      {/* Show 'Search More' button only when the current batch is done and more restaurants remain */}
      {batchStatus === 'completed' && hasMore && (
         <Button variant="secondary" onClick={() => handleSearchMore(batchId)}>Search More</Button>
      )}
    </Card>,
  );
}

// ================================================================
// ===== MODAL: VIEW TRANSCRIPT ===================================
// ================================================================

function renderTranscript(name, transcript) {
  render(
    <Modal title={`Transcript for ${name}`} onClose={() => { /* This would close the modal */ }}>
      <Text>{transcript || "No transcript available."}</Text>
    </Modal>,
  );
}

// ================================================================
// ===== FLOW: SEARCH MORE ========================================
// ================================================================

async function handleSearchMore(batchId) {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  currentBatchState = null;

  render(<Spinner label="Finding and calling more restaurants..." />);

  try {
    const searchResponse = await fetch('/restaurants/search_more', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ batchId }),
    });

    if (!searchResponse.ok) {
      const error = await searchResponse.json();
      return render(<Text>Error: {error.message || 'No more restaurants to search.'}</Text>);
    }

    // Re-start the polling loop with the new data
    const { batchId: newBatchId, mapUrl, restaurants, query, hasMore } = await searchResponse.json();
    startPollingBatch({ batchId: newBatchId, mapUrl, restaurants, query, hasMore: Boolean(hasMore) });

  } catch (err) {
    render(<Text>Error: {err.message}</Text>);
  }
}

// ================================================================
// ===== FLOW: BOOKING (STUBBED) ==================================
// ================================================================

function renderBookingForm(restaurantItem, query) {
  render(
    <Form
      title={`Book at ${restaurantItem.name}`}
      onSubmit={(bookingData) => handleConfirmBooking(restaurantItem, query, bookingData)}
    >
      <Text>Please provide your details to finalize the reservation.</Text>
      <TextField name="user_name" label="Full Name" required={true} />
      <TextField name="user_phone" label="Contact Phone Number" required={true} />
      <Button type="submit">Confirm Reservation</Button>
    </Form>,
  );
}

async function handleConfirmBooking(restaurantItem, query, bookingData) {
  render(<Spinner label="Contacting the restaurant to confirm your booking..." />);
  // This is a stub. We need to implement the /reservations/book endpoint.
  render(<Text>✅ Booking feature not yet implemented.</Text>);
}

main();
