### 🧠 Project Overview: Rezkyoo AI Restaurant Assistant

This Node.js backend powers **Rezkyoo**, an AI-driven restaurant reservation assistant that integrates:

- 📞 **Telnyx Call Control** for automated outbound calls to restaurants  
- 🗺️ **Google Maps API** for geolocation, place search, and timezone awareness  
- 🧠 **OpenAI Whisper + GPT-4o** for call transcription and natural language understanding  
- 🔥 **Firebase Firestore** for tracking call batches, outcomes, and restaurant metadata  
- 🌐 **OpenAPI plugin interface** for integration with ChatGPT via `.well-known/openapi.json`

---

### 🎯 What This Backend Does

- Accepts user input (cuisine, location, party size, date/time)  
- Searches for eligible restaurants using Google Maps  
- Filters out non-reservation-friendly places (e.g. fast food, delivery-only)  
- Initiates calls via Telnyx and records responses  
- Transcribes audio using Whisper  
- Uses GPT-4o to interpret call outcomes (e.g. availability, voicemail, opt-out)  
- Stores all data in Firestore for batch tracking and status updates  
- Exposes REST endpoints for ChatGPT plugin integration:
  - `POST /restaurants/search_and_call`
  - `POST /restaurants/search_more`
  - `GET /status/:batchId`
  - `POST /reservations/book` (stubbed)
  - `POST /voice/webhook` (Telnyx event handler)

---

### 🧩 Integration Goals

- ✅ Compatible with ChatGPT’s **OpenAPI plugin path**  
- ✅ Serves `.well-known/ai-plugin.json` and `openapi.json` via Express  
- ✅ Uses `ngrok` for public HTTPS access during development  


### 🛠️ Technologies Used

- Node.js + Express
- Telnyx SDK
- Google Maps Services SDK
- OpenAI SDK (Whisper + GPT-4o)
- Firebase Admin SDK
- Ngrok (for local HTTPS tunneling)
- OpenAPI 3.0 (for plugin schema)

### 🔑 Environment Variables

- `GOOGLE_MAPS_API_KEY` – enables the backend to generate static map images for the widget.
- `DEV_SIMULATE_CALLS` – optional flag (`true`/`false`) that simulates call outcomes without contacting Telnyx, useful for UI testing.

