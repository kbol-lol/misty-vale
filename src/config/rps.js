/**
 * Rock-paper-scissors presentation and match defaults.
 * Text templates support placeholders such as {player}, {opponent}, {round},
 * {rounds}, {winner}, {winnerMove}, {loserMove}, {score1}, and {score2}.
 */
export const rpsConfig = {
  defaultRounds: 1,
  maximumRounds: 5,
  gameTimeoutMs: 15 * 60 * 1000,
  embedColor: '#D8D9FF',
  emojis: {
    join: '✅',
    rock: '👊',
    paper: '🫳',
    scissors: '✌️',
  },
  text: {
    inviteTitle: 'Rock-Paper-Scissors',
    inviteDescription: 'Click the button below to play {rounds} round(s) of Rock-Paper-Scissors with {player}.',
    joinButton: 'Join game',
    chooseTitle: 'Any of you can go first',
    chooseDescription: 'Click a button to lock in your move for round {round} of {rounds}.\n\nScore: {player} **{score1}** — **{score2}** {opponent}',
    waitingDescription: 'Both players have locked in. Revealing round {round}…',
    roundTie: 'Round {round}: it is a tie! Both chose {move}.',
    roundWinner: 'Round {round}: {winner} wins with {winnerMove} against {loserMove}.',
    matchWinner: '{winner} wins the match **{score1}–{score2}**!',
    matchTie: 'The match is a tie at **{score1}–{score2}**!',
    finalChoices: '{player} chose {move1}\n{opponent} chose {move2}',
    expired: 'This Rock-Paper-Scissors game expired before it was completed.',
    accepted: '{opponent} joined the game. Choose your moves below.',
    locked: 'This game is updating. Please click again in a moment.',
    alreadyLocked: 'Your move for this round is already locked in.',
    selfJoinError: 'You cannot play Rock-Paper-Scissors against yourself.',
    unavailableError: 'This game is no longer accepting players.',
    notInvitedError: 'This game has already been joined by someone else.',
    notPlayerError: 'Only the two players in this game can choose a move.',
  },
};

export default rpsConfig;
