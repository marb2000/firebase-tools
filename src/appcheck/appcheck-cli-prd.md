# Firebase App Check | PRD | Firebase App Check management in the Firebase CLI

**Author:** Miguel Ramos **Status:** Draft **Date:** Jul 8, 2026

## Tl;dr;

Firebase App Check protects a project's backend resources from abuse by attesting that
incoming requests originate from an authentic, untampered instance of your app. Apps prove
their authenticity with an attestation provider: Apple App Attest / DeviceCheck, Android Play
Integrity, reCAPTCHA Enterprise (web **and**, as of June 2026, iOS and Android), or web
reCAPTCHA v3. The App Check backend then mints short-lived tokens that Firebase services
(Realtime Database, Cloud Firestore, Cloud Storage, Authentication, Firebase AI Logic, Cloud
Functions, Data Connect) can require and enforce. This document defines a design for managing
App Check (provider configuration, per-service enforcement, and debug tokens) from the
Firebase CLI.

The CLI is opinionated: every App Check-protected service should end up **enforced**, but the
path there depends on the service. For most services (Realtime Database, Cloud Firestore, Cloud
Storage, Authentication) the right, safe path is the classic graduated rollout: turn on
**unenforced** monitoring, measure verified-vs-unverified traffic, then move to **enforced**
once you've confirmed you won't reject legitimate clients. **Firebase AI Logic is the
exception:** because it fronts the Gemini API, a costly resource that abusers actively target,
it should never sit unenforced, even briefly. For AI Logic the recommended path skips the
monitoring phase: **enforce from the start, attesting with a device debug token first** during
development, then graduate to a production attestation provider before release. Firebase now
auto-enforces App Check for AI Logic, and the CLI keeps it enforced by default and pushes back
before you relax it.

## Background

Coding agents such as Antigravity, Claude Code, and Codex now deliver a large share of
application code and project configuration. When an agent builds an app backed by Firebase, a
production-readiness step is turning on App Check enforcement so the app's Firestore, Storage,
and AI Logic calls reject traffic that does not come from the real app. Today those operations
are available in the Firebase Console and through the Firebase App Check REST API
(`firebaseappcheck.googleapis.com`), but not through the Firebase CLI. Agents do not drive the
console, and Firebase agent guidance directs agents to use the Firebase CLI and MCP server
tools rather than direct REST calls. There is no agent-accessible surface for App Check today.

The Firebase CLI is the foundation for both agent surfaces: the Firebase MCP server ships
inside `firebase-tools`, and Firebase agent skills instruct agents to execute Firebase CLI
commands directly. When the `appcheck` commands ship, agents that execute shell commands can
use them immediately, and the CLI's self-documenting help (`firebase help appcheck`) makes them
discoverable without a skill update. Exposing the same operations as MCP server tools is a fast
follow within the same codebase. This document defines that CLI surface for Firebase App Check.

This design deliberately mirrors the shape of the Firebase AI Logic CLI PRD (provider groups,
enablement flow, non-interactive rules, permission mapping) so the two command surfaces feel
like one product to developers and agents.

## Design philosophy

Every App Check-protected service should end up **enforced**. There are two paths to get there,
and which one is right depends on the service.

**Most services: unenforced → measure → enforce.** For Realtime Database, Cloud Firestore,
Cloud Storage, and Authentication, the classic graduated rollout is the right, safe path: add
the App Check SDK, set the service to **unenforced** so tokens are checked and metrics collected
but nothing is rejected, watch the verified-vs-unverified breakdown until you're confident your
live clients are sending valid tokens, then move to **enforced**. Here monitoring is a genuine,
recommended step: it's how you avoid locking out existing users mid-migration, and the CLI
supports it as the normal flow.

**AI Logic: enforce from the start, debug token first.** Firebase AI Logic fronts the Gemini
API: unattested traffic is direct billing and abuse exposure, and it is a resource abusers
actively target. It should never sit unenforced, even during the monitoring window that suits
other services. So for AI Logic the recommended path deliberately **skips** the unenforced
phase:

1. **Attest with a device debug token first.** The App Check debug provider issues a per-device
   (or per-CI-runner) debug token that satisfies enforcement without a production attestation
   SDK, so a developer or agent can turn enforcement **on immediately** in development. (This is
   a device-scoped token, not a project-wide bypass; each trusted device or runner gets its own.)
2. **Graduate to a production attestation provider** (App Attest, Play Integrity, or reCAPTCHA
   Enterprise) before releasing to real users. On iOS this is now the platform default: as of
   the June 2026 SDKs, physical devices default to reCAPTCHA Enterprise (falling back to
   DeviceCheck), while simulators default to the debug provider.

Firebase now **auto-enforces** App Check for AI Logic during guided setup (rolling out early
July 2026), consistent with this path. The CLI reflects it: AI Logic is enforced by default, and
`services:set ailogic` to `off` or `unenforced` is a discouraged action that prompts for
confirmation (see Services below), whereas relaxing any other service to `unenforced` is a
routine, unprompted part of its rollout.

Debug tokens are useful for any service in CI, but for AI Logic the debug-token-first ordering
is the recommended way to be enforced from day one, which is why the CLI treats debug tokens as
a first-class workflow rather than a console-only convenience.

## Goals

- Bring Firebase App Check management operations (attestation providers, per-service
  enforcement, debug tokens) to the Firebase CLI, so developers can manage App Check from their
  terminal and CI pipelines instead of only the Firebase Console.
- Support both rollout paths as scriptable, first-class flows: the graduated **unenforced →
  measure → enforced** rollout for most services (with confirmation on the client-breaking move
  to enforced), and the **enforce-from-the-start, debug-token-first** path for AI Logic.
- Reflect the AI Logic exception: keep AI Logic enforced by default and make relaxing its
  enforcement a deliberate, confirmation-gated action, while leaving `unenforced` a routine,
  unprompted step for every other service.
- Match existing Firebase CLI conventions for output, confirmation prompts, and non-interactive
  behavior, so the commands work in CI without special casing.
- Make App Check management operations available to coding agents: immediately through direct
  CLI execution guided by Firebase agent skills, and through Firebase MCP server tools as a fast
  follow.

## Non-goals

- **Token minting and verification.** The CLI manages App Check configuration; it does not
  exchange attestations for App Check tokens or verify them. Token acquisition belongs to the
  client SDKs; token verification belongs to the Admin SDK and backend middleware.
- **App registration.** Creating and listing Firebase apps already lives under `firebase apps`.
  App Check commands operate on apps that already exist; `appcheck:apps:list` is a read-only
  convenience view that annotates existing apps with their App Check status.
- **reCAPTCHA / reCAPTCHA Enterprise key creation.** reCAPTCHA attestation providers require a
  reCAPTCHA site key created in the reCAPTCHA or Google Cloud console. The CLI consumes an
  existing key; it does not create one.
- **Per-resource enforcement policies.** Fine-grained enforcement of individual resources (for
  example, a single Cloud Function via `resourcePolicies`) is out of scope for this surface and
  can be added in a follow-up without breaking `appcheck:services:set`.
- **`firebase deploy --only appcheck` integration.** Providers and enforcement are service
  settings, not deployable artifacts, so they do not fit the deploy model. A `firebase.json`
  entry plus deploy target for provider/enforcement configuration can be added in a follow-up.

## User Stories

- **Graduated rollout (most services):** As a developer with existing clients, I want to put a
  service in **unenforced** mode first and watch verified-vs-unverified metrics, then flip it to
  **enforced**, so I don't reject my current users mid-migration.
- **Enforce AI Logic from day one:** As a developer using AI Logic, I want to enforce it
  immediately using a device debug token as my first attestation, so this costly, abuse-targeted
  API is never exposed unenforced, without needing a production attestation SDK yet.
- **Graduate attestation:** As a developer heading to production, I want to configure a real
  attestation provider (App Attest, Play Integrity, reCAPTCHA Enterprise) for each app, so I can
  drop the debug token before release.
- **Keep AI Logic safe:** As a developer, I want AI Logic enforced by default and to be warned
  before I relax it, so I don't accidentally expose the Gemini API to unattested, billable
  traffic.
- **Debug tokens for CI:** As a developer, I want to create, list, and delete App Check debug
  tokens for my CI runners and simulators, so automated tests can talk to enforced backends
  without the console.
- **Inspection:** As a developer, I want to list my apps with their App Check provider status
  and list every enforceable service with its current enforcement mode, so I can audit coverage.

## Command Surface

All commands sit under the `firebase appcheck` namespace.

All App Check management resources are global to the project (or to an app within it) on the
Firebase App Check API (`firebaseappcheck.googleapis.com`, API version `v1`). No command takes a
`--location` flag; App Check has no regional configuration surface.

The help command (`firebase help [namespace]`) recursively lists all subcommands under that
namespace prefix. For example, `firebase help appcheck:services` lists the commands to list,
get, and set service enforcement.

### Services (per-service enforcement)

Enforcement is configured per Firebase service. The CLI exposes short, developer-facing service
aliases and maps them to the underlying service resource IDs.

| Alias      | Service resource ID                | Firebase product        |
| ---------- | ---------------------------------- | ----------------------- |
| `database` | `firebasedatabase.googleapis.com`  | Realtime Database       |
| `firestore`| `firestore.googleapis.com`         | Cloud Firestore         |
| `storage`  | `firebasestorage.googleapis.com`   | Cloud Storage           |
| `auth`     | `identitytoolkit.googleapis.com`   | Firebase Authentication |
| `ailogic`  | `firebasevertexai.googleapis.com`  | Firebase AI Logic       |
| `functions`| `cloudfunctions.googleapis.com`    | Cloud Functions         |

Enforcement mode is one of three developer-facing values, mapped to the API `enforcementMode`
enum:

| Mode         | API enum     | Meaning                                                                 |
| ------------ | ------------ | ----------------------------------------------------------------------- |
| `off`        | `OFF`        | App Check is not applied. No metrics collected.                         |
| `unenforced` | `UNENFORCED` | Requests are checked and metrics collected, but unverified requests are still served. Use this to size impact before enforcing. |
| `enforced`   | `ENFORCED`   | Requests without a valid App Check token are **rejected**.              |

`firebase appcheck:services:list` lists every enforceable service and its current enforcement
mode. Read-only.

```
$ firebase appcheck:services:list
┌────────────┬───────────────────────────────────┬──────────────┐
│ Service    │ Resource ID                       │ Enforcement  │
├────────────┼───────────────────────────────────┼──────────────┤
│ firestore  │ firestore.googleapis.com          │ Enforced     │
├────────────┼───────────────────────────────────┼──────────────┤
│ storage    │ firebasestorage.googleapis.com    │ Unenforced   │
├────────────┼───────────────────────────────────┼──────────────┤
│ database   │ firebasedatabase.googleapis.com   │ Off          │
└────────────┴───────────────────────────────────┴──────────────┘
```

`firebase appcheck:services:get <service>` prints the enforcement mode for one service.

```
$ firebase appcheck:services:get firestore
Enforced
```

`firebase appcheck:services:set <service> <mode>` sets the enforcement mode for one service.

```
$ firebase appcheck:services:set firestore enforced
? Enforcing App Check on firestore will reject requests without a valid App Check token from
  clients that have not been updated to obtain one. Continue? (y/N) y
Successfully set firestore enforcement to enforced.
```

Setting a service to `enforced` prompts for confirmation, because clients that do not yet
obtain an App Check token start receiving rejections. `--force` skips the prompt. Before
enforcing, the CLI warns if the target service has no verified App Check traffic and no
configured providers, since enforcing in that state rejects effectively all requests.

Relaxing a service to `off` or `unenforced` normally does not prompt, except for **AI Logic**,
which Firebase auto-enforces as a critical, abuse-prone service. `services:set ailogic off` or
`services:set ailogic unenforced` is a discouraged action, so the CLI confirms it (and requires
`--force` in non-interactive mode) even though it is not client-breaking:

```
$ firebase appcheck:services:set ailogic unenforced
? ailogic is a critical service that Firebase enforces by default to protect it from abuse.
  Setting it to unenforced removes that protection. Continue? (y/N)
```

### Providers (attestation providers per app)

Each app is attested by a provider matching its platform. Provider types:

| Provider type          | Platforms           | Key inputs                  |
| ---------------------- | ------------------- | --------------------------- |
| `app-attest`           | Apple               | (none; token TTL only)      |
| `device-check`         | Apple               | `--key-id`, `--private-key` |
| `play-integrity`       | Android             | (none; token TTL only)      |
| `recaptcha-enterprise` | Apple, Android, Web | `--site-key`                |
| `recaptcha-v3`         | Web                 | `--site-secret`             |

As of the June 2026 Firebase SDKs, **reCAPTCHA Enterprise is an attestation provider for mobile
(iOS, with Android backend support rolling out) in addition to web**. It is no longer web-only.
On iOS, physical devices default to reCAPTCHA Enterprise (falling back to DeviceCheck) and
simulators default to the debug provider. `recaptcha-v3` remains web-only. `providers:set`
validates the provider against the target app's platform and rejects a mismatch.

`firebase appcheck:providers:list [--app <appId>]` lists the configured providers for each app
in the project (or for one app with `--app`). Read-only.

```
$ firebase appcheck:providers:list
┌──────────────────────┬──────────┬────────────────────────┬────────────┐
│ App ID               │ Platform │ Provider               │ Token TTL  │
├──────────────────────┼──────────┼────────────────────────┼────────────┤
│ 1:1234:ios:abcd      │ iOS      │ app-attest             │ 1h         │
├──────────────────────┼──────────┼────────────────────────┼────────────┤
│ 1:1234:android:efgh  │ Android  │ play-integrity         │ 1h         │
├──────────────────────┼──────────┼────────────────────────┼────────────┤
│ 1:1234:web:ijkl      │ Web      │ recaptcha-enterprise   │ 30m        │
└──────────────────────┴──────────┴────────────────────────┴────────────┘
```

`firebase appcheck:providers:get <appId> <provider>` prints one provider config.

`firebase appcheck:providers:set <appId> <provider> [flags]` configures (registers or updates) a
provider for an app. Provider-specific inputs are passed as flags; `--token-ttl <duration>` sets
the App Check token lifetime for that provider (for example `1h`, `30m`, subject to the API's
allowed range).

```
$ firebase appcheck:providers:set 1:1234:web:ijkl recaptcha-enterprise \
    --site-key 6Lxxxxxxxxxxxxxxxxxxxxxxxxx --token-ttl 30m
Successfully configured recaptcha-enterprise for app 1:1234:web:ijkl.
```

Secret inputs (`--private-key`, `--site-secret`) are write-only: the API stores them and never
returns them, so `providers:get` and `providers:list` show only whether a secret is set, never
its value. To avoid secrets in shell history and CI logs, each secret flag also accepts a
`@path/to/file` argument to read the value from a file, and an environment-variable form.

### Debug tokens

Debug tokens are the first-class starting point of the enable-by-default workflow (see Design
philosophy): they let a trusted non-production environment (a simulator, an emulator, or a CI
runner) obtain valid App Check tokens without a real attestation provider, so a developer can
turn on enforcement immediately and graduate to a production provider later. A debug token is
scoped to a single app and represents a single trusted device or runner; it is not a
project-wide bypass, and each device or runner gets its own.

`firebase appcheck:debug:create <appId> [--display-name <name>] [--token <uuid>]` creates a
debug token. The raw token value is printed **once** at creation and never again; the command
warns that it grants access to enforced backends and must be treated as a secret. With
`--token` the caller supplies the value (useful for rotating a known CI secret); otherwise the
API generates one.

```
$ firebase appcheck:debug:create 1:1234:web:ijkl --display-name "CI runner"
Created debug token "CI runner" (id: 7f3a...).

  Debug token: 3d9c8b2a-1e4f-4a7b-9c2d-5e6f7a8b9c0d

Store this value securely; it will not be shown again. Set it as the
FIREBASE_APPCHECK_DEBUG_TOKEN secret in your CI environment.
```

`firebase appcheck:debug:list <appId>` lists debug tokens for an app (id and display name only;
never the token value).

`firebase appcheck:debug:delete <appId> <tokenId> [--force]` deletes a debug token. Prompts for
confirmation, because CI or test environments relying on the token immediately lose access;
`--force` skips the prompt.

### Apps (inspection)

`firebase appcheck:apps:list` lists the project's Firebase apps annotated with their App Check
status (platform, configured provider, whether App Check is set up). Read-only; a convenience
view over `firebase apps:list` plus the App Check provider configs.

```
$ firebase appcheck:apps:list
┌──────────────────────┬──────────┬───────────────┬────────────────────────┐
│ App ID               │ Platform │ Display Name  │ App Check Provider     │
├──────────────────────┼──────────┼───────────────┼────────────────────────┤
│ 1:1234:ios:abcd      │ iOS      │ My iOS App    │ app-attest             │
├──────────────────────┼──────────┼───────────────┼────────────────────────┤
│ 1:1234:web:ijkl      │ Web      │ My Web App    │ (not configured)       │
└──────────────────────┴──────────┴───────────────┴────────────────────────┘
```

## Global flags and non-interactive behavior

All commands honor the Firebase CLI global flags. `--json` switches output from tables to JSON
for scripting. `--non-interactive` disables prompts; the CLI also auto-detects non-TTY
environments such as CI.

The following commands prompt for confirmation before a client-breaking change:
`services:set <service> enforced` (unattested clients start receiving rejections) and
`debug:delete` (environments relying on the token lose access). `--force` accepts these
confirmations. In non-interactive mode without `--force`, a command that would prompt exits with
an error instead of proceeding, matching Cloud Functions deployment behavior. The error states
the confirmation that was skipped and the exact command to rerun with `--force`.

```
$ firebase appcheck:services:set firestore enforced --non-interactive
Error: Enforcing App Check on firestore requires confirmation.

To proceed in non-interactive mode, rerun with --force:

  firebase appcheck:services:set firestore enforced --force
```

Write commands that require the Firebase App Check API (`services:set`, `providers:set`,
`debug:create`, `debug:delete`) run against a project where the API is not enabled trigger the
interactive enablement flow described under Error behavior, or exit with an error in
non-interactive mode. Read-only commands never trigger enablement: `services:list`,
`services:get`, `providers:list`, `providers:get`, `debug:list`, and `apps:list` report that
App Check is not enabled and return an empty result.

## Permissions

Commands map to Firebase App Check IAM permissions on the Firebase App Check API.

- **Read commands** (`services:list`, `services:get`, `providers:list`, `providers:get`,
  `debug:list`, `apps:list`) require `roles/firebaseappcheck.viewer` or higher, specifically
  `firebaseappcheck.appCheckConfig.get`, `firebaseappcheck.services.get`, and
  `firebaseappcheck.debugTokens.get`.
- **Write commands** (`services:set`, `providers:set`, `debug:create`, `debug:delete`) require
  `roles/firebaseappcheck.admin`, specifically `firebaseappcheck.services.update`,
  `firebaseappcheck.appCheckConfig.update`, `firebaseappcheck.debugTokens.create`, and
  `firebaseappcheck.debugTokens.delete`.

Broader roles that include these permissions (Owner, Editor, Firebase Admin) also work. When a
write command runs against a project where the App Check API is not enabled, enabling it
additionally requires `serviceusage.services.enable`, which the App Check roles do not include
but Owner and Editor do; the CLI names this permission if it is missing and, in the interactive
enablement flow, checks for it up front before prompting. When a command fails with a
permission error, the CLI names the missing permission and the narrowest role that grants it.

## Error behavior

- **API not enabled:** if the Firebase App Check API (`firebaseappcheck.googleapis.com`) is not
  enabled on the project, a write command that requires it prompts to enable it (matching
  existing CLI behavior for other services) or exits with an enablement instruction in
  non-interactive mode. Unlike Firebase AI Logic, there is no provider-selection step in the
  enablement flow; enabling the API is a single action. Read-only commands do not trigger this
  flow; they report that App Check is not enabled and return gracefully.

  Example (interactive):

  ```
  $ firebase appcheck:services:set firestore enforced
  The Firebase App Check API (firebaseappcheck.googleapis.com) is not enabled on project my-project.
  ? Would you like to enable it now? (Y/n) Y
  Enabling firebaseappcheck.googleapis.com...
  Successfully enabled the Firebase App Check API.
  ...
  ```

  Example (non-interactive):

  ```
  $ firebase appcheck:services:set firestore enforced --non-interactive
  Error: The Firebase App Check API (firebaseappcheck.googleapis.com) is not enabled on project my-project.

  Enable it by running:

    firebase appcheck:services:set firestore enforced
    (in an interactive terminal), or enable the API in the Google Cloud console.

  Then run this command again.
  ```

- **Unknown service alias:** `services:get` and `services:set` with a service not in the alias
  table exit with an error listing the valid aliases.

  ```
  $ firebase appcheck:services:set firestor enforced
  Error: Unknown service: firestor

  Valid services:

    database
    firestore
    storage
    auth
    ailogic
    functions
  ```

- **Unknown enforcement mode:** `services:set` with a mode other than `off`, `unenforced`, or
  `enforced` exits with an error listing the valid modes.

- **Provider / platform mismatch:** `providers:set` with a provider that does not match the
  app's platform (for example `play-integrity` on an iOS app) exits with an error naming the
  app's platform and the providers valid for it.

- **Missing required provider input:** `providers:set recaptcha-enterprise` without `--site-key`
  (or `device-check` without `--key-id`/`--private-key`) exits with an error naming the missing
  flag.

## Rollout plan

- **Phase 1, preview:** commands available by default, marked preview in `firebase help`.
  Command surface may still change; breaking changes require a release note. Target audience: all
  Firebase App Check developers, with feedback collected from internal teams and design partners.
- **Phase 2, general availability:** 3 to 4 months after preview. Command surface frozen;
  changes follow the standard Firebase CLI deprecation policy. Exit from preview is informed by
  the success metrics below.

## Success metrics

- **Adoption:** number of projects executing at least one `appcheck:*` command per month.
- **Enforcement outcomes:** number of services moved to `enforced` via the CLI, and the share of
  those preceded by an `unenforced` period (graduated rollout).
- **Agent usage:** share of `appcheck:*` invocations originating from agent environments,
  measured via the MCP server and agent-identifying CLI telemetry.
- **CI usage:** share of `appcheck:services:set` and `appcheck:debug:create` invocations running
  in non-interactive mode, as a proxy for App Check managed from source control and CI rather
  than the console.
- **Quality:** command error rate excluding permission and API-enablement errors, tracked per
  command group.
