// Standalone HTTPS proxy started by work for --tailscale. It terminates TLS for
// *.<WORK_TAILSCALE_DOMAIN> and hands each request to the command's local Portless
// URL, so apps see the same Host they see locally plus X-Forwarded-Host/Proto.
import fs from "node:fs"
import http from "node:http"
import https from "node:https"
import type { Duplex } from "node:stream"
import type { TailnetProxyConfig } from "./tailscale.js"

const configFile = process.argv[2]
if (!configFile) {
  console.error("usage: tailnet-proxy <config.json>")
  process.exit(2)
}

let config = readConfig(configFile)
const server = https.createServer(credentials(config), (request, response) => {
  const target = upstream(request)
  if (!target) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end(`No work preview for ${request.headers.host ?? "this host"}\n`)
    return
  }

  const forward = https.request({ ...target, method: request.method, path: request.url }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.rawHeaders)
    upstreamResponse.pipe(response)
  })
  forward.on("error", (cause) => {
    if (!response.headersSent) response.writeHead(502, { "content-type": "text/plain; charset=utf-8" })
    response.end(`work preview unavailable: ${cause.message}\n`)
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

server.listen(config.port, "127.0.0.1", () => {
  console.log(`${new Date().toISOString()} tailnet proxy listening on 127.0.0.1:${config.port}`)
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

function upstream(request: http.IncomingMessage): https.RequestOptions | null {
  const publicHost = request.headers.host
  if (!publicHost) return null
  const local = config.routes[publicHost.replace(/:\d+$/, "").toLowerCase()]
  if (!local) return null

  const url = new URL(local)
  const forwardedFor = [request.headers["x-forwarded-for"], request.socket.remoteAddress].filter(Boolean).join(", ")
  return {
    host: "127.0.0.1",
    port: Number(url.port || config.portlessPort || 443),
    servername: url.hostname,
    // Portless signs local certificates with its own CA; the hop never leaves loopback.
    rejectUnauthorized: false,
    headers: {
      ...request.headers,
      host: url.host,
      "x-forwarded-host": publicHost,
      "x-forwarded-proto": "https",
      "x-forwarded-for": forwardedFor,
    },
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
