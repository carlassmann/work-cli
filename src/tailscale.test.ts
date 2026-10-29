import { describe, test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import https from "node:https"
import net from "node:net"
import path from "node:path"
import { execFile, spawn } from "node:child_process"
import { promisify } from "node:util"
import { tempDir } from "./test-helpers.js"
import { parseServeTarget, tailscaleExposure, tailscaleHostname } from "./tailscale.js"

const execFileAsync = promisify(execFile)

// Self-signed for *.dev.example.test and *.localhost, valid until 2126. Test use only.
const certificate = `-----BEGIN CERTIFICATE-----
MIIBuDCCAV6gAwIBAgIUbbFeW4RQ1AoCoTTM7qsLO64Ma+IwCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJd29yayB0ZXN0MCAXDTI2MTAyOTA3MzY0NFoYDzIxMjYxMDA1
MDczNjQ0WjAUMRIwEAYDVQQDDAl3b3JrIHRlc3QwWTATBgcqhkjOPQIBBggqhkjO
PQMBBwNCAAROcBOyRx48ZHVYlZtDbDkwwqSV8qc0OSq7ve3ptr0P2GPhOvQ38VXs
3atF5/doJY2ZlJKALzIjs+QYoz99WAnko4GLMIGIMB0GA1UdDgQWBBRWgmWVWC0K
H1oYYQGDW6zrZ0324zAfBgNVHSMEGDAWgBRWgmWVWC0KH1oYYQGDW6zrZ0324zAP
BgNVHRMBAf8EBTADAQH/MDUGA1UdEQQuMCyCEiouZGV2LmV4YW1wbGUudGVzdIIL
Ki5sb2NhbGhvc3SCCWxvY2FsaG9zdDAKBggqhkjOPQQDAgNIADBFAiACaJ13B2Wz
qv3sd2UCN3YXHCOz6eMyCvCT70V4sTGj3gIhAPFdclW40lN9yLCwdCAnYtA/AKr7
2K0T/4glqkyv1v50
-----END CERTIFICATE-----
`
const privateKey = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgYFjL6t0Zd7ydFlwC
JFR+9VE61Mjc8pu4UZaJAVl/3syhRANCAAROcBOyRx48ZHVYlZtDbDkwwqSV8qc0
OSq7ve3ptr0P2GPhOvQ38VXs3atF5/doJY2ZlJKALzIjs+QYoz99WAnk
-----END PRIVATE KEY-----
`

describe("tailscale", () => {
  test("reads the domain, certificate, key, and proxy port from the environment", () => {
    const exposure = tailscaleExposure({
      WORK_TAILSCALE_DOMAIN: "Dev.Example.com",
      WORK_TAILSCALE_CERT: "/certs/fullchain.pem",
      WORK_TAILSCALE_KEY: "/certs/key.pem",
    })
    assert.deepEqual(exposure, {
      ok: true,
      value: { mode: "tailscale", domain: "dev.example.com", certFile: "/certs/fullchain.pem", keyFile: "/certs/key.pem", port: 47443 },
    })
    assert.equal(tailscaleHostname("web-feature-x-tilly", exposure.ok ? exposure.value : { mode: "local" }), "web-feature-x-tilly.dev.example.com")
  })

  test("rejects incomplete configuration", () => {
    const complete = { WORK_TAILSCALE_DOMAIN: "dev.example.com", WORK_TAILSCALE_CERT: "/c.pem", WORK_TAILSCALE_KEY: "/k.pem" }
    for (const environment of [
      { ...complete, WORK_TAILSCALE_DOMAIN: "" },
      { ...complete, WORK_TAILSCALE_DOMAIN: "localhost" },
      { ...complete, WORK_TAILSCALE_KEY: "" },
      { ...complete, WORK_TAILSCALE_PORT: "443" },
    ]) {
      const exposure = tailscaleExposure(environment)
      assert.equal(exposure.ok, false, JSON.stringify(environment))
    }
  })

  test("finds what tailscale serve forwards on port 443", () => {
    assert.equal(parseServeTarget(""), null)
    assert.equal(parseServeTarget(JSON.stringify({ TCP: { "8443": { HTTPS: true } } })), null)
    assert.equal(parseServeTarget(JSON.stringify({ TCP: { "443": { TCPForward: "127.0.0.1:47443" } } })), "127.0.0.1:47443")
    assert.equal(parseServeTarget(JSON.stringify({ TCP: { "443": { HTTPS: true } } })), "another tailscale serve handler")
  })

  test("proxy hands requests and WebSocket upgrades to the local URL with the public origin", async (t) => {
    const dir = await tempDir()
    t.after(() => fs.rm(dir, { recursive: true, force: true }))
    await fs.writeFile(path.join(dir, "cert.pem"), certificate)
    await fs.writeFile(path.join(dir, "key.pem"), privateKey)

    // Stands in for Portless: echoes what it received, and echoes WebSocket frames.
    const portlessPort = await freePort()
    const portless = spawn(process.execPath, ["-e", fakePortless, path.join(dir, "cert.pem"), path.join(dir, "key.pem"), String(portlessPort)], { stdio: "ignore" })
    t.after(() => portless.kill())
    await waitForPort(portlessPort)

    const proxyPort = await freePort()
    const configFile = path.join(dir, "proxy.json")
    await fs.writeFile(configFile, JSON.stringify({
      port: proxyPort,
      certFile: path.join(dir, "cert.pem"),
      keyFile: path.join(dir, "key.pem"),
      portlessPort,
      routes: { "web-main-tilly.dev.example.test": "https://web-main-tilly.localhost" },
    }))
    const proxy = spawn(process.execPath, [path.resolve("src/tailnet-proxy.ts"), configFile], { stdio: "ignore" })
    t.after(() => proxy.kill())
    await waitForPort(proxyPort)

    const page = await get(proxyPort, "web-main-tilly.dev.example.test", "/app")
    assert.equal(page.status, 200)
    assert.deepEqual(JSON.parse(page.body), {
      url: "/app",
      host: "web-main-tilly.localhost",
      forwardedHost: "web-main-tilly.dev.example.test",
      forwardedProto: "https",
      servername: "web-main-tilly.localhost",
    })

    const unknown = await get(proxyPort, "other.dev.example.test", "/")
    assert.equal(unknown.status, 404)

    // The page request above leaves a pooled upstream socket; the upgrade must not reuse it.
    const { stdout } = await execFileAsync(process.execPath, ["-e", webSocketClient, String(proxyPort), "web-main-tilly.dev.example.test"], { timeout: 4_000 })
    assert.match(stdout, /101 Switching Protocols[\s\S]*echo:ping/)
  })
})

const webSocketClient = `
const tls = require("node:tls")
const [port, host] = process.argv.slice(-2)
const socket = tls.connect({ port: Number(port), host: "127.0.0.1", servername: host, rejectUnauthorized: false })
let received = ""
socket.on("data", (chunk) => {
  received += chunk
  if (received.includes("101 ") && !received.includes("echo:")) socket.write("ping")
  if (received.includes("echo:ping")) { process.stdout.write(received); process.exit(0) }
})
socket.write("GET /hmr HTTP/1.1\\r\\nHost: " + host + "\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\n\\r\\n")
`

const fakePortless = `
const fs = require("node:fs")
const https = require("node:https")
const [cert, key, port] = process.argv.slice(-3)
const server = https.createServer({ cert: fs.readFileSync(cert), key: fs.readFileSync(key) }, (request, response) => {
  response.end(JSON.stringify({
    url: request.url,
    host: request.headers.host,
    forwardedHost: request.headers["x-forwarded-host"],
    forwardedProto: request.headers["x-forwarded-proto"],
    servername: request.socket.servername,
  }))
})
server.on("upgrade", (request, socket) => {
  socket.write("HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\n\\r\\n")
  socket.on("data", (chunk) => socket.write("echo:" + chunk))
})
server.listen(Number(port), "127.0.0.1")
`

function listen(server: net.Server) {
  return new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as net.AddressInfo).port)))
}

async function freePort() {
  const server = net.createServer()
  const port = await listen(server)
  await new Promise((resolve) => server.close(resolve))
  return port
}

async function waitForPort(port: number) {
  await waitFor(() => new Promise<boolean>((resolve) => {
    const socket = net.connect(port, "127.0.0.1")
    socket.once("connect", () => { socket.destroy(); resolve(true) })
    socket.once("error", () => resolve(false))
  }))
}

async function waitFor(check: () => boolean | Promise<boolean>) {
  for (let waited = 0; waited < 5_000; waited += 25) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error("timed out")
}

function get(port: number, host: string, requestPath: string) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = https.get({ host: "127.0.0.1", port, path: requestPath, servername: host, headers: { host }, rejectUnauthorized: false }, (response) => {
      let body = ""
      response.on("data", (chunk: Buffer) => { body += chunk.toString() })
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body }))
    })
    request.on("error", reject)
  })
}

