// Weekly view update: reads every submission the bot posted in #submit-links
// (and every registration in #registrations, for PayPal emails),
// gets current view counts from Apify, and works out what to write to the
// Google Sheet (Videos rows, new Creators, Weekly Log lines).
//
// It does not touch the Sheet itself. It writes a JSON file of ranges/values
// that are then written to the Sheet (see WEEKLY.md).
//
// Usage:
//   node scripts/weekly-views.js [--videos videos.json] [--creators creators.json] [--out update.json] [--sample]
//     --videos / --creators: current Sheet rows (Videos!A2:O, Creators!A2:I) as JSON arrays,
//                            so existing rows keep their place and "previous week" views.
//     --sample: use two sample submissions instead of reading Discord (for testing).
// Needs DISCORD_TOKEN and APIFY_TOKEN environment variables.

const fs = require('fs');
const config = require('../config.json');

const args = process.argv.slice(2);
const arg = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const readJson = (file, fallback) => (file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback);

const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' }); // YYYY-MM-DD
const plain = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

// ---------- Discord ----------

async function discord(path) {
  for (;;) {
    const res = await fetch(`https://discord.com/api/v10${path}`, { headers: { Authorization: `Bot ${process.env.DISCORD_TOKEN}` } });
    if (res.status === 429) {
      const wait = ((await res.json()).retry_after || 1) * 1000;
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    if (!res.ok) throw new Error(`Discord ${path}: ${res.status} ${await res.text()}`);
    return res.json();
  }
}

const SUBMISSION = /Submission \*\*#(\d+)\*\* from <@!?(\d+)> for \*\*(.+?)\*\*(?: \(\D*([\d.]+) per 1K views\))?\n(\S+)/;

// All messages the bot posted in a channel, oldest first.
async function botMessages(me, channels, name) {
  const channel = channels.find((c) => c.type === 0 && plain(c.name) === plain(name));
  if (!channel) throw new Error(`No #${name} channel found. Run /setup in Discord first.`);
  const messages = [];
  let before = '';
  for (;;) {
    const page = await discord(`/channels/${channel.id}/messages?limit=100${before}`);
    messages.push(...page);
    if (page.length < 100) break;
    before = `&before=${page[page.length - 1].id}`;
  }
  return messages.filter((m) => m.author.id === me.id).reverse();
}

const REGISTRATION = /<@!?(\d+)> registered\nPayPal \(G&S\): (\S+)/;

async function readDiscord() {
  const me = await discord('/users/@me');
  const guilds = await discord('/users/@me/guilds');
  const guild = guilds.find((g) => g.id === process.env.GUILD_ID) || guilds[0];
  const channels = await discord(`/guilds/${guild.id}/channels`);
  const roles = Object.fromEntries((await discord(`/guilds/${guild.id}/roles`)).map((r) => [r.id, r.name]));
  const messages = await botMessages(me, channels, 'submit-links');

  const names = {};
  const nameOf = async (userId) => (names[userId] ||= (await discord(`/users/${userId}`).catch(() => ({}))).username || userId);

  const niches = {};
  async function nicheOf(userId) {
    if (!(userId in niches)) {
      try {
        const member = await discord(`/guilds/${guild.id}/members/${userId}`);
        niches[userId] = member.roles.map((id) => roles[id]).filter((n) => config.niches.includes(n)).join(', ');
      } catch { niches[userId] = ''; } // creator left the server
    }
    return niches[userId];
  }

  const subs = [];
  for (const m of messages) {
    const match = m.content.match(SUBMISSION);
    if (!match) continue;
    const [, id, userId, song, rate, link] = match;
    subs.push({
      id: Number(id), date: m.timestamp.slice(0, 10), creator: await nameOf(userId),
      niche: await nicheOf(userId), song, link, rate: rate ? Number(rate) : config.ratePer1000Views,
    });
  }

  // Latest registration per creator: { username: { paypal, niche } }.
  const registered = {};
  for (const m of await botMessages(me, channels, 'registrations')) {
    const match = m.content.match(REGISTRATION);
    if (match) registered[await nameOf(match[1])] = { paypal: match[2], niche: await nicheOf(match[1]) };
  }
  return { subs, registered };
}

const SAMPLE = [
  { id: 9001, date: today, creator: 'sample-creator-1', niche: 'Corecore', song: 'Sample Song', rate: 1, link: 'https://www.tiktok.com/@tiktok/video/7700680369246358815' },
  { id: 9002, date: today, creator: 'sample-creator-2', niche: 'Corecore', song: 'Sample Song', rate: 1, link: 'https://www.instagram.com/p/De2bNIWSZdB/' },
];

// ---------- Apify ----------

const platformOf = (link) => (/tiktok\.com/i.test(link) ? 'TikTok' : /instagram\.com/i.test(link) ? 'Instagram' : '');
const tiktokId = (s) => (s || '').match(/\/(?:video|photo)\/(\d+)/)?.[1];
const igCode = (s) => (s || '').match(/\/(?:p|reels?|tv)\/([\w-]+)/)?.[1];

async function apify(actor, input) {
  const base = 'https://api.apify.com/v2';
  const headers = { Authorization: `Bearer ${process.env.APIFY_TOKEN}`, 'Content-Type': 'application/json' };
  let run = (await (await fetch(`${base}/acts/${actor}/runs?waitForFinish=60`, { method: 'POST', headers, body: JSON.stringify(input) })).json()).data;
  if (!run) throw new Error(`Apify ${actor} did not start (check APIFY_TOKEN and credit).`);
  while (['READY', 'RUNNING'].includes(run.status)) {
    run = (await (await fetch(`${base}/actor-runs/${run.id}?waitForFinish=60`, { headers })).json()).data;
  }
  if (run.status !== 'SUCCEEDED') throw new Error(`Apify ${actor} run ${run.status}`);
  return (await fetch(`${base}/datasets/${run.defaultDatasetId}/items?clean=true`, { headers })).json();
}

// Returns { link: { views, handle } } for every link Apify could read.
async function fetchViews(links) {
  const found = {};
  const tiktok = links.filter((l) => platformOf(l) === 'TikTok');
  const insta = links.filter((l) => platformOf(l) === 'Instagram');

  if (tiktok.length) {
    const items = await apify('clockworks~tiktok-scraper', {
      postURLs: tiktok, resultsPerPage: 1, shouldDownloadVideos: false, shouldDownloadCovers: false,
      shouldDownloadSubtitles: false, shouldDownloadSlideshowImages: false,
    });
    for (const link of tiktok) {
      const it = items.find((x) => x.playCount != null && ((tiktokId(link) && x.id === tiktokId(link)) || x.submittedVideoUrl === link || x.input === link));
      if (it) found[link] = { views: it.playCount, handle: `@${it.authorMeta?.name || ''}` };
    }
  }

  if (insta.length) {
    const items = await apify('apify~instagram-scraper', { directUrls: insta, resultsType: 'posts', resultsLimit: 1 });
    for (const link of insta) {
      const it = items.find((x) => !x.error && ((igCode(link) && (x.shortCode === igCode(link) || igCode(x.url) === igCode(link))) || x.inputUrl === link));
      const views = it && (it.videoPlayCount ?? it.videoViewCount);
      if (views != null) found[link] = { views, handle: `@${it.ownerUsername || ''}` };
    }
  }
  return found;
}

// ---------- build the Sheet update ----------

async function main() {
  const { subs, registered } = args.includes('--sample')
    ? { subs: SAMPLE, registered: { 'sample-creator-1': { paypal: 'sample1@example.com', niche: 'Corecore' } } }
    : await readDiscord();
  const oldVideos = readJson(arg('videos'), []).filter((r) => r && r[0] !== undefined && r[0] !== '');
  const oldCreators = readJson(arg('creators'), []).filter((r) => r && r[0]); // Creators!A2:I

  const views = subs.length ? await fetchViews(subs.map((s) => s.link)) : {};

  // Videos: keep existing rows (in their order) and add new submissions at the bottom.
  // Columns A-O; K and M are formulas, so they are null (left alone).
  const rows = oldVideos.map((r) => Array.from({ length: 15 }, (_, i) => r[i] ?? ''));
  const byId = new Map(rows.map((r) => [Number(r[0]), r]));
  const log = [];
  let failed = 0;

  for (const s of subs) {
    let row = byId.get(s.id);
    if (!row) {
      row = [s.id, s.date, s.creator, '', platformOf(s.link), s.niche, s.song, s.link, '', '', '', s.rate, '', '', ''];
      rows.push(row);
      byId.set(s.id, row);
    }
    if (s.niche) row[5] = s.niche;
    const v = views[s.link];
    if (!v) {
      failed++;
      if (!row[14] || String(row[14]).startsWith('⚠')) row[14] = `⚠ Could not read views on ${today} (deleted, private or bad link?)`;
      continue;
    }
    // "Previous week" = last week's count. If already checked today, keep it as is.
    if (row[13] !== today) row[9] = row[8] === '' ? 0 : row[8];
    row[8] = v.views;
    row[3] = v.handle;
    row[13] = today;
    if (String(row[14]).startsWith('⚠')) row[14] = '';
    log.push([today, s.id, row[2], row[4], s.link, v.views]);
  }
  for (const r of rows) { r[10] = null; r[12] = null; }

  // Creators: keep existing names, add anyone new (registered or with a video).
  // Writes A (name), B (niche) and I (PayPal); C-H are null so formulas and "Paid to date" stay.
  const creators = oldCreators.map((r) => [r[0], r[1] ?? '', null, null, null, null, null, null, r[8] ?? '']);
  const creator = (name) => creators.find((r) => r[0] === name)
    || creators[creators.push([name, '', null, null, null, null, null, null, '']) - 1];
  for (const [name, reg] of Object.entries(registered)) {
    const c = creator(name);
    c[8] = reg.paypal;
    if (reg.niche) c[1] = reg.niche;
  }
  for (const s of subs) {
    const c = creator(s.creator);
    if (s.niche) c[1] = s.niche;
  }

  const update = {
    date: today,
    videos: rows.length ? { range: `Videos!A2:O${rows.length + 1}`, values: rows } : null,
    creators: creators.length ? { range: `Creators!A2:I${creators.length + 1}`, values: creators } : null,
    log: log.length ? { range: "'Weekly Log'!A:F", values: log } : null,
    summary: `${subs.length} submissions found, views updated for ${subs.length - failed}, couldn't read ${failed}. `
      + `Total views: ${rows.reduce((a, r) => a + (Number(r[8]) || 0), 0).toLocaleString()}.`,
  };
  const out = arg('out') || 'weekly-update.json';
  fs.writeFileSync(out, JSON.stringify(update, null, 2));
  console.log(update.summary);
  console.log(`Sheet update saved to ${out}`);
}

main().catch((err) => { console.error(err.message); process.exit(1); });
