import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
} from 'discord.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { logger } from '../../utils/logger.js';
import {
  CONNECT_FOUR_COLUMNS,
  createConnectFourBoard,
  dropConnectFourDisc,
  offerConnectFourDraw,
  resolveConnectFourGame,
  respondToConnectFourDraw,
  surrenderConnectFourGame,
} from '../../utils/connectFourGame.js';

const GAME_TIMEOUT_MS = 15 * 60 * 1000;
const EMPTY_DISC = '⚫';
const DISC_EMOJI = { yellow: '🟡', red: '🔴' };
// Keycap emojis are the same width as the disc emojis, so each number sits under its column.
export const COLUMN_NUMBER_ROW = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣'].slice(0, CONNECT_FOUR_COLUMNS).join('');

export default {
  data: new SlashCommandBuilder()
    .setName('connectfour')
    .setDescription('Invite someone in this channel to play Connect Four')
    .setDMPermission(false),
  category: 'Fun',

  async execute(interaction) {
    if (!interaction.inGuild() || !interaction.channel?.isTextBased?.()) {
      await InteractionHelper.safeReply(interaction, {
        content: 'Connect Four can only be started in a server text channel.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const game = {
      creatorId: interaction.user.id,
      opponentId: null,
      board: createConnectFourBoard(),
      startingPlayerId: interaction.user.id,
      currentPlayerId: interaction.user.id,
      finished: false,
      interactionQueue: Promise.resolve(),
      message: null,
    };

    const inviteEmbed = makeEmbed(
      'Connect Four',
      `${interaction.user} invites someone to play Connect Four. Choose a column to drop your disc.`,
    );
    const joinRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('connectfour:join')
        .setStyle(ButtonStyle.Success)
        .setLabel('Join game'),
    );

    if (!await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral })) return;
    try {
      game.message = await interaction.channel.send({ embeds: [inviteEmbed], components: [joinRow] });
      await InteractionHelper.safeEditReply(interaction, { content: 'Your Connect Four invitation is posted.' });
    } catch (error) {
      logger.error('Failed to start Connect Four game:', error);
      await InteractionHelper.safeEditReply(interaction, {
        content: 'I could not post the game. Check that I can send messages and embed links here.',
      });
      return;
    }

    const collector = game.message.createMessageComponentCollector({ time: GAME_TIMEOUT_MS });
    collector.on('collect', componentInteraction => {
      game.interactionQueue = game.interactionQueue
        .then(() => handleGameInteraction(componentInteraction, game, collector))
        .catch(async error => {
          logger.error('Connect Four interaction failed:', error);
          await ephemeralReply(componentInteraction, 'Something went wrong while processing your move.').catch(() => {});
        });
    });

    collector.on('end', async () => {
      if (game.finished) return;
      game.finished = true;
      await game.message.edit({
        embeds: [makeEmbed('Connect Four', 'This Connect Four game expired before it was completed.')],
        components: disableRows(game.message.components),
      }).catch(() => {});
    });
  },
};

async function handleGameInteraction(interaction, game, collector) {
  if (interaction.customId === 'connectfour:join') {
    if (interaction.user.id === game.creatorId) {
      await ephemeralReply(interaction, 'You cannot play Connect Four against yourself.');
      return;
    }
    if (game.opponentId) {
      await ephemeralReply(interaction, 'This game has already been joined by someone else.');
      return;
    }

    game.opponentId = interaction.user.id;
    await interaction.deferUpdate();
    await game.message.edit({
      content: `${interaction.user} <@${game.creatorId}>`,
      embeds: [gameEmbed(game, `${interaction.user} joined. ${mention(game.currentPlayerId)}, choose a column.`)],
      components: makeGameRows(game),
    });
    return;
  }

  if (!game.opponentId || game.finished) {
    await ephemeralReply(interaction, 'This game is no longer accepting actions.');
    return;
  }
  if (interaction.user.id !== game.creatorId && interaction.user.id !== game.opponentId) {
    await ephemeralReply(interaction, 'Only the two players in this game can take actions.');
    return;
  }

  if (interaction.customId === 'connectfour:surrender') {
    const result = surrenderConnectFourGame(game, interaction.user.id);
    if (result.status !== 'surrendered') {
      await ephemeralReply(interaction, 'This game is no longer accepting actions.');
      return;
    }

    await interaction.deferUpdate();
    collector.stop('surrendered');
    await game.message.edit({
      embeds: [gameEmbed(game, `${mention(result.loserId)} gave up. ${mention(result.winnerId)} wins!`)],
      components: disableRows(game.message.components),
    });
    return;
  }

  if (interaction.customId === 'connectfour:offer-draw') {
    const result = offerConnectFourDraw(game, interaction.user.id);
    if (result.status !== 'offered') {
      await ephemeralReply(
        interaction,
        result.status === 'pending'
          ? 'A draw offer is already waiting for a response.'
          : 'This game is no longer accepting actions.',
      );
      return;
    }

    await interaction.deferUpdate();
    await game.message.edit({
      embeds: [gameEmbed(game, `${mention(interaction.user.id)} offers a draw. ${mention(otherPlayer(game, interaction.user.id))}, accept or decline the offer.`)],
      components: makeGameRows(game),
    });
    return;
  }

  if (interaction.customId === 'connectfour:accept-draw' || interaction.customId === 'connectfour:decline-draw') {
    const accepted = interaction.customId === 'connectfour:accept-draw';
    const result = respondToConnectFourDraw(game, interaction.user.id, accepted);
    if (result.status !== 'accepted' && result.status !== 'declined') {
      const messages = {
        own_offer: 'You cannot accept or decline your own draw offer.',
        missing: 'There is no draw offer to respond to.',
      };
      await ephemeralReply(interaction, messages[result.status] || 'This game is no longer accepting actions.');
      return;
    }

    await interaction.deferUpdate();
    if (accepted) {
      collector.stop('draw-agreed');
      await game.message.edit({
        embeds: [gameEmbed(game, 'The draw offer was accepted. The game ends in a draw.')],
        components: disableRows(game.message.components),
      });
      return;
    }

    await game.message.edit({
      embeds: [gameEmbed(game, `${mention(interaction.user.id)} declined the draw offer. ${mention(game.currentPlayerId)}, choose a column.`)],
      components: makeGameRows(game),
    });
    return;
  }

  if (!interaction.customId.startsWith('connectfour:drop:')) return;
  const column = Number(interaction.customId.slice('connectfour:drop:'.length)) - 1;
  const move = dropConnectFourDisc(game, interaction.user.id, column);
  if (move.status !== 'dropped') {
    const messages = {
      not_turn: 'It is not your turn.',
      column_full: 'That column is full. Choose another column.',
      draw_pending: 'Accept or decline the draw offer before continuing.',
    };
    const errorText = messages[move.status] || 'That move is not available.';
    await ephemeralReply(interaction, errorText);
    return;
  }

  let description;
  if (move.winnerId || move.boardFull) {
    const result = resolveConnectFourGame(game, move.winnerId);
    if (result.status === 'finished') {
      collector.stop('completed');
      await interaction.deferUpdate();
      await game.message.edit({
        embeds: [gameEmbed(game, `${mention(result.winnerId)} wins with four in a row!`)],
        components: disableRows(game.message.components),
      });
      return;
    }
    description = `The board filled without a winner. ${mention(game.currentPlayerId)} starts a new board. Choose a column.`;
  } else {
    game.currentPlayerId = interaction.user.id === game.creatorId ? game.opponentId : game.creatorId;
    description = `${mention(game.currentPlayerId)}, choose a column.`;
  }

  await interaction.deferUpdate();
  await game.message.edit({
    embeds: [gameEmbed(game, description)],
    components: makeGameRows(game),
  });
}

function gameEmbed(game, status) {
  const board = game.board.map(row => row.map(cell => DISC_EMOJI[cell] || EMPTY_DISC).join('')).join('\n');
  return makeEmbed(
    'Connect Four',
    `${status}\n\n${board}\n${COLUMN_NUMBER_ROW}\n\n${mention(game.creatorId)} ${DISC_EMOJI.yellow} — ${DISC_EMOJI.red} ${mention(game.opponentId)}`,
  );
}

export function makeGameRows(game) {
  const columns = Array.from({ length: CONNECT_FOUR_COLUMNS }, (_, index) =>
    new ButtonBuilder()
      .setCustomId(`connectfour:drop:${index + 1}`)
      .setLabel(String(index + 1))
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(Boolean(game.drawOfferId)),
  );
  const rows = [
    new ActionRowBuilder().addComponents(...columns.slice(0, 5)),
    new ActionRowBuilder().addComponents(...columns.slice(5)),
  ];
  const surrender = new ButtonBuilder().setCustomId('connectfour:surrender').setStyle(ButtonStyle.Danger).setLabel('Give up');
  rows.push(game.drawOfferId
    ? new ActionRowBuilder().addComponents(
      surrender,
      new ButtonBuilder().setCustomId('connectfour:accept-draw').setStyle(ButtonStyle.Success).setLabel('Accept draw'),
      new ButtonBuilder().setCustomId('connectfour:decline-draw').setStyle(ButtonStyle.Secondary).setLabel('Decline draw'),
    )
    : new ActionRowBuilder().addComponents(
      surrender,
      new ButtonBuilder().setCustomId('connectfour:offer-draw').setStyle(ButtonStyle.Secondary).setLabel('Offer draw'),
    ));
  return rows;
}

function otherPlayer(game, playerId) {
  return playerId === game.creatorId ? game.opponentId : game.creatorId;
}

function makeEmbed(title, description) {
  return new EmbedBuilder({ color: 0xD8D9FF, title, description });
}

function mention(userId) {
  return `<@${userId}>`;
}

function disableRows(rows) {
  return rows.map(row => {
    const json = row.toJSON();
    json.components = json.components.map(component => ({ ...component, disabled: true }));
    return json;
  });
}

function ephemeralReply(interaction, content) {
  return InteractionHelper.safeReply(interaction, { content, flags: MessageFlags.Ephemeral });
}
