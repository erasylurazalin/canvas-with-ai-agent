import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitForSync(providerA, providerB) {
  await new Promise((resolve, reject) => {
    let syncedA = false
    let syncedB = false

    const timeout = setTimeout(() => reject(new Error('sync timeout')), 10000)
    const check = () => {
      if (syncedA && syncedB) {
        clearTimeout(timeout)
        resolve()
      }
    }

    providerA.on('sync', (isSynced) => {
      if (isSynced) {
        syncedA = true
        check()
      }
    })

    providerB.on('sync', (isSynced) => {
      if (isSynced) {
        syncedB = true
        check()
      }
    })
  })
}

async function main() {
  const room = 'brainstorm-step3-check'
  const docA = new Y.Doc()
  const docB = new Y.Doc()
  const providerA = new WebsocketProvider('ws://localhost:1234', room, docA, { disableBc: true })
  const providerB = new WebsocketProvider('ws://localhost:1234', room, docB, { disableBc: true })

  try {
    await waitForSync(providerA, providerB)

    const mapA = docA.getMap('tldraw-document')
    const mapB = docB.getMap('tldraw-document')

    mapA.set(
      'document',
      JSON.stringify({
        check: 'shared-state',
        updatedAt: Date.now(),
      })
    )

    await wait(1200)

    const mirrored = mapB.get('document')

    if (!mirrored) {
      throw new Error('no mirrored document received')
    }

    const parsed = JSON.parse(mirrored)

    if (parsed.check !== 'shared-state') {
      throw new Error('unexpected mirrored payload')
    }

    console.log(JSON.stringify({ ok: true, mirrored: parsed.check }))
  } finally {
    providerA.destroy()
    providerB.destroy()
    docA.destroy()
    docB.destroy()
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
