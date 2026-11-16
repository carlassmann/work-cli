// Standalone HTTPS proxy started by work for --tailscale. It terminates TLS for
// *.<WORK_TAILSCALE_DOMAIN> and hands each request to the command's local Portless
// URL, so apps see the same Host they see locally plus X-Forwarded-Host/Proto.
import fs from "node:fs"
import http from "node:http"
import http2 from "node:http2"
import https from "node:https"
import type { Duplex } from "node:stream"
import type { TailnetProxyConfig } from "./tailscale.js"

// HTTP/2 forbids these in responses; HTTP/1.1 sets its own per connection.
const connectionHeaders = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade"])

const configFile = process.argv[2]
if (!configFile) {
  console.error("usage: tailnet-proxy <config.json>")
  process.exit(2)
}

let config = readConfig(configFile)
// Browsers open at most six HTTP/1.1 connections per host, and a dev server sends every
// module as its own request, so over the tailnet a page waits round trip after round trip.
// HTTP/2 sends them all over one connection. WebSockets still arrive as HTTP/1.1 upgrades.
const server = http2.createSecureServer({ ...credentials(config), allowHTTP1: true }, (request, response) => {
  // With allowHTTP1, HTTP/1.1 requests arrive as http.IncomingMessage/ServerResponse; they have every member used here.
  const target = upstream(request)
  if (!target) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end(`No work preview for ${publicHost(request) ?? "this host"}\n`)
    return
  }

  const forward = https.request({ ...target, method: request.method, path: request.url }, (upstreamResponse) => {
    try {
      response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders(upstreamResponse.rawHeaders))
    } catch (cause) {
      // HTTP/2 throws on headers HTTP/1.1 allows, such as a repeated content-type. Answer 502 instead of exiting.
      for (const name of response.getHeaderNames()) response.removeHeader(name)
      forward.destroy(cause instanceof Error ? cause : new Error(String(cause)))
      return
    }
    upstreamResponse.pipe(response)
  })
  forward.on("error", (cause) => {
    if (response.writableEnded) return
    if (!response.headersSent) response.writeHead(502, { "content-type": "text/plain; charset=utf-8" })
    response.end(`work preview unavailable: ${cause.message}\n`)
  })
  // HTTP/2 browsers cancel streams they no longer need; stop the upstream request with them.
  // A reset HTTP/2 response counts as finished, so only an ended response means it completed.
  response.on("close", () => {
    if (!response.writableEnded) forward.destroy()
  })
  request.pipe(forward)
})

server.on("upgrade", (request: http.IncomingMessage, socket: Duplex, head: Buffer) => {
  const target = upstream(request)
  if (!target) {
    socket.end("HTTP/1.1 404 Not Found\r\n\r\n")
    return
  }

  // A pooled keep-alive socket cannot switch protocols, so upgrades get their own.
  const forward = https.request({ ...target, agent: false, method: request.method, path: request.url })
  forward.on("upgrade", (upstreamResponse, upstreamSocket, upstreamHead) => {
    socket.write(`HTTP/1.1 ${upstreamResponse.statusCode} ${upstreamResponse.statusMessage}\r\n${headerLines(upstreamResponse.rawHeaders)}\r\n`)
    if (upstreamHead.length > 0) socket.write(upstreamHead)
    if (head.length > 0) upstreamSocket.write(head)
    upstreamSocket.pipe(socket).pipe(upstreamSocket)
    upstreamSocket.on("error", () => socket.destroy())
    socket.on("error", () => upstreamSocket.destroy())
  })
  forward.on("response", (upstreamResponse) => {
    socket.end(`HTTP/1.1 ${upstreamResponse.statusCode} ${upstreamResponse.statusMessage}\r\n\r\n`)
  })
  forward.on("error", () => socket.destroy())
  forward.end()
})

server.on("error", (cause) => {
  console.error(`${new Date().toISOString()} tailnet proxy failed: ${cause.message}`)
  process.exit(1)
})

server.listen(config.port, "127.0.0.1", () => {
  console.log(`${new Date().toISOString()} tailnet proxy listening on 127.0.0.1:${config.port}`)
  // work waits for this before pointing tailscale serve here, so a foreign listener on the port is never exposed.
  process.send?.("ready")
  process.disconnect?.()
})

// work rewrites the config when commands start or stop; certificates renew in place.
fs.watchFile(configFile, { interval: 1_000 }, () => reload())
const watchCertificates = (current: TailnetProxyConfig) => {
  for (const file of [current.certFile, current.keyFile]) fs.watchFile(file, { interval: 60_000 }, () => reload())
}
watchCertificates(config)

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)))
}

function reload() {
  try {
    const next = readConfig(configFile!)
    server.setSecureContext(credentials(next))
    if (next.certFile !== config.certFile || next.keyFile !== config.keyFile) {
      fs.unwatchFile(config.certFile)
      fs.unwatchFile(config.keyFile)
      watchCertificates(next)
    }
    config = next
  } catch (cause) {
    console.error(`${new Date().toISOString()} keeping previous config: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
}

function upstream(request: http.IncomingMessage | http2.Http2ServerRequest): https.RequestOptions | null {
  const host = publicHost(request)
  if (!host) return null
  const hostname = host.replace(/:\d+$/, "").toLowerCase()
  // Host comes from the client, so only own keys count; "constructor" must not resolve to Object.prototype.
  if (!Object.hasOwn(config.routes, hostname)) return null
  const url = parseUrl(config.routes[hostname])
  if (!url) return null
  const forwardedFor = [request.headers["x-forwarded-for"], request.socket.remoteAddress].filter(Boolean).join(", ")
  // Portless gets HTTP/1.1, which has no pseudo-headers (":path", ":authority", ...).
  const headers = Object.fromEntries(Object.entries(request.headers).filter(([name]) => !name.startsWith(":")))
  return {
    host: "127.0.0.1",
    port: Number(url.port || config.portlessPort || 443),
    servername: url.hostname,
    // Portless signs local certificates with its own CA; the hop never leaves loopback.
    rejectUnauthorized: false,
    headers: {
      ...headers,
      host: url.host,
      "x-forwarded-host": host,
      "x-forwarded-proto": "https",
      "x-forwarded-for": forwardedFor,
    },
  }
}

// HTTP/2 requests carry the host in ":authority" instead of a Host header.
function publicHost(request: http.IncomingMessage | http2.Http2ServerRequest) {
  const authority = request.headers[":authority"] ?? request.headers.host
  return typeof authority === "string" && authority !== "" ? authority : null
}

function responseHeaders(rawHeaders: Array<string>) {
  const headers: Record<string, string | Array<string>> = {}
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index]!.toLowerCase()
    const value = rawHeaders[index + 1]!
    if (connectionHeaders.has(name)) continue
    const previous = headers[name]
    headers[name] = previous === undefined ? value : [...(Array.isArray(previous) ? previous : [previous]), value]
  }
  return headers
}

function parseUrl(value: unknown) {
  try {
    return new URL(String(value))
  } catch {
    return null
  }
}

function headerLines(rawHeaders: Array<string>) {
  let lines = ""
  for (let index = 0; index < rawHeaders.length; index += 2) lines += `${rawHeaders[index]}: ${rawHeaders[index + 1]}\r\n`
  return lines
}

function credentials(current: TailnetProxyConfig) {
  return { cert: fs.readFileSync(current.certFile), key: fs.readFileSync(current.keyFile) }
}

function readConfig(file: string) {
  return JSON.parse(fs.readFileSync(file, "utf8")) as TailnetProxyConfig
}
