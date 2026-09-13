export function resolveCliCommand(positionals: string[]): string {
  const args = positionals[0] === "dev-router" ? positionals.slice(1) : positionals;
  return args[0] ?? "connect";
}
