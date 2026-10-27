/** Quote one argument for a remote POSIX shell. */
export function shQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

export function shJoin(argv: readonly string[]): string {
  return argv.map(shQuote).join(' ')
}
