# Backend: what is live, and how to run it

## The shape of it

```
ksunimeet.b4rn1.com            CNAME -> barnisan43329-commits.github.io
  served by                    GitHub Pages, built from public/ by pages.yml
  calls                        POCKETBASE_URL (a repository variable)

<random>.trycloudflare.com     cloudflared quick tunnel
  forwards to                  127.0.0.1:8090 on this PC
  which is                     PocketBase 0.40.5, data in pb_data/
```

The frontend and the backend are on different hosts, which is why the backend
address is not in the source: `pages.yml` writes `public/config.js` from the
`KSU_BACKEND` and `POCKETBASE_URL` repository variables at build time. Changing
the backend address is a variable change plus a rebuild, never an edit to a
committed file.

## Why the backend is on this PC

It should not be. It is here because the VPS that used to serve this project
stopped being reachable: the SSH key in `vps/id_ed25519` is refused, the
machine's host key changed, and nothing on its port 443 presents a certificate
for the domain. That box is either rebuilt with a different key or no longer
ours. A home PC is not a server and a quick tunnel address is not stable, but a
working stopgap beats a correct design that does not run.

The intended resting place is the VPS, via `vps/pocketbase-install.sh`. When
there is a server we can log into, point `POCKETBASE_URL` at
`https://pb.ksunimeet.b4rn1.com` and stop running the tunnel.

## Operating it

**After a reboot, or whenever the site says it cannot reach the backend:**

double-click **`START-BACKEND.bat`**, in the top folder of this repository.
Nothing to type. It waits for the internet itself, so running it immediately
after boot is fine, and it reports whether it succeeded before closing.

(From a command line, the same thing: `powershell -ExecutionPolicy Bypass
-File tools\backend-up.ps1`. The .bat is a thin wrapper around it, and exists so
the usual way to do this is a double-click rather than a typed command.)

Either path starts PocketBase, starts the tunnel, reads the new public address,
proves it answers `/api/health`, writes `POCKETBASE_URL`, re-enables the Pages
workflow if it has been disabled, and waits for the rebuild.

The tunnel's address **changes every time it starts**. That is the whole reason
the script exists: without it, a reboot leaves the public site calling an address
that no longer exists, which looks exactly like the backend being down.

**Two things must be true for the site to work:**

- PocketBase is listening on `127.0.0.1:8090` (`Get-Process pocketbase`)
- cloudflared is connected (`Get-Process cloudflared`), and the address in
  `PUBLIC-URL.txt` still answers: `curl <address>/api/health`

**Files on this machine** (outside the repository on purpose):

| path | what |
|---|---|
| `C:\Users\Admin\ksunimeet-backend\` | PocketBase binary, `pb_data/`, logs |
| `C:\Users\Admin\ksunimeet-backend\ADMIN-PASSWORD.txt` | the superuser password |
| `C:\Users\Admin\ksunimeet-backend\PUBLIC-URL.txt` | the current tunnel address |
| `C:\Users\Admin\ksunimeet-backend\tunnel.log` | cloudflared output, where the address is read from |

`pb_data/` is the only irreplaceable thing here. It holds every account, message
and film. Back it up by copying that directory while PocketBase is stopped.

## The admin UI

Not public, and it should stay that way: PocketBase's `/_/` dashboard is reachable
from anywhere the tunnel is, so the superuser password is what stands between a
stranger and every user's data. To reach it locally:
`http://127.0.0.1:8090/_/`.

## Known gaps

- **The certificate.** After the DNS record was changed, GitHub issues a
  Let's Encrypt certificate for `ksunimeet.b4rn1.com` on its own schedule -
  usually minutes, occasionally much longer. Until it exists, HTTPS fails the
  handshake and the site is unreachable even though Pages is built and the DNS
  is correct. Check with:
  `curl -sS https://ksunimeet.b4rn1.com/ -o /dev/null -w '%{http_code}\n'`
  An HTTP code rather than a TLS error means it is done.
- **The PC has to stay on.** Sleep, shutdown or a dropped connection takes the
  backend down, and the site follows.
- **The tunnel hostname is not stable.** Handled by `backend-up.ps1`, not
  eliminated by it.
- **The APK's background path still points at Supabase.** `NotifService` talks
  to the old REST endpoint with its own stored token, so notifications while the
  app is backgrounded do not go through PocketBase. The web app is complete;
  this is the one known broken path, and it is described in `pocketbase/README.md`.
