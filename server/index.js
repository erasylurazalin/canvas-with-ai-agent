import dotenv from 'dotenv'
import express from 'express'
import http from 'http'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { WebSocketServer } from 'ws'
import { setupWSConnection } from 'y-websocket/bin/utils'
import { runAgentTurn } from './agent.js'
import { buildSystemPrompt } from './promptBuilder.js'

dotenv.config()

const app = express()
const port = Number(process.env.PORT || 3001)
const wsPort = Number(process.env.WS_PORT || 1234)
const voiceRooms = new Map()
const execFileAsync = promisify(execFile)
const whisperCliPath = path.resolve('vendor/whisper.cpp/build/bin/whisper-cli')
const whisperModelPath = path.resolve('vendor/whisper.cpp/models/ggml-tiny.en.bin')
const whisperThreadCount =
  typeof os.availableParallelism === 'function'
    ? Math.max(2, Math.min(os.availableParallelism(), 8))
    : 4

function getAudioExtension(mimeType) {
  if (mimeType.includes('mp4')) return 'm4a'
  if (mimeType.includes('ogg')) return 'ogg'
  if (mimeType.includes('mpeg')) return 'mp3'
  return 'webm'
}

function sendJson(socket, payload) {
  if (socket.readyState !== 1) return
  socket.send(JSON.stringify(payload))
}

function getVoiceRoom(roomId) {
  if (!voiceRooms.has(roomId)) {
    voiceRooms.set(roomId, new Map())
  }

  return voiceRooms.get(roomId)
}

function removeVoicePeer(socket) {
  const roomId = socket.voiceRoomId
  const peerId = socket.voicePeerId

  if (!roomId || !peerId) return

  const room = voiceRooms.get(roomId)
  if (!room) return

  room.delete(peerId)

  for (const [, peer] of room) {
    sendJson(peer.socket, {
      type: 'voice-peer-left',
      peerId,
    })
  }

  if (room.size === 0) {
    voiceRooms.delete(roomId)
  }

  socket.voiceRoomId = null
  socket.voicePeerId = null
}

function handleVoiceMessage(socket, rawMessage) {
  let message = null

  try {
    message = JSON.parse(rawMessage.toString())
  } catch {
    return
  }

  if (message.type === 'join-voice-room') {
    removeVoicePeer(socket)

    const roomId = typeof message.roomId === 'string' ? message.roomId : null
    const peerId = typeof message.peerId === 'string' ? message.peerId : null
    const displayName =
      typeof message.displayName === 'string' && message.displayName.trim().length > 0
        ? message.displayName.trim()
        : 'Guest'

    if (!roomId || !peerId) return

    const room = getVoiceRoom(roomId)
    const existingPeers = Array.from(room.values()).map((peer) => ({
      peerId: peer.peerId,
      displayName: peer.displayName,
    }))

    room.set(peerId, {
      peerId,
      displayName,
      socket,
    })

    socket.voiceRoomId = roomId
    socket.voicePeerId = peerId

    sendJson(socket, {
      type: 'voice-joined',
      peers: existingPeers,
    })

    for (const [existingPeerId, peer] of room) {
      if (existingPeerId === peerId) continue

      sendJson(peer.socket, {
        type: 'voice-peer-joined',
        peerId,
        displayName,
      })
    }

    return
  }

  if (message.type === 'leave-voice-room') {
    removeVoicePeer(socket)
    return
  }

  const roomId = socket.voiceRoomId
  const peerId = socket.voicePeerId
  const targetPeerId = typeof message.targetPeerId === 'string' ? message.targetPeerId : null

  if (!roomId || !peerId || !targetPeerId) return

  const room = voiceRooms.get(roomId)
  const targetPeer = room?.get(targetPeerId)

  if (!targetPeer) return

  if (message.type === 'voice-offer' || message.type === 'voice-answer') {
    sendJson(targetPeer.socket, {
      type: message.type,
      peerId,
      displayName:
        room.get(peerId)?.displayName ||
        (typeof message.displayName === 'string' ? message.displayName : 'Guest'),
      sdp: message.sdp,
    })
    return
  }

  if (message.type === 'voice-ice-candidate') {
    sendJson(targetPeer.socket, {
      type: 'voice-ice-candidate',
      peerId,
      candidate: message.candidate,
    })
  }
}

app.use(express.json({ limit: '1mb' }))

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'ai-brainstorm-canvas-server',
    httpPort: port,
    wsPort,
  })
})

app.get('/api/prompt-preview', (_req, res) => {
  res.json({
    prompt: buildSystemPrompt([]),
  })
})

app.post('/api/agent', async (req, res) => {
  const { userMessage, canvasState, conversationHistory, selectedShapeIds } = req.body ?? {}

  try {
    const result = await runAgentTurn({
      userMessage,
      canvasState,
      conversationHistory,
      selectedShapeIds,
    })

    res.json(result)
  } catch (error) {
    const statusCode =
      typeof error.message === 'string' &&
      (error.message.includes('required') || error.message.includes('not configured'))
        ? 400
        : 502

    res.status(statusCode).json({
      error: error.message || 'Agent request failed.',
    })
  }
})

app.post(
  '/api/transcribe',
  express.raw({
    type: () => true,
    limit: '10mb',
  }),
  async (req, res) => {
    if (!req.body || req.body.length === 0) {
      res.status(400).json({
        error: 'Audio body is required.',
      })
      return
    }

    try {
      await fs.access(whisperCliPath)
      await fs.access(whisperModelPath)
    } catch {
      res.status(400).json({
        error: 'Local whisper.cpp binary or model is not available.',
      })
      return
    }

    try {
      const mimeType =
        typeof req.headers['x-audio-mime-type'] === 'string'
          ? req.headers['x-audio-mime-type']
          : 'audio/webm'
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-ai-whisper-'))
      const sourcePath = path.join(tempDir, `input.${getAudioExtension(mimeType)}`)
      const wavPath = path.join(tempDir, 'input.wav')

      await fs.writeFile(sourcePath, req.body)

      await execFileAsync('ffmpeg', [
        '-y',
        '-i',
        sourcePath,
        '-ar',
        '16000',
        '-ac',
        '1',
        '-c:a',
        'pcm_s16le',
        wavPath,
      ])

      const outputPrefix = path.join(tempDir, `transcript-${randomUUID()}`)
      await execFileAsync(whisperCliPath, [
        '-m',
        whisperModelPath,
        '-f',
        wavPath,
        '-l',
        'en',
        '-t',
        String(whisperThreadCount),
        '-bs',
        '1',
        '-bo',
        '1',
        '-nf',
        '-nt',
        '-np',
        '-otxt',
        '-of',
        outputPrefix,
      ])

      const transcription = await fs.readFile(`${outputPrefix}.txt`, 'utf8')

      await fs.rm(tempDir, { recursive: true, force: true })

      res.json({
        text: transcription.trim(),
      })
    } catch (error) {
      res.status(502).json({
        error: error instanceof Error ? error.message : 'Transcription failed.',
      })
    }
  }
)

const httpServer = http.createServer(app)
const voiceWss = new WebSocketServer({ server: httpServer, path: '/voice' })

voiceWss.on('connection', (socket) => {
  socket.voiceRoomId = null
  socket.voicePeerId = null

  socket.on('message', (message) => {
    handleVoiceMessage(socket, message)
  })

  socket.on('close', () => {
    removeVoicePeer(socket)
  })
})

httpServer.listen(port, () => {
  console.log(`HTTP server listening on http://localhost:${port}`)
})

const wsServer = http.createServer()
const wss = new WebSocketServer({ server: wsServer })

wss.on('connection', (socket, request) => {
  setupWSConnection(socket, request)
})

wsServer.listen(wsPort, () => {
  console.log(`Yjs websocket server listening on ws://localhost:${wsPort}`)
})

const shutdown = () => {
  console.log('Shutting down servers...')
  voiceWss.close(() => {
    wss.close(() => {
      wsServer.close(() => {
        httpServer.close(() => {
          process.exit(0)
        })
      })
    })
  })
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
