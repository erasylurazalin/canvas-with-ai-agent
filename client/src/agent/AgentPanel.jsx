import { useEffect, useRef, useState } from 'react'
import { executeAgentActions, serializeCanvas } from '../canvas/agentActions'
import { useAgent } from './useAgent'
import { useVoice } from '../voice/useVoice'
import { useVoiceChat } from '../voice/useVoiceChat'

const PROACTIVE_PROMPT =
  'Observe the current canvas and contribute like an aggressive brainstorming partner, not a passive organizer. Your default job is to add fresh ideas, unexplored opportunities, sharp questions, risks, assumptions, edge cases, target users, features, monetization ideas, or next steps that make the board more interesting and complete. Prefer expanding weak or sparse parts of the canvas with 2 to 5 concrete new nodes and connect them to relevant existing nodes when helpful. Only reorganize or group content if the board is obviously messy or if structure is necessary to make new ideas clearer. Avoid returning an empty action list unless the canvas is already dense, well-structured, and hard to improve.'

function getStatusLabel(status) {
  if (status === 'thinking') return 'Thinking...'
  if (status === 'placing') return 'Placing ideas...'
  if (status === 'error') return 'Error'
  return 'Idle'
}

function RemoteVoiceAudio({ stream }) {
  const audioRef = useRef(null)

  useEffect(() => {
    const audio = audioRef.current

    if (!audio) return undefined

    audio.srcObject = stream
    audio.play().catch(() => {})

    return () => {
      audio.srcObject = null
    }
  }, [stream])

  return <audio ref={audioRef} autoPlay playsInline />
}

export default function AgentPanel({
  editor,
  roomId,
  displayName,
  sharedAgentState,
  updateSharedAgentState,
}) {
  const [message, setMessage] = useState('')
  const [isCollapsed, setIsCollapsed] = useState(false)
  const [lastProactiveRunAt, setLastProactiveRunAt] = useState(null)
  const runInFlightRef = useRef(false)
  const { status, lastThought, lastActions, error, sendMessage, setStatus, setError } = useAgent({
    sharedAgentState,
    updateSharedAgentState,
  })
  const {
    transcript,
    isListening,
    isTranscribing,
    error: voicePromptError,
    isSupported: isVoiceSupported,
    startListening,
    stopListening,
  } = useVoice({
    onFinalTranscript: async (spokenPrompt) => {
      setMessage(spokenPrompt)
      await runAgentTurn(spokenPrompt)
      setMessage('')
    },
  })
  const {
    isSupported: isVoiceChatSupported,
    isConnecting: isVoiceConnecting,
    isConnected: isVoiceConnected,
    isMuted,
    error: voiceError,
    participants: voiceParticipants,
    remoteStreams,
    joinVoice,
    leaveVoice,
    toggleMute,
  } = useVoiceChat({
    roomId,
    displayName,
  })
  const statusLabel = getStatusLabel(status)

  async function runAgentTurn(userMessage) {
    if (!editor || runInFlightRef.current) return

    runInFlightRef.current = true
    try {
      const canvasState = serializeCanvas(editor)
      const selectedShapeIds =
        typeof editor.getSelectedShapeIds === 'function' ? editor.getSelectedShapeIds() : []

      const sent = await sendMessage({
        userMessage,
        canvasState,
        selectedShapeIds,
      })

      if (sent) {
        setStatus('placing')
        await executeAgentActions(editor, sent.actions)
        setStatus('idle')
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Failed to execute agent actions.')
      setStatus('error')
    } finally {
      runInFlightRef.current = false
    }
  }

  async function handleSubmit(event) {
    event.preventDefault()
    const trimmed = message.trim()

    if (!trimmed) return

    await runAgentTurn(trimmed)
    setMessage('')
  }

  async function handleProactiveRun() {
    setLastProactiveRunAt(Date.now())
    await runAgentTurn(PROACTIVE_PROMPT)
  }

  return (
    <div className="absolute bottom-6 right-6 z-40 w-[340px] rounded-3xl border border-white/10 bg-stone-950/80 p-4 shadow-2xl backdrop-blur-xl">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs uppercase tracking-[0.24em] text-stone-500">Agent Panel</p>
          <p className="text-sm font-medium text-stone-100">{statusLabel}</p>
        </div>
        <button
          type="button"
          onClick={() => setIsCollapsed((value) => !value)}
          className="rounded-full border border-white/10 px-3 py-1 text-xs text-stone-300 transition hover:border-white/20 hover:text-stone-100"
        >
          {isCollapsed ? 'Open' : 'Minimize'}
        </button>
      </div>

      {!isCollapsed ? (
        <>
          <div className="mt-4 rounded-2xl border border-white/10 bg-white/5 px-3 py-3">
            <p className="text-[11px] uppercase tracking-[0.22em] text-stone-500">Last Thought</p>
            <p className="mt-2 min-h-[40px] text-sm text-stone-200">
              {lastThought || 'No agent response yet.'}
            </p>
          </div>

          <div className="mt-3 flex items-center justify-between text-xs text-stone-400">
            <span>Actions returned: {lastActions.length}</span>
            <span className={status === 'error' ? 'text-red-300' : 'text-stone-500'}>
              {error || 'Ready'}
            </span>
          </div>

          <p className="mt-2 text-xs text-stone-500">
            {editor && typeof editor.getSelectedShapeIds === 'function'
              ? `${editor.getSelectedShapeIds().length} selected`
              : '0 selected'}
          </p>

          <div className="mt-4 rounded-2xl border border-white/10 bg-black/20 p-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-[11px] uppercase tracking-[0.22em] text-stone-500">
                  Proactive Trigger
                </p>
                <p className="mt-1 text-sm text-stone-200">Run one proactive observation turn</p>
              </div>
              <button
                type="button"
                onClick={handleProactiveRun}
                disabled={!editor || status === 'thinking' || status === 'placing'}
                className="rounded-full bg-emerald-400 px-3 py-1 text-xs text-stone-950 transition hover:bg-emerald-300 disabled:cursor-not-allowed disabled:bg-stone-700 disabled:text-stone-400"
              >
                Run Proactive Turn
              </button>
            </div>
            <p className="mt-2 text-xs text-stone-500">
              {lastProactiveRunAt
                ? `Last proactive run: ${new Date(lastProactiveRunAt).toLocaleTimeString()}`
                : 'No proactive development run yet.'}
            </p>
          </div>

          <div className="mt-4 rounded-2xl border border-white/10 bg-black/20 p-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-[11px] uppercase tracking-[0.22em] text-stone-500">
                  Voice Chat
                </p>
                <p className="mt-1 text-sm text-stone-200">
                  {isVoiceConnected
                    ? `${voiceParticipants.length + 1} in voice`
                    : isVoiceConnecting
                      ? 'Connecting to voice...'
                      : 'Audio room offline'}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={isVoiceConnected ? leaveVoice : joinVoice}
                  disabled={!isVoiceChatSupported || isVoiceConnecting}
                  className="rounded-full bg-sky-400 px-3 py-1 text-xs text-stone-950 transition hover:bg-sky-300 disabled:cursor-not-allowed disabled:bg-stone-700 disabled:text-stone-400"
                >
                  {isVoiceConnected ? 'Leave Voice' : 'Join Voice'}
                </button>
                <button
                  type="button"
                  onClick={toggleMute}
                  disabled={!isVoiceConnected}
                  className="rounded-full border border-white/10 px-3 py-1 text-xs text-stone-300 transition hover:border-white/20 hover:text-stone-100 disabled:cursor-not-allowed disabled:text-stone-500"
                >
                  {isMuted ? 'Unmute' : 'Mute'}
                </button>
              </div>
            </div>
            <p className="mt-2 text-xs text-stone-500">
              {voiceError ||
                (isVoiceChatSupported
                  ? voiceParticipants.map((participant) => participant.name).join(', ') || 'No other listeners yet.'
                  : 'WebRTC voice is not supported in this browser.')}
            </p>
          </div>

          <form onSubmit={handleSubmit} className="mt-4 space-y-3">
            {isListening || isTranscribing || transcript || voicePromptError ? (
              <div className="rounded-2xl border border-emerald-400/20 bg-emerald-400/10 px-3 py-2 text-xs text-emerald-100">
                {voicePromptError ||
                  (isListening
                    ? 'Recording... click Stop Mic to send.'
                    : isTranscribing
                      ? 'Transcribing audio...'
                      : transcript)}
              </div>
            ) : null}

            <textarea
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              placeholder="Ask the agent to brainstorm on the canvas..."
              className="min-h-[96px] w-full resize-none rounded-2xl border border-white/10 bg-black/20 px-3 py-3 text-sm text-stone-100 outline-none transition placeholder:text-stone-500 focus:border-amber-400/60"
            />

            <div className="flex items-center gap-2">
              <button
                type="submit"
                disabled={status === 'thinking' || message.trim().length === 0}
                className="rounded-2xl bg-amber-400 px-4 py-2 text-sm font-medium text-stone-950 transition hover:bg-amber-300 disabled:cursor-not-allowed disabled:bg-stone-700 disabled:text-stone-400"
              >
                Send
              </button>
              <button
                type="button"
                onClick={() => {
                  if (!isVoiceSupported) return
                  if (isListening) {
                    stopListening()
                    return
                  }
                  startListening()
                }}
                disabled={
                  !isVoiceSupported ||
                  isTranscribing ||
                  status === 'thinking' ||
                  status === 'placing'
                }
                className="rounded-2xl border border-white/10 px-4 py-2 text-sm text-stone-300 transition hover:border-white/20 hover:text-stone-100 disabled:cursor-not-allowed disabled:text-stone-500"
                title={isVoiceSupported ? 'Record voice prompt for AI' : 'Audio recording is not supported in this browser'}
              >
                {isTranscribing ? 'Transcribing...' : isListening ? 'Stop Mic' : 'Mic'}
              </button>
            </div>
          </form>
        </>
      ) : null}

      <div className="hidden">
        {remoteStreams.map((stream) => (
          <RemoteVoiceAudio key={stream.peerId} stream={stream.stream} />
        ))}
      </div>
    </div>
  )
}
