// ActionCable provider: creates a consumer against the /~cable mount and bridges
// connection state into React Context. The signed httpOnly clawd_uid cookie is
// sent by the browser automatically on the WS handshake — no token plumbed in JS.
// The consumer factory is injectable so tests drive a fake channel without a real
// WebSocket.

import { type Consumer, createConsumer } from "@rails/actioncable";
import { type FC, type ReactNode, createContext, useContext, useMemo } from "react";

export type ConsumerFactory = () => Consumer;

interface ActionCableContextValue {
  consumer: Consumer;
}

const ActionCableContext = createContext<ActionCableContextValue | null>(null);

export const CABLE_MOUNT = "/~cable";

interface Props {
  children: ReactNode;
  // Default creates a real consumer at /~cable; tests inject a fake.
  consumerFactory?: ConsumerFactory;
}

export const ActionCableProvider: FC<Props> = ({ children, consumerFactory }) => {
  const value = useMemo<ActionCableContextValue>(
    () => ({ consumer: (consumerFactory ?? (() => createConsumer(CABLE_MOUNT)))() }),
    [consumerFactory],
  );
  return <ActionCableContext.Provider value={value}>{children}</ActionCableContext.Provider>;
};

export function useConsumer(): Consumer {
  const ctx = useContext(ActionCableContext);
  if (!ctx) {
    throw new Error("useConsumer must be used within an ActionCableProvider");
  }
  return ctx.consumer;
}
