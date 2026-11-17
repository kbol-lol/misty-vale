/**
 * Rock-paper-scissors presentation and match defaults.
 * Text templates support placeholders such as {player}, {opponent}, {round},
 * {rounds}, {winner}, {winnerMove}, {loserMove}, {score1}, and {score2}.
 */
export const rpsConfig = {
  defaultRounds: 1,
  maximumRounds: 20,
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
    surrenderButton: 'Give up',
    offerDrawButton: 'Offer draw',
    acceptDrawButton: 'Accept draw',
    declineDrawButton: 'Decline draw',
    chooseTitle: 'Any of you can go first',
    chooseDescription: 'Click a button to lock in your move for round {round} of {rounds}.\n\nScore: {player} **{score1}** — **{score2}** {opponent}',
    waitingDescription: 'Waiting for the other player to lock in round {round}…',
    roundTie: 'Round {round}: it is a tie! Both chose {move}.',
    roundWinner: 'Round {round}: {winner} wins with {winnerMove} against {loserMove}.',
    matchWinner: '{winner} wins the match **{score1}–{score2}**!',
    matchTie: 'The match is a tie at **{score1}–{score2}**!',
    finalChoices: '{player} chose {move1}\n{opponent} chose {move2}',
    expired: 'This Rock-Paper-Scissors game expired before it was completed.',
    accepted: '{opponent} joined the game. Choose your moves below.',
    drawOffer: '{player} offers a draw. {opponent}, accept or decline the offer.',
    drawAccepted: 'The draw offer was accepted. The match ends in a draw at **{score1}–{score2}**.',
    drawDeclined: '{opponent} declined the draw offer.',
    drawOfferPending: 'A draw offer is already waiting for a response.',
    drawOfferMissing: 'There is no draw offer to respond to.',
    drawOfferOwn: 'You cannot accept or decline your own draw offer.',
    surrendered: '{loser} gave up. {winner} wins the match **{score1}–{score2}**.',
    alreadyLocked: 'Your move for this round is already locked in.',
    selfJoinError: 'You cannot play Rock-Paper-Scissors against yourself.',
    unavailableError: 'This game is no longer accepting players.',
    notInvitedError: 'This game has already been joined by someone else.',
    notPlayerError: 'Only the two players in this game can choose a move.',
  },
};

export default rpsConfig;
