/**
 * config/loader.ts
 *
 * Reads `.traceweaver/config.yaml` (or the path in TW_CONFIG env var).
 * All fields are optional — sensible defaults are applied when absent.
 *
 * Supported fields:
 *
 * store_dir:   string          # default: .traceweaver
 * socket_path: string          # default: <store_dir>/tw.sock
 *
 * watch:
 *   dirs:      string[]        # project dirs to watch, default: ["."] (project root)
 *   ignored:   string[]        # extra glob patterns to ignore
 *
 * notify:
 *   rules:
 *     - event: entity.state_changed
 *       state: rejected | completed | …
 *   webhook:
 *     url:   string
 *     token: string
 *
 * otel:
 *   project_id: string
 *   exporter:   console | otlp  # default: console
 *
 * http:
 *   port:          number
 *   inbound_token: string
 *
 * harness:
 *   dir: string                # default: <store_dir>/harness
 */

import { readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import yaml from 'js-yaml'

// ── Types ──────────────────────────────────────────────────────────────────

export interface NotifyRule {
  event: string
  state?: string
}

export interface NotifyConfig {
  rules?: NotifyRule[]
  webhook?: { url: string; token?: string }
}

export interface WatchConfig {
  /** Directories to watch for file changes (relative to project root). Default: ["."] */
  dirs?: string[]
  /** Additional glob patterns to ignore (appended to the built-in daemon-file exclusions). */
  ignored?: string[]
}

export interface OtelConfig {
  project_id?: string
  /** console | otlp-http | otlp-grpc  (default: console) */
  exporter?: 'console' | 'otlp-http' | 'otlp-grpc'
  /** host:port without protocol prefix, e.g. "localhost:4317" */
  endpoint?: string
}

export interface HttpConfig {
  port?: number
  inbound_token?: string
}

export interface HarnessConfig {
  dir?: string
}

export interface TwConfig {
  store_dir?: string
  socket_path?: string
  watch?: WatchConfig
  notify?: NotifyConfig
  otel?: OtelConfig
  http?: HttpConfig
  harness?: HarnessConfig
}

// ── Loader ─────────────────────────────────────────────────────────────────

const CONFIG_FILE = 'config.yaml'

/**
 * Load and parse `.traceweaver/config.yaml`.
 * Returns an empty object (all defaults) if the file does not exist.
 * Throws on YAML parse errors.
 *
 * @param storeDir  The resolved store directory (already determined by env / default).
 */
export function loadConfig(storeDir: string): TwConfig {
  const configPath = process.env.TW_CONFIG ?? join(storeDir, CONFIG_FILE)

  if (!existsSync(configPath)) {
    return {}
  }

  const raw = readFileSync(configPath, 'utf8')
  const parsed = yaml.load(raw)

  if (parsed === null || parsed === undefined) return {}
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`config.yaml must be a YAML mapping, got ${typeof parsed}`)
  }

  return parsed as TwConfig
}

// ── Resolved config helpers ────────────────────────────────────────────────

/**
 * Return the list of absolute paths FsWatcher should monitor.
 *
 * Rules:
 *  1. If config.watch.dirs is set, use those (resolved relative to projectRoot).
 *  2. Otherwise default to [projectRoot] (the CWD where `tw` was run).
 *  3. The store directory is always excluded so daemon-internal files are never watched.
 */
export function resolveWatchDirs(config: TwConfig, projectRoot: string, storeDir: string): string[] {
  const dirs = config.watch?.dirs?.length
    ? config.watch.dirs.map(d => resolve(projectRoot, d))
    : [projectRoot]

  // Remove the store dir itself from the watch list to avoid watching daemon internals
  const resolvedStore = resolve(storeDir)
  return dirs.filter(d => resolve(d) !== resolvedStore)
}
