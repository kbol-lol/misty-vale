import assert from 'node:assert/strict';
import test from 'node:test';
import connectFourCommand from '../src/commands/Fun/connectfour.js';
import {
  CONNECT_FOUR_COLUMNS,
  CONNECT_FOUR_ROWS,
  createConnectFourBoard,
  dropConnectFourDisc,
  hasConnectFourWin,
  offerConnectFourDraw,
  resolveConnectFourRound,
  respondToConnectFourDraw,
  surrenderConnectFourGame,
} from '../src/utils/connectFourGame.js';
import { isCollectorManagedComponent } from '../src/utils/collectorComponents.js';

function makeGame(rounds = 1, allowTies = true) {
  return {
    creatorId: 'player-yellow',
    opponentId: 'player-red',
    rounds,
    allowTies,
    round: 1,
    scores: new Map([['player-yellow', 0], ['player-red', 0]]),
    board: createConnectFourBoard(),
    startingPlayerId: 'player-yellow',
    currentPlayerId: 'player-yellow',
    drawOfferId: null,
    finished: false,
  };
}

function playColumns(game, columns) {
  let finalMove;
  for (const column of columns) {
    finalMove = dropConnectFourDisc(game, game.currentPlayerId, column);
    assert.equal(finalMove.status, 'dropped');
    if (finalMove.winnerId || finalMove.boardFull) {
      return { move: finalMove, result: resolveConnectFourRound(game, finalMove.winnerId, { allowTies: game.allowTies }) };
    }
    game.currentPlayerId = game.currentPlayerId === game.creatorId ? game.opponentId : game.creatorId;
  }
  return { move: finalMove, result: null };
}

test('Connect Four command exposes rounds up to twenty and tie disabling', () => {
  const command = connectFourCommand.data.toJSON();
  const rounds = command.options.find(option => option.name === 'rounds');
  const disableTies = command.options.find(option => option.name === 'disable_ties');

  assert.equal(rounds.max_value, 20);
  assert.equal(disableTies.type, 5);
});

test('Connect Four buttons are handled by the game collector', () => {
  for (const customId of [
    'connectfour:join',
    'connectfour:drop:1',
    'connectfour:surrender',
    'connectfour:offer-draw',
    'connectfour:accept-draw',
    'connectfour:decline-draw',
  ]) {
    assert.equal(isCollectorManagedComponent(customId.split(':')[0]), true, customId);
  }
});

test('board starts empty and a disc drops to the bottom of its column', () => {
  const game = makeGame();
  assert.equal(game.board.length, CONNECT_FOUR_ROWS);
  assert.equal(game.board.every(row => row.length === CONNECT_FOUR_COLUMNS && row.every(cell => cell === null)), true);

  const move = dropConnectFourDisc(game, game.creatorId, 3);
  assert.deepEqual({ status: move.status, row: move.row, color: move.color }, {
    status: 'dropped',
    row: CONNECT_FOUR_ROWS - 1,
    color: 'yellow',
  });
});

test('players must take turns and cannot place a disc in a full column', () => {
  const game = makeGame();
  assert.equal(dropConnectFourDisc(game, game.opponentId, 0).status, 'not_turn');

  for (let row = CONNECT_FOUR_ROWS - 1; row >= 0; row -= 1) {
    game.board[row][0] = row % 2 ? 'yellow' : 'red';
  }
  assert.equal(dropConnectFourDisc(game, game.creatorId, 0).status, 'column_full');
});

test('detects horizontal, vertical, and both diagonal four-in-a-row wins', () => {
  const wins = [
    { cells: [[5, 0], [5, 1], [5, 2], [5, 3]], last: [5, 3] },
    { cells: [[2, 4], [3, 4], [4, 4], [5, 4]], last: [2, 4] },
    { cells: [[2, 1], [3, 2], [4, 3], [5, 4]], last: [2, 1] },
    { cells: [[5, 1], [4, 2], [3, 3], [2, 4]], last: [2, 4] },
  ];

  for (const { cells, last } of wins) {
    const board = createConnectFourBoard();
    for (const [row, column] of cells) board[row][column] = 'yellow';
    assert.equal(hasConnectFourWin(board, ...last), true);
  }
});

test('winning a round awards a point and prepares the next round with the other starter', () => {
  const game = makeGame(2);
  const { move, result } = playColumns(game, [0, 0, 1, 1, 2, 2, 3]);

  assert.equal(move.winnerId, game.creatorId);
  assert.equal(result.status, 'round_finished');
  assert.equal(game.scores.get(game.creatorId), 1);
  assert.equal(game.round, 2);
  assert.equal(game.currentPlayerId, game.opponentId);
  assert.equal(game.board.flat().every(cell => cell === null), true);
});

test('matches can complete all twenty rounds', () => {
  const game = makeGame(20);

  for (let round = 1; round <= 20; round += 1) {
    const { result } = playColumns(game, [0, 0, 1, 1, 2, 2, 3]);
    assert.equal(result.round, round);
    assert.equal(result.status, round === 20 ? 'match_finished' : 'round_finished');
    assert.equal(game.finished, round === 20);
  }

  assert.equal(game.scores.get(game.creatorId), 10);
  assert.equal(game.scores.get(game.opponentId), 10);
});

test('a tied final score starts sudden death when ties are disabled', () => {
  const game = makeGame(2, false);
  game.scores.set(game.creatorId, 1);
  game.scores.set(game.opponentId, 0);
  game.round = 2;

  const result = resolveConnectFourRound(game, game.opponentId, { allowTies: false });

  assert.equal(result.status, 'round_finished');
  assert.equal(result.tiebreakStarted, true);
  assert.equal(game.round, 3);
  assert.equal(game.finished, false);
});

test('a full board replays the round when ties are disabled', () => {
  const game = makeGame(1, false);
  game.board = [
    ['yellow', 'red', 'yellow', 'red', 'red', 'yellow', 'red'],
    ['red', 'red', 'red', 'yellow', 'red', 'yellow', 'yellow'],
    ['red', 'yellow', 'red', 'red', 'red', 'yellow', 'yellow'],
    ['red', 'yellow', 'yellow', 'red', 'yellow', 'red', 'red'],
    ['yellow', 'red', 'yellow', 'red', 'yellow', 'yellow', 'yellow'],
    ['yellow', 'yellow', 'red', 'yellow', 'red', 'yellow', 'yellow'],
  ];
  assert.equal(
    game.board.every((row, rowIndex) =>
      row.every((_cell, columnIndex) => !hasConnectFourWin(game.board, rowIndex, columnIndex)),
    ),
    true,
  );

  const result = resolveConnectFourRound(game, null, { allowTies: false });

  assert.equal(result.status, 'replay');
  assert.equal(game.round, 1);
  assert.equal(game.board.flat().every(cell => cell === null), true);
  assert.equal(game.finished, false);
});

test('players can offer and accept or decline draws; either can forfeit', () => {
  const game = makeGame(3);
  assert.deepEqual(offerConnectFourDraw(game, game.creatorId), { status: 'offered' });
  assert.deepEqual(respondToConnectFourDraw(game, game.creatorId, true), { status: 'own_offer' });
  assert.deepEqual(respondToConnectFourDraw(game, game.opponentId, false), { status: 'declined' });
  assert.equal(game.drawOfferId, null);

  assert.deepEqual(offerConnectFourDraw(game, game.opponentId), { status: 'offered' });
  assert.deepEqual(respondToConnectFourDraw(game, game.creatorId, true), { status: 'accepted' });
  assert.equal(game.finished, true);
});

test('surrender declares the other player the winner and rejects spectators', () => {
  const game = makeGame();
  assert.deepEqual(surrenderConnectFourGame(game, 'spectator'), { status: 'not_player' });
  assert.deepEqual(surrenderConnectFourGame(game, game.opponentId), {
    status: 'surrendered',
    loserId: game.opponentId,
    winnerId: game.creatorId,
  });
  assert.equal(game.finished, true);
});
