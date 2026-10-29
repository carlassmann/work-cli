import { describe, test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import https from "node:https"
import net from "node:net"
import path from "node:path"
import { portlessPort, portlessTlds, probePortless, serviceCustomization } from "./portless-proxy.js"
import { certificate, privateKey } from "./test-certificate.js"
import { tempDir } from "./test-helpers.js"

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

  test("ignores ports outside the valid range", async () => {
    const stateDir = await tempDir("portless-state-")
    await fs.writeFile(path.join(stateDir, "proxy.port"), "70000\n")
    assert.equal(await portlessPort({ PORTLESS_STATE_DIR: stateDir, PORTLESS_PORT: "65536" }), 443)
  })

  test("reads the port Portless recorded when PORTLESS_PORT is unset", async () => {
    const stateDir = await tempDir("portless-state-")
    const free = await freePort()
    await fs.writeFile(path.join(stateDir, "proxy.port"), `${free}\n`)

    assert.deepEqual(await probePortless({ PORTLESS_STATE_DIR: stateDir }), { state: "stopped", port: free })
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
