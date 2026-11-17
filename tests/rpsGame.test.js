import assert from 'node:assert/strict';
import test from 'node:test';
import rpsCommand from '../src/commands/Fun/rps.js';
import {
  offerRpsDraw,
  respondToRpsDraw,
  resolveRpsRound,
  surrenderRpsGame,
} from '../src/utils/rpsGame.js';
import { isCollectorManagedComponent } from '../src/utils/collectorComponents.js';

function makeGame(rounds) {
  return {
    creatorId: 'player-one',
    opponentId: 'player-two',
    rounds,
    round: 1,
    scores: new Map([['player-one', 0], ['player-two', 0]]),
    choices: new Map(),
    finished: false,
  };
}

test('RPS button interactions are left to their message collector', () => {
  for (const customId of [
    'rps:join',
    'rps:move:rock',
    'rps:move:paper',
    'rps:move:scissors',
    'rps:surrender',
    'rps:offer-draw',
    'rps:accept-draw',
    'rps:decline-draw',
  ]) {
    assert.equal(isCollectorManagedComponent(customId.split(':')[0]), true, customId);
  }
});

test('RPS slash command exposes the tie-disable option', () => {
  const command = rpsCommand.data.toJSON();
  const option = command.options.find(({ name }) => name === 'disable_ties');

  assert.equal(option?.type, 5);
  assert.match(option.description, /sudden death/i);
});

test('matching moves tie without changing scores', () => {
  for (const move of ['rock', 'paper', 'scissors']) {
    const game = makeGame(1);
    game.choices.set(game.creatorId, move);
    game.choices.set(game.opponentId, move);

    const result = resolveRpsRound(game);

    assert.equal(result.winnerId, null, `${move} vs ${move}`);
    assert.equal(game.scores.get(game.creatorId), 0);
    assert.equal(game.scores.get(game.opponentId), 0);
    assert.equal(game.finished, true);
  }
});

test('disabled ties replay the same round without changing score', () => {
  const game = makeGame(1);
  game.choices.set(game.creatorId, 'rock');
  game.choices.set(game.opponentId, 'rock');

  const tied = resolveRpsRound(game, { allowTies: false });

  assert.equal(tied.replay, true);
  assert.equal(tied.round, 1);
  assert.equal(tied.isFinalRound, false);
  assert.equal(game.round, 1);
  assert.equal(game.choices.size, 0);
  assert.equal(game.scores.get(game.creatorId), 0);
  assert.equal(game.scores.get(game.opponentId), 0);
  assert.equal(game.finished, false);

  game.choices.set(game.creatorId, 'rock');
  game.choices.set(game.opponentId, 'scissors');
  const decided = resolveRpsRound(game, { allowTies: false });

  assert.equal(decided.replay, false);
  assert.equal(decided.isFinalRound, true);
  assert.equal(decided.winnerId, game.creatorId);
  assert.equal(game.finished, true);
});

test('disabled ties use a sudden-death round when the match score is tied', () => {
  const game = makeGame(4);
  const rounds = [
    ['rock', 'scissors'],
    ['rock', 'scissors'],
    ['scissors', 'rock'],
    ['scissors', 'rock'],
  ];

  for (const [firstMove, secondMove] of rounds) {
    game.choices.set(game.creatorId, firstMove);
    game.choices.set(game.opponentId, secondMove);
    resolveRpsRound(game, { allowTies: false });
  }

  assert.equal(game.scores.get(game.creatorId), 2);
  assert.equal(game.scores.get(game.opponentId), 2);
  assert.equal(game.round, 5);
  assert.equal(game.finished, false);

  game.choices.set(game.creatorId, 'rock');
  game.choices.set(game.opponentId, 'scissors');
  const result = resolveRpsRound(game, { allowTies: false });

  assert.equal(result.isFinalRound, true);
  assert.equal(result.winnerId, game.creatorId);
  assert.equal(game.finished, true);
});

test('round counts from one through twenty finish on the requested round', () => {
  for (let rounds = 1; rounds <= 20; rounds += 1) {
    const game = makeGame(rounds);

    for (let round = 1; round <= rounds; round += 1) {
      game.choices.set(game.creatorId, 'rock');
      game.choices.set(game.opponentId, 'rock');

      const result = resolveRpsRound(game);

      assert.equal(result.round, round);
      assert.equal(result.isFinalRound, round === rounds);
      assert.equal(game.finished, round === rounds);
      if (round < rounds) {
        assert.equal(game.round, round + 1);
        assert.equal(game.choices.size, 0);
      }
    }

    assert.equal(game.round, rounds);
  }
});

test('RPS command accepts up to twenty rounds', () => {
  const roundsOption = rpsCommand.data.toJSON().options.find(({ name }) => name === 'rounds');
  assert.equal(roundsOption.max_value, 20);
});

test('players can offer and accept a draw, ending the match', () => {
  const game = makeGame(5);

  assert.deepEqual(offerRpsDraw(game, game.creatorId), { status: 'offered' });
  assert.deepEqual(offerRpsDraw(game, game.opponentId), { status: 'pending' });
  assert.deepEqual(respondToRpsDraw(game, game.creatorId, true), { status: 'own_offer' });
  assert.deepEqual(respondToRpsDraw(game, game.opponentId, true), { status: 'accepted' });
  assert.equal(game.finished, true);
});

test('declining a draw resumes the match and either player can surrender', () => {
  const game = makeGame(5);

  assert.deepEqual(offerRpsDraw(game, game.creatorId), { status: 'offered' });
  assert.deepEqual(respondToRpsDraw(game, game.opponentId, false), { status: 'declined' });
  assert.equal(game.drawOfferId, null);
  assert.equal(game.finished, false);
  assert.deepEqual(surrenderRpsGame(game, game.opponentId), {
    status: 'surrendered',
    loserId: game.opponentId,
    winnerId: game.creatorId,
  });
  assert.equal(game.finished, true);
});

test('non-players cannot offer draws, accept them, or surrender', () => {
  const game = makeGame(2);
  assert.deepEqual(offerRpsDraw(game, 'spectator'), { status: 'not_player' });
  assert.deepEqual(respondToRpsDraw(game, 'spectator', true), { status: 'missing' });
  assert.deepEqual(surrenderRpsGame(game, 'spectator'), { status: 'not_player' });
});

test('a winning move awards a point to the round winner', () => {
  const game = makeGame(1);
  game.choices.set(game.creatorId, 'rock');
  game.choices.set(game.opponentId, 'scissors');

  const result = resolveRpsRound(game);

  assert.equal(result.winnerId, game.creatorId);
  assert.equal(game.scores.get(game.creatorId), 1);
  assert.equal(game.scores.get(game.opponentId), 0);
});
