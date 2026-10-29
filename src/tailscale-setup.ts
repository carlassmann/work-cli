import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Resolver } from "node:dns/promises"
import { X509Certificate, createPrivateKey } from "node:crypto"
import type { KeyObject } from "node:crypto"
import { execFile, spawn } from "node:child_process"
import { promisify } from "node:util"
import { readGlobalConfig, updateGlobalConfig } from "./config.js"
import { acmeManagesCertificate, renewalScheduled, scheduleRenewal } from "./certificate-renewal.js"
import { childEnvironment } from "./environment.js"
import { errResult, ok } from "./result.js"
import { portlessPort, portlessServiceCustomization, portlessTlds } from "./portless-proxy.js"
import { commandExists } from "./shell.js"
import { certificatePaths, isPreviewDomain, savedTailscaleDomain, tailscaleExposure } from "./tailscale.js"
import type { Result } from "./result.js"

const exec = promisify(execFile)
const RENEW_BEFORE_DAYS = 30
const CLOUDFLARE_TIMEOUT_MS = 30_000
const ACME_TIMEOUT_MS = 5 * 60_000
const BREW_TIMEOUT_MS = 10 * 60_000
const CLOUDFLARE_TOKEN_URL = "https://dash.cloudflare.com/profile/api-tokens"

type SetupPrompts = {
  ask(question: string): Promise<string>
  askSecret(question: string): Promise<string>
  confirm(question: string): Promise<boolean>
  waitForEnter(question: string): Promise<void>
}

type SetupOptions = {
  domain?: string | undefined
  environment: NodeJS.ProcessEnv
  prompts: SetupPrompts
  log: (line: string) => void
  fetch?: typeof fetch
}

export async function runTailscaleSetup(options: SetupOptions): Promise<Result<void>> {
  const { environment, prompts, log } = options

  const ip = await tailnetIPv4(environment)
  if (!ip.ok) return ip
  log(`✓ Tailscale is connected. This machine is ${ip.value} in your tailnet.`)

  const saved = await readGlobalConfig(environment)
  if (!saved.ok) return saved
  const savedDomain = savedTailscaleDomain(saved.value)
  const domain = (options.domain ?? savedDomain ?? await prompts.ask("Domain for previews, for example dev.example.com: ")).trim().toLowerCase()
  if (!domain) return errResult("CLIError", "no domain given. Pass --domain dev.example.com")
  if (!isPreviewDomain(domain)) return errResult("CLIError", `not a usable domain: ${domain}`)
  if (!options.domain && savedDomain) log(`Using the saved domain ${domain}. Pass --domain to change it.`)

  const paths = certificatePaths(domain, environment)
  const dnsReady = await wildcardResolvesTo(domain, ip.value)
  const certificate = await certificateStatus(paths, domain)
  const certificateReady = certificate.state === "valid" && certificate.daysLeft > RENEW_BEFORE_DAYS
  log(dnsReady ? `✓ DNS: *.${domain} points to ${ip.value}.` : `• DNS: *.${domain} must point to ${ip.value}.`)
  log(certificateReady && certificate.state === "valid"
    ? `✓ Certificate: valid for ${certificate.daysLeft} more days.`
    : `• Certificate: ${certificate.state === "valid" ? `expires in ${certificate.daysLeft} days` : certificate.state === "missing" ? "none yet" : certificate.reason}.`)

  if (!dnsReady || !certificateReady) {
    log("")
    const cloudflare = await prompts.confirm(`Is ${domain} on Cloudflare DNS? Then work sets up ${dnsReady ? "the certificate" : "the record and the certificate"} for you.`)
    const zone = cloudflare ? await cloudflareZone(domain, options) : ok(null)
    if (!zone.ok) return zone

    if (!dnsReady) {
      const dns = zone.value
        ? await createRecord(zone.value, domain, ip.value, options)
        : await waitForManualRecord(domain, ip.value, options)
      if (!dns.ok) return dns
    }

    if (!certificateReady) {
      const issued = zone.value ? await issueCertificate(domain, zone.value, options) : manualCertificate(domain, options)
      if (!issued.ok) return issued
    }
  }

  // A rerun with a valid certificate still repairs renewal, which an earlier run may have failed to schedule.
  if (certificateReady && await acmeManagesCertificate(domain, environment) && !await renewalScheduled(environment)) {
    const acme = await installedAcmeSh(environment)
    if (acme) log(renewalLine(await scheduleRenewal(acme, environment, (args) => runWithTimeout(acme, args, childEnvironment(environment), ACME_TIMEOUT_MS))))
  }

  await serveDomainOnThisMachine(domain, options)

  const stored = await updateGlobalConfig({ tailscale: { domain } }, environment)
  if (!stored.ok) return stored

  log("")
  log(`✓ Saved. Routed commands will use https://{command}-{workspace}-{project}.${domain}`)
  log("")
  log("If the app signs users in with OAuth (for example WorkOS), allow:")
  log(`  redirect URI   https://*.${domain}/<callback path>`)
  log(`  web origin     https://*.${domain}`)
  log("")
  log("Then, in a project:")
  log("  work setup --tailscale     # if your setup hook writes URLs into config")
  log("  work up --tailscale")
  return ok(undefined)
}

async function tailnetIPv4(environment: NodeJS.ProcessEnv): Promise<Result<string>> {
  if (!await commandExists("tailscale", environment)) {
    return errResult("ProcessError", "the tailscale CLI was not found. Install Tailscale, sign in, and make sure tailscale is on PATH.")
  }
  try {
    const { stdout } = await exec("tailscale", ["ip", "-4"], { env: childEnvironment(environment), timeout: 15_000 })
    const ip = stdout.trim().split("\n")[0]?.trim()
    if (ip && /^100\.\d+\.\d+\.\d+$/.test(ip)) return ok(ip)
  } catch {}
  return errResult("ProcessError", "Tailscale is not connected. Start Tailscale, sign in, then run this again.")
}

async function wildcardResolvesTo(domain: string, ip: string, servers = ["1.1.1.1", "8.8.8.8"]) {
  const resolver = new Resolver({ timeout: 3_000, tries: 2 })
  resolver.setServers(servers)
  try {
    // Every address must match: clients pick any of them, and a stray one sends some requests elsewhere.
    const addresses = await resolver.resolve4(`work-check.${domain}`)
    return addresses.length > 0 && addresses.every((address) => address === ip)
  } catch {
    return false
  }
}

type CloudflareZone = { token: string; zoneId: string; dns: CloudflareDns }

async function cloudflareZone(domain: string, options: SetupOptions): Promise<Result<CloudflareZone>> {
  let token = options.environment["CLOUDFLARE_API_TOKEN"] || options.environment["CF_Token"]
  if (!token) {
    options.log(`  Create a token at ${CLOUDFLARE_TOKEN_URL}`)
    options.log(`  Template "Edit zone DNS", Zone Resources: Include → Specific zone → the zone of ${domain}.`)
    token = (await options.prompts.askSecret("  Paste the token (input is hidden): ")).trim()
  }
  if (!token) return errResult("CLIError", "no Cloudflare token given")
  const dns = new CloudflareDns(token, options.fetch ?? fetch)
  const zone = await dns.findZone(domain)
  return zone.ok ? ok({ token, zoneId: zone.value, dns }) : zone
}

async function createRecord(zone: CloudflareZone, domain: string, ip: string, options: SetupOptions): Promise<Result<void>> {
  const record = await zone.dns.upsertWildcard(zone.zoneId, domain, ip, (current) =>
    options.prompts.confirm(`  *.${domain} currently points to ${current}. Replace it with ${ip}?`))
  if (!record.ok) return record
  options.log(`✓ DNS: ${record.value} *.${domain} → ${ip} (DNS only).`)
  return ok(undefined)
}

async function waitForManualRecord(domain: string, ip: string, options: SetupOptions): Promise<Result<void>> {
  options.log("  Add this record at your DNS provider:")
  options.log(`    Type A   Name *.${domain}   Value ${ip}   (no proxy / DNS only)`)
  await options.prompts.waitForEnter("  Press Enter once it is saved…")
  if (!await waitForResolution(domain, ip)) {
    return errResult("ProcessError", `*.${domain} does not resolve to ${ip} yet. DNS can take a few minutes; run work tailscale setup again.`)
  }
  options.log("✓ DNS resolves.")
  return ok(undefined)
}

async function waitForResolution(domain: string, ip: string) {
  for (let attempt = 0; attempt < 24; attempt++) {
    if (await wildcardResolvesTo(domain, ip)) return true
    await new Promise((resolve) => setTimeout(resolve, 5_000))
  }
  return false
}

export class CloudflareDns {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch,
    private readonly api = "https://api.cloudflare.com/client/v4",
  ) {}

  // The zone is the longest suffix of the domain that Cloudflare knows.
  async findZone(domain: string): Promise<Result<string>> {
    const labels = domain.split(".")
    for (let index = 0; index < labels.length - 1; index++) {
      const name = labels.slice(index).join(".")
      const zones = await this.request<Array<{ id: string }>>(`/zones?name=${encodeURIComponent(name)}`)
      if (!zones.ok) return zones
      const zone = zones.value[0]
      if (zone) return ok(zone.id)
    }
    return errResult("ConfigError", `the token cannot see a Cloudflare zone for ${domain}. Give it Zone → DNS → Edit on that zone.`)
  }

  async upsertWildcard(
    zoneId: string,
    domain: string,
    ip: string,
    confirmReplace: (current: string) => Promise<boolean>,
  ): Promise<Result<"Created" | "Updated" | "Kept">> {
    const name = `*.${domain}`
    const existing = await this.request<Array<{ id: string; content: string; proxied: boolean }>>(
      `/zones/${zoneId}/dns_records?type=A&name=${encodeURIComponent(name)}`,
    )
    if (!existing.ok) return existing
    const body = { type: "A", name, content: ip, proxied: false, ttl: 1, comment: "work: tailnet previews" }
    const keep = existing.value.find((record) => record.content === ip) ?? existing.value[0]
    const others = existing.value.filter((record) => record !== keep)
    const elsewhere = existing.value.filter((record) => record.content !== ip).map((record) => record.content)
    if (elsewhere.length > 0 && !await confirmReplace(elsewhere.join(", "))) {
      return errResult("CLIError", `left *.${domain} unchanged`)
    }

    // A wildcard with several A records splits traffic, so only the one pointing here may stay.
    for (const record of others) {
      const removed = await this.request(`/zones/${zoneId}/dns_records/${record.id}`, { method: "DELETE" })
      if (!removed.ok) return removed
    }
    if (!keep) {
      const created = await this.request(`/zones/${zoneId}/dns_records`, { method: "POST", body })
      return created.ok ? ok("Created") : created
    }
    if (keep.content === ip && !keep.proxied) return ok(others.length > 0 ? "Updated" : "Kept")
    const updated = await this.request(`/zones/${zoneId}/dns_records/${keep.id}`, { method: "PATCH", body })
    return updated.ok ? ok("Updated") : updated
  }

  private async request<T>(route: string, init: { method?: string; body?: unknown } = {}): Promise<Result<T>> {
    let response: Response
    try {
      response = await this.fetchImpl(`${this.api}${route}`, {
        method: init.method ?? "GET",
        headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
        signal: AbortSignal.timeout(CLOUDFLARE_TIMEOUT_MS),
        ...(init.body ? { body: JSON.stringify(init.body) } : {}),
      })
    } catch (cause) {
      return errResult("ProcessError", "could not reach the Cloudflare API", cause)
    }
    const payload = await response.json().catch(() => null) as { success?: boolean; result?: T; errors?: Array<{ message?: string }> } | null
    if (!response.ok || !payload?.success) {
      const message = payload?.errors?.map((error) => error.message).filter(Boolean).join("; ") || `HTTP ${response.status}`
      return errResult("ProcessError", `Cloudflare API: ${message}`)
    }
    return ok(payload.result as T)
  }
}

export type CertificateStatus =
  | { state: "missing" }
  | { state: "invalid"; reason: string }
  | { state: "valid"; expiresAt: Date; daysLeft: number }

export async function certificateStatus(
  paths: { certFile: string; keyFile: string },
  domain: string,
  now = new Date(),
): Promise<CertificateStatus> {
  let certificate: X509Certificate
  try {
    certificate = new X509Certificate(await fs.readFile(paths.certFile))
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === "ENOENT" ? { state: "missing" } : { state: "invalid", reason: "not a PEM certificate" }
  }
  if (!certificate.subjectAltName?.split(", ").includes(`DNS:*.${domain}`)) {
    return { state: "invalid", reason: `does not cover *.${domain}` }
  }
  const keyProblem = await privateKeyProblem(certificate, paths.keyFile)
  if (keyProblem) return { state: "invalid", reason: keyProblem }
  const expiresAt = new Date(certificate.validTo)
  const daysLeft = Math.floor((expiresAt.getTime() - now.getTime()) / 86_400_000)
  return daysLeft < 0 ? { state: "invalid", reason: `expired on ${expiresAt.toISOString().slice(0, 10)}` } : { state: "valid", expiresAt, daysLeft }
}

async function privateKeyProblem(certificate: X509Certificate, keyFile: string): Promise<string | null> {
  let key: KeyObject
  try {
    key = createPrivateKey(await fs.readFile(keyFile))
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === "ENOENT" ? `has no private key at ${keyFile}` : `has an unreadable private key at ${keyFile}`
  }
  return certificate.checkPrivateKey(key) ? null : `does not match the private key at ${keyFile}`
}

function manualCertificate(domain: string, options: SetupOptions): Result<void> {
  const paths = certificatePaths(domain, options.environment)
  options.log(`  Issue a certificate for *.${domain} with your DNS provider's plugin, then install it here:`)
  options.log(`    fullchain  ${paths.certFile}`)
  options.log(`    key        ${paths.keyFile}`)
  options.log(`  For example: acme.sh --issue --server letsencrypt --dns <dns_provider> -d '*.${domain}'`)
  options.log("  Providers: https://github.com/acmesh-official/acme.sh/wiki/dnsapi")
  return errResult("CLIError", "run work tailscale setup again once the certificate is installed")
}

async function issueCertificate(domain: string, zone: CloudflareZone, options: SetupOptions): Promise<Result<void>> {
  const { environment, log } = options
  const paths = certificatePaths(domain, environment)
  const acme = await findAcmeSh(environment, options.prompts, log)
  if (!acme.ok) return acme

  log(`  Requesting *.${domain} from Let's Encrypt. This takes about a minute…`)
  const acmeEnvironment = { ...childEnvironment(environment), CF_Token: zone.token, CF_Zone_ID: zone.zoneId }
  const issued = await runWithTimeout(acme.value, ["--issue", "--server", "letsencrypt", "--dns", "dns_cf", "-d", `*.${domain}`, "--keylength", "ec-256"], acmeEnvironment, ACME_TIMEOUT_MS)
  // acme.sh exits with 2 when its copy is still current and it skipped the request.
  if (issued.code !== 0 && issued.code !== 2) {
    return errResult("ProcessError", `acme.sh could not issue the certificate:\n${lastLines(issued.output)}`)
  }

  for (const file of [paths.certFile, paths.keyFile]) await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const installed = await runWithTimeout(acme.value, ["--install-cert", "-d", `*.${domain}`, "--ecc", "--fullchain-file", paths.certFile, "--key-file", paths.keyFile], acmeEnvironment, ACME_TIMEOUT_MS)
  if (installed.code !== 0) return errResult("ProcessError", `acme.sh could not install the certificate:\n${lastLines(installed.output)}`)

  const status = await certificateStatus(paths, domain)
  if (status.state !== "valid") return errResult("ProcessError", `the installed certificate is unusable (${status.state === "invalid" ? status.reason : "missing"})`)
  log(`✓ Certificate: valid until ${status.expiresAt.toISOString().slice(0, 10)}.`)
  log(renewalLine(await scheduleRenewal(acme.value, environment, (args) => runWithTimeout(acme.value, args, acmeEnvironment, ACME_TIMEOUT_MS))))
  return ok(undefined)
}

function renewalLine(renewal: Result<string>) {
  return renewal.ok ? `✓ Renewal: ${renewal.value}` : `• Renewal: not scheduled. ${renewal.error.message}\n  Run work tailscale setup again to retry.`
}

// *.<domain> resolves to this machine's tailnet address, and tailscale serve answers only
// other devices, so this machine's own browser would land on a 404. Portless 0.15.1 serves
// extra domains given as --tld and maps their names to 127.0.0.1 in /etc/hosts, which makes
// the same URLs open here too.
async function serveDomainOnThisMachine(domain: string, options: SetupOptions) {
  const { environment, prompts, log } = options
  if (!await commandExists("portless", environment)) return
  const tlds = await portlessTlds(environment)
  const port = await portlessPort(environment)
  const version = await portlessVersion(environment)
  const customization = tlds.includes(domain) || port !== 443 ? null : await portlessServiceCustomization(environment)
  const plan = portlessDomainPlan(domain, tlds, port, version, customization)
  if (plan.state === "ready") {
    log(`✓ This machine: Portless serves *.${domain} too, so the URLs open here as well.`)
    return
  }

  log(`• This machine: *.${domain} points to its tailnet address, which only other devices reach.`)
  if (plan.state === "port") {
    log(`  Portless listens on :${port}, but the URLs use :443, so they open only on other devices. Use the *.localhost URLs here.`)
    return
  }
  if (plan.state === "outdated") {
    log("  Portless 0.15.1 or newer can serve the domain here too. Update it (npm install -g portless@latest) and run work tailscale setup again.")
    return
  }

  const command = `portless ${plan.args.join(" ")}`
  if (plan.state === "manual") {
    log(`  Portless can serve it here too, but reinstalling its service would reset other settings: ${plan.reason}.`)
    log(`  Run this with your own options added: ${command}`)
    return
  }
  if (!await prompts.confirm(`  Let Portless serve it here too? This reinstalls its startup service with \`${command}\` and asks for your password.`)) {
    log(`  To do it later: ${command}`)
    return
  }
  const code = await runInteractive("portless", plan.args, childEnvironment(environment))
  log(code === 0
    ? `✓ This machine: Portless serves *.${domain}. Restart running routed commands (work restart --all) so they get the new names.`
    : `  Portless exited with code ${code}. Run it yourself: ${command}`)
}

// The names map to 127.0.0.1 without a port, so Portless must listen on 443 for them to open here.
export function portlessDomainPlan(domain: string, tlds: Array<string>, port: number, version: string | null, customization: string | null):
  | { state: "ready" }
  | { state: "port" }
  | { state: "outdated" }
  | { state: "manual"; reason: string; args: Array<string> }
  | { state: "install"; args: Array<string> } {
  if (port !== 443) return { state: "port" }
  if (tlds.includes(domain)) return { state: "ready" }
  if (!version || compareVersions(version, "0.15.1") < 0) return { state: "outdated" }
  const args = ["service", "install", ...[...tlds, domain].flatMap((tld) => ["--tld", tld])]
  return customization ? { state: "manual", reason: customization, args } : { state: "install", args }
}

function compareVersions(left: string, right: string) {
  const a = left.split(".").map(Number)
  const b = right.split(".").map(Number)
  for (let index = 0; index < 3; index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

async function portlessVersion(environment: NodeJS.ProcessEnv) {
  try {
    const { stdout } = await exec("portless", ["--version"], { env: childEnvironment(environment) })
    return /\d+\.\d+\.\d+/.exec(stdout)?.[0] ?? null
  } catch {
    return null
  }
}

// Portless asks for the password itself, so it needs the terminal.
function runInteractive(command: string, args: Array<string>, env: NodeJS.ProcessEnv) {
  return new Promise<number>((resolve) => {
    const child = spawn(command, args, { env, stdio: "inherit" })
    child.on("error", () => resolve(127))
    child.on("exit", (code) => resolve(code ?? 1))
  })
}

async function installedAcmeSh(environment: NodeJS.ProcessEnv): Promise<string | null> {
  if (await commandExists("acme.sh", environment)) return "acme.sh"
  const home = path.join(os.homedir(), ".acme.sh", "acme.sh")
  return await fs.access(home).then(() => true, () => false) ? home : null
}

async function findAcmeSh(environment: NodeJS.ProcessEnv, prompts: SetupPrompts, log: (line: string) => void): Promise<Result<string>> {
  const installed = await installedAcmeSh(environment)
  if (installed) return ok(installed)

  if (await commandExists("brew", environment) && await prompts.confirm("  acme.sh issues the certificate. Install it with Homebrew now?")) {
    log("  Installing acme.sh…")
    const installed = await runWithTimeout("brew", ["install", "acme.sh"], childEnvironment(environment), BREW_TIMEOUT_MS)
    if (installed.code === 0) return ok("acme.sh")
    return errResult("ProcessError", `brew install acme.sh failed:\n${lastLines(installed.output)}`)
  }
  return errResult("ProcessError", "acme.sh is required to issue the certificate: https://github.com/acmesh-official/acme.sh#1-how-to-install")
}

export function runWithTimeout(command: string, args: Array<string>, env: NodeJS.ProcessEnv, timeoutMs: number) {
  return new Promise<{ code: number; output: string }>((resolve) => {
    // Its own process group, so a timeout also stops grandchildren that hold the output pipes open.
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"], detached: true })
    let output = ""
    let timedOut = false
    const stop = (signal: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, signal)
      } catch {}
    }
    const timer = setTimeout(() => {
      timedOut = true
      output += `\n${command} did not finish within ${Math.round(timeoutMs / 60_000)} minutes and was stopped.`
      stop("SIGTERM")
      setTimeout(() => stop("SIGKILL"), 5_000).unref()
    }, timeoutMs)
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString() })
    child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString() })
    child.on("error", (cause) => { clearTimeout(timer); resolve({ code: -1, output: cause.message }) })
    // A timeout fails the run even if the direct child already exited 0 and only descendants lingered.
    child.on("close", (code) => { clearTimeout(timer); resolve({ code: timedOut ? -1 : code ?? -1, output }) })
  })
}

function lastLines(output: string, count = 15) {
  return output.trim().split("\n").slice(-count).join("\n")
}

export async function tailscaleDoctorLine(environment: NodeJS.ProcessEnv): Promise<string> {
  const exposure = await tailscaleExposure(environment)
  if (!exposure.ok) return `tailscale\tnot configured\t${exposure.error.message}`
  if (exposure.value.mode !== "tailscale") return "tailscale\tnot configured"
  const { domain, certFile, keyFile } = exposure.value

  const certificate = await certificateStatus({ certFile, keyFile }, domain)
  if (certificate.state === "missing") return `tailscale\tmissing\t${certFile}. Run: work tailscale setup`
  if (certificate.state === "invalid") return `tailscale\tinvalid\tcertificate ${certificate.reason}. Run: work tailscale setup`

  const ip = await tailnetIPv4(environment)
  if (!ip.ok) return `tailscale\tmissing\t${ip.error.message}`
  if (!await wildcardResolvesTo(domain, ip.value)) return `tailscale\tdns\t*.${domain} does not point to ${ip.value}. Run: work tailscale setup`
  if (certificate.daysLeft <= 14) return `tailscale\texpiring\tcertificate expires in ${certificate.daysLeft} days. Run: work tailscale setup`
  return `tailscale\tok\t${domain} (certificate ${certificate.daysLeft} days)${await localAccessNote(domain, environment)}`
}

async function localAccessNote(domain: string, environment: NodeJS.ProcessEnv) {
  const port = await portlessPort(environment)
  if (port !== 443) return `; this machine opens the URLs only through *.localhost, because Portless listens on :${port}`
  if (!(await portlessTlds(environment)).includes(domain)) return `; this machine opens the URLs only after work tailscale setup lets Portless serve ${domain}`
  return ""
}
