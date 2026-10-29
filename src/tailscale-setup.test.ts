import { describe, test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { CloudflareDns, certificateStatus } from "./tailscale-setup.js"
import { generateKeyPairSync } from "node:crypto"
import { certificate, privateKey } from "./test-certificate.js"
import { certificatePaths } from "./tailscale.js"
import { tempDir } from "./test-helpers.js"

type Call = { method: string; url: string; body?: unknown }

// A stand-in for the Cloudflare API with one zone, example.com.
function fakeCloudflare(records: Array<{ id: string; name: string; content: string; proxied: boolean }> = []) {
  const calls: Array<Call> = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = init?.method ?? "GET"
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined
    calls.push({ method, url: url.pathname + url.search, body })
    const reply = (result: unknown) => new Response(JSON.stringify({ success: true, result }), { status: 200 })

    if (url.pathname.endsWith("/zones")) return reply(url.searchParams.get("name") === "example.com" ? [{ id: "zone-1" }] : [])
    if (method === "GET") return reply(records.filter((record) => record.name === url.searchParams.get("name")))
    return reply({ id: "record-new" })
  }) as typeof fetch
  return { calls, dns: new CloudflareDns("token", fetchImpl, "https://cloudflare.test/client/v4") }
}

describe("tailscale setup", () => {
  test("finds the zone from the longest domain suffix Cloudflare knows", async () => {
    const { dns, calls } = fakeCloudflare()
    assert.deepEqual(await dns.findZone("dev.example.com"), { ok: true, value: "zone-1" })
    assert.deepEqual(calls.map((call) => call.url), ["/client/v4/zones?name=dev.example.com", "/client/v4/zones?name=example.com"])

    const missing = await dns.findZone("dev.other.org")
    assert.equal(missing.ok, false)
  })

  test("creates the wildcard record unproxied, or keeps a matching one", async () => {
    const created = fakeCloudflare()
    assert.deepEqual(await created.dns.upsertWildcard("zone-1", "dev.example.com", "100.64.0.7", async () => true), { ok: true, value: "Created" })
    assert.deepEqual(created.calls.at(-1), {
      method: "POST",
      url: "/client/v4/zones/zone-1/dns_records",
      body: { type: "A", name: "*.dev.example.com", content: "100.64.0.7", proxied: false, ttl: 1, comment: "work: tailnet previews" },
    })

    const kept = fakeCloudflare([{ id: "r1", name: "*.dev.example.com", content: "100.64.0.7", proxied: false }])
    assert.deepEqual(await kept.dns.upsertWildcard("zone-1", "dev.example.com", "100.64.0.7", async () => true), { ok: true, value: "Kept" })
    assert.equal(kept.calls.length, 1)
  })

  test("replaces a record pointing elsewhere only after confirmation", async () => {
    const records = [{ id: "r1", name: "*.dev.example.com", content: "100.64.0.9", proxied: false }]
    const declined = fakeCloudflare(records)
    const refused = await declined.dns.upsertWildcard("zone-1", "dev.example.com", "100.64.0.7", async () => false)
    assert.equal(refused.ok, false)
    assert.equal(declined.calls.length, 1)

    const accepted = fakeCloudflare(records)
    assert.deepEqual(await accepted.dns.upsertWildcard("zone-1", "dev.example.com", "100.64.0.7", async () => true), { ok: true, value: "Updated" })
    assert.equal(accepted.calls.at(-1)?.method, "PATCH")
    assert.equal(accepted.calls.at(-1)?.url, "/client/v4/zones/zone-1/dns_records/r1")
  })

  test("removes other A records on the wildcard after confirmation", async () => {
    const records = [
      { id: "r1", name: "*.dev.example.com", content: "100.64.0.7", proxied: false },
      { id: "r2", name: "*.dev.example.com", content: "203.0.113.5", proxied: false },
    ]
    const declined = fakeCloudflare(records)
    let asked = ""
    assert.equal((await declined.dns.upsertWildcard("zone-1", "dev.example.com", "100.64.0.7", async (current) => { asked = current; return false })).ok, false)
    assert.equal(asked, "203.0.113.5")
    assert.equal(declined.calls.length, 1)

    const accepted = fakeCloudflare(records)
    assert.deepEqual(await accepted.dns.upsertWildcard("zone-1", "dev.example.com", "100.64.0.7", async () => true), { ok: true, value: "Updated" })
    assert.deepEqual(accepted.calls.slice(1).map((call) => `${call.method} ${call.url}`), [
      "DELETE /client/v4/zones/zone-1/dns_records/r2",
    ])
  })

  test("checks that a certificate covers the wildcard and has not expired", async (t) => {
    const dir = await tempDir()
    t.after(() => fs.rm(dir, { recursive: true, force: true }))
    const paths = { certFile: path.join(dir, "fullchain.pem"), keyFile: path.join(dir, "key.pem") }

    assert.deepEqual(await certificateStatus(paths, "dev.example.test"), { state: "missing" })
    await fs.writeFile(paths.certFile, certificate)
    await fs.writeFile(paths.keyFile, privateKey)

    const valid = await certificateStatus(paths, "dev.example.test", new Date("2026-10-29T00:00:00Z"))
    assert.equal(valid.state, "valid")
    assert.ok(valid.state === "valid" && valid.daysLeft > 36_000)

    assert.deepEqual(await certificateStatus(paths, "dev.example.com"), { state: "invalid", reason: "does not cover *.dev.example.com" })
    const expired = await certificateStatus(paths, "dev.example.test", new Date("2127-01-01T00:00:00Z"))
    assert.equal(expired.state, "invalid")
  })

  test("rejects a certificate whose private key is missing or does not match", async (t) => {
    const dir = await tempDir()
    t.after(() => fs.rm(dir, { recursive: true, force: true }))
    const paths = { certFile: path.join(dir, "fullchain.pem"), keyFile: path.join(dir, "key.pem") }
    await fs.writeFile(paths.certFile, certificate)

    assert.deepEqual(await certificateStatus(paths, "dev.example.test"), { state: "invalid", reason: `has no private key at ${paths.keyFile}` })

    const other = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" })
    await fs.writeFile(paths.keyFile, other)
    assert.deepEqual(await certificateStatus(paths, "dev.example.test"), { state: "invalid", reason: `does not match the private key at ${paths.keyFile}` })
  })

  test("certificate paths honor WORK_TAILSCALE_CERT and WORK_TAILSCALE_KEY", () => {
    const environment = { XDG_CONFIG_HOME: "/tmp/work-config", WORK_TAILSCALE_CERT: "/certs/full.pem", WORK_TAILSCALE_KEY: "/certs/key.pem" }
    assert.deepEqual(certificatePaths("dev.example.com", environment), { certFile: "/certs/full.pem", keyFile: "/certs/key.pem" })
  })
})
