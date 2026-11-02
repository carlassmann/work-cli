import { afterEach, beforeEach, describe, test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import http from "node:http"
import https from "node:https"
import net from "node:net"
import path from "node:path"
import { ensurePortlessProxy, portlessPort, portlessProxyRemedy, portlessTlds, probePortless, proxyRemedy, proxyRemedyHint, serviceCustomization } from "./portless-proxy.js"
import { certificate, privateKey } from "./test-certificate.js"
import { tempDir } from "./test-helpers.js"

const previousStateRoot = process.env["WORK_STATE_ROOT"]

beforeEach(async () => {
  process.env["WORK_STATE_ROOT"] = await tempDir("work-cli-state-")
})

afterEach(() => {
  if (previousStateRoot === undefined) delete process.env["WORK_STATE_ROOT"]
  else process.env["WORK_STATE_ROOT"] = previousStateRoot
})

describe("probePortless", () => {
  test("tells Portless apart from another proxy on its port and from a free port", async () => {
    const stateDir = await tempDir("portless-state-")
    await fs.writeFile(path.join(stateDir, "proxy.tls"), "1")

    const portless = await listen((_request, response) => response.writeHead(404, { "x-portless": "1" }).end())
    const other = await listen((_request, response) => response.writeHead(404).end())
    const free = await freePort()

    try {
      assert.deepEqual(await probePortless({ PORTLESS_STATE_DIR: stateDir, PORTLESS_PORT: String(portless.port) }), { state: "ok", port: portless.port })
      assert.deepEqual(await probePortless({ PORTLESS_STATE_DIR: stateDir, PORTLESS_PORT: String(other.port) }), { state: "foreign", port: other.port })
      assert.deepEqual(await probePortless({ PORTLESS_STATE_DIR: stateDir, PORTLESS_PORT: String(free) }), { state: "stopped", port: free })
    } finally {
      portless.server.close()
      other.server.close()
    }
  })

  test("gives up on a server that trickles its response past the deadline", async () => {
    const stateDir = await tempDir("portless-state-")
    const sockets: Array<net.Socket> = []
    const trickler = net.createServer((socket) => {
      sockets.push(socket)
      socket.write("HTTP/1.1 200 OK\r\n")
      const drip = setInterval(() => socket.write("x-slow: 1\r\n"), 200)
      socket.on("close", () => clearInterval(drip))
    })
    await new Promise<void>((resolve) => trickler.listen(0, "127.0.0.1", resolve))
    const { port } = trickler.address() as net.AddressInfo

    try {
      const started = Date.now()
      assert.deepEqual(await probePortless({ PORTLESS_STATE_DIR: stateDir, PORTLESS_PORT: String(port) }), { state: "foreign", port })
      assert.ok(Date.now() - started < 4_000)
    } finally {
      for (const socket of sockets) socket.destroy()
      trickler.close()
    }
  })

  test("looks for ~/.portless in the HOME the command runs with", async () => {
    const home = await tempDir("portless-home-")
    await fs.mkdir(path.join(home, ".portless"))
    await fs.writeFile(path.join(home, ".portless", "proxy.port"), "43127\n")
    await fs.mkdir(path.join(home, "custom"))
    await fs.writeFile(path.join(home, "custom", "proxy.port"), "43128\n")

    assert.equal(await portlessPort({ HOME: home }, async () => false), 43127)
    assert.equal(await portlessPort({ HOME: home, PORTLESS_STATE_DIR: "~/custom" }), 43128)
  })

  test("ignores ports outside the valid range", async () => {
    const stateDir = await tempDir("portless-state-")
    await fs.writeFile(path.join(stateDir, "proxy.port"), "70000\n")
    assert.equal(await portlessPort({ PORTLESS_STATE_DIR: stateDir, PORTLESS_PORT: "65536" }), 443)
  })

  test("prefers the port a running Portless recorded over PORTLESS_PORT, like Portless itself", async () => {
    const home = await tempDir("portless-home-")
    const portless = http.createServer((_request, response) => response.writeHead(404, { "x-portless": "1" }).end())
    await new Promise<void>((resolve) => portless.listen(0, "127.0.0.1", resolve))
    const { port } = portless.address() as net.AddressInfo
    await fs.mkdir(path.join(home, ".portless"))
    await fs.writeFile(path.join(home, ".portless", "proxy.port"), `${port}\n`)

    try {
      assert.equal(await portlessPort({ HOME: home, PORTLESS_PORT: "9" }), port)
    } finally {
      portless.close()
    }
  })

  test("falls back like portless <name>, which restarts its proxy on the recorded port", async () => {
    const home = await tempDir("portless-home-")
    await fs.mkdir(path.join(home, ".portless"))
    await fs.writeFile(path.join(home, ".portless", "proxy.port"), "8443\n")
    const environment = { HOME: home, PORTLESS_PORT: "9443" }
    const answering = (ports: Array<number>) => async (port: number) => ports.includes(port)

    assert.equal(await portlessPort(environment, answering([])), 8443)
    assert.equal(await portlessPort(environment, answering([9443])), 9443)
    assert.equal(await portlessPort(environment, answering([9443, 1355])), 1355)
    assert.equal(await portlessPort({ HOME: await tempDir("portless-home-"), PORTLESS_PORT: "9443" }, answering([])), 9443)
  })

  test("uses the port recorded in PORTLESS_STATE_DIR before PORTLESS_PORT", async () => {
    const stateDir = await tempDir("portless-state-")
    await fs.writeFile(path.join(stateDir, "proxy.port"), "8443\n")
    assert.equal(await portlessPort({ PORTLESS_STATE_DIR: stateDir, PORTLESS_PORT: "9" }), 8443)
  })

  test("reads the port Portless recorded when PORTLESS_PORT is unset", async () => {
    const stateDir = await tempDir("portless-state-")
    const free = await freePort()
    await fs.writeFile(path.join(stateDir, "proxy.port"), `${free}\n`)

    assert.deepEqual(await probePortless({ PORTLESS_STATE_DIR: stateDir }), { state: "stopped", port: free })
  })
})

describe("last seen proxy", () => {
  test("falls back to the port that last answered once Portless deleted proxy.port and proxy.tls", async () => {
    const stateDir = await tempDir("portless-state-")
    const portless = await listen((_request, response) => response.writeHead(404, { "x-portless": "1" }).end())
    await fs.writeFile(path.join(stateDir, "proxy.port"), `${portless.port}\n`)
    await fs.writeFile(path.join(stateDir, "proxy.tls"), "1")
    try {
      assert.deepEqual(await probePortless({ PORTLESS_STATE_DIR: stateDir }), { state: "ok", port: portless.port })
    } finally {
      portless.server.close()
    }
    await fs.rm(path.join(stateDir, "proxy.port"))
    await fs.rm(path.join(stateDir, "proxy.tls"))

    assert.deepEqual(await probePortless({ PORTLESS_STATE_DIR: stateDir }), { state: "stopped", port: portless.port })
    assert.equal(proxyRemedyHint(await portlessProxyRemedy({ PORTLESS_STATE_DIR: stateDir }, portless.port, async () => false)), `start it with portless proxy start -p ${portless.port} --https`)
    assert.equal(await portlessPort({ PORTLESS_STATE_DIR: stateDir, PORTLESS_PORT: "9443" }), 9443)
    await fs.writeFile(path.join(stateDir, "proxy.port"), "8443\n")
    assert.equal(await portlessPort({ PORTLESS_STATE_DIR: stateDir }), 8443)
    assert.equal(await portlessPort({ PORTLESS_STATE_DIR: await tempDir("portless-state-") }), 443)
  })

  test("comes last in Portless's discovery order for the default state directory", async () => {
    const home = await tempDir("portless-home-")
    const portless = http.createServer((_request, response) => response.writeHead(404, { "x-portless": "1" }).end())
    await new Promise<void>((resolve) => portless.listen(0, "127.0.0.1", resolve))
    const { port } = portless.address() as net.AddressInfo
    await fs.mkdir(path.join(home, ".portless"))
    try {
      assert.equal((await probePortless({ HOME: home }, port)).state, "ok")
    } finally {
      portless.close()
    }
    const answering = (ports: Array<number>) => async (candidate: number) => ports.includes(candidate)

    assert.equal(await portlessPort({ HOME: home }, answering([])), port)
    assert.equal(await portlessPort({ HOME: home }, answering([1355])), 1355)
    assert.equal(await portlessPort({ HOME: home, PORTLESS_PORT: "9443" }, answering([])), 9443)
  })

  test("does not remember a port nothing answered on", async () => {
    const stateDir = await tempDir("portless-state-")
    const free = await freePort()
    assert.equal((await probePortless({ PORTLESS_STATE_DIR: stateDir, PORTLESS_PORT: String(free) })).state, "stopped")
    assert.equal(await portlessPort({ PORTLESS_STATE_DIR: stateDir }), 443)
  })
})

describe("proxyRemedy", () => {
  const linux = { installed: false, platform: "linux" as const }

  test("starts the proxy on its own port with the protocol it served", () => {
    assert.deepEqual(proxyRemedy(1355, true, linux), { kind: "start", command: "portless proxy start -p 1355 --https" })
    assert.deepEqual(proxyRemedy(8080, false, linux), { kind: "start", command: "portless proxy start -p 8080 --no-tls" })
  })

  test("offers an unprivileged port next to sudo for ports below 1024", () => {
    const remedy = proxyRemedy(443, true, linux)
    assert.deepEqual(remedy, { kind: "sudo", command: "sudo portless proxy start -p 443 --https", unprivileged: "portless proxy start -p 1355 --https" })
    assert.equal(proxyRemedyHint(remedy), "start it with sudo portless proxy start -p 443 --https, or without sudo: portless proxy start -p 1355 --https")
  })

  test("points at the startup service when one is installed", () => {
    assert.deepEqual(proxyRemedy(443, true, { installed: true, platform: "linux" }), { kind: "service", command: "sudo systemctl restart portless" })
    assert.deepEqual(proxyRemedy(443, true, { installed: true, platform: "darwin" }), { kind: "service", command: "sudo launchctl kickstart -k system/sh.portless.proxy" })
  })
})

describe("ensurePortlessProxy", () => {
  const noService = async () => false

  test("refuses routed commands while the proxy is stopped and names the exact start command", async () => {
    const result = await ensurePortlessProxy([{ id: "web", port: 1355, environment: {} }, { id: "api", port: 1355, environment: {} }], async () => ({ state: "stopped", port: 1355 }), noService)
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.error.tag, "PortlessError")
    assert.equal(result.error.message, [
      "the Portless proxy is not running on :1355, and routed commands need it (web, api). Start it, then retry:",
      "  portless proxy start -p 1355 --https",
    ].join("\n"))
  })

  test("lets commands start when the proxy answers or another proxy owns the port", async () => {
    assert.equal((await ensurePortlessProxy([{ id: "web", port: 1355, environment: {} }], async () => ({ state: "ok", port: 1355 }), noService)).ok, true)
    assert.equal((await ensurePortlessProxy([{ id: "web", port: 443, environment: {} }], async () => ({ state: "foreign", port: 443 }), noService)).ok, true)
  })

  test("does not probe without routed commands", async () => {
    const result = await ensurePortlessProxy([], async () => assert.fail("probed"), noService)
    assert.equal(result.ok, true)
  })

  test("probes exactly the port each command's URL was built for, once per endpoint", async () => {
    const stateDir = await tempDir("portless-state-")
    const probed: Array<number | undefined> = []
    const probe = async (_environment: NodeJS.ProcessEnv, port?: number) => {
      probed.push(port)
      return { state: port === 1355 ? "ok" as const : "stopped" as const, port: port ?? 443 }
    }
    const environment = { PORTLESS_STATE_DIR: stateDir }

    const result = await ensurePortlessProxy([
      { id: "web", port: 1355, environment },
      { id: "api", port: 8443, environment },
      { id: "docs", port: 1355, environment },
    ], probe, noService)

    assert.deepEqual(probed, [1355, 8443])
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.error.message, [
      "the Portless proxy is not running on :8443, and routed commands need it (api). Start it, then retry:",
      "  portless proxy start -p 8443 --https",
    ].join("\n"))
  })
})

describe("portlessTlds", () => {
  test("reads every TLD Portless serves, falling back to the single-TLD file and then localhost", async () => {
    const stateDir = await tempDir("portless-state-")
    assert.deepEqual(await portlessTlds({ PORTLESS_STATE_DIR: stateDir }), ["localhost"])

    await fs.writeFile(path.join(stateDir, "proxy.tld"), "test\n")
    assert.deepEqual(await portlessTlds({ PORTLESS_STATE_DIR: stateDir }), ["test"])

    await fs.writeFile(path.join(stateDir, "proxy.tlds"), "localhost\ndev.example.com\n")
    assert.deepEqual(await portlessTlds({ PORTLESS_STATE_DIR: stateDir }), ["localhost", "dev.example.com"])
  })
})

async function listen(handler: https.RequestListener) {
  const server = https.createServer({ cert: certificate, key: privateKey }, handler)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  return { server, port: (server.address() as net.AddressInfo).port }
}

async function freePort() {
  const server = net.createServer()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as net.AddressInfo
  await new Promise((resolve) => server.close(resolve))
  return port
}

describe("serviceCustomization", () => {
  const defaults = (overrides: Record<string, string> = {}) => Object.entries({
    "Manager state": "running",
    Installed: "yes",
    "Proxy on 443": "responding",
    HTTPS: "yes",
    TLDs: ".localhost",
    "LAN mode": "no",
    Wildcard: "no",
    "State directory": "/home/me/.portless",
    "Service entry": "/Library/LaunchDaemons/sh.portless.proxy.plist",
    ...overrides,
  }).map(([key, value]) => `  ${key}: ${value}`).join("\n")
  const plainEntry = async () => "<string>--https</string>"

  test("accepts a service running with defaults", async () => {
    assert.equal(await serviceCustomization(`portless service\n${defaults()}`, "/home/me/.portless", plainEntry), null)
  })

  test("names the setting a reinstall would reset", async () => {
    assert.equal(await serviceCustomization(defaults({ Installed: "no" }), "/home/me/.portless", plainEntry), "the startup service is not installed")
    assert.equal(await serviceCustomization(defaults({ HTTPS: "no" }), "/home/me/.portless", plainEntry), "it runs without HTTPS")
    assert.equal(await serviceCustomization(defaults({ "LAN mode": "yes" }), "/home/me/.portless", plainEntry), "it runs in LAN mode")
    assert.equal(await serviceCustomization(defaults({ Wildcard: "yes" }), "/home/me/.portless", plainEntry), "it runs with wildcard routing")
    assert.equal(await serviceCustomization(defaults(), "/other/state", plainEntry), "it uses the state directory /home/me/.portless")
    assert.equal(await serviceCustomization(defaults(), "/home/me/.portless", async () => "<string>--cert</string>"), "it uses a custom certificate")
  })
})
