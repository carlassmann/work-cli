import { describe, test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import https from "node:https"
import net from "node:net"
import path from "node:path"
import { execFile, spawn } from "node:child_process"
import { promisify } from "node:util"
import { certificate, privateKey } from "./test-certificate.js"
import { tempDir } from "./test-helpers.js"
import { parseServeTarget, tailscaleExposure, tailscaleHostname } from "./tailscale.js"

const execFileAsync = promisify(execFile)


describe("tailscale", () => {
  test("reads the domain, certificate, key, and proxy port from the environment", async (t) => {
    const config = await tempDir()
    t.after(() => fs.rm(config, { recursive: true, force: true }))
    const exposure = await tailscaleExposure({
      XDG_CONFIG_HOME: config,
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

  test("falls back to the domain saved by work tailscale setup and its certificate paths", async (t) => {
    const config = await tempDir()
    t.after(() => fs.rm(config, { recursive: true, force: true }))
    await fs.mkdir(path.join(config, "work"))
    await fs.writeFile(path.join(config, "work", "config.json"), JSON.stringify({ maxTtlSeconds: 60, tailscale: { domain: "dev.example.com" } }))

    const exposure = await tailscaleExposure({ XDG_CONFIG_HOME: config })
    assert.deepEqual(exposure, {
      ok: true,
      value: {
        mode: "tailscale",
        domain: "dev.example.com",
        certFile: path.join(config, "work", "tailscale", "dev.example.com.fullchain.pem"),
        keyFile: path.join(config, "work", "tailscale", "dev.example.com.key.pem"),
        port: 47443,
      },
    })
  })

  test("rejects a missing or unusable domain and a privileged proxy port", async (t) => {
    const config = await tempDir()
    t.after(() => fs.rm(config, { recursive: true, force: true }))
    for (const environment of [
      {},
      { WORK_TAILSCALE_DOMAIN: "localhost" },
      { WORK_TAILSCALE_DOMAIN: "dev.example.com", WORK_TAILSCALE_PORT: "443" },
    ]) {
      const exposure = await tailscaleExposure({ XDG_CONFIG_HOME: config, ...environment })
      assert.equal(exposure.ok, false, JSON.stringify(environment))
    }
    const missing = await tailscaleExposure({ XDG_CONFIG_HOME: config })
    assert.match(missing.ok ? "" : missing.error.message, /work tailscale setup/)
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

    for (const hostile of ["constructor", "__proto__", "hasOwnProperty"]) {
      assert.equal((await get(proxyPort, hostile, "/")).status, 404)
    }
    assert.equal(proxy.exitCode, null)

    // The page request above leaves a pooled upstream socket; the upgrade must not reuse it.
    const { stdout } = await execFileAsync(process.execPath, ["-e", webSocketClient, String(proxyPort), "web-main-tilly.dev.example.test"], { timeout: 4_000 })
    assert.match(stdout, /101 Switching Protocols[\s\S]*echo:ping/)
  })

  test("proxy exits without reporting ready when its port is taken", async (t) => {
    const dir = await tempDir()
    t.after(() => fs.rm(dir, { recursive: true, force: true }))
    await fs.writeFile(path.join(dir, "cert.pem"), certificate)
    await fs.writeFile(path.join(dir, "key.pem"), privateKey)

    const occupant = net.createServer()
    const port = await listen(occupant)
    t.after(() => occupant.close())

    const configFile = path.join(dir, "proxy.json")
    await fs.writeFile(configFile, JSON.stringify({
      port,
      certFile: path.join(dir, "cert.pem"),
      keyFile: path.join(dir, "key.pem"),
      portlessPort: 443,
      routes: {},
    }))
    const proxy = spawn(process.execPath, [path.resolve("src/tailnet-proxy.ts"), configFile], { stdio: ["ignore", "ignore", "ignore", "ipc"] })
    t.after(() => proxy.kill())
    const messages: Array<unknown> = []
    proxy.on("message", (message) => messages.push(message))

    const exitCode = await new Promise((resolve) => proxy.once("exit", resolve))
    assert.equal(exitCode, 1)
    assert.deepEqual(messages, [])
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

