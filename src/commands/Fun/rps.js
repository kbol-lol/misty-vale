import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
} from 'discord.js';
import { rpsConfig } from '../../config/rps.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { logger } from '../../utils/logger.js';
import { resolveRpsRound, RPS_MOVES } from '../../utils/rpsGame.js';

export default {
  data: new SlashCommandBuilder()
    .setName('rps')
    .setDescription('Invite someone in this channel to play Rock-Paper-Scissors')
    .addIntegerOption((option) =>
      option
        .setName('rounds')
        .setDescription(`Number of rounds to play (default ${rpsConfig.defaultRounds}, maximum ${rpsConfig.maximumRounds})`)
        .setMinValue(1)
        .setMaxValue(rpsConfig.maximumRounds)
        .setRequired(false),
    )
    .addBooleanOption((option) =>
      option
        .setName('allow_ties')
        .setDescription('Allow tied moves to count as a round (default: yes)')
        .setRequired(false),
    )
    .setDMPermission(false),
  category: 'Fun',

  async execute(interaction) {
    const rounds = interaction.options.getInteger('rounds') ?? rpsConfig.defaultRounds;
    const allowTies = interaction.options.getBoolean('allow_ties') ?? true;
    if (!interaction.inGuild() || !interaction.channel?.isTextBased?.()) {
      await InteractionHelper.safeReply(interaction, {
        content: 'Rock-Paper-Scissors can only be started in a server text channel.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const game = {
      creatorId: interaction.user.id,
      opponentId: null,
      rounds,
      allowTies,
      round: 1,
      scores: new Map([[interaction.user.id, 0]]),
      choices: new Map(),
      roundResults: [],
      finished: false,
      interactionQueue: Promise.resolve(),
      message: null,
    };

    const inviteEmbed = makeEmbed(
      rpsConfig.text.inviteTitle,
      format(rpsConfig.text.inviteDescription, {
        player: interaction.user.toString(),
        rounds,
      }),
    );
    const joinRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('rps:join')
        .setStyle(ButtonStyle.Success)
        .setLabel(rpsConfig.text.joinButton)
        .setEmoji(parseButtonEmoji(rpsConfig.emojis.join)),
    );

    const deferred = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
    if (!deferred) return;
    try {
      game.message = await interaction.channel.send({ embeds: [inviteEmbed], components: [joinRow] });
      await InteractionHelper.safeEditReply(interaction, { content: 'Your Rock-Paper-Scissors invitation is posted.' });
    } catch (error) {
      logger.error('Failed to start Rock-Paper-Scissors game:', error);
      await InteractionHelper.safeEditReply(interaction, { content: 'I could not post the game. Check that I can send messages and embed links here.' });
      return;
    }

    const collector = game.message.createMessageComponentCollector({ time: rpsConfig.gameTimeoutMs });
    collector.on('collect', (componentInteraction) => {
      game.interactionQueue = game.interactionQueue
        .then(() => handleGameInteraction(componentInteraction, game, collector))
        .catch(async (error) => {
          logger.error('Rock-Paper-Scissors interaction failed:', error);
          await ephemeralReply(componentInteraction, 'Something went wrong while processing your move.').catch(() => {});
        });
    });

    collector.on('end', async () => {
      if (game.finished) return;
      game.finished = true;
      const expiredEmbed = makeEmbed(rpsConfig.text.inviteTitle, rpsConfig.text.expired);
      await game.message.edit({ embeds: [expiredEmbed], components: disableRows(game.message.components) }).catch(() => {});
    });
  },
};

async function handleGameInteraction(interaction, game, collector) {
  if (interaction.customId === 'rps:join') {
    if (interaction.user.id === game.creatorId) {
      await ephemeralReply(interaction, rpsConfig.text.selfJoinError);
      return;
    }
    if (game.opponentId) {
      await ephemeralReply(interaction, rpsConfig.text.notInvitedError);
      return;
    }

    game.opponentId = interaction.user.id;
    game.scores.set(game.opponentId, 0);
    await interaction.deferUpdate();
    await game.message.edit({
      content: `${interaction.user} ${mentionUser(game.creatorId)}`,
      embeds: [makeMoveEmbed(game, rpsConfig.text.accepted.replace('{opponent}', interaction.user.toString()))],
      components: makeMoveRows(game),
    });
    return;
  }

  if (!interaction.customId.startsWith('rps:move:')) return;
  if (!game.opponentId) {
    await ephemeralReply(interaction, rpsConfig.text.unavailableError);
    return;
  }
  if (interaction.user.id !== game.creatorId && interaction.user.id !== game.opponentId) {
    await ephemeralReply(interaction, rpsConfig.text.notPlayerError);
    return;
  }

  const move = interaction.customId.slice('rps:move:'.length);
  if (!RPS_MOVES.includes(move) || game.finished) {
    await ephemeralReply(interaction, rpsConfig.text.unavailableError);
    return;
  }
  if (game.choices.has(interaction.user.id)) {
    await ephemeralReply(interaction, rpsConfig.text.alreadyLocked);
    return;
  }

  game.choices.set(interaction.user.id, move);
  await interaction.deferUpdate();
  if (game.choices.size < 2) {
    await game.message.edit({
      embeds: [makeMoveEmbed(game, makeWaitingText(game))],
      components: makeMoveRows(game),
    });
    return;
  }

  await finishRound(game, collector);
}

async function finishRound(game, collector) {
  const result = resolveRpsRound(game, { allowTies: game.allowTies });
  const { firstMove, secondMove, winnerId, round, isFinalRound } = result;
  let roundDescription;

  if (!winnerId) {
    const roundTieText = format(rpsConfig.text.roundTie, {
      round,
      move: displayMove(firstMove),
    });
    roundDescription = result.tiebreakStarted
      ? `The match is tied; sudden death begins after this tie. ${roundTieText}`
      : result.tiebreak
        ? `Sudden-death round: ${roundTieText}`
        : roundTieText;
    if (result.replay) {
      await game.message.edit({
        embeds: [makeMoveEmbed(game, `${roundDescription}\n\n${makeMoveDescription(game)}`)],
        components: makeMoveRows(game),
      });
      return;
    }
  } else {
    const loserId = winnerId === game.creatorId ? game.opponentId : game.creatorId;
    const winnerMove = winnerId === game.creatorId ? firstMove : secondMove;
    const loserMove = winnerId === game.creatorId ? secondMove : firstMove;
    roundDescription = format(rpsConfig.text.roundWinner, {
      round,
      winner: mentionUser(winnerId),
      winnerMove: displayMove(winnerMove),
      loserMove: displayMove(loserMove),
    });
  }

  game.roundResults.push(format(rpsConfig.text.finalChoices, {
    player: mentionUser(game.creatorId),
    opponent: mentionUser(game.opponentId),
    move1: displayMove(firstMove),
    move2: displayMove(secondMove),
  }));

  if (isFinalRound) {
    collector.stop('completed');
    const firstScore = game.scores.get(game.creatorId);
    const secondScore = game.scores.get(game.opponentId);
    const resultText = firstScore === secondScore
      ? format(rpsConfig.text.matchTie, { score1: firstScore, score2: secondScore })
      : format(rpsConfig.text.matchWinner, {
        winner: mentionUser(firstScore > secondScore ? game.creatorId : game.opponentId),
        score1: Math.max(firstScore, secondScore),
        score2: Math.min(firstScore, secondScore),
      });
    const finalEmbed = makeEmbed(
      rpsConfig.text.inviteTitle,
      `${roundDescription}\n\n**${resultText}**\n\n${game.roundResults.join('\n')}`,
    );
    await game.message.edit({ embeds: [finalEmbed], components: disableRows(game.message.components) });
    return;
  }

  await game.message.edit({
    embeds: [makeMoveEmbed(game, `${roundDescription}\n\n${makeMoveDescription(game)}`)],
    components: makeMoveRows(game),
  });
}

function makeMoveEmbed(game, description) {
  return makeEmbed(rpsConfig.text.chooseTitle, description || makeMoveDescription(game));
}

function makeMoveDescription(game) {
  return format(rpsConfig.text.chooseDescription, {
    round: game.round,
    rounds: game.rounds,
    player: mentionUser(game.creatorId),
    opponent: mentionUser(game.opponentId),
    score1: game.scores.get(game.creatorId) || 0,
    score2: game.scores.get(game.opponentId) || 0,
  });
}

function makeWaitingText(game) {
  const lockedCount = game.choices.size;
  return `${makeMoveDescription(game)}\n\n${format(rpsConfig.text.waitingDescription, { round: game.round })}\n${lockedCount} of 2 players locked in.`;
}

function makeMoveRows(game) {
  const row = new ActionRowBuilder().addComponents(
    ...RPS_MOVES.map((move) => new ButtonBuilder()
      .setCustomId(`rps:move:${move}`)
      .setStyle(ButtonStyle.Secondary)
      .setEmoji(parseButtonEmoji(rpsConfig.emojis[move]))
      .setDisabled(game.choices.has(game.creatorId) && game.choices.has(game.opponentId))),
  );
  return [row];
}

function makeEmbed(title, description) {
  // Pass the payload to the builder constructor so shared EmbedBuilder
  // convenience patches elsewhere in the app cannot strip game emoji from
  // the move reveal or configured text.
  return new EmbedBuilder({
    color: normalizeColor(rpsConfig.embedColor),
    title,
    description,
  });
}

function displayMove(move) {
  return rpsConfig.emojis[move];
}

function parseButtonEmoji(value) {
  const match = /^<(a?):([A-Za-z0-9_]+):(\d{17,20})>$/.exec(value);
  if (!match) return value;
  return { animated: Boolean(match[1]), name: match[2], id: match[3] };
}

function normalizeColor(color) {
  if (Number.isInteger(color)) return color;
  if (typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color)) {
    return Number.parseInt(color.slice(1), 16);
  }
  return 0xD8D9FF;
}

function format(template, values) {
  return String(template).replace(/\{([A-Za-z0-9]+)\}/g, (placeholder, key) => values[key] ?? placeholder);
}

function mentionUser(userId) {
  return `<@${userId}>`;
}

function disableRows(rows) {
  return rows.map((row) => {
    const json = row.toJSON();
    json.components = json.components.map((component) => ({ ...component, disabled: true }));
    return json;
  });
}

function ephemeralReply(interaction, content) {
  return InteractionHelper.safeReply(interaction, { content, flags: MessageFlags.Ephemeral });
}
