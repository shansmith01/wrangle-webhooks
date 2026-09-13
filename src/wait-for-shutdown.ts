export function waitForShutdownSignal(): Promise<void> {
  return new Promise((resolve) => {
    // Heartbeats are unref'd so a programmatic client does not pin the process.
    // The CLI must hold a referenced handle or Node exits as soon as the banner prints.
    const keepAlive = setInterval(() => undefined, 60_000);
    const finish = (): void => {
      clearInterval(keepAlive);
      process.off("SIGINT", finish);
      process.off("SIGTERM", finish);
      resolve();
    };
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
  });
}
