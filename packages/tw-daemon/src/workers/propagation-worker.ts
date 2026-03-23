/**
 * Worker thread entry point for propagation calculation.
 * Receives PropagateInput + entity snapshot via workerData.
 * Runs Propagator (pure), posts PropagateResult back via postMessage.
 * Keeps the main event loop free from CPU-bound DAG traversal.
 */
import { workerData, parentPort } from 'node:worker_threads'
import { Propagator } from '../core/propagator/propagator.js'
import type { Entity, PropagateInput, PropagateResult } from '@traceweaver/types'

interface WorkerInput {
  entities: Entity[]
  propagate: PropagateInput
}

const { entities, propagate } = workerData as WorkerInput
const prop = new Propagator(entities)

const result: PropagateResult = propagate.direction === 'bubble_up'
  ? prop.bubbleUp(propagate.source_id, propagate.source_state, propagate.previous_state)
  : prop.cascadeDown(propagate.source_id, propagate.source_state)

parentPort?.postMessage(result)
