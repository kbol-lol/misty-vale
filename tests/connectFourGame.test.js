import assert from 'node:assert/strict';
import test from 'node:test';
import connectFourCommand from '../src/commands/Fun/connectfour.js';
import {
  CONNECT_FOUR_COLUMNS,
  CONNECT_FOUR_ROWS,
  createConnectFourBoard,
  dropConnectFourDisc,
  hasConnectFourWin,
  resolveConnectFourGame,
  surrenderConnectFourGame,
} from '../src/utils/connectFourGame.js';
import { isCollectorManagedComponent } from '../src/utils/collectorComponents.js';

function makeGame() {
  return {
    creatorId: 'player-yellow',
    opponentId: 'player-red',
    board: createConnectFourBoard(),
    startingPlayerId: 'player-yellow',
    currentPlayerId: 'player-yellow',
    finished: false,
  };
}

function playColumns(game, columns) {
  let finalMove;
  for (const column of columns) {
    finalMove = dropConnectFourDisc(game, game.currentPlayerId, column);
    assert.equal(finalMove.status, 'dropped');
    if (finalMove.winnerId || finalMove.boardFull) {
      return { move: finalMove, result: resolveConnectFourGame(game, finalMove.winnerId) };
    }
    game.currentPlayerId = game.currentPlayerId === game.creatorId ? game.opponentId : game.creatorId;
  }
  return { move: finalMove, result: null };
}

test('Connect Four command starts one complete game without round or draw options', () => {
  const command = connectFourCommand.data.toJSON();
  assert.deepEqual(command.options, []);
});

test('Connect Four buttons are handled by the game collector', () => {
  for (const customId of [
    'connectfour:join',
    'connectfour:drop:1',
    'connectfour:surrender',
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

test('a winning connect-four game ends immediately', () => {
  const game = makeGame();
  const { move, result } = playColumns(game, [0, 0, 1, 1, 2, 2, 3]);

  assert.equal(move.winnerId, game.creatorId);
  assert.equal(result.status, 'finished');
  assert.equal(result.winnerId, game.creatorId);
  assert.equal(game.finished, true);
});

test('a full board without a winner restarts the game with the other player', () => {
  const game = makeGame();
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

  const result = resolveConnectFourGame(game, null);

  assert.equal(result.status, 'replay');
  assert.equal(game.board.flat().every(cell => cell === null), true);
  assert.equal(game.currentPlayerId, game.opponentId);
  assert.equal(game.finished, false);
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
