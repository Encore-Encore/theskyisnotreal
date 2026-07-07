# DNS for AI Discovery (DNS-AID)

Reference for the agent-discovery DNS records published for `theskyisnotreal.com`.
These records live in **Cloudflare DNS**, not in this repo (there is no
DNS-as-code pipeline here) — this file is the source of truth for what *should*
be configured, so the intended DNS state travels with the code it describes.

- Spec: <https://datatracker.ietf.org/doc/draft-mozleywilliams-dnsop-dnsaid/>
- SVCB/HTTPS records: <https://www.rfc-editor.org/rfc/rfc9460>
- Validator: `POST https://isitagentready.com/api/scan` →
  `checks.discoverability.dnsAid.status == "pass"`

## What they point at

The `_a2a` record advertises the site's real A2A agent, implemented in the
Worker ([`src/index.js`](../src/index.js)):

- **Agent Card:** `https://theskyisnotreal.com/.well-known/agent-card.json`
  (legacy alias: `/.well-known/agent.json`)
- **JSON-RPC 2.0 endpoint:** `POST https://theskyisnotreal.com/a2a`
  (`message/send`; CORS + OPTIONS handled; stateless)

Agents resolve the SVCB record to the host, then fetch the Agent Card to learn
the actual endpoint `url`. The record is a discovery hint; the transport is
ordinary HTTPS.

## Records (ServiceMode SVCB)

Zone-file form:

```dns
; A2A agent endpoint (backed by /a2a + the Agent Card)
_a2a._agents.theskyisnotreal.com.   3600 IN SVCB 1 theskyisnotreal.com. (
                                      alpn="a2a" port=443 mandatory=alpn,port )

; Generic discovery entrypoint (points agents at the site over h2)
_index._agents.theskyisnotreal.com. 3600 IN SVCB 1 theskyisnotreal.com. (
                                      alpn="h2" port=443 )
```

Cloudflare dashboard form (**DNS → Records → Add record**):

| Field    | `_a2a._agents`            | `_index._agents` |
| -------- | ------------------------- | ---------------- |
| Type     | SVCB                      | SVCB             |
| Name     | `_a2a._agents`            | `_index._agents` |
| TTL      | 1h                        | 1h               |
| Priority | 1                         | 1                |
| Target   | `theskyisnotreal.com`     | `theskyisnotreal.com` |
| Value    | `alpn="a2a" port=443 mandatory="alpn,port"` | `alpn="h2" port=443` |

> Note: `alpn="a2a"` is a DNS-AID service label, not a real TLS ALPN token —
> A2A runs over normal HTTPS (h2). It marks the record as "an A2A service lives
> here"; the negotiated transport is still h2/http1.1.

## DNSSEC

Enabled on the zone (Cloudflare → DNS → Settings → DNSSEC). The DS record below
is published at the registrar so validating resolvers return authenticated data:

```dns
theskyisnotreal.com. 3600 IN DS 2371 13 2 06F2A15E91B9F27FD9B35918E094E9C4302DE991A42D8C42B0EFE9CC938240DF
```

- Key tag: `2371`
- Algorithm: `13` (ECDSA Curve P-256 with SHA-256)
- Digest type: `2` (SHA-256)

## Operational notes

- Deploy the Worker (`npm run deploy`) before publishing/relying on `_a2a`, so
  the advertised endpoint is live rather than 404.
- If the apex host or endpoint path changes, update these records and the
  Agent Card `url` together.
