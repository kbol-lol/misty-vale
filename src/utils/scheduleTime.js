const UNIT_MS = Object.freeze({
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000,
});

export function durationMilliseconds(value, unit) {
  if (!Number.isInteger(value) || value < 1 || !UNIT_MS[unit]) {
    throw new RangeError('A positive integer and a supported time unit are required.');
  }
  return value * UNIT_MS[unit];
}

export function advanceInterval(nextRunAt, intervalMs, now) {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new RangeError('The schedule interval must be a positive number.');
  }
  if (!Number.isFinite(nextRunAt) || nextRunAt <= 0) return now + intervalMs;
  return nextRunAt + (Math.floor(Math.max(0, now - nextRunAt) / intervalMs) + 1) * intervalMs;
}

export function inactivityDeadline({ armedAt, createdAt, joinedAt, lastActivityAt, deadlineMs }) {
  return Math.max(armedAt || 0, createdAt || 0, joinedAt || 0, lastActivityAt || 0) + deadlineMs;
}

export function formatDuration(milliseconds) {
  if (milliseconds % UNIT_MS.days === 0) {
    const days = milliseconds / UNIT_MS.days;
    return `${days} ${days === 1 ? 'day' : 'days'}`;
  }
  if (milliseconds % UNIT_MS.hours === 0) {
    const hours = milliseconds / UNIT_MS.hours;
    return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  }
  const minutes = Math.round(milliseconds / UNIT_MS.minutes);
  return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
}
