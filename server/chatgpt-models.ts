import { createModels, type CredentialStore } from '@earendil-works/pi-ai';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { refreshSignIn } from './chatgpt-sign-in.js';

export function chatgptModels(credentials: CredentialStore) {
  const models = createModels({
    credentials,
    authContext: { env: async () => undefined, fileExists: async () => false },
  });
  const provider = openaiProvider();
  // Do not consult API-key environment variables or other applications' credentials.
  // pi-ai loads its own ChatGPT sign-in code by a path a Worker bundle cannot
  // follow, so the admin page's sign-in also refreshes and presents the token.
  const subscription: typeof provider = {
    ...provider,
    auth: {
      oauth: {
        name: 'OpenAI (ChatGPT subscription)',
        isSubscription: true,
        login: async () => {
          throw new Error('Connect ChatGPT on the admin page.');
        },
        refresh: refreshSignIn,
        toAuth: async (credential) => ({ apiKey: credential.access }),
      },
    },
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
