// A fake ActionCable consumer for tests: subscriptions.create returns a stub that
// records the mixin (so a test can drive `received`/`connected`) and never opens a
// real WebSocket. Pass via AppProvider's consumerFactory.

import type { Consumer } from "@rails/actioncable";

export interface FakeSubscription {
  received?: (data: unknown) => void;
  connected?: () => void;
  unsubscribe: () => void;
}

export function makeFakeConsumer(): { consumer: Consumer; subscriptions: FakeSubscription[] } {
  const subscriptions: FakeSubscription[] = [];
  const consumer = {
    subscriptions: {
      create(_channel: unknown, mixin: Record<string, unknown>) {
        const sub: FakeSubscription = {
          received: mixin.received as ((data: unknown) => void) | undefined,
          connected: mixin.connected as (() => void) | undefined,
          unsubscribe: () => {},
        };
        subscriptions.push(sub);
        return sub;
      },
    },
  } as unknown as Consumer;
  return { consumer, subscriptions };
}
