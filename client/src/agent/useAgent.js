const MAX_HISTORY_TURNS = 3
const DEFAULT_AGENT_STATE = {
  status: 'idle',
  lastThought: '',
  lastActions: [],
  error: '',
  conversationHistory: [],
}

function normalizeError(error) {
  if (error instanceof Error && error.message) return error.message
  return 'Agent request failed.'
}

function normalizeAgentState(sharedState) {
  if (!sharedState || typeof sharedState !== 'object' || Array.isArray(sharedState)) {
    return DEFAULT_AGENT_STATE
  }

  return {
    status: typeof sharedState.status === 'string' ? sharedState.status : DEFAULT_AGENT_STATE.status,
    lastThought:
      typeof sharedState.lastThought === 'string'
        ? sharedState.lastThought
        : DEFAULT_AGENT_STATE.lastThought,
    lastActions: Array.isArray(sharedState.lastActions)
      ? sharedState.lastActions
      : DEFAULT_AGENT_STATE.lastActions,
    error: typeof sharedState.error === 'string' ? sharedState.error : DEFAULT_AGENT_STATE.error,
    conversationHistory: Array.isArray(sharedState.conversationHistory)
      ? sharedState.conversationHistory.slice(-MAX_HISTORY_TURNS)
      : DEFAULT_AGENT_STATE.conversationHistory,
  }
}

export function useAgent({ sharedAgentState, updateSharedAgentState }) {
  const agentState = normalizeAgentState(sharedAgentState)

  function patchAgentState(patch) {
    if (!updateSharedAgentState) return normalizeAgentState(sharedAgentState)

    return updateSharedAgentState((current) => ({
      ...normalizeAgentState(current),
      ...patch,
    }))
  }

  return {
    status: agentState.status,
    lastThought: agentState.lastThought,
    lastActions: agentState.lastActions,
    error: agentState.error,
    setError(error) {
      patchAgentState({ error })
    },
    setStatus(status) {
      patchAgentState({ status })
    },
    async sendMessage({ userMessage, canvasState = [], selectedShapeIds = [] }) {
      const trimmedMessage = userMessage.trim()

      if (!trimmedMessage) {
        return null
      }

      const conversationHistory = agentState.conversationHistory
      patchAgentState({
        status: 'thinking',
        error: '',
        lastActions: [],
      })

      try {
        const response = await fetch('/api/agent', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            userMessage: trimmedMessage,
            canvasState,
            conversationHistory,
            selectedShapeIds,
          }),
        })
        const responseText = await response.text()
        let payload = null

        try {
          payload = responseText ? JSON.parse(responseText) : null
        } catch {
          throw new Error('Server returned an invalid JSON response.')
        }

        if (!response.ok) {
          throw new Error(payload?.error || 'Agent request failed.')
        }

        console.log('Agent response:', payload)

        patchAgentState({
          status: 'idle',
          lastThought: payload?.thought || '',
          lastActions: Array.isArray(payload?.actions) ? payload.actions : [],
          error: '',
          conversationHistory: [
            ...conversationHistory,
            { role: 'user', content: trimmedMessage },
            {
              role: 'assistant',
              content: payload?.thought || JSON.stringify(payload?.actions || []),
            },
          ].slice(-MAX_HISTORY_TURNS),
        })

        return payload
      } catch (requestError) {
        const message = normalizeError(requestError)
        patchAgentState({
          status: 'error',
          error: message,
          lastActions: [],
        })
        return null
      }
    },
  }
}
