import { parentPort, workerData } from 'node:worker_threads'
import { SqliteMetadataIndex, indexMethods } from './sqlite-index'

const port = parentPort!
// An open failure (e.g. a newer schema) throws here and reaches the client as the worker error.
// A schema update says when it starts and how long it took, so a slow one can be explained.
let updating: number | undefined
const index = new SqliteMetadataIndex((workerData as { path: string }).path, {
  onMigrate: () => {
    updating = performance.now()
    port.postMessage({ updating: true })
  },
})
if (updating !== undefined) port.postMessage({ updating: false, ms: performance.now() - updating })
const methods = new Set<string>(indexMethods)

port.on('message', (request: { id: number; method: string; args: unknown[] }) => {
  try {
    if (!methods.has(request.method)) throw new Error('Unknown mail index method.')
    const method = index[request.method as keyof SqliteMetadataIndex] as (
      ...args: unknown[]
    ) => unknown
    port.postMessage({ id: request.id, result: method.apply(index, request.args) })
  } catch (error) {
    port.postMessage({
      id: request.id,
      error: { message: error instanceof Error ? error.message : String(error) },
    })
  }
})
