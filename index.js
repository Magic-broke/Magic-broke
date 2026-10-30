// Magic-broke: a simple Discord bot for pay-per-view creator campaigns.
// Settings live in config.json, data is saved to data.json, and the bot
// token comes from the DISCORD_TOKEN environment variable.

const fs = require('fs');
const path = require('path');
const {
  Client, GatewayIntentBits, ChannelType, PermissionFlagsBits,
  SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle,
} = require('discord.js');

const config = require('./config.json');
// On a host like Railway, set DATA_DIR to a mounted volume so data survives restarts.
const DATA_FILE = path.join(process.env.DATA_DIR || __dirname, 'data.json');

// ---------- storage ----------

function loadData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return { nextId: 1, campaigns: {}, submissions: [], accounts: {}, paypal: {}, profiles: {} };
  }
}
const data = loadData();
data.paypal ||= {};
data.profiles ||= {};
function save() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

const money = (n) => `${config.currency}${n.toFixed(2)}`;

function calcPay(views, rate) {
  if (views < config.minViews) return 0;
  return Math.round((views / 1000) * rate * 100) / 100;
}

// ---------- server layout ----------

const READ_ONLY = 'read-only';
const LAYOUT = [
  { category: 'Welcome', channels: [
    { name: 'rules', mode: READ_ONLY },
    { name: 'introduce-yourself' },
    { name: 'pick-your-niche', mode: READ_ONLY, needsNiches: true },
  ] },
  { category: 'Campaigns', channels: [
    { name: 'announcements', mode: READ_ONLY },
    { name: 'songs', mode: READ_ONLY },
    { name: 'register', mode: READ_ONLY },
    { name: 'submit-links' },
    { name: 'general-chat' },
  ] },
];

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const plain = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

function findChannel(guild, name, type) {
  return guild.channels.cache.find((c) => c.type === type && plain(c.name) === plain(name));
}

async function ensureRole(guild, name) {
  return guild.roles.cache.find((r) => r.name === name)
    || guild.roles.create({ name, mentionable: false, reason: 'Magic-broke setup' });
}

async function ensureCategory(guild, name, permissionOverwrites) {
  return findChannel(guild, name, ChannelType.GuildCategory)
    || guild.channels.create({ name, type: ChannelType.GuildCategory, permissionOverwrites });
}

async function ensureText(guild, name, parent, permissionOverwrites) {
  const existing = findChannel(guild, name, ChannelType.GuildText);
  if (existing) return { channel: existing, created: false };
  const channel = await guild.channels.create({
    name, type: ChannelType.GuildText, parent, permissionOverwrites,
  });
  return { channel, created: true };
}

function nicheButtons() {
  const rows = [];
  for (let i = 0; i < config.niches.length; i += 5) {
    rows.push(new ActionRowBuilder().addComponents(
      config.niches.slice(i, i + 5).map((n) => new ButtonBuilder()
        .setCustomId(`niche:${n}`).setLabel(n).setStyle(ButtonStyle.Secondary)),
    ));
  }
  return rows.slice(0, 5);
}

async function runSetup(guild) {
  const me = guild.members.me;
  const everyone = guild.roles.everyone;
  const created = [];

  await ensureRole(guild, 'Creator');
  for (const n of config.niches) await ensureRole(guild, n);

  const readOnly = [
    { id: everyone.id, deny: [PermissionFlagsBits.SendMessages] },
    { id: me.id, allow: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.ViewChannel] },
  ];

  for (const section of LAYOUT) {
    const cat = await ensureCategory(guild, section.category);
    for (const ch of section.channels.filter((c) => !c.needsNiches || config.niches.length)) {
      const res = await ensureText(guild, ch.name, cat.id, ch.mode === READ_ONLY ? readOnly : undefined);
      if (res.created) created.push(`#${ch.name}`);
      // Existing channels (like a locked #rules or #songs) may block the bot from posting.
      else await res.channel.permissionOverwrites.edit(me.id, {
        ViewChannel: true, SendMessages: true, EmbedLinks: true, ReadMessageHistory: true,
      }).catch(() => {});
    }
  }

  // One private channel per niche, visible only to that niche's role.
  // (Skipped when config.json has no niches.)
  const nicheCat = config.niches.length && await ensureCategory(guild, 'Niches');
  for (const n of config.niches) {
    const role = guild.roles.cache.find((r) => r.name === n);
    const res = await ensureText(guild, slug(n), nicheCat.id, [
      { id: everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: role.id, allow: [PermissionFlagsBits.ViewChannel] },
      { id: me.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
    ]);
    if (res.created) created.push(`#${slug(n)}`);
  }

  // Private channel where every registration (with PayPal email) is logged for the mods.
  const modRoles = guild.roles.cache.filter((r) => r.id !== everyone.id && !r.managed
    && (r.permissions.has(PermissionFlagsBits.ManageGuild) || r.permissions.has(PermissionFlagsBits.Administrator)));
  const regs = await ensureText(guild, 'registrations', null, [
    { id: everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: me.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
    ...modRoles.map((r) => ({ id: r.id, allow: [PermissionFlagsBits.ViewChannel] })),
  ]);
  if (regs.created) created.push('#registrations (private, mods only)');

  // Post the niche picker and pay rules, or update the bot's earlier post so it matches
  // config.json. A channel the bot can't post in is reported back instead of failing setup.
  const blocked = [];
  const postOnce = async (name, message) => {
    const ch = findChannel(guild, name, ChannelType.GuildText);
    try {
      const recent = await ch.messages.fetch({ limit: 20 });
      const mine = recent.find((m) => m.author.id === me.id);
      if (mine) await mine.edit(message);
      else await ch.send(message);
    } catch {
      blocked.push(ch);
    }
  };

  if (config.niches.length) await postOnce('pick-your-niche', {
    content: '**Pick your niche(s)** 👇\nClick a button to join that niche and see its channel. Click again to leave.',
    components: nicheButtons(),
  });

  await postOnce('register', {
    content: [
      '**Register & submit a video** 📝',
      'Posted a video with one of our sounds? Click the button and fill out the form, once for **every** video.',
      'You\'ll need: your handle (without the @), your PayPal Goods & Services email, your profile link, the video link and the sound you used.',
    ].join('\n'),
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('form:open').setLabel('Register & submit a video').setStyle(ButtonStyle.Primary).setEmoji('📝'))],
  });

  await postOnce('rules', { embeds: [
    new EmbedBuilder()
      .setTitle('Video rules')
      .setDescription([
        '• **The song must be clearly audible for at least 10 seconds** of your video.',
        '• **Put the song name and artist name in your caption**, every time.',
        '• **Only post your own original videos.** Reposting someone else\'s video means no pay and a ban.',
        '• **Keep your videos up.** Deleted or private videos stop earning and are not paid.',
        '• Only videos from your registered accounts count. Fake or bought views mean a ban.',
      ].join('\n')),
    new EmbedBuilder()
      .setTitle('How pay works')
      .setDescription([
        `• You earn **${money(config.ratePer1000Views)} per 1,000 views** (some songs may pay more; check #songs).`,
        `• Videos need at least **${config.minViews.toLocaleString()} views** to be paid.`,
        '• **Payouts are sent only by PayPal Goods & Services**, to the email you give in the form.',
        '• Fill out the form in #register (or type `/submit`) for every video you post. One video per form.',
        '• Views are checked every Thursday. See your total any time with `/earnings`.',
      ].join('\n')),
  ] });

  // #songs is posted to later by /campaign add, so check it now too.
  const songs = findChannel(guild, 'songs', ChannelType.GuildText);
  if (!songs.permissionsFor(me).has([PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) blocked.push(songs);

  return { created, blocked };
}

// ---------- slash commands ----------

const modOnly = PermissionFlagsBits.ManageGuild;
const campaignChoice = (o) => o.setName('song').setDescription('Which song/campaign').setRequired(true).setAutocomplete(true);

// The niche option only shows up when config.json has niches.
const withNicheOption = (s) => (config.niches.length
  ? s.addStringOption((o) => o.setName('niche').setDescription('Niche (leave empty for all)')
    .addChoices(...config.niches.slice(0, 25).map((n) => ({ name: n, value: n }))))
  : s);

const commands = [
  new SlashCommandBuilder().setName('setup')
    .setDescription('Create the channels, roles and niche picker (safe to run again)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder().setName('campaign').setDescription('Manage song campaigns')
    .setDefaultMemberPermissions(modOnly)
    .addSubcommand((s) => withNicheOption(s.setName('add').setDescription('Start a new song campaign')
      .addStringOption((o) => o.setName('song').setDescription('Song name').setRequired(true))
      .addStringOption((o) => o.setName('link').setDescription('Link to the sound/song').setRequired(true)))
      .addNumberOption((o) => o.setName('rate').setDescription(`Pay per 1,000 views (default ${config.ratePer1000Views})`).setMinValue(0))
      .addStringOption((o) => o.setName('notes').setDescription('Instructions for creators')))
    .addSubcommand((s) => s.setName('end').setDescription('Stop taking submissions for a song')
      .addStringOption(campaignChoice)),

  new SlashCommandBuilder().setName('register').setDescription('Register and submit a video (opens a form)'),

  new SlashCommandBuilder().setName('submit').setDescription('Submit a video you posted (opens a form)'),

  new SlashCommandBuilder().setName('earnings').setDescription('See your submissions and earnings'),

  new SlashCommandBuilder().setName('pending').setDescription('List videos that still need view counts')
    .setDefaultMemberPermissions(modOnly),

  new SlashCommandBuilder().setName('views').setDescription('Record the view count for a submission')
    .setDefaultMemberPermissions(modOnly)
    .addIntegerOption((o) => o.setName('id').setDescription('Submission number').setRequired(true))
    .addIntegerOption((o) => o.setName('views').setDescription('View count').setRequired(true).setMinValue(0)),

  new SlashCommandBuilder().setName('payouts').setDescription('Who is owed money right now')
    .setDefaultMemberPermissions(modOnly),

  new SlashCommandBuilder().setName('paid').setDescription('Mark everything owed to a creator as paid')
    .setDefaultMemberPermissions(modOnly)
    .addUserOption((o) => o.setName('user').setDescription('Creator').setRequired(true)),
].map((c) => c.toJSON());

// ---------- handlers ----------

function campaignsFor(guildId) {
  return (data.campaigns[guildId] ||= {});
}

async function handleCommand(i) {
  const g = i.guild;
  const campaigns = campaignsFor(g.id);

  switch (i.commandName) {
    case 'setup': {
      await i.deferReply({ ephemeral: true });
      const { created, blocked } = await runSetup(g);
      const lines = [created.length
        ? `Done! Created: ${created.join(', ')}.\nExisting channels were left alone.`
        : 'Everything was already set up. Nothing changed.'];
      if (blocked.length) {
        lines.push(`\n⚠️ I'm not allowed to post in ${blocked.join(', ')}. In each one: Edit Channel → Permissions → `
          + `add **${g.members.me.displayName}** → turn on **Send Messages** and **Embed Links** → Save. Then run /setup again.`);
      }
      return i.editReply(lines.join('\n'));
    }

    case 'campaign': {
      const song = i.options.getString('song');
      if (i.options.getSubcommand() === 'end') {
        if (!campaigns[song]) return i.reply({ content: 'No campaign with that name.', ephemeral: true });
        campaigns[song].active = false;
        save();
        return i.reply(`🛑 **${song}** is closed. New submissions are no longer accepted.`);
      }
      const c = {
        song,
        link: i.options.getString('link'),
        niche: i.options.getString('niche'),
        rate: i.options.getNumber('rate') ?? config.ratePer1000Views,
        notes: i.options.getString('notes'),
        active: true,
      };
      campaigns[song] = c;
      save();
      const embed = new EmbedBuilder()
        .setTitle(`🎵 ${song}`)
        .setURL(c.link)
        .setDescription(c.notes || 'Use this sound in your videos.')
        .addFields(
          { name: 'Pay', value: `${money(c.rate)} per 1,000 views`, inline: true },
          { name: 'Niche', value: c.niche || 'All', inline: true },
          { name: 'How to submit', value: `\`/submit song:${song}\` in #submit-links` },
        );
      const songsCh = findChannel(g, 'songs', ChannelType.GuildText);
      const role = c.niche && g.roles.cache.find((r) => r.name === c.niche);
      if (songsCh) await songsCh.send({ content: role ? `${role}` : undefined, embeds: [embed] });
      return i.reply({ content: `Campaign **${song}** is live${songsCh ? ' and posted in #songs' : ''}.`, ephemeral: true });
    }

    case 'register':
    case 'submit':
      return i.showModal(videoForm(i.user.id));

    case 'earnings': {
      const mine = data.submissions.filter((s) => s.guildId === g.id && s.userId === i.user.id);
      if (!mine.length) return i.reply({ content: 'No submissions yet. Fill out the form in #register (or type `/submit`) to add one.', ephemeral: true });
      const owed = mine.filter((s) => s.status === 'counted').reduce((a, s) => a + s.pay, 0);
      const paid = mine.filter((s) => s.status === 'paid').reduce((a, s) => a + s.pay, 0);
      const lines = mine.slice(-15).map((s) => `#${s.id} ${s.song}: ${s.views == null ? 'waiting for count' : `${s.views.toLocaleString()} views → ${money(s.pay)}`}${s.status === 'paid' ? ' (paid)' : ''}`);
      const pp = data.paypal[i.user.id] ? `PayPal (G&S): ${data.paypal[i.user.id]}` : 'No PayPal email yet: fill out the form in #register.';
      return i.reply({ content: `**Owed:** ${money(owed)}  **Paid so far:** ${money(paid)}\n${pp}\n\n${lines.join('\n')}`, ephemeral: true });
    }

    case 'pending': {
      const list = data.submissions.filter((s) => s.guildId === g.id && s.status === 'pending');
      if (!list.length) return i.reply({ content: 'Nothing waiting for a view count. 🎉', ephemeral: true });
      const lines = list.slice(0, 25).map((s) => `#${s.id} <@${s.userId}> ${s.song}: <${s.link}>`);
      return i.reply({ content: `**Needs view counts (${list.length}):**\n${lines.join('\n')}\n\nUse \`/views id: views:\``, ephemeral: true });
    }

    case 'views': {
      const sub = data.submissions.find((s) => s.guildId === g.id && s.id === i.options.getInteger('id'));
      if (!sub) return i.reply({ content: 'No submission with that number.', ephemeral: true });
      if (sub.status === 'paid') return i.reply({ content: 'That one has already been paid.', ephemeral: true });
      const rate = campaigns[sub.song]?.rate ?? config.ratePer1000Views;
      sub.views = i.options.getInteger('views');
      sub.pay = calcPay(sub.views, rate);
      sub.status = 'counted';
      save();
      const note = sub.views < config.minViews ? ` (under the ${config.minViews.toLocaleString()} view minimum)` : '';
      return i.reply({ content: `#${sub.id}: ${sub.views.toLocaleString()} views → **${money(sub.pay)}**${note}`, ephemeral: true });
    }

    case 'payouts': {
      const owed = {};
      for (const s of data.submissions) {
        if (s.guildId === g.id && s.status === 'counted' && s.pay > 0) owed[s.userId] = (owed[s.userId] || 0) + s.pay;
      }
      const rows = Object.entries(owed).sort((a, b) => b[1] - a[1]);
      if (!rows.length) return i.reply({ content: 'Nobody is owed anything right now.', ephemeral: true });
      const total = rows.reduce((a, [, v]) => a + v, 0);
      const lines = rows.map(([u, v]) => `<@${u}>: **${money(v)}** → PayPal G&S: ${data.paypal[u] || '⚠️ no email'}`);
      return i.reply({ content: `**Owed (total ${money(total)}):**\n${lines.join('\n')}\n\nAfter paying someone, run \`/paid user:\``, ephemeral: true });
    }

    case 'paid': {
      const user = i.options.getUser('user');
      let total = 0;
      for (const s of data.submissions) {
        if (s.guildId === g.id && s.userId === user.id && s.status === 'counted') {
          s.status = 'paid';
          total += s.pay;
        }
      }
      save();
      return i.reply({ content: `Marked ${money(total)} as paid to ${user}.`, ephemeral: true });
    }
  }
}

// ---------- registration / submission form ----------

const platformOf = (link) => (/tiktok\.com/i.test(link) ? 'TikTok' : /instagram\.com/i.test(link) ? 'Instagram' : null);

function videoForm(userId) {
  const acc = data.accounts[userId] || {};
  const platform = Object.keys(acc).pop();
  const field = (id, label, placeholder, value) => {
    const input = new TextInputBuilder().setCustomId(id).setLabel(label).setPlaceholder(placeholder)
      .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(200);
    if (value) input.setValue(value);
    return new ActionRowBuilder().addComponents(input);
  };
  return new ModalBuilder().setCustomId('form:video').setTitle('Register & submit a video').addComponents(
    field('handle', 'Your handle (without the @)', 'yourname', platform && acc[platform]),
    field('paypal', 'PayPal Goods & Services email', 'you@example.com', data.paypal[userId]),
    field('profile', 'Your TikTok or Instagram profile link', 'https://www.tiktok.com/@yourname', platform && data.profiles[userId]?.[platform]),
    field('video', 'Link to the video', 'https://www.tiktok.com/@yourname/video/...', ''),
    field('sound', 'Sound used (song name and artist)', 'Song Name - Artist', ''),
  );
}

async function handleVideoForm(i) {
  const g = i.guild;
  const get = (id) => i.fields.getTextInputValue(id).trim();
  const handle = get('handle').replace(/^@+/, '');
  const paypal = get('paypal').toLowerCase();
  const profile = get('profile');
  const link = get('video');
  const sound = get('sound');
  const platform = platformOf(profile);

  const problem = !/^[\w.]{1,30}$/.test(handle) ? 'Your handle should be just the name, with no @ or spaces (for example `yourname`).'
    : !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(paypal) ? 'That PayPal email doesn\'t look right.'
      : !platform ? 'Your profile link must be a TikTok or Instagram link.'
        : platformOf(link) !== platform ? `Your video link must be a ${platform} link, like your profile.`
          : data.submissions.some((s) => s.link === link) ? 'That video has already been submitted.'
            : null;
  if (problem) return i.reply({ content: `${problem} Please click the button and try again.`, ephemeral: true });

  // Save the creator's details, and log them privately in #registrations when new or changed.
  const acc = (data.accounts[i.user.id] ||= {});
  const profiles = (data.profiles[i.user.id] ||= {});
  const changed = acc[platform] !== handle || profiles[platform] !== profile || data.paypal[i.user.id] !== paypal;
  acc[platform] = handle;
  profiles[platform] = profile;
  data.paypal[i.user.id] = paypal;

  // Use the campaign's rate when the sound matches a song from /campaign add.
  const c = Object.values(campaignsFor(g.id)).find((x) => plain(x.song) === plain(sound));
  const rate = c?.rate ?? config.ratePer1000Views;
  const sub = {
    id: data.nextId++, guildId: g.id, userId: i.user.id, song: c?.song || sound, link,
    views: null, pay: 0, status: 'pending', date: new Date().toISOString(),
  };
  data.submissions.push(sub);
  save();

  if (changed) {
    const regs = findChannel(g, 'registrations', ChannelType.GuildText);
    if (regs) {
      await regs.send({
        content: `📝 ${i.user} registered\nPayPal (G&S): ${paypal}\n${platform}: ${handle}\nProfile: ${profile}`,
        allowedMentions: { parse: [] },
      });
    }
  }
  // Always posted in #submit-links: the weekly view update reads submissions from there.
  const submitCh = findChannel(g, 'submit-links', ChannelType.GuildText);
  if (submitCh) await submitCh.send(`✅ Submission **#${sub.id}** from ${i.user} for **${sub.song}** (${money(rate)} per 1K views)\n${link}`);
  return i.reply({
    content: `✅ Got it! Your video is logged as **#${sub.id}**${submitCh ? ` in ${submitCh}` : ''}. Views are checked every Thursday; see your total with \`/earnings\`.`,
    ephemeral: true,
  });
}

async function handleNicheButton(i) {
  const name = i.customId.slice('niche:'.length);
  const role = i.guild.roles.cache.find((r) => r.name === name);
  if (!role) return i.reply({ content: 'That niche role is missing. Ask a mod to run /setup.', ephemeral: true });
  const creator = i.guild.roles.cache.find((r) => r.name === 'Creator');
  if (i.member.roles.cache.has(role.id)) {
    await i.member.roles.remove(role);
    return i.reply({ content: `Removed **${name}**.`, ephemeral: true });
  }
  await i.member.roles.add(creator ? [role, creator] : [role]);
  return i.reply({ content: `You joined **${name}**! Check your new #${slug(name)} channel.`, ephemeral: true });
}

// ---------- client ----------

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('clientReady', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  for (const guild of client.guilds.cache.values()) {
    await guild.commands.set(commands);
    console.log(`Commands registered in ${guild.name}`);
  }
});

client.on('guildCreate', (guild) => guild.commands.set(commands));

client.on('interactionCreate', async (i) => {
  try {
    if (i.isAutocomplete()) {
      const typed = i.options.getFocused().toLowerCase();
      const names = Object.values(campaignsFor(i.guildId))
        .filter((c) => c.active && c.song.toLowerCase().includes(typed))
        .slice(0, 25).map((c) => ({ name: c.song, value: c.song }));
      return i.respond(names);
    }
    if (i.isButton() && i.customId.startsWith('niche:')) return await handleNicheButton(i);
    if (i.isButton() && i.customId === 'form:open') return await i.showModal(videoForm(i.user.id));
    if (i.isModalSubmit() && i.customId === 'form:video') return await handleVideoForm(i);
    if (i.isChatInputCommand()) return await handleCommand(i);
  } catch (err) {
    console.error(err);
    const msg = { content: `Something went wrong: ${err.message}`, ephemeral: true };
    if (i.isRepliable()) (i.deferred || i.replied ? i.editReply(msg) : i.reply(msg)).catch(() => {});
  }
});

if (!process.env.DISCORD_TOKEN) {
  console.error('DISCORD_TOKEN is not set.');
  process.exit(1);
}
if (require.main === module) client.login(process.env.DISCORD_TOKEN);
module.exports = { client, runSetup };
