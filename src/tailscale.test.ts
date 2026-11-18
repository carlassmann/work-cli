import { describe, test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import http2 from "node:http2"
import https from "node:https"
import net from "node:net"
import path from "node:path"
import { execFile, spawn } from "node:child_process"
import { promisify } from "node:util"
import { certificate, privateKey } from "./test-certificate.js"
import { tempDir } from "./test-helpers.js"
import { checkServePort, parseServeTarget, serveConflictMessage, tailscaleByDefault, tailscaleExposure, tailscaleHost, tailscaleHostname } from "./tailscale.js"
import { publicUrl } from "./portless.js"

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
      value: { mode: "tailscale", domain: "dev.example.com", certFile: "/certs/fullchain.pem", keyFile: "/certs/key.pem", port: 47443, servePort: 443 },
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
        servePort: 443,
      },
    })
  })

  test("reads the tailnet serve port from setup or the environment and puts it in the URL", async (t) => {
    const config = await tempDir()
    t.after(() => fs.rm(config, { recursive: true, force: true }))
    await fs.mkdir(path.join(config, "work"))
    await fs.writeFile(path.join(config, "work", "config.json"), JSON.stringify({ tailscale: { domain: "dev.example.com", servePort: 9443 } }))

    const saved = await tailscaleExposure({ XDG_CONFIG_HOME: config })
    assert.equal(saved.ok && saved.value.mode === "tailscale" ? saved.value.servePort : null, 9443)
    const exposure = saved.ok ? saved.value : { mode: "local" as const }
    assert.equal(tailscaleHost("web-feature-x-tilly", exposure), "web-feature-x-tilly.dev.example.com:9443")
    const command = { command: "astro dev", route: true as const }
    assert.equal(
      publicUrl({ project: "tilly", commands: { web: command } }, "feature-x", "web", command, exposure, 443),
      "https://web-feature-x-tilly.dev.example.com:9443",
    )

    const overridden = await tailscaleExposure({ XDG_CONFIG_HOME: config, WORK_TAILSCALE_SERVE_PORT: "443" })
    const plain = overridden.ok ? overridden.value : { mode: "local" as const }
    assert.equal(tailscaleHost("web-feature-x-tilly", plain), "web-feature-x-tilly.dev.example.com")
    // Records from before servePort existed mean 443.
    assert.equal(tailscaleHost("web-a-b", { mode: "tailscale", domain: "dev.example.com", certFile: "c", keyFile: "k", port: 47443 }), "web-a-b.dev.example.com")

    for (const bad of ["0", "70000", "x"]) {
      const exposure = await tailscaleExposure({ XDG_CONFIG_HOME: config, WORK_TAILSCALE_SERVE_PORT: bad })
      assert.equal(exposure.ok, false, bad)
    }
  })

  test("uses tailnet URLs by default only when setup saved it or the environment says so", async (t) => {
    const config = await tempDir()
    t.after(() => fs.rm(config, { recursive: true, force: true }))
    assert.equal(await tailscaleByDefault({ XDG_CONFIG_HOME: config }), false)
    await fs.mkdir(path.join(config, "work"))
    await fs.writeFile(path.join(config, "work", "config.json"), JSON.stringify({ tailscale: { domain: "dev.example.com", default: true } }))
    assert.equal(await tailscaleByDefault({ XDG_CONFIG_HOME: config }), true)
    assert.equal(await tailscaleByDefault({ XDG_CONFIG_HOME: config, WORK_TAILSCALE_DEFAULT: "0" }), false)
    assert.equal(await tailscaleByDefault({ XDG_CONFIG_HOME: config, WORK_TAILSCALE_DEFAULT: "1" }), true)
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

  test("a forward to a server listening only on ::1 is not taken over", async (t) => {
    const server = net.createServer()
    await new Promise<void>((resolve) => server.listen(0, "::1", resolve))
    t.after(() => server.close())
    const port = (server.address() as net.AddressInfo).port
    const bin = await tempDir()
    await fs.writeFile(path.join(bin, "tailscale"), `#!/bin/sh\necho '${JSON.stringify({ TCP: { "443": { TCPForward: `localhost:${port}` } } })}'\n`, { mode: 0o755 })
    const environment = { ...process.env, PATH: `${bin}:${process.env["PATH"]}` }

    const held = await checkServePort(47443, 443, environment)
    assert.match(held.ok ? "" : held.error.message, new RegExp(`forwards tailnet port 443 to localhost:${port}`))
    server.close()
    assert.ok((await checkServePort(47443, 443, environment)).ok)
  })

  test("finds what tailscale serve forwards on port 443", () => {
    assert.equal(parseServeTarget(""), null)
    assert.equal(parseServeTarget(JSON.stringify({ TCP: { "8443": { HTTPS: true } } })), null)
    assert.equal(parseServeTarget(JSON.stringify({ TCP: { "443": { TCPForward: "127.0.0.1:47443" } } })), "127.0.0.1:47443")
    assert.equal(parseServeTarget(JSON.stringify({ TCP: { "443": { HTTPS: true } } })), "another tailscale serve handler")
    assert.equal(parseServeTarget(JSON.stringify({ TCP: { "443": { HTTPS: true }, "9443": { TCPForward: "127.0.0.1:47443" } } }), 9443), "127.0.0.1:47443")
    assert.equal(parseServeTarget(JSON.stringify({ TCP: { "443": { HTTPS: true } } }), 9443), null)
  })

  test("a port 443 conflict names the handler and the commands that free it", () => {
    const https = JSON.stringify({
      TCP: { "443": { HTTPS: true } },
      Web: {
        "box.tail1.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:3000" }, "/docs": { Path: "/srv/docs" } } },
        "box.tail1.ts.net:8443": { Handlers: { "/": { Proxy: "http://127.0.0.1:9000" } } },
      },
    })
    const message = serveConflictMessage(https, "127.0.0.1:47443")
    assert.match(message, /uses tailnet port 443 for \/ -> http:\/\/127\.0\.0\.1:3000, \/docs -> \/srv\/docs;/)
    assert.match(message, /tailscale serve --https=443 off && tailscale serve --bg --https=8443 http:\/\/127\.0\.0\.1:3000 && tailscale serve --bg --https=8443 --set-path=\/docs \/srv\/docs/)
    assert.doesNotMatch(message, /9000/)

    const onServePort = serveConflictMessage(https, "127.0.0.1:47443", 8443)
    assert.match(onServePort, /uses tailnet port 8443 for \/ -> http:\/\/127\.0\.0\.1:9000;/)
    assert.match(onServePort, /tailscale serve --https=8443 off && tailscale serve --bg --https=9443 http:\/\/127\.0\.0\.1:9000/)

    const forward = serveConflictMessage(JSON.stringify({ TCP: { "443": { TCPForward: "127.0.0.1:5000" } } }), "127.0.0.1:47443")
    assert.match(forward, /forwards tailnet port 443 to 127\.0\.0\.1:5000, which is in use/)
    assert.match(forward, /tailscale serve --tcp=443 off/)
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

    // Browsers get HTTP/2, which carries the host in ":authority" and forbids hop-by-hop response headers.
    const multiplexed = await getOverHttp2(proxyPort, "web-main-tilly.dev.example.test", ["/a", "/b", "/c"])
    assert.equal(multiplexed.protocol, "h2")
    for (const [index, response] of multiplexed.responses.entries()) {
      assert.equal(response.status, 200)
      assert.deepEqual(response.cookies, ["a=1", "b=2"])
      assert.deepEqual(JSON.parse(response.body), {
        url: ["/a", "/b", "/c"][index],
        host: "web-main-tilly.localhost",
        forwardedHost: "web-main-tilly.dev.example.test",
        forwardedProto: "https",
        servername: "web-main-tilly.localhost",
      })
    }

    // A response HTTP/2 can't carry gets a 502 instead of taking the proxy down.
    const duplicate = await getOverHttp2(proxyPort, "web-main-tilly.dev.example.test", ["/duplicate-content-type"])
    assert.equal(duplicate.responses[0]!.status, 502)
    assert.equal(proxy.exitCode, null)

    // A cancelled HTTP/2 stream stops the upstream request.
    const session = http2.connect(`https://127.0.0.1:${proxyPort}`, { servername: "web-main-tilly.dev.example.test", rejectUnauthorized: false })
    t.after(() => session.close())
    const hanging = session.request({ ":path": "/hang", ":authority": "web-main-tilly.dev.example.test" })
    hanging.on("error", () => {})
    hanging.end()
    const hangState = async () => JSON.parse((await get(proxyPort, "web-main-tilly.dev.example.test", "/hang-state")).body) as { received: boolean; closed: boolean }
    await waitFor(async () => (await hangState()).received)
    hanging.close(http2.constants.NGHTTP2_CANCEL)
    await waitFor(async () => (await hangState()).closed)

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
const hang = { received: false, closed: false }
const server = https.createServer({ cert: fs.readFileSync(cert), key: fs.readFileSync(key) }, (request, response) => {
  if (request.url === "/hang") {
    hang.received = true
    response.on("close", () => { hang.closed = true })
    return
  }
  if (request.url === "/hang-state") return response.end(JSON.stringify(hang))
  if (request.url === "/duplicate-content-type") {
    response.setHeader("content-type", ["text/html", "text/plain"])
    return response.end("two types")
  }
  response.setHeader("set-cookie", ["a=1", "b=2"])
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

async function getOverHttp2(port: number, host: string, paths: Array<string>) {
  const session = http2.connect(`https://127.0.0.1:${port}`, { servername: host, rejectUnauthorized: false })
  try {
    const responses = await Promise.all(paths.map((requestPath) => new Promise<{ status: number; cookies: unknown; body: string }>((resolve, reject) => {
      const stream = session.request({ ":path": requestPath, ":authority": host })
      let status = 0
      let cookies: unknown
      let body = ""
      stream.on("response", (headers) => {
        status = Number(headers[":status"])
        cookies = headers["set-cookie"]
      })
      stream.on("data", (chunk: Buffer) => { body += chunk.toString() })
      stream.on("end", () => resolve({ status, cookies, body }))
      stream.on("error", reject)
      session.on("error", reject)
      stream.end()
    })))
    return { protocol: session.alpnProtocol, responses }
  } finally {
    session.close()
  }
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

