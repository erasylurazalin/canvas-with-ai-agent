import OpenAI from 'openai'
import { buildSystemPrompt } from './promptBuilder.js'

const MODEL = 'openai/gpt-oss-20b'
const MAX_HISTORY_TURNS = 3
const MAX_OUTPUT_TOKENS = 1200
const HIGGSFIELD_BASE_URL = 'https://platform.higgsfield.ai'
const HIGGSFIELD_MODEL_ID =
  process.env.HIGGSFIELD_MODEL_ID || 'bytedance/seedream/v4/text-to-image'
const HIGGSFIELD_POLL_INTERVAL_MS = 2000
const HIGGSFIELD_MAX_POLL_ATTEMPTS = 30
const EDIT_INTENT_PATTERNS = [
  /\b(change|edit|update|modify|recolor|colour|color|rename|rewrite|move|reposition|shift)\b/i,
  /\bturn\b.+\b(yellow|blue|green|red|purple)\b/i,
  /\bmake\b.+\b(yellow|blue|green|red|purple|bigger|smaller)\b/i,
]
const CREATION_INTENT_PATTERNS = [
  /\b(brainstorm|add|create|new|another|more|expand|generate)\b/i,
]
const ACTION_TYPES = new Set([
  'create_node',
  'update_node',
  'update_node_color',
  'create_image',
  'create_connection',
  'create_group',
  'create_text',
  'move_node',
  'highlight_node',
])

const ACTION_RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    thought: { type: 'string' },
    actions: {
      type: 'array',
      items: {
        anyOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              type: { type: 'string', enum: ['create_node'] },
              id: { type: 'string' },
              content: { type: 'string' },
              x: { type: 'number' },
              y: { type: 'number' },
              color: { type: 'string', enum: ['yellow', 'blue', 'green', 'red', 'purple'] },
              size: { type: 'string', enum: ['small', 'medium', 'large'] },
            },
            required: ['type', 'id', 'content', 'x', 'y', 'color', 'size'],
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              type: { type: 'string', enum: ['update_node'] },
              id: { type: 'string' },
              content: { type: 'string' },
              color: { type: 'string', enum: ['yellow', 'blue', 'green', 'red', 'purple'] },
              size: { type: 'string', enum: ['small', 'medium', 'large'] },
              x: { type: 'number' },
              y: { type: 'number' },
            },
            required: ['type', 'id', 'content', 'color', 'size', 'x', 'y'],
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              type: { type: 'string', enum: ['update_node_color'] },
              id: { type: 'string' },
              color: { type: 'string', enum: ['yellow', 'blue', 'green', 'red', 'purple'] },
            },
            required: ['type', 'id', 'color'],
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              type: { type: 'string', enum: ['create_image'] },
              id: { type: 'string' },
              prompt: { type: 'string' },
              x: { type: 'number' },
              y: { type: 'number' },
              width: { type: 'number' },
              height: { type: 'number' },
            },
            required: ['type', 'id', 'prompt', 'x', 'y', 'width', 'height'],
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              type: { type: 'string', enum: ['create_connection'] },
              from_id: { type: 'string' },
              to_id: { type: 'string' },
              label: { type: 'string' },
            },
            required: ['type', 'from_id', 'to_id', 'label'],
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              type: { type: 'string', enum: ['create_group'] },
              node_ids: {
                type: 'array',
                items: { type: 'string' },
                minItems: 2,
              },
              label: { type: 'string' },
            },
            required: ['type', 'node_ids', 'label'],
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              type: { type: 'string', enum: ['create_text'] },
              content: { type: 'string' },
              x: { type: 'number' },
              y: { type: 'number' },
              fontSize: { type: 'number' },
            },
            required: ['type', 'content', 'x', 'y', 'fontSize'],
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              type: { type: 'string', enum: ['move_node'] },
              id: { type: 'string' },
              x: { type: 'number' },
              y: { type: 'number' },
            },
            required: ['type', 'id', 'x', 'y'],
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              type: { type: 'string', enum: ['highlight_node'] },
              id: { type: 'string' },
              reason: { type: 'string' },
            },
            required: ['type', 'id', 'reason'],
          },
        ],
      },
    },
  },
  required: ['thought', 'actions'],
}

const FALLBACK_CANVAS_STATE = [
  {
    id: 'note:students-core',
    type: 'note',
    x: 320,
    y: 220,
    content: 'Social app for students',
    color: 'yellow',
    width: 200,
    height: 200,
  },
  {
    id: 'note:privacy',
    type: 'note',
    x: 640,
    y: 220,
    content: 'What about privacy?',
    color: 'red',
    width: 200,
    height: 200,
  },
]

function sanitizeHistory(history) {
  if (!Array.isArray(history)) return []

  return history
    .slice(-MAX_HISTORY_TURNS)
    .filter((entry) => entry && typeof entry.role === 'string' && typeof entry.content === 'string')
    .map((entry) => ({
      role: entry.role === 'assistant' ? 'assistant' : 'user',
      content: entry.content.trim(),
    }))
    .filter((entry) => entry.content.length > 0)
}

function stripJsonFences(text) {
  const trimmed = text.trim()

  if (trimmed.startsWith('```')) {
    return trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
  }

  return trimmed
}

function coerceString(value, fallback = '') {
  return typeof value === 'string' ? value : fallback
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`)
  }
}

function validateAction(action, index) {
  assertObject(action, `Action ${index}`)

  if (!ACTION_TYPES.has(action.type)) {
    throw new Error(`Action ${index} has invalid or missing type.`)
  }

  switch (action.type) {
    case 'create_node':
      if (!coerceString(action.id) || !coerceString(action.content)) {
        throw new Error(`Action ${index} create_node requires id and content.`)
      }
      if (!isFiniteNumber(action.x) || !isFiniteNumber(action.y)) {
        throw new Error(`Action ${index} create_node requires numeric x and y.`)
      }
      return {
        type: 'create_node',
        id: action.id,
        content: action.content,
        x: Math.round(action.x),
        y: Math.round(action.y),
        color: ['yellow', 'blue', 'green', 'red', 'purple'].includes(action.color)
          ? action.color
          : 'yellow',
        size: ['small', 'medium', 'large'].includes(action.size) ? action.size : 'medium',
      }

    case 'create_connection':
      if (!coerceString(action.from_id) || !coerceString(action.to_id)) {
        throw new Error(`Action ${index} create_connection requires from_id and to_id.`)
      }
      return {
        type: 'create_connection',
        from_id: action.from_id,
        to_id: action.to_id,
        label: coerceString(action.label),
      }

    case 'create_image':
      if (!coerceString(action.id) || !coerceString(action.prompt)) {
        throw new Error(`Action ${index} create_image requires id and prompt.`)
      }
      if (
        !isFiniteNumber(action.x) ||
        !isFiniteNumber(action.y) ||
        !isFiniteNumber(action.width) ||
        !isFiniteNumber(action.height)
      ) {
        throw new Error(`Action ${index} create_image requires numeric x, y, width, and height.`)
      }
      return {
        type: 'create_image',
        id: action.id,
        prompt: action.prompt,
        x: Math.round(action.x),
        y: Math.round(action.y),
        width: Math.max(128, Math.round(action.width)),
        height: Math.max(128, Math.round(action.height)),
      }

    case 'update_node':
      if (!coerceString(action.id)) {
        throw new Error(`Action ${index} update_node requires id.`)
      }
      if (!coerceString(action.content)) {
        throw new Error(`Action ${index} update_node requires content.`)
      }
      if (!isFiniteNumber(action.x) || !isFiniteNumber(action.y)) {
        throw new Error(`Action ${index} update_node requires numeric x and y.`)
      }
      return {
        type: 'update_node',
        id: action.id,
        content: action.content,
        x: Math.round(action.x),
        y: Math.round(action.y),
        color: ['yellow', 'blue', 'green', 'red', 'purple'].includes(action.color)
          ? action.color
          : 'yellow',
        size: ['small', 'medium', 'large'].includes(action.size) ? action.size : 'medium',
      }

    case 'update_node_color':
      if (!coerceString(action.id)) {
        throw new Error(`Action ${index} update_node_color requires id.`)
      }
      return {
        type: 'update_node_color',
        id: action.id,
        color: ['yellow', 'blue', 'green', 'red', 'purple'].includes(action.color)
          ? action.color
          : 'yellow',
      }

    case 'create_group':
      if (!Array.isArray(action.node_ids) || action.node_ids.length < 2) {
        throw new Error(`Action ${index} create_group requires at least two node_ids.`)
      }
      return {
        type: 'create_group',
        node_ids: action.node_ids.filter((id) => typeof id === 'string'),
        label: coerceString(action.label),
      }

    case 'create_text':
      if (!coerceString(action.content)) {
        throw new Error(`Action ${index} create_text requires content.`)
      }
      if (!isFiniteNumber(action.x) || !isFiniteNumber(action.y)) {
        throw new Error(`Action ${index} create_text requires numeric x and y.`)
      }
      return {
        type: 'create_text',
        content: action.content,
        x: Math.round(action.x),
        y: Math.round(action.y),
        fontSize: isFiniteNumber(action.fontSize) ? action.fontSize : 24,
      }

    case 'move_node':
      if (!coerceString(action.id)) {
        throw new Error(`Action ${index} move_node requires id.`)
      }
      if (!isFiniteNumber(action.x) || !isFiniteNumber(action.y)) {
        throw new Error(`Action ${index} move_node requires numeric x and y.`)
      }
      return {
        type: 'move_node',
        id: action.id,
        x: Math.round(action.x),
        y: Math.round(action.y),
      }

    case 'highlight_node':
      if (!coerceString(action.id)) {
        throw new Error(`Action ${index} highlight_node requires id.`)
      }
      return {
        type: 'highlight_node',
        id: action.id,
        reason: coerceString(action.reason),
      }
  }
}

function validateActionsAgainstCanvas(actions, canvasState) {
  const options =
    arguments.length > 2 && arguments[2] && typeof arguments[2] === 'object' ? arguments[2] : {}
  const allowedTargetIds = new Set(
    Array.isArray(options.allowedTargetIds) ? options.allowedTargetIds.filter((id) => typeof id === 'string') : []
  )
  const knownIds = new Set(
    (Array.isArray(canvasState) ? canvasState : [])
      .map((shape) => (shape && typeof shape.id === 'string' ? shape.id : null))
      .filter(Boolean)
  )

  const validActions = []

  for (let index = 0; index < actions.length; index += 1) {
    const action = actions[index]

    try {
      const validated = validateAction(action, index)

      if (options.disallowCreateNode && validated.type === 'create_node') {
        throw new Error(`Action ${index} create_node is not allowed for an edit-existing request.`)
      }

      if (validated.type === 'create_node') {
        knownIds.add(`shape:${validated.id}`)
        validActions.push(validated)
        continue
      }

      if (validated.type === 'create_text' || validated.type === 'create_image') {
        validActions.push(validated)
        continue
      }

      if (validated.type === 'update_node') {
        if (!knownIds.has(validated.id) && !knownIds.has(`shape:${validated.id}`)) {
          throw new Error(`Action ${index} update_node references a missing existing shape id.`)
        }
        if (
          allowedTargetIds.size > 0 &&
          !allowedTargetIds.has(validated.id) &&
          !allowedTargetIds.has(`shape:${validated.id}`)
        ) {
          throw new Error(`Action ${index} update_node must target one of the selected shapes.`)
        }

        validActions.push(validated)
        continue
      }

      if (validated.type === 'update_node_color') {
        if (!knownIds.has(validated.id) && !knownIds.has(`shape:${validated.id}`)) {
          throw new Error(`Action ${index} update_node_color references a missing existing shape id.`)
        }
        if (
          allowedTargetIds.size > 0 &&
          !allowedTargetIds.has(validated.id) &&
          !allowedTargetIds.has(`shape:${validated.id}`)
        ) {
          throw new Error(`Action ${index} update_node_color must target one of the selected shapes.`)
        }

        validActions.push(validated)
        continue
      }

      if (validated.type === 'move_node' || validated.type === 'highlight_node') {
        if (!knownIds.has(validated.id) && !knownIds.has(`shape:${validated.id}`)) {
          throw new Error(`Action ${index} references a missing existing shape id.`)
        }
        if (
          allowedTargetIds.size > 0 &&
          !allowedTargetIds.has(validated.id) &&
          !allowedTargetIds.has(`shape:${validated.id}`)
        ) {
          throw new Error(`Action ${index} must target one of the selected shapes.`)
        }

        validActions.push(validated)
        continue
      }

      if (validated.type === 'create_connection') {
        const fromExists =
          knownIds.has(validated.from_id) || knownIds.has(`shape:${validated.from_id}`)
        const toExists = knownIds.has(validated.to_id) || knownIds.has(`shape:${validated.to_id}`)

        if (!fromExists || !toExists) {
          throw new Error(`Action ${index} create_connection references missing shapes.`)
        }

        validActions.push(validated)
        continue
      }

      if (validated.type === 'create_group') {
        const matchedNodeIds = validated.node_ids.filter(
          (id) => knownIds.has(id) || knownIds.has(`shape:${id}`)
        )

        if (matchedNodeIds.length < 2) {
          throw new Error(`Action ${index} create_group references fewer than 2 real shapes.`)
        }
        if (
          allowedTargetIds.size > 0 &&
          matchedNodeIds.some(
            (id) => !allowedTargetIds.has(id) && !allowedTargetIds.has(`shape:${id}`)
          )
        ) {
          throw new Error(`Action ${index} create_group must only include selected shapes.`)
        }

        validActions.push({
          ...validated,
          node_ids: matchedNodeIds,
        })
      }
    } catch (error) {
      if (options.failFast) {
        throw error
      }

      console.warn('Dropping invalid Groq action after canvas validation:', {
        index,
        action,
        reason: error.message,
      })
    }
  }

  return validActions
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function getHiggsfieldHeaders() {
  if (!process.env.HIGGSFIELD_API_KEY || !process.env.HIGGSFIELD_API_SECRET) {
    throw new Error('HIGGSFIELD_API_KEY and HIGGSFIELD_API_SECRET are required for image generation.')
  }

  return {
    Authorization: `Key ${process.env.HIGGSFIELD_API_KEY}:${process.env.HIGGSFIELD_API_SECRET}`,
    'Content-Type': 'application/json',
  }
}

function getAspectRatio(width, height) {
  const ratio = width / height

  if (ratio > 1.45) return '16:9'
  if (ratio < 0.8) return '9:16'
  return '1:1'
}

async function generateHiggsfieldImage(action) {
  const submitResponse = await fetch(`${HIGGSFIELD_BASE_URL}/${HIGGSFIELD_MODEL_ID}`, {
    method: 'POST',
    headers: getHiggsfieldHeaders(),
    body: JSON.stringify({
      prompt: action.prompt,
      aspect_ratio: getAspectRatio(action.width, action.height),
      resolution: '2K',
      camera_fixed: false,
    }),
  })

  if (!submitResponse.ok) {
    const body = await submitResponse.text()
    throw new Error(`Higgsfield submit failed: ${body || submitResponse.statusText}`)
  }

  const queued = await submitResponse.json()
  const statusUrl =
    typeof queued.status_url === 'string'
      ? queued.status_url
      : `${HIGGSFIELD_BASE_URL}/requests/${queued.request_id}/status`

  for (let attempt = 0; attempt < HIGGSFIELD_MAX_POLL_ATTEMPTS; attempt += 1) {
    await wait(HIGGSFIELD_POLL_INTERVAL_MS)

    const statusResponse = await fetch(statusUrl, {
      headers: getHiggsfieldHeaders(),
    })

    if (!statusResponse.ok) {
      const body = await statusResponse.text()
      throw new Error(`Higgsfield status failed: ${body || statusResponse.statusText}`)
    }

    const payload = await statusResponse.json()

    if (payload.status === 'completed') {
      const imageUrl =
        Array.isArray(payload.images) && payload.images[0] && typeof payload.images[0].url === 'string'
          ? payload.images[0].url
          : null

      if (!imageUrl) {
        throw new Error('Higgsfield completed without an image URL.')
      }

      return {
        ...action,
        imageUrl,
      }
    }

    if (payload.status === 'failed' || payload.status === 'nsfw') {
      throw new Error(
        `Higgsfield image generation ended with status "${payload.status}": ${JSON.stringify(payload)}`
      )
    }
  }

  throw new Error('Higgsfield image generation timed out.')
}

async function resolveGeneratedMedia(actions) {
  const resolvedActions = []

  for (const action of actions) {
    if (action.type === 'create_image') {
      resolvedActions.push(await generateHiggsfieldImage(action))
      continue
    }

    resolvedActions.push(action)
  }

  return resolvedActions
}

function parseAgentResponse(rawText) {
  const parsed = JSON.parse(stripJsonFences(rawText))

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Groq response was not a JSON object.')
  }

  if (typeof parsed.thought !== 'string') {
    throw new Error('Groq response is missing a string "thought" field.')
  }

  if (!Array.isArray(parsed.actions)) {
    throw new Error('Groq response is missing an "actions" array.')
  }

  const validActions = []

  for (let index = 0; index < parsed.actions.length; index += 1) {
    try {
      validActions.push(validateAction(parsed.actions[index], index))
    } catch (error) {
      console.warn('Dropping invalid Groq action:', {
        index,
        action: parsed.actions[index],
        reason: error.message,
      })
    }
  }

  if (parsed.actions.length > 0 && validActions.length === 0) {
    throw new Error('Groq returned actions, but none were valid.')
  }

  return {
    thought: parsed.thought,
    actions: validActions,
  }
}

function inferRequestMode(userMessage, selectedShapeIds) {
  const message = typeof userMessage === 'string' ? userMessage.trim() : ''
  const hasSelectedTargets = Array.isArray(selectedShapeIds) && selectedShapeIds.length > 0

  if (!message) return 'general'

  const hasEditIntent = EDIT_INTENT_PATTERNS.some((pattern) => pattern.test(message))
  const hasCreationIntent = CREATION_INTENT_PATTERNS.some((pattern) => pattern.test(message))

  if (hasSelectedTargets && !hasCreationIntent) {
    return 'edit_selection'
  }

  if (hasEditIntent && !hasCreationIntent) {
    return 'edit_existing'
  }

  return 'general'
}

function buildUserPrompt({ userMessage, canvasState, requestMode, selectedShapeIds, selectedShapes }) {
  const promptLines = [
    'User request:',
    userMessage,
    '',
    'Canvas state for this turn:',
    JSON.stringify(canvasState, null, 2),
    '',
    'Return only a JSON object with "thought" and "actions".',
    'Every action object must include a valid "type" and all required fields.',
    'Do not return empty objects in the actions array.',
    'Use update_node to modify an existing sticky note. Do not create a replacement node when the user wants to recolor, rewrite, resize, or reposition an existing note.',
    'For color-only changes, use update_node_color so the existing note content stays unchanged.',
    'If the user asks to paste or generate an image on the canvas, use create_image with a strong visual prompt plus x, y, width, and height.',
    'For create_connection, always include a "label" string. Use "" when there is no label.',
    'For update_node, update_node_color, move_node, highlight_node, create_connection, and create_group, use only exact ids that already exist in CURRENT CANVAS STATE.',
    'Do not invent alternate ids for existing shapes.',
    'If grouping or connecting, prefer exact ids copied from CURRENT CANVAS STATE.',
  ]

  if (Array.isArray(selectedShapeIds) && selectedShapeIds.length > 0) {
    promptLines.push(
      '',
      'Selected shape ids for this turn:',
      JSON.stringify(selectedShapeIds, null, 2),
      '',
      'Selected shape objects for this turn:',
      JSON.stringify(selectedShapes, null, 2)
    )
  }

  if (requestMode === 'edit_existing' || requestMode === 'edit_selection') {
    promptLines.push(
      'This request is asking you to edit existing objects, not add new ones.',
      'Do not use create_node for this request.',
      'If the user only wants a color change, use update_node_color and do not change the note text.',
      'If you need to recolor, rewrite, resize, or reposition an existing note, use update_node with the exact existing id.',
      'If you need to move an existing shape without changing its content or color, use move_node.'
    )
  }

  if (requestMode === 'edit_selection') {
    promptLines.push(
      'You must treat the selected shapes as the intended targets.',
      'Do not update, move, highlight, or group shapes outside the selected shape ids unless the user explicitly asks to connect them.'
    )
  }

  promptLines.push(
    'Example:',
    JSON.stringify(
      {
        thought: 'Placing three starter ideas and a question nearby.',
        actions: [
          {
            type: 'create_node',
            id: 'idea-target-audience',
            content: 'Student clubs and campus groups',
            x: 320,
            y: 260,
            color: 'yellow',
            size: 'medium',
          },
          {
            type: 'create_text',
            content: 'Student Social App',
            x: 260,
            y: 120,
            fontSize: 28,
          },
          {
            type: 'update_node',
            id: 'shape:existing-note',
            content: 'Clarified existing note',
            x: 420,
            y: 260,
            color: 'green',
            size: 'medium',
          },
          {
            type: 'create_image',
            id: 'visual-campus-app-mockup',
            prompt: 'A polished mobile app mockup for a student social app, bright campus aesthetic, clean UI',
            x: 860,
            y: 220,
            width: 512,
            height: 512,
          },
        ],
      },
      null,
      2
    )
  )

  return promptLines.join('\n')
}

async function createGroqResponse({ client, systemPrompt, messages }) {
  return client.chat.completions.create({
    model: MODEL,
    max_tokens: MAX_OUTPUT_TOKENS,
    messages: [
      {
        role: 'system',
        content: systemPrompt,
      },
      ...messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
    ],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'canvas_agent_actions',
        schema: ACTION_RESPONSE_SCHEMA,
        strict: true,
      },
    },
  })
}

function normalizeSelectedShapeIds(selectedShapeIds, canvasState) {
  if (!Array.isArray(selectedShapeIds)) return []

  const knownIds = new Set(
    (Array.isArray(canvasState) ? canvasState : [])
      .map((shape) => (shape && typeof shape.id === 'string' ? shape.id : null))
      .filter(Boolean)
  )

  return selectedShapeIds.filter(
    (id) => typeof id === 'string' && (knownIds.has(id) || knownIds.has(`shape:${id}`))
  )
}

function getSelectedShapes(canvasState, selectedShapeIds) {
  const selectedIdSet = new Set(selectedShapeIds)

  return (Array.isArray(canvasState) ? canvasState : []).filter(
    (shape) =>
      shape &&
      typeof shape.id === 'string' &&
      (selectedIdSet.has(shape.id) || selectedIdSet.has(shape.id.replace(/^shape:/, '')))
  )
}

export async function runAgentTurn({ userMessage, canvasState, conversationHistory, selectedShapeIds }) {
  if (!process.env.GROQ_API_KEY) {
    throw new Error('GROQ_API_KEY is not configured.')
  }

  if (typeof userMessage !== 'string' || userMessage.trim().length === 0) {
    throw new Error('userMessage is required.')
  }

  const effectiveCanvasState =
    Array.isArray(canvasState) && canvasState.length > 0 ? canvasState : FALLBACK_CANVAS_STATE
  const normalizedSelectedShapeIds = normalizeSelectedShapeIds(selectedShapeIds, effectiveCanvasState)
  const selectedShapes = getSelectedShapes(effectiveCanvasState, normalizedSelectedShapeIds)

  const client = new OpenAI({
    apiKey: process.env.GROQ_API_KEY,
    baseURL: 'https://api.groq.com/openai/v1',
  })

  const systemPrompt = buildSystemPrompt(effectiveCanvasState, selectedShapes)
  const historyMessages = sanitizeHistory(conversationHistory)
  const requestMode = inferRequestMode(userMessage, normalizedSelectedShapeIds)
  const baseMessages = [
    ...historyMessages,
    {
      role: 'user',
      content: buildUserPrompt({
        userMessage: userMessage.trim(),
        canvasState: effectiveCanvasState,
        requestMode,
        selectedShapeIds: normalizedSelectedShapeIds,
        selectedShapes,
      }),
    },
  ]

  let rawText = ''

  try {
    const response = await createGroqResponse({
      client,
      systemPrompt,
      messages: baseMessages,
    })
    rawText = response.choices?.[0]?.message?.content?.trim?.() || ''
    const parsed = parseAgentResponse(rawText)
    const validActions = validateActionsAgainstCanvas(parsed.actions, effectiveCanvasState, {
      disallowCreateNode: requestMode === 'edit_existing' || requestMode === 'edit_selection',
      failFast: requestMode === 'edit_existing' || requestMode === 'edit_selection',
      allowedTargetIds: requestMode === 'edit_selection' ? normalizedSelectedShapeIds : [],
    })

    if (parsed.actions.length > 0 && validActions.length === 0) {
      throw new Error('Groq returned actions, but none matched the current canvas ids.')
    }

    return {
      thought: parsed.thought,
      actions: await resolveGeneratedMedia(validActions),
    }
  } catch (error) {
    const retryInstruction = [
      'Your previous response could not be parsed.',
      'Respond again with only valid JSON matching the required action protocol.',
      'Do not use markdown fences.',
      'Start with { and end with }.',
    ].join(' ')

    const retryResponse = await createGroqResponse({
      client,
      systemPrompt: `${systemPrompt}\n\n${retryInstruction}`,
      messages: [
        ...baseMessages,
        {
          role: 'assistant',
          content: rawText || `Invalid response: ${error.message}`,
        },
        {
          role: 'user',
          content: retryInstruction,
        },
      ],
    })

    const parsed = parseAgentResponse(retryResponse.choices?.[0]?.message?.content?.trim?.() || '')
    const validActions = validateActionsAgainstCanvas(parsed.actions, effectiveCanvasState, {
      disallowCreateNode: requestMode === 'edit_existing' || requestMode === 'edit_selection',
      failFast: requestMode === 'edit_existing' || requestMode === 'edit_selection',
      allowedTargetIds: requestMode === 'edit_selection' ? normalizedSelectedShapeIds : [],
    })

    if (parsed.actions.length > 0 && validActions.length === 0) {
      throw new Error('Groq returned actions, but none matched the current canvas ids.')
    }

    return {
      thought: parsed.thought,
      actions: await resolveGeneratedMedia(validActions),
    }
  }
}
