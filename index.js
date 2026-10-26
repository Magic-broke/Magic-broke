// Magic-broke: a simple Discord bot for pay-per-view creator campaigns.
// Settings live in config.json, data is saved to data.json, and the bot
// token comes from the DISCORD_TOKEN environment variable.

const fs = require('fs');
const path = require('path');
const {
  Client, GatewayIntentBits, ChannelType, PermissionFlagsBits,
  SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder,
} = require('discord.js');

const config = require('./config.json');
const DATA_FILE = path.join(__dirname, 'data.json');

// ---------- storage ----------

function loadData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return { nextId: 1, campaigns: {}, submissions: [], accounts: {} };
  }
}
const data = loadData();
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
    { name: 'pick-your-niche', mode: READ_ONLY },
  ] },
  { category: 'Campaigns', channels: [
    { name: 'announcements', mode: READ_ONLY },
    { name: 'songs', mode: READ_ONLY },
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
    for (const ch of section.channels) {
      const res = await ensureText(guild, ch.name, cat.id, ch.mode === READ_ONLY ? readOnly : undefined);
      if (res.created) created.push(`#${ch.name}`);
    }
  }

  // One private channel per niche, visible only to that niche's role.
  const nicheCat = await ensureCategory(guild, 'Niches');
  for (const n of config.niches) {
    const role = guild.roles.cache.find((r) => r.name === n);
    const res = await ensureText(guild, slug(n), nicheCat.id, [
      { id: everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: role.id, allow: [PermissionFlagsBits.ViewChannel] },
      { id: me.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
    ]);
    if (res.created) created.push(`#${slug(n)}`);
  }

  // Post the niche picker (once).
  const picker = findChannel(guild, 'pick-your-niche', ChannelType.GuildText);
  const recent = await picker.messages.fetch({ limit: 20 });
  if (!recent.some((m) => m.author.id === me.id)) {
    await picker.send({
      content: '**Pick your niche(s)** 👇\nClick a button to join that niche and see its channel. Click again to leave.',
      components: nicheButtons(),
    });
  }

  // Post the pay rules (once).
  const rules = findChannel(guild, 'rules', ChannelType.GuildText);
  const rulesMsgs = await rules.messages.fetch({ limit: 20 });
  if (!rulesMsgs.some((m) => m.author.id === me.id)) {
    await rules.send({ embeds: [new EmbedBuilder()
      .setTitle('How pay works')
      .setDescription([
        `• You earn **${money(config.ratePer1000Views)} per 1,000 views** (some songs may pay more; check #songs).`,
        `• Videos need at least **${config.minViews.toLocaleString()} views** to be paid.`,
        '• Use `/register` once to add your social accounts.',
        '• Post each video with `/submit` in #submit-links. One video per submission.',
        '• Views are counted by the mods, and you can check your total any time with `/earnings`.',
        '• Only videos from your registered accounts count. Fake views mean a ban.',
      ].join('\n'))] });
  }

  return created;
}

// ---------- slash commands ----------

const modOnly = PermissionFlagsBits.ManageGuild;
const campaignChoice = (o) => o.setName('song').setDescription('Which song/campaign').setRequired(true).setAutocomplete(true);

const commands = [
  new SlashCommandBuilder().setName('setup')
    .setDescription('Create the channels, roles and niche picker (safe to run again)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder().setName('campaign').setDescription('Manage song campaigns')
    .setDefaultMemberPermissions(modOnly)
    .addSubcommand((s) => s.setName('add').setDescription('Start a new song campaign')
      .addStringOption((o) => o.setName('song').setDescription('Song name').setRequired(true))
      .addStringOption((o) => o.setName('link').setDescription('Link to the sound/song').setRequired(true))
      .addStringOption((o) => o.setName('niche').setDescription('Niche (leave empty for all)')
        .addChoices(...config.niches.slice(0, 25).map((n) => ({ name: n, value: n }))))
      .addNumberOption((o) => o.setName('rate').setDescription(`Pay per 1,000 views (default ${config.ratePer1000Views})`).setMinValue(0))
      .addStringOption((o) => o.setName('notes').setDescription('Instructions for creators')))
    .addSubcommand((s) => s.setName('end').setDescription('Stop taking submissions for a song')
      .addStringOption(campaignChoice)),

  new SlashCommandBuilder().setName('register').setDescription('Add one of your social accounts')
    .addStringOption((o) => o.setName('platform').setDescription('Platform').setRequired(true)
      .addChoices(...['TikTok', 'YouTube', 'Instagram', 'X'].map((p) => ({ name: p, value: p }))))
    .addStringOption((o) => o.setName('handle').setDescription('Your @handle').setRequired(true)),

  new SlashCommandBuilder().setName('submit').setDescription('Submit a video you posted')
    .addStringOption(campaignChoice)
    .addStringOption((o) => o.setName('link').setDescription('Link to your video').setRequired(true)),

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

const VIDEO_SITES = /(tiktok\.com|youtube\.com|youtu\.be|instagram\.com|x\.com|twitter\.com)/i;

function campaignsFor(guildId) {
  return (data.campaigns[guildId] ||= {});
}

async function handleCommand(i) {
  const g = i.guild;
  const campaigns = campaignsFor(g.id);

  switch (i.commandName) {
    case 'setup': {
      await i.deferReply({ ephemeral: true });
      const created = await runSetup(g);
      return i.editReply(created.length
        ? `Done! Created: ${created.join(', ')}.\nExisting channels were left alone.`
        : 'Everything was already set up. Nothing changed.');
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

    case 'register': {
      const acc = (data.accounts[i.user.id] ||= {});
      acc[i.options.getString('platform')] = i.options.getString('handle').replace(/^@?/, '@');
      save();
      const list = Object.entries(acc).map(([p, h]) => `${p}: ${h}`).join('\n');
      return i.reply({ content: `Saved. Your accounts:\n${list}`, ephemeral: true });
    }

    case 'submit': {
      const song = i.options.getString('song');
      const link = i.options.getString('link').trim();
      const c = campaigns[song];
      if (!c || !c.active) return i.reply({ content: 'That campaign is not active. Check #songs.', ephemeral: true });
      if (!VIDEO_SITES.test(link)) return i.reply({ content: 'Please submit a TikTok, YouTube, Instagram or X link.', ephemeral: true });
      if (data.submissions.some((s) => s.link === link)) return i.reply({ content: 'That video has already been submitted.', ephemeral: true });
      if (!data.accounts[i.user.id]) return i.reply({ content: 'Please `/register` your social account first.', ephemeral: true });
      const sub = {
        id: data.nextId++, guildId: g.id, userId: i.user.id, song, link,
        views: null, pay: 0, status: 'pending', date: new Date().toISOString(),
      };
      data.submissions.push(sub);
      save();
      return i.reply(`✅ Submission **#${sub.id}** from ${i.user} for **${song}**\n${link}`);
    }

    case 'earnings': {
      const mine = data.submissions.filter((s) => s.guildId === g.id && s.userId === i.user.id);
      if (!mine.length) return i.reply({ content: 'No submissions yet. Use `/submit` to add one.', ephemeral: true });
      const owed = mine.filter((s) => s.status === 'counted').reduce((a, s) => a + s.pay, 0);
      const paid = mine.filter((s) => s.status === 'paid').reduce((a, s) => a + s.pay, 0);
      const lines = mine.slice(-15).map((s) => `#${s.id} ${s.song}: ${s.views == null ? 'waiting for count' : `${s.views.toLocaleString()} views → ${money(s.pay)}`}${s.status === 'paid' ? ' (paid)' : ''}`);
      return i.reply({ content: `**Owed:** ${money(owed)}  **Paid so far:** ${money(paid)}\n\n${lines.join('\n')}`, ephemeral: true });
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
      const lines = rows.map(([u, v]) => `<@${u}>: **${money(v)}**`);
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

client.once('ready', async () => {
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
client.login(process.env.DISCORD_TOKEN);
