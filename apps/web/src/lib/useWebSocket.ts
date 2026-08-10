import { useCallback, useEffect, useRef, useState } from "react";
import { resolveWebSocketUrl } from "./appBackend";

type UseWebSocketOptions = {
  onMessage?: (message: Record<string, unknown>) => void;
  onError?: (error: string) => void;
  reconnectInterval?: number;
  maxReconnectAttempts?: number;
};

export type WebSocketConnectionState =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected";

export function useWebSocket(options: UseWebSocketOptions = {}) {
  const {
    onMessage,
    onError,
    reconnectInterval = 3000,
    maxReconnectAttempts = 10
  } = options;

  const socketRef = useRef<WebSocket | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const allowReconnectRef = useRef(true);
  const onMessageRef = useRef(onMessage);
  const onErrorRef = useRef(onError);
  onMessageRef.current = onMessage;
  onErrorRef.current = onError;

  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connectionState, setConnectionState] =
    useState<WebSocketConnectionState>("connecting");

  const connect = useCallback(() => {
    allowReconnectRef.current = true;

    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }

    const existing = socketRef.current;
    if (existing?.readyState === WebSocket.OPEN || existing?.readyState === WebSocket.CONNECTING) {
      return;
    }

    existing?.close();

    setConnectionState(reconnectAttemptsRef.current > 0 ? "reconnecting" : "connecting");
    const socket = new WebSocket(resolveWebSocketUrl());
    socketRef.current = socket;

    socket.onopen = () => {
      if (socketRef.current !== socket) {
        return;
      }

      setIsConnected(true);
      setError(null);
      setConnectionState("connected");
      reconnectAttemptsRef.current = 0;
    };

    socket.onclose = () => {
      if (socketRef.current !== socket) {
        return;
      }

      setIsConnected(false);

      if (!allowReconnectRef.current) {
        return;
      }

      if (reconnectAttemptsRef.current < maxReconnectAttempts) {
        setConnectionState("reconnecting");
        reconnectTimerRef.current = setTimeout(() => {
          reconnectAttemptsRef.current++;
          connect();
        }, reconnectInterval);
      } else {
        const msg = "WebSocket connection lost";
        setError(msg);
        setConnectionState("disconnected");
        onErrorRef.current?.(msg);
      }
    };

    socket.onerror = () => {
      if (socketRef.current !== socket) {
        return;
      }

      const msg = "WebSocket connection failed";
      setError(msg);
      onErrorRef.current?.(msg);
    };

    socket.onmessage = (event) => {
      if (socketRef.current !== socket) {
        return;
      }

      const message = JSON.parse(String(event.data)) as Record<string, unknown>;
      if (message.type === "ready") {
        return;
      }
      onMessageRef.current?.(message);
    };
  }, [maxReconnectAttempts, reconnectInterval]);

  const send = useCallback((data: unknown): boolean => {
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify(data));
      return true;
    }
    return false;
  }, []);

  const reconnect = useCallback(() => {
    allowReconnectRef.current = true;
    reconnectAttemptsRef.current = 0;
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }

    const existing = socketRef.current;
    socketRef.current = null;
    if (existing) {
      existing.onopen = null;
      existing.onclose = null;
      existing.onerror = null;
      existing.onmessage = null;
      existing.close();
    }

    setIsConnected(false);
    setError(null);
    setConnectionState("connecting");
    connect();
  }, [connect]);

  const disconnect = useCallback(() => {
    allowReconnectRef.current = false;

    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }

    reconnectAttemptsRef.current = maxReconnectAttempts;
    const socket = socketRef.current;
    socketRef.current = null;

    if (socket) {
      socket.onopen = null;
      socket.onclose = null;
      socket.onerror = null;
      socket.onmessage = null;
      socket.close();
    }

    setIsConnected(false);
    setConnectionState("disconnected");
  }, [maxReconnectAttempts]);

  useEffect(() => {
    return () => {
      disconnect();
    };
  }, [disconnect]);

  return {
    connect,
    reconnect,
    send,
    disconnect,
    isConnected,
    connectionState,
    error,
    socketRef
  };
}
