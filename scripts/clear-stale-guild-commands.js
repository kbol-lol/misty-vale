// One-off cleanup: removes server-specific slash command overrides so the
// global commands (/level, /levelboard, /levelconfig, ...) show on every server.
// Usage (Railway console or locally with the same env vars):
//   node scripts/clear-stale-guild-commands.js
// Reads DISCORD_TOKEN and CLIENT_ID. Guild IDs come from GUILD_IDS (comma list),
// falling back to GUILD_ID.

import { REST, Routes } from 'discord.js';

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID;
const guildIds = (process.env.GUILD_IDS || process.env.GUILD_ID || '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);

if (!token || !clientId) {
  console.error('DISCORD_TOKEN and CLIENT_ID are required.');
  process.exit(1);
}
if (!guildIds.length) {
  console.error('Set GUILD_IDS (comma separated) or GUILD_ID.');
  process.exit(1);
}

const rest = new REST({ version: '10' }).setToken(token);

for (const guildId of guildIds) {
  try {
    const before = await rest.get(Routes.applicationGuildCommands(clientId, guildId));
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: [] });
    console.log(`Guild ${guildId}: removed ${before.length} server-specific command(s): ${before.map((c) => c.name).join(', ') || 'none'}`);
  } catch (error) {
    console.error(`Guild ${guildId}: failed - ${error.message}`);
  }
}

const globals = await rest.get(Routes.applicationCommands(clientId));
console.log(`Global commands currently registered: ${globals.map((c) => c.name).join(', ')}`);
