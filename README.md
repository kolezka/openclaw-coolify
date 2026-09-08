# openclaw-coolify

[OpenClaw](https://github.com/openclaw/openclaw) on Coolify, routed through a LiteLLM proxy.

The official image binds to loopback and has no model configured. This repo adds a
`Dockerfile` that starts the gateway with `--bind lan` and seeds `openclaw.json` on first
boot. The config references env vars (`${LITELLM_API_KEY}` etc.), which OpenClaw resolves
at load time, so no secret is written to disk and changing a value in Coolify takes
effect on restart.

## Deploy

1. Coolify: New Resource, Docker Compose, point at this repo.
2. Set the env vars from `.env.example`. All five are required; the container refuses to
   start without them. `OPENCLAW_ALLOWED_ORIGINS` is the dashboard URL you will attach in
   step 3, e.g. `https://openclaw.example.com`, so decide it before deploying.
3. Attach the domain to port `18789`. That is the only exposed port. If an older deploy
   attached a domain to `18791`, remove it in Coolify; that port is browser control, not
   the dashboard.
4. Deploy. Open the dashboard, paste `OPENCLAW_GATEWAY_TOKEN`. On "pairing required",
   approve your browser from the container terminal in Coolify:
   ```
   node openclaw.mjs devices list
   node openclaw.mjs devices approve <REQUEST_ID>
   ```

Use HTTPS for the domain. The dashboard needs a secure context outside localhost, so a
plain `http://` hostname will connect but not authenticate.

## LiteLLM

`LITELLM_MODEL` is the `model_name` alias from your LiteLLM `model_list`. The seeded
config declares it with a 128k context window and 8k max output; edit `openclaw.json`
in the volume (or Config in the dashboard) if your model differs. To confirm traffic
actually goes through LiteLLM, check its spend logs for the virtual key after a chat.

## State

Everything lives in the `openclaw_state` volume at `/home/node/.openclaw`. The seeded
config is only copied when that file does not exist yet, so dashboard edits survive
redeploys.

The first version of this repo mounted volumes under `/root`, but the image runs as
`node`, so that data landed in the container's writable layer. Before redeploying an app
created from that version, copy it out: `docker cp <old-container>:/home/node/.openclaw ./export`.
