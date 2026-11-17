export const RPS_MOVES = ['rock', 'paper', 'scissors'];

const MOVE_BEATS = { rock: 'scissors', paper: 'rock', scissors: 'paper' };

export function offerRpsDraw(game, playerId) {
  if (game.finished) return { status: 'finished' };
  if (playerId !== game.creatorId && playerId !== game.opponentId) return { status: 'not_player' };
  if (game.drawOfferId) return { status: 'pending' };

  game.drawOfferId = playerId;
  return { status: 'offered' };
}

export function respondToRpsDraw(game, playerId, accept) {
  if (game.finished) return { status: 'finished' };
  if (!game.drawOfferId) return { status: 'missing' };
  if (playerId !== game.creatorId && playerId !== game.opponentId) return { status: 'not_player' };
  if (playerId === game.drawOfferId) return { status: 'own_offer' };

  if (accept) {
    game.finished = true;
    return { status: 'accepted' };
  }

  game.drawOfferId = null;
  return { status: 'declined' };
}

export function surrenderRpsGame(game, playerId) {
  if (game.finished) return { status: 'finished' };
  if (playerId !== game.creatorId && playerId !== game.opponentId) return { status: 'not_player' };

  game.finished = true;
  return {
    status: 'surrendered',
    loserId: playerId,
    winnerId: playerId === game.creatorId ? game.opponentId : game.creatorId,
  };
}

export function resolveRpsRound(game, { allowTies = true } = {}) {
  const firstMove = game.choices.get(game.creatorId);
  const secondMove = game.choices.get(game.opponentId);
  let winnerId = null;
  const round = game.round;

  if (firstMove === secondMove && !allowTies) {
    game.choices.clear();
    return {
      firstMove,
      secondMove,
      winnerId,
      round,
      isFinalRound: false,
      replay: true,
      tiebreak: game.round > game.rounds,
      tiebreakStarted: false,
    };
  }

  if (firstMove !== secondMove) {
    winnerId = MOVE_BEATS[firstMove] === secondMove ? game.creatorId : game.opponentId;
    game.scores.set(winnerId, (game.scores.get(winnerId) ?? 0) + 1);
  }

  let isFinalRound = round >= game.rounds;
  let tiebreak = false;
  let tiebreakStarted = false;
  if (isFinalRound && !allowTies && game.scores.get(game.creatorId) === game.scores.get(game.opponentId)) {
    game.round += 1;
    game.choices.clear();
    isFinalRound = false;
    tiebreak = true;
    tiebreakStarted = true;
  }

  if (isFinalRound) {
    game.finished = true;
  } else if (!tiebreak) {
    game.round += 1;
    game.choices.clear();
  }

  return { firstMove, secondMove, winnerId, round, isFinalRound, replay: false, tiebreak, tiebreakStarted };
}
