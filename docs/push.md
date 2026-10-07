# Push notifications

anywh can notify a phone when a session needs attention, even with the app
closed. The relay does not talk to Apple (or anyone else's push service). It
sends a small event to an address a client gave it, and whatever answers at
that address does the delivery. This page is the contract on both sides of
that address, so a build of the app with its own accounts can supply its own.

Nothing here is required. A relay with no registered address never sends
anything, and a client with no address provider keeps the local desktop and
OS notifications it always had.

## Who does what

```
 app ──(1) PUT /push/devices/:deviceId ──▶ relay
                                            │ a turn ends, a prompt waits…
                                            ▼
                              (2) POST <gatewayUrl>  ──▶ gateway ──▶ the push service ──▶ the phone
```

- The **client** holds an *address*: `{gatewayUrl, pushKey}`. It registers it
  on every relay it uses (1).
- The **relay** stores addresses and, when something is worth a notification
  and nobody is looking, posts the event to each address's gateway (2). It
  treats `pushKey` as an opaque secret and never learns what it stands for.
- The **gateway** turns a `pushKey` into a device, decides whether that device
  may be notified, and delivers. It is not part of this repository.

`pushKey` is a capability: whoever holds it can send that device a
notification, so the relay keeps it in an owner-only file and never lists it.

## Contract B — registering an address (client → relay)

No authentication of its own, like every route on the relay: the network it is
reachable on is the boundary.

```
PUT    /push/devices/:deviceId     register or refresh        → 204
DELETE /push/devices/:deviceId     forget                     → 204 (also when absent)
GET    /push/devices               list, without keys         → 200 {"devices": [...]}
```

`:deviceId` is chosen by the client: 8–64 characters of `A–Z a–z 0–9 _ -`.
Re-registering the same id replaces the entry.

```jsonc
// PUT body
{
  "gatewayUrl": "https://…",          // https, or http only for a loopback host
  "pushKey":    "…",                  // opaque, 1–256 characters
  "label":      "Wil's iPhone",       // optional, up to 64
  "data":       { "profileId": "…" }  // optional JSON object, up to 512 bytes
}
```

`data` is echoed back to the gateway untouched with every notification. The
client uses it for what only it knows — which profile this relay is, on that
device — so a tap can be routed. A malformed body is a `400`.

```jsonc
// GET answer
{ "devices": [ { "deviceId": "…", "label": "…" /* or null */, "lastSeenAt": 1760000000000 } ] }
```

An entry nobody re-registers for 30 days is dropped; the client is expected to
register on launch and whenever its address changes.

`RELAY_PUSH_DISABLED=1` removes the whole feature: these routes then answer as
they do on a relay that predates them (`426`), which is how a client learns to
keep notifying locally. `RELAY_PUSH_DEVICES_FILE` says where the registry
lives.

## Contract C — notifying (relay → gateway)

```
POST <gatewayUrl>
content-type: application/json

{
  "v": 1,
  "eventId": "<uuid>",
  "event": {
    "kind": "turn_completed" | "turn_stopped" | "turn_failed" | "approval_required" | "choice_required",
    "sessionId": "…",
    "title":   "…" | null,
    "preview": "…" | null,
    "ts": 1760000000000
  },
  "devices": [ { "pushKey": "…", "data": { … } } ]
}
```

One request per gateway, listing every device of that gateway. `title` is the
conversation's name and `preview` the start of what the agent said (160
characters, markdown and code blocks stripped) — the same text the desktop
notification shows. Either is `null` when there is nothing to say, and the
gateway words the notification itself then. Two kinds deliberately carry no
preview: a failed turn (the error text is written for logs) and an approval
(the command being approved can hold anything).

| `kind` | When |
|---|---|
| `turn_completed` | a turn ended normally |
| `turn_stopped` | the person stopped a turn |
| `turn_failed` | a turn could not run |
| `approval_required` | the agent is waiting for a tool approval |
| `choice_required` | the agent asked a question with options |

Intermediate messages, tool calls, background jobs and downloads never
notify.

### The answer

| Status | Meaning | What the relay does |
|---|---|---|
| `200 {"rejected": [...], "failed": [...]}` | delivered, except the listed keys | forgets `rejected` keys, retries `failed` ones alone |
| `400` | the request itself is wrong | gives up on this event |
| `429`, `5xx`, no answer | try later | repeats the whole request, honouring `Retry-After` |

- **`rejected` means permanent**: the key is unknown, its device was revoked,
  its owner is no longer entitled, or the push service says the device token
  is dead. The relay deletes every registration holding that key. Say
  `rejected` only when it is true for good — a gateway that rejects on its
  *own* misconfiguration wipes every user's registrations. Answer `503`
  instead.
- **`failed` means transient**: worth another try.
- Retries keep the same `eventId` — a gateway can use it to avoid notifying
  twice — start at 2 s, double, are shortened by up to half at random, and stop
  after 5 attempts (about half a minute). The queue is in memory; a relay
  restart forgets what was waiting.
- Redirects are not followed, and requests time out after 10 s.
- The relay logs the event id, kind, the gateway's origin and counts. It does
  not log titles, previews or keys.

## Contract E — who is looking (client → relay)

A client tells the relay, over each session's chat WebSocket, whether the
session is on its screen:

```json
{ "type": "presence", "visible": true }
```

While at least one connected client claims `visible: true` for a session, the
relay sends **nothing** for it — to any device. A claim is a **45-second
lease**: clients repeat it every 20 seconds while true, and send
`visible: false` when they stop looking. The lease matters because a suspended
phone keeps its socket open without running any code; a flag set once would
mute the session until the relay restarted. A client that never sends
`presence` never silences anything, so an older client errs towards notifying.

An older relay ignores the message, and the wire version does not change.

## Providing an address (client)

The client has no address of its own. A build that wants push installs a
provider:

```ts
import { setPushAddressProvider } from "@/lib/platform/pushAddress";

setPushAddressProvider({
  // The current address, or null when there is none (signed out, no permission).
  getAddress: async () => ({ gatewayUrl, pushKey }),
  // Called with a new address whenever it changes (rotated, signed out).
  subscribe: (listener) => { /* … */ return () => { /* unsubscribe */ }; },
});
```

With no provider installed the feature is inert. With one, the client
registers its address on each relay when the address arrives, when a profile
is added, and on the first connection after launch (at most once a day per
profile if nothing changed), and removes it from each relay before removing
the profile. On a platform that supports it, a relay that predates push or has
it disabled leaves local notifications in place for that profile.

Where `gatewayUrl` and `pushKey` come from is the provider's business. The
build of the app published on the App Store obtains them from the anywh
service after sign-in; nothing in this repository knows how.

## Running your own

Build the app with your own Apple team and bundle identifier, implement a
provider that returns an address you issued, and run a gateway that implements
contract C. The gateway is where a device is looked up, where you decide who
may be notified, and where the push service's credentials live — none of that
passes through the relay.
