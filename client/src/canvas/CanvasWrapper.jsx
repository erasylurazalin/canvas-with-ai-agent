import { useEffect, useRef, useState } from 'react'
import { getSnapshot, loadSnapshot, Tldraw } from 'tldraw'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'

const USER_COLORS = ['#f59e0b', '#38bdf8', '#22c55e', '#ef4444', '#a855f7', '#f97316']
const MAX_HISTORY_TURNS = 3
const DEFAULT_AGENT_STATE = {
  status: 'idle',
  lastThought: '',
  lastActions: [],
  error: '',
  conversationHistory: [],
}

function getCollaborationUrl(port) {
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
  const host = window.location.hostname || 'localhost'
  return `${protocol}://${host}:${port}`
}

function randomUser() {
  const suffix = Math.floor(Math.random() * 900) + 100
  return {
    id: `user-${crypto.randomUUID()}`,
    name: `User ${String(suffix).slice(-1)}`,
    color: USER_COLORS[Math.floor(Math.random() * USER_COLORS.length)],
  }
}

export default function CanvasWrapper({
  roomId,
  onCollaborationChange,
  onEditorReady,
  onAgentStateChange,
  onAgentStateReady,
}) {
  const editorRef = useRef(null)
  const providerRef = useRef(null)
  const docRef = useRef(null)
  const yCanvasRef = useRef(null)
  const yAgentStateRef = useRef(null)
  const initializedRef = useRef(false)
  const providerSyncedRef = useRef(false)
  const applyingRemoteRef = useRef(false)
  const teardownStoreListenerRef = useRef(() => {})
  const lastSerializedDocumentRef = useRef('')
  const [user] = useState(() => randomUser())

  useEffect(() => {
    const doc = new Y.Doc()
    const provider = new WebsocketProvider(getCollaborationUrl(1234), roomId, doc)
    const yCanvas = doc.getMap('tldraw-document')
    const yAgentState = doc.getMap('agent-state')

    docRef.current = doc
    providerRef.current = provider
    yCanvasRef.current = yCanvas
    yAgentStateRef.current = yAgentState

    const normalizeAgentState = (value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return DEFAULT_AGENT_STATE
      }

      return {
        status: typeof value.status === 'string' ? value.status : DEFAULT_AGENT_STATE.status,
        lastThought:
          typeof value.lastThought === 'string' ? value.lastThought : DEFAULT_AGENT_STATE.lastThought,
        lastActions: Array.isArray(value.lastActions) ? value.lastActions : DEFAULT_AGENT_STATE.lastActions,
        error: typeof value.error === 'string' ? value.error : DEFAULT_AGENT_STATE.error,
        conversationHistory: Array.isArray(value.conversationHistory)
          ? value.conversationHistory.slice(-MAX_HISTORY_TURNS)
          : DEFAULT_AGENT_STATE.conversationHistory,
      }
    }

    const publishAgentState = () => {
      const serializedState = yAgentState.get('state')

      if (typeof serializedState !== 'string' || serializedState.length === 0) {
        onAgentStateChange?.(DEFAULT_AGENT_STATE)
        return
      }

      try {
        const normalizedState = normalizeAgentState(JSON.parse(serializedState))
        const normalizedSerializedState = JSON.stringify(normalizedState)

        if (normalizedSerializedState !== serializedState) {
          yAgentState.set('state', normalizedSerializedState)
          return
        }

        onAgentStateChange?.(normalizedState)
      } catch {
        onAgentStateChange?.(DEFAULT_AGENT_STATE)
      }
    }

    onAgentStateReady?.((updater) => {
      const currentState = normalizeAgentState(
        (() => {
          const serializedState = yAgentStateRef.current?.get('state')

          if (typeof serializedState !== 'string' || serializedState.length === 0) {
            return DEFAULT_AGENT_STATE
          }

          try {
            return JSON.parse(serializedState)
          } catch {
            return DEFAULT_AGENT_STATE
          }
        })()
      )
      const nextState =
        typeof updater === 'function' ? normalizeAgentState(updater(currentState)) : normalizeAgentState(updater)

      yAgentStateRef.current?.set('state', JSON.stringify(nextState))
      return nextState
    })

    const publishState = (statusOverride) => {
      const awarenessStates = Array.from(provider.awareness.getStates().values())
      onCollaborationChange({
        status: statusOverride || (provider.wsconnected ? 'connected' : 'connecting'),
        synced: provider.synced,
        userCount: Math.max(awarenessStates.length, 1),
        userName: user.name,
      })
    }

    const syncDocumentFromYjs = () => {
      const editor = editorRef.current
      const serializedDocument = yCanvas.get('document')

      if (!editor || !providerSyncedRef.current) return

      if (typeof serializedDocument === 'string' && serializedDocument.length > 0) {
        if (serializedDocument === lastSerializedDocumentRef.current) {
          initializedRef.current = true
          return
        }

        applyingRemoteRef.current = true
        try {
          const documentSnapshot = JSON.parse(serializedDocument)
          editor.store.mergeRemoteChanges(() => {
            loadSnapshot(editor.store, { document: documentSnapshot })
          })
          lastSerializedDocumentRef.current = serializedDocument
        } finally {
          applyingRemoteRef.current = false
        }
      } else {
        const localSnapshot = getSnapshot(editor.store)
        const localSerializedDocument = JSON.stringify(localSnapshot.document)
        yCanvas.set('document', localSerializedDocument)
        lastSerializedDocumentRef.current = localSerializedDocument
      }

      initializedRef.current = true
    }

    const handleYjsDocumentChange = (event) => {
      if (!event.keysChanged.has('document')) return
      if (!initializedRef.current || applyingRemoteRef.current) return
      syncDocumentFromYjs()
    }
    const handleAgentStateChange = (event) => {
      if (!event.keysChanged.has('state')) return
      publishAgentState()
    }

    provider.awareness.setLocalStateField('user', {
      id: user.id,
      name: user.name,
      color: user.color,
    })

    const handleStatus = ({ status }) => publishState(status)
    const handleSync = (isSynced) => {
      providerSyncedRef.current = isSynced
      publishState(isSynced ? 'synced' : 'connecting')
      if (isSynced) {
        syncDocumentFromYjs()
      }
    }
    const handleAwareness = () => publishState()

    provider.on('status', handleStatus)
    provider.on('sync', handleSync)
    provider.awareness.on('change', handleAwareness)
    yCanvas.observe(handleYjsDocumentChange)
    yAgentState.observe(handleAgentStateChange)

    if (typeof yAgentState.get('state') !== 'string') {
      yAgentState.set('state', JSON.stringify(DEFAULT_AGENT_STATE))
    }

    publishState('connecting')
    publishAgentState()

    return () => {
      teardownStoreListenerRef.current()
      yCanvas.unobserve(handleYjsDocumentChange)
      yAgentState.unobserve(handleAgentStateChange)
      provider.awareness.off('change', handleAwareness)
      provider.off('sync', handleSync)
      provider.off('status', handleStatus)
      provider.destroy()
      doc.destroy()
      yCanvasRef.current = null
      yAgentStateRef.current = null
      providerRef.current = null
      docRef.current = null
      initializedRef.current = false
      providerSyncedRef.current = false
      applyingRemoteRef.current = false
      lastSerializedDocumentRef.current = ''
      onAgentStateReady?.(null)
    }
  }, [onAgentStateChange, onAgentStateReady, onCollaborationChange, roomId, user.color, user.id, user.name])

  useEffect(() => {
    return () => {
      window.__APP_EDITOR = null
      onEditorReady?.(null)
    }
  }, [onEditorReady])

  return (
    <div className="absolute inset-0 pt-[68px]">
      <div className="relative h-full w-full">
        <Tldraw
          onMount={(editor) => {
            editorRef.current = editor
            window.__APP_EDITOR = editor
            onEditorReady?.(editor)
            teardownStoreListenerRef.current = editor.store.listen(
              () => {
                const yCanvas = yCanvasRef.current

                if (!initializedRef.current || applyingRemoteRef.current || !yCanvas) return

                const snapshot = getSnapshot(editor.store)
                const serializedDocument = JSON.stringify(snapshot.document)

                if (serializedDocument === lastSerializedDocumentRef.current) return

                lastSerializedDocumentRef.current = serializedDocument
                yCanvas.set('document', serializedDocument)
              },
              { source: 'user', scope: 'document' }
            )

            if (providerSyncedRef.current) {
              const serializedDocument = yCanvasRef.current?.get('document')
              if (typeof serializedDocument === 'string' && serializedDocument.length > 0) {
                applyingRemoteRef.current = true
                try {
                  loadSnapshot(editor.store, { document: JSON.parse(serializedDocument) })
                  lastSerializedDocumentRef.current = serializedDocument
                } finally {
                  applyingRemoteRef.current = false
                }
              }
              initializedRef.current = true
            }
          }}
        />

        <div className="pointer-events-none absolute left-5 top-5 z-20 max-w-sm rounded-2xl border border-white/10 bg-stone-950/70 px-4 py-3 text-sm text-stone-300 shadow-2xl backdrop-blur-md">
          <p className="font-medium text-stone-100">Connected as {user.name}</p>
          <p className="mt-1 text-stone-400">
            `tldraw` is live. Document snapshots now flow through Yjs, so the same room should
            mirror canvas edits across browser tabs.
          </p>
        </div>
      </div>
    </div>
  )
}
