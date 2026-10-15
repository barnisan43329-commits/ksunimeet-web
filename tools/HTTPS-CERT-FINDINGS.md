# HTTPS for ksunimeet.b4rn1.com — why no certificate, and what can be done

Investigated: the certificate for `ksunimeet.b4rn1.com` has never been issued.
GitHub serves its generic `*.github.io` certificate for the domain, so
`https://ksunimeet.b4rn1.com/` fails and the site only works over `http://`.

**Conclusion: this is a GitHub Pages fault, not a configuration error on our
side. Nothing in DNS, CAA, the repository, or the Pages settings is wrong, and
nothing we change here will make the certificate appear.**

---

## What the certificate actually is right now

```
subject : CN=*.github.io
issuer  : Let's Encrypt
valid   : Sep 30 2026 -> Dec 29 2026
SANs    : DNS:*.github.com, DNS:*.github.io, DNS:*.githubusercontent.com,
          DNS:github.com, DNS:github.io, DNS:githubusercontent.com
```

`ksunimeet.b4rn1.com` is not in that list, so the browser rejects the
connection with `ERR_TLS_CERT_ALTNAME_INVALID`. The same certificate is served
when no SNI name is sent, i.e. it is a catch-all, not one issued for us.

## GitHub's own health check says our configuration is correct

`GET /repos/barnisan43329-commits/ksunimeet-web/pages/health`:

```
dns_resolves: true                 is_valid: true
has_cname_record: true             reason: null
is_cname_to_github_user_domain: true   is_served_by_pages: true
is_proxied: false                  is_a_record: false
is_non_github_pages_ip_present: false   is_old_ip_address: false
is_https_eligible: true            caa_error: null
responds_to_https: false           https_error: "peer_failed_verification"
enforces_https: false
```

`https_error: "peer_failed_verification"` is a **symptom, not a cause**: GitHub's
own HTTPS probe fails *because* it is serving the wrong certificate.

`GET /repos/barnisan43329-commits/ksunimeet-web/pages` reports
`cname: "ksunimeet.b4rn1.com"`, `status: "built"`, and — importantly —
**no `https_certificate` object at all**, at API versions `2022-11-28` and
`2026-03-10`. GitHub holds no certificate record for this domain, so no
provisioning attempt has ever been recorded.

## Everything ruled out, with the evidence

| candidate cause | verdict | evidence |
|---|---|---|
| Wrong DNS target | **no** | `ksunimeet.b4rn1.com` CNAME → `barnisan43329-commits.github.io`, the documented form for a subdomain |
| Stale old A record | **no** | resolves to the four GitHub Pages IPs; `is_old_ip_address: false`, `is_non_github_pages_ip_present: false` |
| CAA blocking Let's Encrypt | **no** | `caa_error: null`; raw CAA at the name is `issue "digicert.com"`, `issue "letsencrypt.org"`, `issue "sectigo.com"` — Let's Encrypt is explicitly permitted |
| AAAA pointing elsewhere | **no** | the only AAAA records are GitHub's own `2606:50c0:800{0..3}::153` |
| Competing Pages site on the same domain | **no** | swept every repo in the account; `ksunimeet-web` is the only Pages site, and it is the only claimant of the domain |
| A `CNAME` file with the wrong value | **no** | `public/CNAME` is exactly `ksunimeet.b4rn1.com\n` (20 bytes, no BOM, no CRLF) and matches the configured domain |
| Domain not verified on the account | **no** | see below |
| GitHub Pages outage | **no** | checked directly: `githubstatus.com/api/v2/summary.json` → overall *All Systems Operational*, Pages component *operational*, **0** open incidents |

### Domain verification is not the cause

Verifying a custom domain is **takeover protection**, not a precondition for a
certificate. GitHub's own documentation ("Verifying your custom domain for
GitHub Pages") frames it purely as stopping other users from claiming the
domain, and "Securing your GitHub Pages site with HTTPS" states that *"All
GitHub Pages sites, including sites that are correctly configured with a custom
domain, support HTTPS."*

Confirming it in DNS: no `_github-pages-challenge-*` TXT record exists at either
`b4rn1.com` or `ksunimeet.b4rn1.com`. Adding one is still **worth doing** as
takeover protection, but it will not produce a certificate.

## This is a known, widespread, unresolved GitHub Pages fault

Multiple open community reports describe this exact signature — health check
green, generic `*.github.io` certificate served, certificate state stuck at
`new` / `authorization_created` / `bad_authz`:

- [#205765](https://github.com/orgs/community/discussions/205765) — stuck 56 days
- [#206017](https://github.com/orgs/community/discussions/206017), [#206108](https://github.com/orgs/community/discussions/206108), [#207228](https://github.com/orgs/community/discussions/207228), [#209625](https://github.com/orgs/community/discussions/209625)

The two decisive findings from those threads:

1. **The job never starts.** Certificate Transparency logs show *zero*
   issuances ever for the affected domains — so it is not a failing ACME
   validation, no order reaches Let's Encrypt at all.
2. **Remove-and-re-add does not fix it.** One reporter cleared the custom domain
   for 36 minutes until the certificate object went null, then re-added it —
   identical behaviour. Another tried three times over 56 days.

GitHub Support closes these as **out of scope for the Free plan** — tickets
`#4697430`, `#4703929`, `#4818422` — and redirects to Community. In that thread,
every domain which eventually served HTTPS had **left GitHub Pages**; there is no
case of GitHub issuing one of these certificates.

### What was tried here

Re-submitting the custom domain (`PUT /repos/.../pages {"cname":"ksunimeet.b4rn1.com"}`,
HTTP 204) re-ran GitHub's DNS check — it changed `pages/health` from a blank
`202` to the fully green `200` body quoted above, which is how we obtained the
evidence. It did **not** create a certificate record, matching the reports.

The full unlink/re-add cycle was deliberately **not** performed: the reports
show it does not work for this class of fault, and it would take the working
`http://` site offline for the duration.

## Why this matters more than "no padlock"

The calling feature **cannot work over plain HTTP at all**.
`public/call.js` and `public/watch.js` call
`navigator.mediaDevices.getUserMedia(...)`, and `navigator.mediaDevices` does
not exist outside a secure context. Over `http://`, voice and video calls fail
before they begin. The app is currently usable over HTTP for messaging, but not
for calls.

## The paths that do produce a certificate

All of them mean **moving TLS off GitHub's certificate pipeline**.

1. **Serve the site from the VPS.** This is the repository's original design and
   the only option that is not a CDN. `vps/ksunimeet-b4rn1.conf`,
   `vps/ksunimeet-b4rn1-le-ssl.conf` and `vps/deploy.sh` already exist for it,
   and the repo README notes the VPS "already responds from Russia". Its
   current state is broken: TCP 22 and 443 accept connections, **80 times out**,
   and 443 answers **plaintext HTTP** (`HTTP/1.0 400 Bad Request`), which is the
   `EPROTO` seen on `https://`. Port 80 is required for the Let's Encrypt
   HTTP-01 challenge, so that has to be fixed first.
2. **A CDN or host in front of GitHub Pages.** Possible in principle, but
   **Cloudflare is specifically ruled out for this project** — see the comment
   in `.github/workflows/pages.yml`: Russian providers have been cutting
   Cloudflare's network since June 2025, which is also why `supabase-js` is
   self-hosted instead of loaded from jsDelivr/unpkg. Vercel and Netlify were
   what the other reporters used; both are worth checking for Russia
   reachability before committing.
3. **Wait.** No case in the reports ended this way.

## Pasteable escalation (Community, since Support declines Free)

> Repository: barnisan43329-commits/ksunimeet-web — Pages, `build_type: workflow`
> Custom domain: ksunimeet.b4rn1.com
>
> The certificate has never been issued and the edge serves the generic
> `*.github.io` certificate, so `https://` fails with
> `ERR_TLS_CERT_ALTNAME_INVALID`.
>
> `GET /pages/health` is green on every field: `dns_resolves: true`,
> `has_cname_record: true`, `is_cname_to_github_user_domain: true`,
> `is_served_by_pages: true`, `is_valid: true`, `reason: null`,
> `is_https_eligible: true`, `caa_error: null`, `is_proxied: false`,
> `is_non_github_pages_ip_present: false`. The only red field is
> `https_error: "peer_failed_verification"`, which is a consequence of the
> wrong certificate being served.
>
> `GET /pages` returns `cname: "ksunimeet.b4rn1.com"`,
> `status: "built"`, and **no `https_certificate` object at all** (checked at
> API versions `2022-11-28` and `2026-03-10`) — so no provisioning record
> exists for this domain.
>
> DNS: `ksunimeet.b4rn1.com` CNAME → `barnisan43329-commits.github.io`; A →
> the four documented GitHub Pages addresses; AAAA → `2606:50c0:8000::153` …
> `8003::153`; CAA permits `letsencrypt.org`. No other Pages site on the
> account claims the domain, and `public/CNAME` matches the configured domain
> exactly.
>
> This matches the pattern in #205765, #206017, #206108, #207228 and #209625:
> the health check is green, Certificate Transparency shows no ACME order has
> ever been created, and remove/re-add does not help.
>
> Could the certificate provisioning job for `ksunimeet.b4rn1.com` be cleared
> and re-triggered? DNS and the custom-domain setting are being left untouched.

---

*Produced by tracing GitHub's Pages API and live DNS/TLS behaviour. Every claim
above is reproducible with `GET /repos/barnisan43329-commits/ksunimeet-web/pages`,
`GET .../pages/health`, a CAA/CNAME lookup on `ksunimeet.b4rn1.com`, and a TLS
handshake against the domain.*

---

## Resolution — the custom domain was removed

**Applied.** The domain was not merely a missing padlock; it was the direct
cause of a total outage in the Android app, and that is what forced the choice.

`public/CNAME` bound the Pages site to `ksunimeet.b4rn1.com`, and because no
certificate can be issued for it (above), Enforce HTTPS could not be enabled.
GitHub therefore answered **every** github.io URL with:

```
HTTP/1.1 301 Moved Permanently
Location: http://ksunimeet.b4rn1.com/
```

The APK loads `https://barnisan43329-commits.github.io/ksunimeet-web/` in its
WebView. It followed that redirect and — targeting API 33 with no cleartext
override in the manifest — had the load blocked with
`ERR_CLEARTEXT_NOT_PERMITTED`, on a blank page, with no way to sign in.

What was changed:

1. `public/CNAME` deleted (commit `3dfd05e`).
2. The Pages **setting** cleared, which is the part that actually mattered:
   `PUT /repos/barnisan43329-commits/ksunimeet-web/pages {"cname": null}` → 204.
   Deleting the file alone did not do it. The domain lives in the repository's
   Pages settings, and the next deploy still honoured it.

Verified afterwards:

```
GET /repos/.../pages        cname: null
                            html_url: https://barnisan43329-commits.github.io/ksunimeet-web/
                            https_enforced: true
all 18 app assets           HTTP 200, no redirect
http://ksunimeet.b4rn1.com/ HTTP 404  (domain detached)
```

Two things worth remembering:

- **The edge caches the redirect per path.** Once the setting was cleared,
  paths that had been requested repeatedly kept serving the cached 301
  (`X-Cache: HIT`, `Age: 1219`) while untouched paths returned 200 immediately.
  A fresh Pages deploy purges it, which is what cleared the last of them.
- **The page is a secure context again**, which it never was over `http://`.
  Without that, `navigator.mediaDevices` does not exist and calls cannot work.

`public/mirror.js` still lists `https://ksunimeet.b4rn1.com/` as a mirror. It is
a dead address now and the probe simply fails, which is harmless. It becomes
meaningful again only if the domain is pointed at the VPS with a real
certificate — option 1 under "The paths that do produce a certificate".
