# Kbols Bot

**Kbols Bot** is a Discord bot with moderation, verification, economy, community, and utility features. Built with Discord.js v14 and PostgreSQL.

[![Discord.js](https://img.shields.io/npm/v/discord.js?style=flat-square&labelColor=%23202225&color=%23202225&logo=npm&logoColor=white&logoWidth=20)](https://www.npmjs.com/package/discord.js)
![PostgreSQL](https://img.shields.io/badge/-PostgreSQL-%23336791?logo=postgresql&logoColor=white&style=flat-square&logoWidth=20)

## Table of Contents

- [Features Overview](#features-overview)
- [Quick Setup](#quick-setup)
- [Manual Installation Steps](#manual-installation-steps)
- [Required Bot Intents](#bot-intents)
- [Contributing](CONTRIBUTING.md)

<a name="features-overview"></a>
## Features Overview

Kbols Bot offers tools for Discord server management and community engagement:

<table>
<tr>
<td width="50%" valign="top">

### Moderation & Administration
- **Mass Actions** - Bulk ban/kick capabilities
- **User Notes** - Keep detailed moderation records
- **Case Management** - View and track all mod actions
- **Honeypot** - Configure a restricted channel, automatic message deletion, ban/kick/timeout response, optional editable DM, and a moderation log channel with `/honeypot dashboard`
- **Scheduled Tasks** - Recurring announcements and configurable inactivity rules with a preview-first dashboard

### Economy System
- **Shop & Inventory** - Buy and manage items
- **Gambling** - Risk it for rewards
- **Pay System** - Transfer money between users

### Fun & Entertainment
- **Random Facts** - Learn something new
- **Wanted Poster** - Create fun wanted images
- **Text Reversal** - Reverse any text
- **Rock-Paper-Scissors** - Invite another server member to a configurable multi-round match

### Advanced Ticket System
- **Claim & Priority** - Staff ticket management
- **Ticket Limits** - Prevent spam
- **Transcript System** - Save ticket history

### Server Stats
- **Member Counter** - Live member count channels
- **Voice Counters** - Track voice stats
- **Dynamic Updates** - Real-time channel updates

### Reaction Roles
- **Role Assignment** - Self-assignable roles
- **Native Reactions** - Add a role by reacting; removing the reaction removes the role
- **Custom Server Emoji** - Use server emojis for each role
- **Images per Panel** - Give each reaction-role message its own optional image

Create a native reaction panel with `/reactroles reaction-setup`, then use
`/reactroles dashboard` to add or remove emoji/role pairs. Discord limits each
message to 20 distinct reactions; the bot supports up to five native reaction
panels per server (up to 100 reaction roles total). Each panel can have its own
optional image attachment, which can be replaced or removed later in the
dashboard. The emoji picker lists server emojis, includes a searchable,
categorized Unicode library with skin-tone variants, and supports manually
pasted custom emoji markup (including emojis from other servers when the bot
has **Use External Emojis** permission). Role dropdown panels remain a separate
feature.

### Reaction Limiter
- **Per-message caps** - Limits how many people can use a selected emoji on any message
- **Channel controls** - Enable or disable reaction limits for individual channels
- **Live dashboard** - Manage emoji caps and channel settings with `/reactionlimit dashboard`

Use `/reactionlimit dashboard` to add, edit, or remove emoji limits and enable
or disable the limiter per channel. Emoji limits are shared across channels
where the limiter is enabled. The value is the maximum number of human users
who may react with that emoji to one message. The `/reactionlimit add`, `set`,
`remove`, and `list` subcommands remain available.
Custom emoji use Discord's standard format:

```js
<:emoji_name:1490994864790175884>
```

The `src/config/reactionLimiter.js` file supplies the defaults for new servers.

The bot needs the **Manage Messages** permission in channels where reaction
limits should be enforced. Limits for custom emojis are removed automatically
when those emojis are deleted from the server.

</td>
<td width="50%" valign="top">

### Giveaways & Events
- **Multiple Winners** - Support multi-winner giveaways
- **Auto Picking** - Automatic winner selection
- **Reroll System** - Pick new winners if needed

### Utility Tools
- **Report System** - Report issues to staff
- **Todo Lists** - Personal task management
- **First Message** - Jump to channel's first message

### Welcome System
- **Welcome Messages** - Greet new members
- **Auto Roles** - Assign roles on join
- **Custom Embeds** - Personalized messages
  
</td>
</tr>
</table>

### Scheduled Tasks

Use `/schedule announcement` to schedule recurring messages by interval (minutes,
hours, or days). Optional role/user mentions and `@here`/`@everyone` pings can be
configured. Use `/schedule inactivity` to monitor message/reaction activity and
choose an action (ban, kick, timeout, or role removal), target/exempt roles,
warning settings, log channel, and per-run safety limit.

Open `/schedule dashboard` to inspect tasks, pause or enable them, send an
announcement immediately, preview an inactivity rule, or delete a task. Edit a
task by re-running its matching command with the task ID shown in the dashboard.
Inactivity rules simulate actions by default. To enable actual punishments, set
`live` to true; this requires PostgreSQL, the appropriate bot permissions, and a
log channel. A bot restart restarts the activity observation window, so a member
is not punished for activity that happened while the bot was offline.

### Rock-Paper-Scissors

Use `/rps` to post a public invitation in the current channel. Another member joins
with the checkmark, then both players lock in a move with the rock, paper, or scissors
buttons. Add the optional `rounds` value to play a match with multiple rounds.

Customize the embed color, button emojis, default and maximum round counts, timeout,
and displayed text in `src/config/rps.js`. Custom Discord emojis can be supplied in
the standard `<:emoji_name:emoji_id>` or `<a:emoji_name:emoji_id>` format.

<a name="quick-setup"></a>
## Quick Setup (Recommended for non-coders)

## Docker Deployment (Recommended)

Kbols Bot is containerized for easy deployment.

1. **Clone the repository:**
   ```bash
   git clone https://github.com/kbol-lol/misty-vale.git
   cd misty-vale
   ```

2. **Configure environment variables:**
   ```bash
   cp .env.example .env
   ```
   Set at minimum `DISCORD_TOKEN` and `CLIENT_ID`. Docker Compose also reads `POSTGRES_USER`, `POSTGRES_PASSWORD`, and `POSTGRES_DB` from `.env` (defaults: `kbolsbot` / `password` / `kbolsbot`).

3. **Build and start the containers:**
   ```bash
   docker compose up -d --build
   ```

4. **Check status:**
   ```bash
   docker compose ps
   curl http://localhost:3000/health
   ```

This starts the bot and PostgreSQL. The compose file sets `POSTGRES_SSL=false` and `AUTO_MIGRATE=true` for the bundled database.

<a name="manual-installation-steps"></a>
## Manual Installation Steps

### Prerequisites
- Node.js 20.10.0 or higher
- PostgreSQL server (recommended) or memory storage fallback
- Discord bot application with proper intents

1. **Clone the Repository**
   ```bash
   git clone https://github.com/kbol-lol/misty-vale.git
   cd misty-vale
   ```

2. **Install Dependencies**
   ```bash
   npm install
   ```

3. **Configure Environment Variables**
   ```bash
   cp .env.example .env
   ```
   Edit `.env` with your configuration (only the following variables require configuration, leave remaining variables as default):
   ```env
   # Discord Bot Configuration
   DISCORD_TOKEN=your_discord_bot_token_here
   CLIENT_ID=your_discord_client_id_here
   GUILD_ID=your_discord_guild_id_here

   # PostgreSQL Configuration (Primary Database)
   POSTGRES_URL=postgresql://postgres:yourpassword@localhost:5432/kbolsbot
   POSTGRES_HOST=localhost
   POSTGRES_PORT=5432
   POSTGRES_DB=kbolsbot
   POSTGRES_USER=postgres
   POSTGRES_PASSWORD=yourpassword
   ```

   Production note:
   - `NODE_ENV=production`
   - `LOG_LEVEL=warn` for a clean production console (critical issues + startup status)
   - `LOG_LEVEL=info` if you want more detailed operational logs
   - If your chosen `PORT` is already used, Kbols Bot automatically tries the next port(s)

   Environment options reference:
   - `NODE_ENV`: `development`, `production`, `test` (any non-`production` value is treated as non-production)
   - `LOG_LEVEL`: `error`, `warn`, `info`, `http`, `verbose`, `debug`, `silly`
   - Accepted aliases for `LOG_LEVEL` in this bot: `warns`, `warning`, `warnings` → `warn`

   Recommended production `.env` (easy mode + default mode):
   ```env
   NODE_ENV=production
   LOG_LEVEL=warn
   WEB_HOST=0.0.0.0
   PORT=3000
   PORT_RETRY_ATTEMPTS=5
   ```
   This gives clear startup/online status messages while keeping logs simple for non-technical operators.
   If port `3000` is busy, the bot tries the next available ports automatically (up to `PORT_RETRY_ATTEMPTS`).

### Multiple servers

Slash commands are registered **globally** on startup (via `CLIENT_ID`), so the bot works in every server it is invited to.

Notes:
- Global slash commands may take up to about an hour to propagate on first deploy
- Each server has **isolated** data: config, economy, tickets, dashboards, warnings, etc. (all keys are scoped as `guild:{guildId}:...`)
- In the [Discord Developer Portal](https://discord.com/developers/applications), ensure your bot is not restricted to a single guild if you plan to invite it elsewhere
- Generate an OAuth2 invite URL from the [Discord Developer Portal](https://discord.com/developers/applications) (OAuth2 → URL Generator, scopes: `bot` and `applications.commands`)

4. **Setup PostgreSQL Database** (Optional but recommended)
   ```bash
   # Create database and user
   createdb kbolsbot
   createuser kbolsbot
   psql -c "ALTER USER kbolsbot PASSWORD 'yourpassword';"
   psql -c "GRANT ALL PRIVILEGES ON DATABASE kbolsbot TO kbolsbot;"
   ```

5. **Verify Database Setup**
   ```bash
   npm run migrate:check
   ```

6. **Start the Bot**
   ```bash
   npm start
   ```

> **Note on database migrations:** Schema tables and legacy key migrations run
> **automatically on startup**, so` managed hosts like **Railway** need no manual
> migration step — just deploy/restart. To disable auto-migration set
> `AUTO_MIGRATE=false`. You can still run a manual key migration locally with
> `node scripts/migrate-keys.js --dry-run` (preview) or `node scripts/migrate-keys.js`.
<a name="bot-intents"></a>

## Required Bot Intents
Kbols Bot requires the following Discord intents:
- **Guilds**
- **Guild Messages**
- **Message Content**
- **Guild Members**
- **Guild Message Reactions**
- **Guild Voice States**
- **Direct Messages**
- **Bot**
- **Applications.commands**

### Required Permissions
- **View Channels**
- **Send Messages**
- **Embed Links**
- **Attach Files**
- **Read Message History**
- **Manage Messages**
- **Manage Channels**
- **Manage Roles**
- **Kick Members**
- **Manage Messages**
- **Ban Members**
- **Moderate Members**
- **Connect**

## License

This project is distributed under the MIT License. See [LICENSE](LICENSE) for details.

## Thank You

Thank you for choosing Kbols Bot for your Discord server!

*Last updated: May 2026*
