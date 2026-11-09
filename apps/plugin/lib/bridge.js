import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'

const PROTOCOL = 1
const HEARTBEAT_MS = 15_000
const MAX_BODY_BYTES = 64 * 1024

function json(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve(text ? JSON.parse(text) : {})
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

function dshHome() {
  if (process.env.DSH_HOME?.trim()) return process.env.DSH_HOME.trim()
  return path.join(os.homedir(), '.dsh')
}

/**
 * Loopback HTTP + SSE bridge.
 *
 * The discovery file carries the bearer token. Requests must arrive on
 * loopback with a loopback Host header and no cross-site Origin, which keeps
 * a normal web page from reading the stream through DNS rebinding.
 */
export class BridgeServer {
  constructor(ctx, config, store) {
    this.ctx = ctx
    this.config = config
    this.store = store
    this.token = randomBytes(32).toString('base64url')
    this.server = undefined
    this.port = 0
    this.clients = new Set()
    this.heartbeat = undefined
    this.discoveryPath = undefined
    this.lastByTask = new Map()
    this.startedAt = Date.now()
    this.disposed = false
  }

  async start() {
    this.server = http.createServer((req, res) => {
      this.route(req, res).catch((error) => {
        this.ctx.logger?.warn?.(`[task-monitor] bridge request failed: ${String(error)}`)
        if (!res.headersSent) json(res, 500, { code: 'internal_error' })
        else res.destroy()
      })
    })
    await new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(this.config.port, '127.0.0.1', resolve)
    })
    if (this.disposed) {
      await new Promise((resolve) => this.server.close(resolve))
      return
    }
    this.port = this.server.address().port
    await this.writeDiscovery()
    if (this.disposed) return
    this.store.setPublisher((frame) => this.broadcast(frame))
    this.heartbeat = setInterval(() => this.ping(), HEARTBEAT_MS)
    this.heartbeat.unref?.()
    this.ctx.logger?.info?.(`[task-monitor] bridge listening on 127.0.0.1:${this.port}`)
  }

  async writeDiscovery() {
    if (this.disposed) return
    const dir = path.join(dshHome(), 'storages', 'task-monitor', 'bridges')
    await mkdir(dir, { recursive: true })
    const profile = process.env.DSH_PROFILE ?? 'default'
    this.discoveryPath = path.join(dir, `${process.pid}-${profile}.json`)
    const document = {
      protocol: PROTOCOL,
      pid: process.pid,
      profile,
      dshVersion: this.store.dshVersion(),
      url: `http://127.0.0.1:${this.port}`,
      token: this.token,
      startedAt: this.startedAt,
    }
    await writeFile(this.discoveryPath, JSON.stringify(document, null, 2), { mode: 0o600 })
  }

  authorized(req) {
    const host = String(req.headers.host ?? '')
    if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host)) return false
    const origin = req.headers.origin
    if (origin !== undefined) {
      const allowed = [`http://${host}`, `http://127.0.0.1:${this.port}`, `http://localhost:${this.port}`]
      if (!allowed.includes(String(origin))) return false
    }
    const header = String(req.headers.authorization ?? '')
    const given = Buffer.from(header.replace(/^Bearer\s+/i, ''))
    const expected = Buffer.from(this.token)
    return given.length === expected.length && timingSafeEqual(given, expected)
  }

  async route(req, res) {
    if (!this.authorized(req)) {
      json(res, 401, { code: 'unauthorized' })
      return
    }
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.port}`)
    if (req.method === 'GET' && url.pathname === '/v1/health') {
      json(res, 200, {
        ok: true,
        protocol: PROTOCOL,
        pid: process.pid,
        profile: process.env.DSH_PROFILE ?? 'default',
        dshVersion: this.store.dshVersion(),
        uptimeMs: Date.now() - this.startedAt,
      })
      return
    }
    if (req.method === 'GET' && url.pathname === '/v1/snapshot') {
      json(res, 200, this.store.snapshot())
      return
    }
    if (req.method === 'GET' && url.pathname === '/v1/events') {
      this.openStream(req, res)
      return
    }
    if (req.method === 'POST' && url.pathname === '/v1/actions/cancel-turn') {
      await this.cancelTurn(req, res)
      return
    }
    if (req.method === 'POST' && url.pathname === '/v1/actions/cancel-job') {
      await this.cancelJob(req, res)
      return
    }
    json(res, 404, { code: 'not_found' })
  }

  openStream(req, res) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    res.write('retry: 2000\n\n')
    const state = this.store.snapshot()
    const seq = state.health?.lastSeq ?? 0
    this.writeEvent(res, 'snapshot', seq, state)
    const client = { res }
    this.clients.add(client)
    req.on('close', () => {
      this.clients.delete(client)
    })
  }

  writeEvent(res, event, id, payload) {
    try {
      res.write(`id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(payload)}\n\n`)
    } catch {
      this.clients.delete({ res })
    }
  }

  broadcast(frame) {
    if (this.clients.size === 0) return
    const upserts = []
    for (const task of frame.tasks) {
      const signature = JSON.stringify(task)
      if (this.lastByTask.get(task.id) !== signature) {
        this.lastByTask.set(task.id, signature)
        upserts.push(task)
      }
    }
    const current = new Set(frame.tasks.map((task) => task.id))
    const removed = [...this.lastByTask.keys()].filter((id) => !current.has(id))
    for (const id of removed) this.lastByTask.delete(id)
    if (upserts.length === 0 && removed.length === 0) return
    const patch = { seq: frame.seq, upserts, removed, aggregate: frame.aggregate }
    for (const client of this.clients) {
      this.writeEvent(client.res, 'patch', frame.seq, patch)
    }
  }

  ping() {
    for (const client of this.clients) {
      try {
        client.res.write(': ping\n\n')
      } catch {
        this.clients.delete(client)
      }
    }
  }

  async cancelTurn(req, res) {
    const body = await readBody(req)
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
    if (!sessionId) {
      json(res, 400, { code: 'bad_request', message: 'sessionId is required' })
      return
    }
    const agent = this.ctx.agents?.get?.(sessionId)
    if (!agent) {
      json(res, 404, { code: 'unknown_session' })
      return
    }
    agent.cancel({ kind: 'user' })
    json(res, 200, { ok: true })
  }

  async cancelJob(req, res) {
    const body = await readBody(req)
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
    const jobId = typeof body.jobId === 'string' ? body.jobId : ''
    const jobs = this.ctx.jobs
    if (!sessionId || !jobId) {
      json(res, 400, { code: 'bad_request', message: 'sessionId and jobId are required' })
      return
    }
    if (typeof jobs?.kill !== 'function') {
      json(res, 501, { code: 'unsupported' })
      return
    }
    try {
      await jobs.kill(sessionId, jobId)
      json(res, 200, { ok: true })
    } catch (error) {
      json(res, 409, { code: 'not_running', message: String(error) })
    }  }

  async dispose() {
    if (this.disposed) return
    this.disposed = true
    this.store.setPublisher(undefined)
    if (this.heartbeat) clearInterval(this.heartbeat)
    for (const client of this.clients) {
      try {
        client.res.end()
      } catch {
        // client already gone
      }
    }
    this.clients.clear()
    if (this.discoveryPath) {
      await rm(this.discoveryPath, { force: true }).catch(() => {})
      this.discoveryPath = undefined
    }
    if (this.server) {
      await new Promise((resolve) => this.server.close(resolve))
      this.server = undefined
    }
  }
}
