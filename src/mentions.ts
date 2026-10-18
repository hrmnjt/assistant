/**
 * Whether a shared-channel message mentions the assistant: `@assistant` as a
 * whole token anywhere, in any case. Longer handles, words, and addresses
 * such as `@assistants`, `@assistant_bot`, or `me@assistant.example` do not count.
 */
export function mentionsAssistant(text: string) {
  return /(?:^|[^\p{L}\p{N}_@.])@assistant(?![\p{L}\p{N}_@-]|\.[\p{L}\p{N}])/iu.test(text);
}
