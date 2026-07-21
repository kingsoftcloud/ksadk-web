export function ownsOlderMessageScrollRequest(options: {
  requestedSessionId: string;
  activeSessionId: string | null;
  requestToken: symbol;
  activeRequestToken: symbol | null;
}): boolean {
  return options.requestedSessionId === options.activeSessionId
    && options.requestToken === options.activeRequestToken;
}
