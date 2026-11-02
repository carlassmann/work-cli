import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { exposureLabel, portlessLabel, routeName, routeUrl, slugify, validateSlug } from "./names.js"

describe("names", () => {
  test("slugifies branch names for workspace aliases", () => {
    assert.equal(slugify("feature/foo_bar"), "feature-foo-bar")
    assert.equal(slugify("CARL/FixThing"), "carl-fixthing")
  })

  test("derives canonical route names", () => {
    assert.equal(routeName("tilly", "feature-x", "web"), "web-feature-x-tilly")
    assert.equal(routeName("tilly", "feature-x", "web", "app"), "app-feature-x-tilly")
  })

  test("derives route urls on the Portless proxy port", () => {
    assert.equal(routeUrl("web-feature-x-tilly", 443), "https://web-feature-x-tilly.localhost")
    assert.equal(routeUrl("web-feature-x-tilly", 1355), "https://web-feature-x-tilly.localhost:1355")
  })

  // Expected labels come from truncateLabel in Portless 0.15.12 (dist/cli.js).
  test("shortens long route names the way Portless does", () => {
    const route = routeName("syntwin-mono", "ruler-fix-tabs-size-strip-instead-of-touch-t", "preview")
    assert.equal(portlessLabel(route), "preview-ruler-fix-tabs-size-strip-instead-of-touch-t-syn-154ac3")
    assert.equal(routeUrl(route, 1355), "https://preview-ruler-fix-tabs-size-strip-instead-of-touch-t-syn-154ac3.localhost:1355")
    assert.equal(portlessLabel(`web-${"x".repeat(51)}-feature-tilly`), `web-${"x".repeat(51)}-10f294`)
    assert.equal(portlessLabel("a".repeat(63)), "a".repeat(63))
    assert.equal(portlessLabel("a".repeat(64)), `${"a".repeat(56)}-ffe054`)
  })

  test("keeps exposure labels DNS-safe and stable within 63 characters", () => {
    assert.equal(exposureLabel("cbook", "web-feature-x-tilly"), "cbook-web-feature-x-tilly")

    const label = exposureLabel("cbook", `web-${"feature-".repeat(12)}tilly`)
    assert.equal(label.length, 63)
    assert.match(label, /^cbook-web-feature-.+-[a-f0-9]{8}$/)
    assert.equal(label, exposureLabel("cbook", `web-${"feature-".repeat(12)}tilly`))
  })
})

describe("validateSlug", () => {
  test("accepts valid slugs", () => {
    const r = validateSlug("feature-x", "workspace")
    assert.equal(r.ok, true)
    if (r.ok) assert.equal(r.value, "feature-x")
  })

  test("rejects empty string", () => {
    const r = validateSlug("", "workspace")
    assert.equal(r.ok, false)
  })

  test("rejects leading dash", () => {
    const r = validateSlug("-bad", "workspace")
    assert.equal(r.ok, false)
  })

  test("rejects uppercase", () => {
    const r = validateSlug("BadName", "workspace")
    assert.equal(r.ok, false)
  })

  test("rejects characters outside [a-z0-9-]", () => {
    assert.equal(validateSlug("foo_bar", "workspace").ok, false)
    assert.equal(validateSlug("foo.bar", "workspace").ok, false)
    assert.equal(validateSlug("foo bar", "workspace").ok, false)
  })

  test("error includes the field name", () => {
    const r = validateSlug("BAD", "project")
    assert.equal(r.ok, false)
    if (!r.ok) assert.match(r.error.message, /project must match/)
  })
})
