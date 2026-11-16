import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveRpsRound } from '../src/utils/rpsGame.js';
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
  for (const customId of ['rps:join', 'rps:move:rock', 'rps:move:paper', 'rps:move:scissors']) {
    assert.equal(isCollectorManagedComponent(customId.split(':')[0]), true, customId);
  }
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

test('round counts from one through five finish on the requested round', () => {
  for (let rounds = 1; rounds <= 5; rounds += 1) {
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

test('a winning move awards a point to the round winner', () => {
  const game = makeGame(1);
  game.choices.set(game.creatorId, 'rock');
  game.choices.set(game.opponentId, 'scissors');

  const result = resolveRpsRound(game);

  assert.equal(result.winnerId, game.creatorId);
  assert.equal(game.scores.get(game.creatorId), 1);
  assert.equal(game.scores.get(game.opponentId), 0);
});
