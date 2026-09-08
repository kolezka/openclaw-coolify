# openclaw-coolify

Docker Compose deployment of [OpenClaw](https://github.com/openclaw/openclaw)
for Coolify, wired to talk to a self-hosted LiteLLM proxy instead of calling
LLM providers directly.

This repo deploys the official `openclaw/openclaw` image. It does not use the
`coollabsio/openclaw` fork, so there is no env-driven model config — the
LiteLLM connection is wired up once, by hand, through the OpenClaw dashboard
after first deploy.

## What's here

- `docker-compose.yml` — the OpenClaw gateway service. Port `18789` (dashboard
  and API) is published so Coolify's proxy can attach a domain to it. Port
  `18791` (bridge) is only exposed inside the Docker network, not published to
  the host — nothing outside the stack talks to it directly.
- `.env.example` — variables Coolify needs. Copy the values into the app's
  environment settings in Coolify; never commit a real `.env` (this repo is
  public).

## Deploy

1. **Create the app in Coolify.**
   New Resource -> Docker Compose -> point at this repo/branch. Pick the
   server that will run it.
2. **Set environment variables** (from `.env.example`):
   - `OPENCLAW_VERSION` — pin to a real release tag from the
     [releases page](https://github.com/openclaw/openclaw/releases); don't
     deploy `latest`.
   - `OPENCLAW_GATEWAY_TOKEN` — `openssl rand -hex 32`.
   - `OPENCLAW_ALLOWED_ORIGINS` — leave blank on the very first deploy, then
     set it to the domain Coolify assigns once you know it, and redeploy.
3. **Deploy**, then attach a domain to the `18789` port if Coolify didn't do
   it automatically.
4. **Onboard the agent.** Exec into the running container:
   ```
   docker compose exec openclaw openclaw setup
   docker compose exec openclaw openclaw dashboard   # prints a URL+token, open it
   docker compose exec openclaw openclaw devices list
   docker compose exec openclaw openclaw devices approve <REQUEST ID>
   docker compose exec openclaw openclaw configure
   ```
5. **Wire up LiteLLM.** In the dashboard: Config -> Models -> add a custom
   provider.
   - Adapter: OpenAI-compatible
   - Base URL: your LiteLLM proxy's public URL (`LITELLM_BASE_URL` in
     `.env.example` — the value isn't read automatically, just copy it in
     here)
   - API key: a LiteLLM **virtual key**, not a raw provider key
     (`LITELLM_API_KEY`)

   Set this as the default model for the assistant so all chat traffic routes
   through LiteLLM.
6. **Enable a channel** (Telegram, during `openclaw configure` in step 4) if
   you want to talk to it outside the dashboard.
7. **Verify the integration, not just the connection.** Send a message and
   confirm it shows up in LiteLLM's own spend logs / request logs for that
   virtual key — a 200 from OpenClaw's chat screen doesn't by itself prove
   the request went through LiteLLM rather than a provider key baked in
   somewhere else.

## Notes

- Config, memory and the agent workspace persist in the named volumes
  `openclaw_config` and `openclaw_workspace` — they survive redeploys as long
  as the volumes aren't removed.
- If OpenClaw ever needs to reach LiteLLM over an internal Docker network
  instead of a public URL (both deployed on the same Coolify server), swap
  `LITELLM_BASE_URL` for the internal service hostname and drop the public
  exposure on the LiteLLM side.
