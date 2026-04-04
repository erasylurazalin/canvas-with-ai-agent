import { AssetRecordType, createBindingId, createShapeId, toRichText } from 'tldraw'

const ACTION_DELAY_MS = 300

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function mapNoteSize(size) {
  if (size === 'small') return 's'
  if (size === 'large') return 'l'
  return 'm'
}

function mapNoteColor(color) {
  const colorMap = {
    yellow: 'yellow',
    blue: 'blue',
    green: 'green',
    red: 'red',
    purple: 'violet',
  }

  return colorMap[color] || 'yellow'
}

function extractShapeContent(shape) {
  const rawContent = shape.props?.text || shape.props?.richText || ''

  if (typeof rawContent === 'string') {
    return rawContent
  }

  if (rawContent && typeof rawContent === 'object') {
    const fragments = []

    const visitNode = (node) => {
      if (!node || typeof node !== 'object') return

      if (typeof node.text === 'string') {
        fragments.push(node.text)
      }

      if (Array.isArray(node.content)) {
        for (const child of node.content) {
          visitNode(child)
        }

        if (node.type === 'paragraph') {
          fragments.push('\n')
        }
      }
    }

    visitNode(rawContent)

    const plainText = fragments.join('').replace(/\n{2,}/g, '\n').trim()
    if (plainText) return plainText
  }

  try {
    return JSON.stringify(rawContent)
  } catch {
    return ''
  }
}

export function serializeCanvas(editor) {
  if (!editor) return []

  const shapes = editor.getCurrentPageShapes()

  return shapes.map((shape) => ({
    id: shape.id,
    type: shape.type,
    x: Math.round(shape.x),
    y: Math.round(shape.y),
    content: extractShapeContent(shape),
    color: shape.props?.color || null,
    width: Math.round(shape.props?.w || 0),
    height: Math.round(shape.props?.h || 0),
  }))
}

function upsertNote(editor, action) {
  const shapeId = getCanvasShapeId(action.id)
  const existingShape = editor.getShape(shapeId)
  const partial = {
    id: shapeId,
    type: 'note',
    x: action.x,
    y: action.y,
    props: {
      color: mapNoteColor(action.color),
      size: mapNoteSize(action.size),
      richText: toRichText(action.content || ''),
    },
    meta: {
      agentId: action.id,
    },
  }

  if (existingShape) {
    editor.updateShape(partial)
  } else {
    editor.createShape(partial)
  }
}

function getCanvasShapeId(id) {
  if (typeof id === 'string' && id.startsWith('shape:')) {
    return id
  }

  return createShapeId(id)
}

function getShapeBounds(editor, shapeId) {
  return editor.getShapePageBounds(shapeId)
}

function upsertText(editor, action) {
  const textId = getCanvasShapeId(`text-${action.content}-${action.x}-${action.y}`)
  const existingShape = editor.getShape(textId)
  const partial = {
    id: textId,
    type: 'text',
    x: action.x,
    y: action.y,
    props: {
      richText: toRichText(action.content || ''),
      size: 'm',
      scale: Math.max(0.5, Math.min((action.fontSize || 24) / 24, 2.5)),
    },
  }

  if (existingShape) {
    editor.updateShape(partial)
  } else {
    editor.createShape(partial)
  }
}

function createImage(editor, action) {
  if (typeof action.imageUrl !== 'string' || action.imageUrl.length === 0) {
    console.warn('Skipping create_image: missing generated image URL', { action })
    return
  }

  const assetId = AssetRecordType.createId(`agent-image-${action.id}`)
  const shapeId = getCanvasShapeId(`image-${action.id}`)
  const existingShape = editor.getShape(shapeId)

  editor.createAssets([
    {
      id: assetId,
      type: 'image',
      typeName: 'asset',
      props: {
        name: action.prompt || 'AI image',
        src: action.imageUrl,
        w: action.width,
        h: action.height,
        mimeType: 'image/jpeg',
        isAnimated: false,
      },
      meta: {
        agentPrompt: action.prompt || '',
      },
    },
  ])

  const partial = {
    id: shapeId,
    type: 'image',
    x: action.x,
    y: action.y,
    props: {
      assetId,
      w: action.width,
      h: action.height,
      playing: false,
      url: '',
    },
    meta: {
      agentId: action.id,
      agentPrompt: action.prompt || '',
    },
  }

  if (existingShape) {
    editor.updateShape(partial)
  } else {
    editor.createShape(partial)
  }
}

function moveNode(editor, action) {
  const shapeId = getCanvasShapeId(action.id)
  const shape = editor.getShape(shapeId)

  if (!shape) {
    console.warn('Skipping move_node: target shape not found', {
      action,
      shapeId,
      availableShapeIds: editor.getCurrentPageShapes().map((candidate) => candidate.id),
    })
    return
  }

  editor.updateShape({
    ...shape,
    x: action.x,
    y: action.y,
  })
}

function createConnection(editor, action) {
  const fromShapeId = getCanvasShapeId(action.from_id)
  const toShapeId = getCanvasShapeId(action.to_id)
  const fromShape = editor.getShape(fromShapeId)
  const toShape = editor.getShape(toShapeId)

  if (!fromShape || !toShape) {
    console.warn('Skipping create_connection: referenced shapes not found', {
      action,
      fromShapeId,
      toShapeId,
      availableShapeIds: editor.getCurrentPageShapes().map((shape) => shape.id),
    })
    return
  }

  const fromBounds = getShapeBounds(editor, fromShapeId)
  const toBounds = getShapeBounds(editor, toShapeId)

  if (!fromBounds || !toBounds) return

  const arrowId = getCanvasShapeId(`arrow-${action.from_id}-${action.to_id}`)
  const existingArrow = editor.getShape(arrowId)

  if (!existingArrow) {
    editor.createShape({
      id: arrowId,
      type: 'arrow',
      x: fromBounds.center.x,
      y: fromBounds.center.y,
      props: {
        text: action.label || '',
      },
    })
  } else {
    editor.updateShape({
      id: arrowId,
      type: 'arrow',
      x: fromBounds.center.x,
      y: fromBounds.center.y,
      props: {
        text: action.label || '',
      },
    })
  }

  editor.createBindings([
    {
      id: createBindingId(`binding-start-${action.from_id}-${action.to_id}`),
      type: 'arrow',
      fromId: arrowId,
      toId: fromShapeId,
      props: {
        terminal: 'start',
        normalizedAnchor: { x: 0.5, y: 0.5 },
        isExact: false,
        isPrecise: false,
      },
    },
    {
      id: createBindingId(`binding-end-${action.from_id}-${action.to_id}`),
      type: 'arrow',
      fromId: arrowId,
      toId: toShapeId,
      props: {
        terminal: 'end',
        normalizedAnchor: { x: 0.5, y: 0.5 },
        isExact: false,
        isPrecise: false,
      },
    },
  ])
}

function createGroup(editor, action) {
  const requestedShapeIds = action.node_ids.map(getCanvasShapeId)
  const shapeIds = requestedShapeIds.filter((id) => editor.getShape(id))

  if (shapeIds.length < 2) {
    console.warn('Skipping create_group: fewer than 2 matching shapes found', {
      action,
      requestedShapeIds,
      matchedShapeIds: shapeIds,
      availableShapeIds: editor.getCurrentPageShapes().map((shape) => shape.id),
    })
    return
  }

  editor.groupShapes(shapeIds, {
    groupId: getCanvasShapeId(`group-${action.node_ids.join('-')}`),
    select: false,
  })

  if (action.label) {
    const bounds = shapeIds
      .map((id) => getShapeBounds(editor, id))
      .filter(Boolean)

    if (bounds.length > 0) {
      const minX = Math.min(...bounds.map((box) => box.x))
      const minY = Math.min(...bounds.map((box) => box.y))
      upsertText(editor, {
        type: 'create_text',
        content: action.label,
        x: minX,
        y: minY - 56,
        fontSize: 24,
      })
    }
  }
}

async function highlightNode(editor, action) {
  const shapeId = getCanvasShapeId(action.id)
  const shape = editor.getShape(shapeId)

  if (!shape || shape.type !== 'note') {
    console.warn('Skipping highlight_node: target note not found', {
      action,
      shapeId,
    })
    return
  }

  const originalColor = shape.props.color

  editor.updateShape({
    ...shape,
    props: {
      ...shape.props,
      color: 'red',
    },
    meta: {
      ...shape.meta,
      highlightReason: action.reason || '',
    },
  })

  await wait(2000)

  const updatedShape = editor.getShape(shapeId)
  if (!updatedShape || updatedShape.type !== 'note') return

  editor.updateShape({
    ...updatedShape,
    props: {
      ...updatedShape.props,
      color: originalColor,
    },
  })
}

function updateNodeColor(editor, action) {
  const shapeId = getCanvasShapeId(action.id)
  const shape = editor.getShape(shapeId)

  if (!shape || shape.type !== 'note') {
    console.warn('Skipping update_node_color: target note not found', {
      action,
      shapeId,
    })
    return
  }

  editor.updateShape({
    ...shape,
    props: {
      ...shape.props,
      color: mapNoteColor(action.color),
    },
  })
}

async function runAction(editor, action) {
  console.log('Executing agent action:', action)

  if (action.type === 'create_node') {
    upsertNote(editor, action)
    return
  }

  if (action.type === 'update_node') {
    upsertNote(editor, action)
    return
  }

  if (action.type === 'update_node_color') {
    updateNodeColor(editor, action)
    return
  }

  if (action.type === 'create_text') {
    upsertText(editor, action)
    return
  }

  if (action.type === 'create_image') {
    createImage(editor, action)
    return
  }

  if (action.type === 'move_node') {
    moveNode(editor, action)
    return
  }

  if (action.type === 'create_connection') {
    createConnection(editor, action)
    return
  }

  if (action.type === 'create_group') {
    createGroup(editor, action)
    return
  }

  if (action.type === 'highlight_node') {
    await highlightNode(editor, action)
    return
  }

  console.warn('Unsupported agent action:', action)
}

export async function executeAgentActions(editor, actions, _options = {}) {
  if (!editor || !Array.isArray(actions) || actions.length === 0) {
    return
  }

  for (const action of actions) {
    await runAction(editor, action)
    await wait(ACTION_DELAY_MS)
  }
}
