// This file defines the user interface for the Rezkyoo app inside ChatGPT.
// It uses the components provided by the OpenAI Apps SDK.

import { render, Form, TextField, Stepper, DatePicker, TimePicker, Button, Text, Card, Image, Spinner, Modal } from '@openai/apps-sdk';

// A simple in-memory store for our polling timer
let pollTimer = null;

// ================================================================\
// ===== SCREEN 1: THE INITIAL SEARCH FORM ========================\
// ================================================================\

async function main() {
  // Clear any existing timers when the app re-launches
  if (pollTimer) clearInterval(pollTimer);
  
  render(
    <Form
      title="Find a Reservation with Rezkyoo"
      description="Tell us what you're looking for, and our AI will call restaurants to find availability for you."
      onSubmit={(formData) => handleSearchSubmit(formData)}
    >
      <TextField name="cuisine" label="Cuisine or Restaurant Type" placeholder="e.g., steakhouse, Italian" required={true} />
      <TextField name="location" label="Location" placeholder="e.g., Scottsdale, AZ" defaultValue="near me" required={true} />
      <Stepper name="party_size" label="Party Size" defaultValue={2} min={1} max={20} />
      <DatePicker name="date" label="Date" defaultValue={new Date()} />
      <TimePicker name="time" label="Time" defaultValue="19:00" />
      <input type="hidden" name="intent" value="specific_time" />
      <Button type="submit">Find Availability</Button>
    </Form>
  );
}

// ================================================================\
// ===== STEP 2: SUBMIT SEARCH & START POLLING ====================\
// ================================================================\

async function handleSearchSubmit(formData) {
  if (pollTimer) clearInterval(pollTimer);
  
  render(<Spinner label="Finding restaurants and starting the calls..." />);
  
  try {
    const searchResponse = await fetch('/restaurants/search_and_call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(formData),
    });

    if (!searchResponse.ok) {
      const error = await searchResponse.json();
      return render(<Text>Error: {error.message || "Could not start search."}</Text>);
    }
    
    // Store the static restaurant data and query data
    const { batchId, mapUrl, restaurants, query } = await searchResponse.json();

    // Start polling for results
    // We pass the static data to the poller so it can merge it
    pollTimer = setInterval(() => pollForResults(batchId, mapUrl, restaurants, query), 2500);

  } catch (err) {
    render(<Text>Error: {err.message}</Text>);
  }
}

// ================================================================\
// ===== STEP 3: POLLING & RENDERING RESULTS ======================\
// ================================================================\

async function pollForResults(batchId, mapUrl, staticRestaurants, query) {
  try {
    const statusResponse = await fetch(`/status/${batchId}`);
    if (!statusResponse.ok) {
      clearInterval(pollTimer);
      return render(<Text>Error: Could not retrieve batch status.</Text>);
    }
    
    const { status: batchStatus, items: liveCallItems } = await statusResponse.json();
    
    // --- This is the key logic ---
    // Merge the static data (name, rating) with the live call data (status, result)
    const mergedItems = staticRestaurants.map(staticResto => {
      const liveData = liveCallItems.find(live => live.phone === staticResto.formatted_phone_number);
      return {
        ...staticResto, // name, rating, user_ratings_total
        ...liveData    // id, status, result, raw
      };
    });
    // -----------------------------

    renderResultsScreen(batchId, mapUrl, mergedItems, query, batchStatus);
    
    if (batchStatus === 'completed') {
      clearInterval(pollTimer);
    }
  } catch (err) {
    clearInterval(pollTimer);
    render(<Text>Error polling for results: {err.message}</Text>);
  }
}

// ================================================================\
// ===== SCREEN 2: THE DYNAMIC RESULTS SCREEN =====================\
// ================================================================\

function renderResultsScreen(batchId, mapUrl, mergedItems, query, batchStatus) {
  render(
    <Card>
      <Image src={mapUrl} alt="Map of restaurants" />
      {batchStatus !== 'completed' && <Spinner label="Live status: Calls in progress..." />}
      {batchStatus === 'completed' && <Text>✅ All calls are complete.</Text>}
      
      {mergedItems.map((item, index) => (
        <Card key={item.id || index} title={item.name}>
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
      
      {/* Show 'Search More' button only when the current batch is done */}
      {batchStatus === 'completed' && (
         <Button variant="secondary" onClick={() => handleSearchMore(batchId)}>Search More</Button>
      )}
    </Card>
  );
}

// ================================================================\
// ===== MODAL: VIEW TRANSCRIPT ===================================\
// ================================================================\

function renderTranscript(name, transcript) {
  render(
    <Modal title={`Transcript for ${name}`} onClose={() => { /* This would close the modal */ }}>
      <Text>{transcript || "No transcript available."}</Text>
    </Modal>
  );
}

// ================================================================\
// ===== FLOW: SEARCH MORE ========================================\
// ================================================================\

async function handleSearchMore(batchId) {
  if (pollTimer) clearInterval(pollTimer);
  
  render(<Spinner label="Finding and calling more restaurants..." />);
  
  try {
    const searchResponse = await fetch('/restaurants/search_more', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ original_batch_id: batchId }),
    });
    
    if (!searchResponse.ok) {
      const error = await searchResponse.json();
      return render(<Text>Error: {error.message || "No more restaurants to search."}</Text>);
    }
    
    // Re-start the polling loop with the new data
    const { batchId: newBatchId, mapUrl, restaurants, query } = await searchResponse.json();
    pollTimer = setInterval(() => pollForResults(newBatchId, mapUrl, restaurants, query), 2500);

  } catch (err) {
    render(<Text>Error: {err.message}</Text>);
  }
}

// ================================================================\
// ===== FLOW: BOOKING (STUBBED) ==================================\
// ================================================================\

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
    </Form>
  );
}

async function handleConfirmBooking(restaurantItem, query, bookingData) {
  render(<Spinner label="Contacting the restaurant to confirm your booking..." />);
  // This is a stub. We need to implement the /reservations/book endpoint.
  render(<Text>✅ Booking feature not yet implemented.</Text>);
}