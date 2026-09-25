# AI Brainstorm Canvas

A shared whiteboard where an AI agent works on the board itself instead of sitting
in a sidebar chat. You ask it something, by text or by voice, and it adds sticky
notes, groups and connects ideas, and generates images right on the canvas, where
everyone connected sees it happen.

Built by a team of two at HackNU 26, the Nazarbayev University hackathon. It made the
final.

## What's in it

- Real-time multiplayer canvas: tldraw, synced over Yjs and a WebSocket server
- The agent: an LLM on Groq (`openai/gpt-oss-20b`) that returns canvas actions
  (create, move, group, connect), which the client applies to the shared board
- Speech to text runs on the server with whisper.cpp (`tiny.en`), not a cloud
  API
- Image generation through the Higgsfield API
- Voice chat between users over WebRTC, or a link to a hosted room

React, Vite and Tailwind on the front, Node and Express on the back.

## Running it

Needs Node, ffmpeg, and a Groq API key. Image generation needs a Higgsfield key.

```bash
npm install
cp .env.example .env          # then fill in the keys

# whisper.cpp, for speech to text
git clone https://github.com/ggml-org/whisper.cpp vendor/whisper.cpp
cd vendor/whisper.cpp
cmake -B build && cmake --build build -j --config Release
sh ./models/download-ggml-model.sh tiny.en
cd ../..

npm run dev                   # client on http://127.0.0.1:5173
```

The server runs over HTTPS, because browsers only allow microphone access on a
secure origin. For a production-style run with a throwaway self-signed certificate:

```bash
openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 1 -nodes -subj "/CN=localhost"
npm run build
npm start                     # https://localhost:3001
```

Other devices on the network have to accept the certificate once.

Environment variables the server reads: `GROQ_API_KEY`, `HIGGSFIELD_API_KEY`,
`HIGGSFIELD_API_SECRET`, `HIGGSFIELD_MODEL_ID`, `PORT` (3001), `WS_PORT` (1234), and
optionally `RTC_STUN_URLS` and `RTC_TURN_*` for voice chat across networks.
`VITE_VOICE_ROOM_URL` points the voice button at a hosted room instead.

## Known limitations

- Hackathon code: no test suite, and the agent keeps only short conversation memory.
- Everything runs on one Node server. Fine for a demo, not built to scale.
