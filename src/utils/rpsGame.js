export const RPS_MOVES = ['rock', 'paper', 'scissors'];

const MOVE_BEATS = { rock: 'scissors', paper: 'rock', scissors: 'paper' };

export function resolveRpsRound(game) {
  const firstMove = game.choices.get(game.creatorId);
  const secondMove = game.choices.get(game.opponentId);
  let winnerId = null;
  const round = game.round;

  if (firstMove !== secondMove) {
    winnerId = MOVE_BEATS[firstMove] === secondMove ? game.creatorId : game.opponentId;
    game.scores.set(winnerId, (game.scores.get(winnerId) ?? 0) + 1);
  }

  const isFinalRound = round >= game.rounds;
  if (isFinalRound) {
    game.finished = true;
  } else {
    game.round += 1;
    game.choices.clear();
  }

  return { firstMove, secondMove, winnerId, round, isFinalRound };
}
