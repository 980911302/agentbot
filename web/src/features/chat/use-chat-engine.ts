import { useRef, useSyncExternalStore } from 'react';
import { ChatEngine } from './chat-engine';

export function useChatEngine() {
  const ref = useRef<ChatEngine | null>(null);
  if (!ref.current) ref.current = new ChatEngine();
  const engine = ref.current;
  useSyncExternalStore(engine.subscribe, engine.getVersion);
  return engine;
}
