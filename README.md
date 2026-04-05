# AI Brainstorm Canvas

AI Brainstorm Canvas is a real-time collaborative whiteboard where an AI agent participates directly on the canvas instead of sitting in a sidebar chat.

Users can brainstorm together, talk over built-in voice chat, speak prompts to the AI, and watch the agent create, move, group, annotate, and visualize ideas on the board.

## Features

- Real-time multiplayer canvas with `tldraw` + `Yjs`
- AI agent that acts directly on the canvas
- Shared agent state across all connected users
- Text prompts and speech-to-AI input
- Built-in user voice chat
- Image generation on the canvas
- Reactive AI mode with shared on/off state

## Tech Stack

### Frontend

- React + Vite
- tldraw
- Yjs + y-websocket
- TailwindCSS

### Backend

- Node.js + Express
- Groq API for the brainstorming agent
- Local `whisper.cpp` for speech-to-text
- Higgsfield API for image generation

## Project Structure

```text
client/   React frontend
server/   Express server, agent pipeline, APIs
vendor/   Local whisper.cpp dependency
```

## Running Locally

Install dependencies:

```bash
npm install
```

Run the development setup:

```bash
npm run dev
```

Run the production-style app:

```bash
openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 1 -nodes -subj "/CN=localhost"
npm run build
npm start
```

The app will be available at:

```text
https://localhost:3001
```

For remote devices in a demo setting, each browser needs to accept the self-signed certificate once via `Advanced` -> `Proceed anyway`.

## Environment Variables

Create a `.env` file in the project root and configure the required keys:

```env
GROQ_API_KEY=your_key_here
HIGGSFIELD_API_KEY=your_key_here
HIGGSFIELD_API_SECRET=your_secret_here
HIGGSFIELD_MODEL_ID=bytedance/seedream/v4/text-to-image
PORT=3001
VITE_VOICE_ROOM_URL=https://your-subdomain.daily.co/{roomId}
```

## Notes

- Speech-to-text runs locally through `whisper.cpp`, so the host machine also needs `ffmpeg`.
- Collaboration, agent requests, transcription, and voice signaling are all served from the same Node server in production mode.
- For demos, the in-app voice button can open a hosted room link instead of using browser-to-browser WebRTC. Set `VITE_VOICE_ROOM_URL` to a Daily room URL like `https://your-subdomain.daily.co/{roomId}`. If unset, the UI falls back to a shared Jitsi room URL.
- Conversation memory is intentionally short and only keeps the most recent context.
