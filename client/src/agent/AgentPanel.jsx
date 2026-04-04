import { useEffect, useRef, useState } from 'react'
import { executeAgentActions, serializeCanvas } from '../canvas/agentActions'
import { useAgent } from './useAgent'
import { useVoice } from '../voice/useVoice'
import { useVoiceChat } from '../voice/useVoiceChat'

const PROACTIVE_PROMPT =
  'Observe the current canvas and contribute like an aggressive brainstorming partner, not a passive organizer. Your default job is to add fresh ideas, unexplored opportunities, sharp questions, risks, assumptions, edge cases, target users, features, monetization ideas, or next steps that make the board more interesting and complete. Prefer expanding weak or sparse parts of the canvas with 2 to 5 concrete new nodes and connect them to relevant existing nodes when helpful. Only reorganize or group content if the board is obviously messy or if structure is necessary to make new ideas clearer. Avoid returning an empty action list unless the canvas is already dense, well-structured, and hard to improve.'
const REACTIVE_IDLE_MS = 15000

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
  const [reactiveCountdownMs, setReactiveCountdownMs] = useState(null)
  const runInFlightRef = useRef(false)
  const isApplyingAgentActionsRef = useRef(false)
  const reactiveTimeoutRef = useRef(null)
  const reactiveIntervalRef = useRef(null)
  const reactiveDeadlineRef = useRef(null)
  const previousShapesRef = useRef(new Map())
  const {
    status,
    lastThought,
    lastActions,
    error,
    isReactiveEnabled,
    sendMessage,
    setStatus,
    setError,
    setReactiveEnabled,
  } = useAgent({ sharedAgentState, updateSharedAgentState })
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
  const isWorking = status === 'thinking' || status === 'placing'
  const reactiveCountdownSeconds =
    reactiveCountdownMs === null ? null : Math.max(0, Math.ceil(reactiveCountdownMs / 1000))

  function snapshotShape(shape) {
    return {
      id: shape.id,
      type: shape.type,
      text:
        typeof shape.props?.text === 'string'
          ? shape.props.text
          : typeof shape.props?.plainText === 'string'
            ? shape.props.plainText
            : '',
      color: shape.props?.color || '',
      w: Math.round(shape.props?.w || 0),
      h: Math.round(shape.props?.h || 0),
    }
  }

  function snapshotCurrentShapes() {
    if (!editor) return new Map()

    return new Map(editor.getCurrentPageShapes().map((shape) => [shape.id, snapshotShape(shape)]))
  }

  function isCanvasEmpty() {
    return snapshotCurrentShapes().size === 0
  }

  function hasMeaningfulUserChange() {
    const nextShapes = snapshotCurrentShapes()
    const previousShapes = previousShapesRef.current
    let hasMeaningfulChange = false

    for (const [id, nextShape] of nextShapes) {
      const previousShape = previousShapes.get(id)

      if (!previousShape) {
        if (['note', 'text', 'image'].includes(nextShape.type)) {
          hasMeaningfulChange = true
          break
        }
        continue
      }

      if (
        previousShape.type !== nextShape.type ||
        previousShape.text !== nextShape.text ||
        previousShape.color !== nextShape.color ||
        previousShape.w !== nextShape.w ||
        previousShape.h !== nextShape.h
      ) {
        hasMeaningfulChange = true
        break
      }
    }

    previousShapesRef.current = nextShapes
    return hasMeaningfulChange
  }

  useEffect(() => {
    return () => {
      if (reactiveTimeoutRef.current) {
        clearTimeout(reactiveTimeoutRef.current)
      }
      if (reactiveIntervalRef.current) {
        clearInterval(reactiveIntervalRef.current)
      }
      reactiveDeadlineRef.current = null
      previousShapesRef.current = new Map()
    }
  }, [])

  useEffect(() => {
    if (!editor) return undefined

    previousShapesRef.current = snapshotCurrentShapes()

    const clearReactiveTimeout = () => {
      if (reactiveTimeoutRef.current) {
        clearTimeout(reactiveTimeoutRef.current)
        reactiveTimeoutRef.current = null
      }
      if (reactiveIntervalRef.current) {
        clearInterval(reactiveIntervalRef.current)
        reactiveIntervalRef.current = null
      }
      reactiveDeadlineRef.current = null
      setReactiveCountdownMs(null)
    }

    const armReactiveTimeout = () => {
      clearReactiveTimeout()

      if (!isReactiveEnabled) return
      if (isCanvasEmpty()) return

      reactiveDeadlineRef.current = Date.now() + REACTIVE_IDLE_MS
      setReactiveCountdownMs(REACTIVE_IDLE_MS)
      reactiveIntervalRef.current = window.setInterval(() => {
        if (!reactiveDeadlineRef.current) {
          setReactiveCountdownMs(null)
          return
        }

        setReactiveCountdownMs(Math.max(0, reactiveDeadlineRef.current - Date.now()))
      }, 250)
      reactiveTimeoutRef.current = setTimeout(async () => {
        clearReactiveTimeout()
        if (runInFlightRef.current || isApplyingAgentActionsRef.current) return
        setLastProactiveRunAt(Date.now())
        await runAgentTurn(PROACTIVE_PROMPT, {
          requestModeHint: 'reactive_focus',
        })
      }, REACTIVE_IDLE_MS)
    }

    const teardown = editor.store.listen(
      () => {
        if (isApplyingAgentActionsRef.current) return
        if (isCanvasEmpty()) {
          previousShapesRef.current = new Map()
          clearReactiveTimeout()
          return
        }
        if (!hasMeaningfulUserChange()) return
        armReactiveTimeout()
      },
      { source: 'user', scope: 'document' }
    )

    if (!isReactiveEnabled) {
      clearReactiveTimeout()
    }

    return () => {
      clearReactiveTimeout()
      teardown()
    }
  }, [editor, isReactiveEnabled])

  async function runAgentTurn(userMessage, options = {}) {
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
        recentChangedShapeIds: options.recentChangedShapeIds || [],
        requestModeHint: options.requestModeHint || 'general',
      })

      if (sent) {
        setStatus('placing')
        isApplyingAgentActionsRef.current = true
        await executeAgentActions(editor, sent.actions)
        previousShapesRef.current = snapshotCurrentShapes()
        setStatus('idle')
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Failed to execute agent actions.')
      setStatus('error')
    } finally {
      isApplyingAgentActionsRef.current = false
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
        <div className="flex items-center gap-3">
          <div
            className={`h-3.5 w-3.5 rounded-full border-2 ${
              isWorking
                ? 'animate-spin border-stone-600 border-t-amber-300'
                : 'border-stone-700'
            }`}
          />
          <div>
            <p className="text-xs uppercase tracking-[0.24em] text-stone-500">Agent Panel</p>
            <p className="text-sm font-medium text-stone-100">{statusLabel}</p>
          </div>
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
                  Agent Mode
                </p>
                <p className="mt-1 text-sm text-stone-200">
                  {isReactiveEnabled
                    ? 'On: auto-runs after 15s of canvas idle'
                    : 'Off: only responds when you ask'}
                </p>
                {isReactiveEnabled ? (
                  <p className="mt-1 text-xs text-stone-500">
                    {isWorking
                      ? 'Reactive mode will resume after this turn finishes.'
                      : reactiveCountdownSeconds === null
                        ? 'Waiting for a canvas change.'
                        : `Next reactive run in ${reactiveCountdownSeconds}s`}
                  </p>
                ) : null}
              </div>
              <label className="flex items-center gap-2 text-xs text-stone-300">
                <span>{isReactiveEnabled ? 'On' : 'Off'}</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={isReactiveEnabled}
                  onClick={() => {
                    setReactiveEnabled((current) => {
                      const next = !current

                      if (!next && reactiveTimeoutRef.current) {
                        clearTimeout(reactiveTimeoutRef.current)
                        reactiveTimeoutRef.current = null
                      }
                      if (!next && reactiveIntervalRef.current) {
                        clearInterval(reactiveIntervalRef.current)
                        reactiveIntervalRef.current = null
                      }
                      if (!next) {
                        reactiveDeadlineRef.current = null
                        setReactiveCountdownMs(null)
                      }

                      return next
                    })
                  }}
                  className={`relative h-7 w-12 rounded-full transition ${
                    isReactiveEnabled ? 'bg-emerald-400' : 'bg-stone-700'
                  }`}
                >
                  <span
                    className={`absolute top-1 h-5 w-5 rounded-full bg-white transition ${
                      isReactiveEnabled ? 'left-6' : 'left-1'
                    }`}
                  />
                </button>
              </label>
            </div>
            <div className="mt-3 flex items-center justify-between gap-3">
              <p className="text-xs text-stone-500">
                {lastProactiveRunAt
                  ? `Last proactive run: ${new Date(lastProactiveRunAt).toLocaleTimeString()}`
                  : 'No proactive run yet.'}
              </p>
              <button
                type="button"
                onClick={handleProactiveRun}
                disabled={!editor || status === 'thinking' || status === 'placing'}
                className="rounded-full bg-emerald-400 px-3 py-1 text-xs text-stone-950 transition hover:bg-emerald-300 disabled:cursor-not-allowed disabled:bg-stone-700 disabled:text-stone-400"
              >
                Run Now
              </button>
            </div>
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
