# Security policy

This policy covers `@bivelio/savings-layer` on npm (the SDK and the `bvsala`
gateway it ships) and the control plane at savings.bivelio.com.

<!--
  Interno: cada plazo y cada cifra de «Availability» sale del código y lo
  comprueba test/disponibilidad-documentada.test.ts. Si cambias un plazo en el
  código, cámbialo aquí o el test falla. La publicación (trusted publishing,
  provenance, SBOM) la vigila test/cadena-de-suministro.test.ts.
-->

## Reporting a vulnerability

Write to **privacy@bivelio.com** with `SECURITY` in the subject line. Please include:

- the affected version (`npm ls @bivelio/savings-layer`) or URL;
- what an attacker can do, and how to reproduce it;
- whether you would like to be credited when the fix ships.

Please do not open a public issue or publish details before a fix is released.
Do not paste license keys, service keys (`bvk_…`) or provider API keys into the
report. If one has been exposed, say so, so that it can be revoked.

Fixes ship as a new version of `@bivelio/savings-layer`. There are no maintained
older release lines, so the fix is always "upgrade to the latest version".

## Verifying the package you install

### Registry signatures and provenance

In a project that has the package installed, run:

```sh
npm audit signatures
```

It checks the npm registry signature of every installed package and, where one
exists, its provenance attestation.

To check whether a specific version has a provenance attestation:

```sh
npm view @bivelio/savings-layer@<version> dist.attestations.provenance.predicateType
```

It prints `https://slsa.dev/provenance/v1` when the version has one, and nothing
when it does not. On npmjs.com, a version with provenance shows a "Provenance"
section that links to the source commit and the build that produced it.

Which versions have provenance:

- **Up to and including 0.4.24**, versions were published by hand. They carry no
  provenance attestation.
- **From the next release on**, versions are published by our release workflow
  with npm trusted publishing (short-lived OIDC credentials, no stored npm
  token). npm only generates provenance when the source repository is public.
  While our repository is private, releases are published without it, and the
  command above prints nothing.

### What the release workflow checks before publishing

The workflow packs the tarball once, checks that file, and publishes that same
file. It refuses to publish unless the tarball:

- has the license check closed (the development bypass is not compiled in);
- contains no source maps;
- embeds BiVelio's public verification key in both the SDK and the gateway.

Only the Ed25519 public key ships. The signing key never leaves our control
plane. After publishing, the workflow checks that the registry serves a tarball
with the same SHA-512 as the one it checked.

### SBOM

Each release made by the workflow produces a CycloneDX 1.5 SBOM of the published
tarball. It lists the third-party code bundled inside the package, with exact
versions, taken from the bundler's own record of what it included. It also lists
the optional peer dependency, which is not bundled. The SBOM carries the
tarball's SHA-512 and SHA-256, so you can check that it describes the file you
installed.

The SBOM is attached to the GitHub Release. While the repository is private,
write to privacy@bivelio.com to get it for the version you use.

## Availability: what happens if our servers do not respond

Once running, license checks never wait on our servers: they read state kept in
memory, and every call to our servers runs in the background. The one exception
is gateway startup, described below. What an outage changes depends on how you
run the product.

### SDK with an offline license (`licenseKey` only)

- There are no licensing calls to our servers at all. The key is verified on
  your machine against the public key embedded in the package.
- The license stops working at its expiry date plus its grace period. This is
  checked against the live clock, so no restart is needed.
- Revocations are not applied on this path, because it has no source for them.

### SDK with an online license (`licenseKey` and `licenseServerUrl`)

**Revocation list.** The SDK fetches it from `<licenseServerUrl>/licenses/revocations`
when it starts, without waiting for the answer, and then every 15 minutes, never
more often than every 5 minutes, with ±10% jitter. Each request times out after
30 seconds. During an outage, retries back off to 10, 20 and 40 minutes, and then
every 60 minutes.

- If the list cannot be fetched, or it does not verify, the last good list is
  kept. Revocations already known still apply; new ones do not arrive.
- A console warning appears after the 3rd consecutive network failure, then
  every 12th. `silenceWarnings` turns it off.

**Fail-closed after 72 hours.** The SDK stops serving if it goes 72 hours
without a confirmed answer from the revocation endpoint (an "unchanged"
response, or a list whose signature verifies). The 72 hours count from process
start or from the last confirmed answer, and each new process starts its own
window. When the limit is reached, new requests fail with `LicenseError` status
`stale` (`generate()` throws it, `generateStream()` reports it in the stream).
The message says it is a connectivity problem, not a billing one. The SDK serves
again as soon as a confirmed answer arrives. You can change the limit
with `licenseRevocation.maxStalenessSeconds`.

**Renewed license** (with `serviceAccountKey`). From 7 days before the license
expires, the SDK asks `<licenseServerUrl>/api/license/current` once an hour for
the renewed license (30-second timeout). If it cannot reach it, the current
license keeps working until its expiry plus grace period. After that, the SDK
stops with `LicenseError` status `expired`. An HTTP 401, 403 or 404 prints one
warning, because a wrong key does not fix itself.

**Usage reporting** (with `serviceAccountKey`) never blocks a request. Records
are sent every 15 seconds, in batches of 50. While the server cannot be reached
or answers with a 5xx error, up to 1,000 records are kept in memory and retried.
Beyond that, records are dropped.

### Gateway (`bvsala`)

**At startup, the gateway needs our server.** It collects your organization's
license from savings.bivelio.com with `BIVELIO_SERVICE_KEY` and verifies it on
your machine. It waits up to 10 seconds, or 3 seconds when a valid
`BIVELIO_LICENSE_KEY` fallback is set.

- If the server cannot be reached (network error, timeout, an HTTP error other
  than 401 or 404, or an unexpected answer), the gateway starts with
  `BIVELIO_LICENSE_KEY` if it is set and still valid, and says so. Without it,
  the gateway does not start (exit code 1).
- An HTTP 401 (unknown service key) or 404 (no license) is an answer, not an
  outage: the gateway does not start, with or without the fallback key.

**While running, the gateway keeps serving without our servers.**

- Each new request is checked against the loaded license, with the live clock
  and the revocations already known. The gateway serves until the license's
  expiry plus grace period, and never cuts a request in flight.
- Unlike the SDK's online path, the gateway has no 72-hour limit.
- The revocation list follows the same schedule as in the SDK. If it cannot be
  fetched, known revocations keep applying.
- Renewal: from 7 days before expiry, once an hour (30-second timeout). If it
  cannot be reached, the current license stays. A gateway that started with the
  fallback key checks right away.
- Entitlements (which savings features your plan includes, and whether the
  control plane reports your organization as blocked) are cached for up to 5
  minutes and refreshed in the background when a request arrives (10-second
  timeout). If they cannot be fetched, savings features switch off, traffic
  keeps flowing to your provider unchanged, and the gateway retries within 60
  seconds. A failed fetch never blocks your organization. Only an answer from
  the server can.
- Usage reporting works as in the SDK.

### Grace period

Each license token carries its own grace period (`grace_days`). Licenses issued
for a subscription get 21 days by default. The gateway prints the value at
startup (`+N days grace`).
