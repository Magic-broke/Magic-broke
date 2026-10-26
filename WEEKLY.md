# Weekly view update

Runs every Thursday around 10 AM Pacific. Google Sheet:
https://docs.google.com/spreadsheets/d/1WIpsUD828rvnMAWuJPDOLHf52kW4WbpnCY-bqtkHb9M/edit

1. Read the current Sheet rows and save them as JSON files (arrays of rows):
   - `Videos!A2:O` → `videos.json`
   - `Creators!A2:B` → `creators.json`
2. Run (needs `DISCORD_TOKEN` and `APIFY_TOKEN`; add `NODE_USE_ENV_PROXY=1` in a Claude cloud session):

   ```
   npm install
   node scripts/weekly-views.js --videos videos.json --creators creators.json --out weekly-update.json
   ```

   It reads every submission the bot posted in #submit-links, gets current views from Apify,
   and saves what to write in `weekly-update.json`.
3. Write `weekly-update.json` to the Sheet:
   - `videos`: write `values` to `range`. Cells that are `null` (columns K and M) must be
     skipped, as they hold ARRAYFORMULAs. Never write to Videos K or M.
   - `creators`: write `values` to `range` (columns A and B only; never touch G, which is typed by hand).
   - `log`: append `values` to the Weekly Log tab.
   Skip any section that is `null`.
4. Report the `summary` line, plus any Videos rows whose Notes say views could not be read.
