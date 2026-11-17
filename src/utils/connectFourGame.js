export const CONNECT_FOUR_ROWS = 6;
export const CONNECT_FOUR_COLUMNS = 7;

export function createConnectFourBoard() {
  return Array.from({ length: CONNECT_FOUR_ROWS }, () => Array(CONNECT_FOUR_COLUMNS).fill(null));
}

export function dropConnectFourDisc(game, playerId, column) {
  if (game.finished) return { status: 'finished' };
  if (playerId !== game.creatorId && playerId !== game.opponentId) return { status: 'not_player' };
  if (playerId !== game.currentPlayerId) return { status: 'not_turn' };
  if (!Number.isInteger(column) || column < 0 || column >= CONNECT_FOUR_COLUMNS) {
    return { status: 'invalid_column' };
  }

  let row = CONNECT_FOUR_ROWS - 1;
  while (row >= 0 && game.board[row][column] !== null) row -= 1;
  if (row < 0) return { status: 'column_full' };

  const color = playerId === game.creatorId ? 'yellow' : 'red';
  game.board[row][column] = color;

  return {
    status: 'dropped',
    row,
    column,
    color,
    winnerId: hasConnectFourWin(game.board, row, column) ? playerId : null,
    boardFull: game.board[0].every(cell => cell !== null),
  };
}

export function hasConnectFourWin(board, row, column) {
  const color = board[row][column];
  if (!color) return false;

  const directions = [
    [0, 1],
    [1, 0],
    [1, 1],
    [1, -1],
  ];

  return directions.some(([rowStep, columnStep]) => {
    let connected = 1;
    for (const sign of [-1, 1]) {
      let nextRow = row + rowStep * sign;
      let nextColumn = column + columnStep * sign;
      while (
        nextRow >= 0
        && nextRow < CONNECT_FOUR_ROWS
        && nextColumn >= 0
        && nextColumn < CONNECT_FOUR_COLUMNS
        && board[nextRow][nextColumn] === color
      ) {
        connected += 1;
        nextRow += rowStep * sign;
        nextColumn += columnStep * sign;
      }
    }
    return connected >= 4;
  });
}

export function resolveConnectFourGame(game, winnerId) {
  if (!winnerId && !game.board[0].every(cell => cell !== null)) {
    return { status: 'in_progress' };
  }

  if (!winnerId) {
    game.board = createConnectFourBoard();
    game.startingPlayerId = game.startingPlayerId === game.creatorId ? game.opponentId : game.creatorId;
    game.currentPlayerId = game.startingPlayerId;
    return { status: 'replay' };
  }

  game.finished = true;
  return { status: 'finished', winnerId };
}

export function surrenderConnectFourGame(game, playerId) {
  if (game.finished) return { status: 'finished' };
  if (playerId !== game.creatorId && playerId !== game.opponentId) return { status: 'not_player' };

  game.finished = true;
  return {
    status: 'surrendered',
    loserId: playerId,
    winnerId: playerId === game.creatorId ? game.opponentId : game.creatorId,
  };
}
