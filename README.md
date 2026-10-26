# Magic-broke

Discord bot for pay-per-view creator campaigns: niche roles, song campaigns,
video submissions, view counts and payouts.

## Run

1. Set the `DISCORD_TOKEN` environment variable (Developer Portal → your app → **Bot** → Reset Token).
2. `npm install`
3. `npm start`

In a Claude Code cloud session (traffic goes through a proxy), start it with
`NODE_USE_ENV_PROXY=1 npm start` instead.

## First use

In Discord, an admin runs `/setup` once. Niches, pay rate and minimum views are in `config.json`.

| Command | Who | What it does |
|---|---|---|
| `/setup` | Admin | Creates missing channels/roles and the niche picker |
| `/campaign add` / `end` | Mods | Start or close a song campaign (posts in #songs) |
| `/register` | Creators | Save a social account |
| `/submit` | Creators | Submit a video link for a song |
| `/earnings` | Creators | See your views, owed and paid amounts |
| `/pending` | Mods | Videos waiting for a view count |
| `/views` | Mods | Record views for a submission (calculates pay) |
| `/payouts` | Mods | Who is owed what |
| `/paid` | Mods | Mark a creator as paid |
