# s.pfadis.ch — link shortener + QR codes

A small self-hosted app: paste a long URL, get a short one on `s.pfadis.ch`
plus a printable QR code. Runs in Docker — Node/Express backend, SQLite
storage, a plain-JS frontend — sitting behind your own Nginx Proxy Manager
(NPM) for TLS.

## 1. Point the domain at your server

Wherever DNS for `pfadis.ch` is managed, add an A (and optionally AAAA)
record so `s.pfadis.ch` resolves to the public IP of the server running NPM:

```
Type: A    Name: s    Value: <your server's public IPv4>
```

## 2. Configure

```bash
cp .env.example .env
```

Edit `.env`:
- `BASE_URL` — should be `https://s.pfadis.ch` for production.
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_ALLOWED_DOMAIN` —
  Google sign-in, restricted to your domain. See "Setting up Google
  sign-in" below. Leave blank to skip it.
- `SESSION_SECRET` — a random string that signs login sessions. Generate
  one with `openssl rand -hex 32`. Required if you're using Google sign-in
  (otherwise everyone gets signed out whenever the container restarts).
- `API_KEY` — optional, separate from Google sign-in. Lets scripts/automation
  call the API with `Authorization: Bearer <key>` instead of logging in.

If you leave Google sign-in, `API_KEY`, and everything else blank, the app
runs with no login at all — fine for a private network, not recommended if
it's reachable from the open internet.

### Setting up Google sign-in

1. In [Google Cloud Console](https://console.cloud.google.com/), create or
   pick a project.
2. Go to **APIs & Services → OAuth consent screen**.
   - If `pfadis.ch` is a Google Workspace domain, choose **Internal** —
     Google then only allows your domain's own accounts to sign in at all,
     which is stronger than anything the app can check on its own.
   - Otherwise choose **External** and keep it in testing/basic mode; the
     app itself checks the signed-in account's domain on every login.
3. Go to **Credentials → Create credentials → OAuth client ID**, application
   type **Web application**. Add an authorized redirect URI:
   - `https://s.pfadis.ch/auth/google/callback` for production
   - `http://localhost:3000/auth/google/callback` if testing locally
4. Copy the generated **Client ID** and **Client secret** into `.env` as
   `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
5. Confirm `GOOGLE_ALLOWED_DOMAIN=pfadis.ch` (or your domain) in `.env`, and
   set `SESSION_SECRET`.

Anyone outside `GOOGLE_ALLOWED_DOMAIN` who tries to sign in is rejected
after Google authenticates them, with a plain "access denied" page — they're
never shown the app.

## 3. Run the app container

```bash
docker compose up -d --build
```

This starts just the `app` container, publishing it on `127.0.0.1:3000` —
reachable from the host itself (where NPM runs) but not from the internet
directly. Nothing in this project handles TLS; NPM does that.

## 4. Point Nginx Proxy Manager at it

In the NPM admin UI, **Proxy Hosts → Add Proxy Host**:

- **Domain Names**: `s.pfadis.ch`
- **Scheme**: `http`
- **Forward Hostname / IP**:
  - If NPM runs directly on the host (not in Docker), or in Docker with
    `network_mode: host`: use `127.0.0.1`
  - If NPM runs in its own Docker container: use the host's LAN IP, or —
    cleaner — attach this app to NPM's Docker network (see below) and use
    the container name instead
- **Forward Port**: `3000`
- **Websockets Support**: off (not needed)

Then on the **SSL** tab: pick **Request a new SSL certificate**, enable
**Force SSL**, and save. NPM handles issuing and renewing the Let's Encrypt
certificate from there — nothing to do on the app side.

### Optional: shared Docker network instead of a host port

If you'd rather not publish a port on the host at all, attach this app's
container to the same Docker network as NPM so they can reach each other by
container name:

1. Find NPM's network: `docker network ls` (often something like
   `nginxproxymanager_default`).
2. In `docker-compose.yml`, uncomment the `networks:` block under `app` and
   the top-level `networks:` block, and put NPM's network name in place of
   `<your-reverse-proxy-network-name>`.
3. Remove or comment out the `ports:` section, since it's no longer needed.
4. `docker compose up -d --build`.
5. In NPM, set **Forward Hostname / IP** to this app's container name
   (check with `docker ps`) instead of an IP.

## 5. A note on cookies and Google sign-in

The app decides whether to mark its login cookie "secure" (HTTPS-only)
based on `BASE_URL` starting with `https://` — not on how NPM talks to it
internally. As long as `BASE_URL=https://s.pfadis.ch` and NPM has "Force
SSL" on, sign-in works correctly even though the NPM-to-app hop inside
Docker is plain HTTP. The Google OAuth redirect URI
(`https://s.pfadis.ch/auth/google/callback`) is unaffected either way.

## Local testing (no domain / no reverse proxy)

```bash
docker compose run --rm -p 3000:3000 -e BASE_URL=http://localhost:3000 app
```

Then open `http://localhost:3000`. QR codes will encode `localhost:3000`
links instead of `s.pfadis.ch` ones, which is expected — they just need to
match wherever the app is actually reachable.

## How it works

- `POST /api/links` — create a short link (`{ url, code? }`); auto-generates
  a 6-character code if none is given.
- `GET /:code` — redirects to the destination and counts the click.
- `GET /api/links/:code/qr?format=png|svg` — the QR code for that link.
- `GET /api/links` / `DELETE /api/links/:code` — list / remove.
- `GET /auth/google`, `GET /auth/google/callback`, `POST /auth/logout` —
  Google sign-in flow.

Everything lives in one SQLite file at `./data/db.sqlite` on the host, via a
Docker volume — back that file up if the links matter to you.

## Publishing to Docker Hub
 
By default `docker-compose.yml` builds the image locally (`build: .`). If
you'd rather build once and pull a ready-made image on the server instead,
push it to Docker Hub:
 
```bash
docker login
docker build -t <dockerhub-username>/pfadis-shortener:latest .
docker push <dockerhub-username>/pfadis-shortener:latest
```
 
Tag a version alongside `latest` if you want to be able to roll back
(`-t <dockerhub-username>/pfadis-shortener:v1.0.0`, pushed the same way).
 
If your build machine and server use different CPU architectures (e.g.
building on an Intel/AMD machine but deploying to a Raspberry Pi), build a
multi-arch image with buildx instead of a plain `docker build`:
 
```bash
docker buildx create --use --name multiarch 2>/dev/null || docker buildx use multiarch
docker buildx build --platform linux/amd64,linux/arm64 \
  -t <dockerhub-username>/pfadis-shortener:latest --push .
```
 
Then, on the server, swap the `build:` line for `image:` in
`docker-compose.yml`:
 
```yaml
services:
  app:
    image: <dockerhub-username>/pfadis-shortener:latest
    # build: .
    ...
```
 
From then on, deploying an update is:
 
```bash
docker compose pull
docker compose up -d
```
 
instead of `docker compose up -d --build`.

## Updating

```bash
git pull   # or however you're syncing the files
docker compose up -d --build
```

The database file isn't touched by rebuilds.
