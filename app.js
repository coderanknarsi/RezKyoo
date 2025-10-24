// app.js
// RezKyoo in-ChatGPT UI (OpenAI Apps SDK)
// Flow: Mood (free-text) -> Chips confirm -> Structured form -> Start calls -> Live results

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

// ============== Globals & initial state ==============
let pollTimer = null;

const initialDate = new Date().toISOString().split('T')[0];

let formState = {
  cuisine: 'any',           // dropdown fallback; we primarily use cuisine_notes from mood
  cuisine_notes: '',
  location: 'near me',
  party_size: 2,
  date: initialDate,
  time: '19:00',
  intent: 'specific_time',  // or 'next_available'
};

// Holds the conversational “mood” step
let moodState = {
  user_text: '',
  chips: [],    // [{ label: "Spicy", active: true }, ...]
  parsed: null, // normalized JSON from /nlp/parse_query
};

// Small pill chip UI
function Chips({ items, onToggle }) {
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
      {items.map((c, i) => (
        <button
          key={i}
          type="button"
          onClick={() => onToggle(i)}
          style={{
            padding: '6px 10px',
            borderRadius: 999,
            border: '1px solid #aab',
            background: c.active ? '#eef2ff' : 'transparent',
            cursor: 'pointer'
          }}
        >
          {c.label}
        </button>
      ))}
    </div>
  );
}

// ================================================================
// ============ ENTRY =============================================
// ================================================================
export default async function main() {
  if (pollTimer) clearInterval(pollTimer);
  renderMoodScreen();
}

// ================================================================
// ============ SCREEN 0: Mood (conversational first step) =========
// ================================================================
function renderMoodScreen(error) {
  render(
    <Form
      title="What are you in the mood for?"
      description="Say anything: dishes, vibes, budget, exclusions (e.g., “spicy noodles, casual, $$, not sushi”)."
      onSubmit={async ({ mood_text }) => {
        moodState.user_text = (mood_text || '').trim();
        if (!moodState.user_text) {
          return renderMoodScreen("Please tell us what you're craving.");
        }
        render(<Spinner label="Understanding your taste..." />);
        try {
          const r = await fetch('/nlp/parse_query', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: moodState.user_text }),
          });
          if (!r.ok) {
            const err = await r.json().catch(() => ({}));
            return renderMoodScreen(err.error || 'Could not parse preferences. Try again.');
          }
          const data = await r.json();
          moodState.parsed = data.parsed || null;
          const incomingChips = Array.isArray(data.chips) ? data.chips : [];
          moodState.chips = incomingChips.map(label => ({ label, active: true }));
          renderChipsConfirm();
        } catch (e) {
          renderMoodScreen('Network error parsing your preferences. Please try again.');
        }
      }}
    >
      {error && <Text style={{ color: '#d92d20' }}>{error}</Text>}
      <TextField
        name="mood_text"
        placeholder="spicy noodles, lively, $$, not sushi"
        required
      />
      <Button type="submit">Continue</Button>
    </Form>
  );
}

// ================================================================
// ============ SCREEN 0.5: Chips confirmation ====================
// ================================================================
function renderChipsConfirm() {
  render(
    <Form
      title="Looks right?"
      description="Toggle off anything that doesn’t matter. You can add more notes next."
      onSubmit={() => renderSearchForm()}
    >
      <Chips
        items={moodState.chips}
        onToggle={(i) => {
          moodState.chips[i].active = !moodState.chips[i].active;
          renderChipsConfirm();
        }}
      />
      <Button type="submit" style={{ marginTop: 12 }}>Next</Button>
    </Form>
  );
}

// ================================================================
// ============ SCREEN 1: Structured form =========================
// ================================================================
function renderSearchForm(overrides = {}, options = {}) {
  formState = { ...formState, ...overrides };
  const { error } = options;

  render(
    <Form
      title="When & where should we search?"
      description="We’ll start calling the best matches for your craving."
      onSubmit={(formData) => handleSearchSubmit(formData)}
    >
      {error && <Text style={{ color: '#d92d20' }}>{error}</Text>}

      <Card title="Timing">
        <label htmlFor="intent">Preference</label>
        <select id="intent" name="intent" defaultValue={formState.intent} required>
          <option value="next_available">Next available table</option>
          <option value="specific_time">Book a specific time</option>
        </select>

        <DatePicker name="date" label="Date" defaultValue={formState.date} required />
        <TimePicker name="time" label="Preferred Time" defaultValue={formState.time} />
        <Text size="small">
          We’ll only use the time if you chose “Book a specific time.”
        </Text>
      </Card>

      <Card title="Party & notes">
        <Stepper
          name="party_size"
          label="Party Size"
          defaultValue={formState.party_size}
          min={1}
          max={20}
        />
        <TextField
          name="cuisine_notes"
          label="Anything else we should consider?"
          placeholder="Optional: add dietary notes or a specific restaurant"
          defaultValue={formState.cuisine_notes}
        />
      </Card>

      <Card title="Location">
        <TextField
          name="location"
          label="Where should we search?"
          placeholder="e.g., Scottsdale, AZ"
          defaultValue={formState.location}
          required
        />
      </Card>

      <Button type="submit">Start calling restaurants</Button>
    </Form>
  );
}

async function handleSearchSubmit(formData) {
  if (pollTimer) clearInterval(pollTimer);

  const locationInput = typeof formData.location === 'string' ? formData.location.trim() : '';
  const cuisineNotesInput = typeof formData.cuisine_notes === 'string' ? formData.cuisine_notes.trim() : '';
  const intentInput = typeof formData.intent === 'string' ? formData.intent : formState.intent;
  const timeInput = typeof formData.time === 'string' ? formData.time : '';
  const partySizeInput = parseInt(formData.party_size, 10);

  formState = {
    ...formState,
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
    // NEW: craving context from mood step
    craving: {
      user_text: moodState.user_text,
      chips: moodState.chips.filter(c => c.active).map(c => c.label),
      parsed: moodState.parsed,
    },
    // Existing/structured fields
    cuisine: formState.cuisine_notes ? formState.cuisine_notes : formState.cuisine,
    location: formState.location,
    party_size: formState.party_size,
    date: formState.date,
    intent: formState.intent,
  };
  if (formState.intent === 'specific_time') payload.time = formState.time;

  render(<Spinner label="Finding restaurants and starting the calls..." />);

  try {
    const searchResponse = await fetch('/restaurants/search_and_call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!searchResponse.ok) {
      const error = await searchResponse.json().catch(() => ({}));
      return render(<Text>Error: {error.message || 'Could not start search.'}</Text>);
    }

    // Response should provide batchId, mapUrl, restaurants[], query
    const { batchId, mapUrl, restaurants, query } = await searchResponse.json();

    // Start polling for results
    pollTimer = setInterval(() => pollForResults(batchId, mapUrl, restaurants, query), 2500);

  } catch (err) {
    render(<Text>Error: {err.message}</Text>);
  }
}

// ================================================================
// ============ POLLING & RESULTS =================================
// ================================================================
async function pollForResults(batchId, mapUrl, staticRestaurants, query) {
  try {
    const statusResponse = await fetch(`/status/${batchId}`);
    if (!statusResponse.ok) {
      clearInterval(pollTimer);
      return render(<Text>Error: Could not retrieve batch status.</Text>);
    }

    const { status: batchStatus, items: liveCallItems } = await statusResponse.json();

    // Merge static data (name, rating, etc.) with live status/result
    const mergedItems = staticRestaurants.map((staticResto) => {
      const liveData = liveCallItems.find((live) => live.phone === staticResto.formatted_phone_number);
      return {
        ...staticResto,
        ...liveData, // id, status, result, raw transcript, outcome flags
      };
    });

    renderResultsScreen(batchId, mapUrl, mergedItems, query, batchStatus);

    if (batchStatus === 'completed') {
      clearInterval(pollTimer);
    }
  } catch (err) {
    clearInterval(pollTimer);
    render(<Text>Error polling for results: {err.message}</Text>);
  }
}

function renderResultsScreen(batchId, mapUrl, mergedItems, query, batchStatus) {
  render(
    <Card>
      {mapUrl && <Image src={mapUrl} alt="Map of restaurants" />}
      {batchStatus !== 'completed' && <Spinner label="Live status: Calls in progress..." />}
      {batchStatus === 'completed' && <Text>✅ All calls are complete.</Text>}

      {mergedItems.map((item, index) => (
        <Card key={item.id || index} title={item.name || 'Restaurant'}>
          <Text>{item.rating ? `${item.rating} ⭐` : '—'} {item.user_ratings_total ? `(${item.user_ratings_total} reviews)` : ''}</Text>
          <Text>Status: {item.status || 'Pending...'}</Text>

          {/* Completed call with result */}
          {item.status === 'completed' && item.result && (
            <Card>
              <Text>Outcome: {item.result.ai_summary || item.result.outcome || '—'}</Text>

              {item.result.outcome === 'available' && (
                <Button onClick={() => renderBookingForm(item, query)}>Book Now</Button>
              )}

              {item.result.outcome === 'alternative_offered' && (
                <Text>Offered: {item.result.alternative_time}</Text>
              )}

              {item.result.outcome === 'credit_card_required' && (
                <Text>💳 Requires Credit Card to hold.</Text>
              )}

              {item.raw && (
                <Button variant="secondary" onClick={() => renderTranscript(item.name || 'Restaurant', item.raw)}>
                  View Transcript
                </Button>
              )}
            </Card>
          )}

          {/* Other statuses */}
          {item.status === 'machine_detected' && <Text>Outcome: Answering machine, skipped.</Text>}
          {item.status === 'error' && <Text>Outcome: Call failed.</Text>}
          {item.status === 'skipped' && <Text>Outcome: Skipped (on Do Not Call list).</Text>}
        </Card>
      ))}

      {batchStatus === 'completed' && (
        <Button variant="secondary" onClick={() => handleSearchMore(batchId)}>Search More</Button>
      )}
    </Card>
  );
}

// ================================================================
// ============ Transcript Modal ==================================
// ================================================================
function renderTranscript(name, transcript) {
  render(
    <Modal title={`Transcript for ${name}`} onClose={() => { /* Modal closes in host UI */ }}>
      <Text>{transcript || 'No transcript available.'}</Text>
    </Modal>
  );
}

// ================================================================
// ============ Search More =======================================
// ================================================================
async function handleSearchMore(batchId) {
  if (pollTimer) clearInterval(pollTimer);
  render(<Spinner label="Finding and calling more restaurants..." />);

  try {
    const searchResponse = await fetch('/restaurants/search_more', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ original_batch_id: batchId, craving: {
        user_text: moodState.user_text,
        chips: moodState.chips.filter(c => c.active).map(c => c.label),
        parsed: moodState.parsed
      }}),
    });

    if (!searchResponse.ok) {
      const error = await searchResponse.json().catch(() => ({}));
      return render(<Text>Error: {error.message || 'No more restaurants to search.'}</Text>);
    }

    const { batchId: newBatchId, mapUrl, restaurants, query } = await searchResponse.json();
    pollTimer = setInterval(() => pollForResults(newBatchId, mapUrl, restaurants, query), 2500);

  } catch (err) {
    render(<Text>Error: {err.message}</Text>);
  }
}

// ================================================================
// ============ Booking (stub) ====================================
// ================================================================
function renderBookingForm(restaurantItem, query) {
  render(
    <Form
      title={`Book at ${restaurantItem.name || 'Restaurant'}`}
      onSubmit={(bookingData) => handleConfirmBooking(restaurantItem, query, bookingData)}
    >
      <Text>Please provide your details to finalize the reservation.</Text>
      <TextField name="user_name" label="Full Name" required />
      <TextField name="user_phone" label="Contact Phone Number" required />
      <Button type="submit">Confirm Reservation</Button>
    </Form>
  );
}

async function handleConfirmBooking(_restaurantItem, _query, _bookingData) {
  render(<Spinner label="Contacting the restaurant to confirm your booking..." />);
  // Implement /reservations/book on the server to complete this
  render(<Text>✅ Booking feature not yet implemented.</Text>);
}
