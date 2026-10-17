import { createModels, type CredentialStore } from '@earendil-works/pi-ai';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';

export function chatgptModels(credentials: CredentialStore) {
  const models = createModels({
    credentials,
    authContext: { env: async () => undefined, fileExists: async () => false },
  });
  const provider = openaiProvider();
  // Do not consult API-key environment variables or other applications' credentials.
  const subscription: typeof provider = {
    ...provider,
    auth: { oauth: provider.auth.oauth },
    streamSimple: (model, context, options) =>
      provider.streamSimple(model, context, {
        ...options,
        maxTokens: 4096,
        onProviderStreamEvent: async (event, currentModel) => {
          if (
            typeof event === 'object' &&
            event !== null &&
            'type' in event &&
            event.type === 'response.incomplete'
          )
            throw new Error('ChatGPT did not complete its response.');
          await options?.onProviderStreamEvent?.(event, currentModel);
        },
      }),
  };
  models.setProvider(subscription);
  return models;
}
