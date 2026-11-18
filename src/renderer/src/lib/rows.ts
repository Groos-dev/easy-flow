export function reuseRows<T>(previous: T[], next: T[], key: (row: T) => string): T[] {
  const known = new Map(previous.map(row => [key(row), row]))
  const rows = next.map(row => {
    const cached = known.get(key(row))
    return cached && JSON.stringify(cached) === JSON.stringify(row) ? cached : row
  })
  return rows.length === previous.length && rows.every((row, i) => row === previous[i])
    ? previous
    : rows
}
