// Lightweight logger that wraps opencode's app logger.
// Silently no-ops if the log API is unavailable.

export function createLogger(client) {
  return {
    log(scope, message, level = "debug") {
      try {
        client?.app?.log?.({ scope, message, level });
      } catch {
        // logging must never break the plugin
      }
    },
  };
}