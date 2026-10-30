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
Creators click the button in #register (or type `/register` / `/submit`) to open a form: handle, PayPal
Goods & Services email, profile link, video link and sound. Every submission is posted in #submit-links;
new or changed details (with the PayPal email) go to the private #registrations channel.

| Command | Who | What it does |
|---|---|---|
| `/setup` | Admin | Creates missing channels/roles and the niche picker |
| `/campaign add` / `end` | Mods | Start or close a song campaign (posts in #songs) |
| `/register` / `/submit` | Creators | Open the registration & video form |
| `/earnings` | Creators | See your views, owed and paid amounts |
| `/pending` | Mods | Videos waiting for a view count |
| `/views` | Mods | Record views for a submission (calculates pay) |
| `/payouts` | Mods | Who is owed what |
| `/paid` | Mods | Mark a creator as paid |

## Weekly view counts

Every Thursday, `scripts/weekly-views.js` reads the submissions in #submit-links, gets view
counts from Apify (`APIFY_TOKEN`) and updates the Google Sheet. See [WEEKLY.md](WEEKLY.md).

## Hosting (Railway)

Set `DISCORD_TOKEN` in the service variables. Add a volume mounted at `/data` and set
`DATA_DIR=/data` so campaigns, accounts and submissions survive restarts.
