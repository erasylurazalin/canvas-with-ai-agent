import { useCallback, useState } from 'react'
import CanvasWrapper from './canvas/CanvasWrapper'
import AgentPanel from './agent/AgentPanel'

const ROOM_ID = 'brainstorm-001'
const DEFAULT_AGENT_STATE = {
  status: 'idle',
  lastThought: '',
  lastActions: [],
  error: '',
  conversationHistory: [],
  isReactiveEnabled: false,
}

export default function App() {
  const [editor, setEditor] = useState(null)
  const [collaborationState, setCollaborationState] = useState({
    status: 'connecting',
    synced: false,
    userCount: 1,
    userName: 'User 1',
  })
  const [agentState, setAgentState] = useState(DEFAULT_AGENT_STATE)
  const [updateSharedAgentState, setUpdateSharedAgentState] = useState(null)
  const handleAgentStateReady = useCallback((nextUpdater) => {
    setUpdateSharedAgentState(() => nextUpdater)
  }, [])

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-stone-950 text-stone-50">
      <div className="pointer-events-none absolute inset-x-0 top-0 z-30 flex items-center justify-between border-b border-white/10 bg-stone-950/70 px-5 py-3 backdrop-blur-md">
        <div className="flex items-center gap-3">
          <div className="h-3 w-3 rounded-full bg-amber-400 shadow-[0_0_20px_rgba(251,191,36,0.75)]" />
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.24em] text-stone-300">
              AI Brainstorm Canvas
            </p>
            <p className="text-xs text-stone-500">Spatial AI teammate</p>
          </div>
        </div>
        <div className="flex items-center gap-6 text-sm text-stone-300">
          <div>
            Room: <span className="font-medium text-stone-100">{ROOM_ID}</span>
          </div>
          <div>
            Users: <span className="font-medium text-stone-100">{collaborationState.userCount}</span>
          </div>
          <div className="flex items-center gap-2">
            <span
              className={`h-2.5 w-2.5 rounded-full ${
                collaborationState.synced ? 'bg-emerald-400' : 'bg-amber-400'
              }`}
            />
            <span className="capitalize">{collaborationState.status}</span>
          </div>
        </div>
      </div>

      <CanvasWrapper
        roomId={ROOM_ID}
        onCollaborationChange={setCollaborationState}
        onEditorReady={setEditor}
        onAgentStateChange={setAgentState}
        onAgentStateReady={handleAgentStateReady}
      />
      <AgentPanel
        editor={editor}
        roomId={ROOM_ID}
        displayName={collaborationState.userName}
        sharedAgentState={agentState}
        updateSharedAgentState={updateSharedAgentState}
      />
    </div>
  )
}
