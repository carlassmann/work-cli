import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { routeName, routeUrl, slugify, validateSlug } from "./names.js"

describe("names", () => {
  test("slugifies branch names for workspace aliases", () => {
    assert.equal(slugify("feature/foo_bar"), "feature-foo-bar")
    assert.equal(slugify("CARL/FixThing"), "carl-fixthing")
  })

  test("derives canonical route names", () => {
    assert.equal(routeName("tilly", "feature-x", "web"), "web-feature-x-tilly")
    assert.equal(routeName("tilly", "feature-x", "web", "app"), "app-feature-x-tilly")
  })

  test("derives canonical route urls", () => {
    assert.equal(routeUrl("tilly", "feature-x", "web"), "https://web-feature-x-tilly.localhost")
    assert.equal(routeUrl("tilly", "feature-x", "web", "app"), "https://app-feature-x-tilly.localhost")
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
