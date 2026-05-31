import { useCallback, useEffect, useRef, useState } from "react";

type UseWebSocketOptions = {
  onMessage?: (message: Record<string, unknown>) => void;
  onError?: (error: string) => void;
  reconnectInterval?: number;
  maxReconnectAttempts?: number;
};

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

  const resolveSocketUrl = useCallback(() => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const host = import.meta.env.DEV ? `${window.location.hostname}:4000` : window.location.host;

    return `${protocol}//${host}/ws`;
  }, []);

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

    const socket = new WebSocket(resolveSocketUrl());
    socketRef.current = socket;

    socket.onopen = () => {
      if (socketRef.current !== socket) {
        return;
      }

      setIsConnected(true);
      setError(null);
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
        reconnectTimerRef.current = setTimeout(() => {
          reconnectAttemptsRef.current++;
          connect();
        }, reconnectInterval);
      } else {
        const msg = "WebSocket connection lost";
        setError(msg);
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
  }, [maxReconnectAttempts, reconnectInterval, resolveSocketUrl]);

  const send = useCallback((data: unknown): boolean => {
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify(data));
      return true;
    }
    return false;
  }, []);

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
  }, [maxReconnectAttempts]);

  useEffect(() => {
    return () => {
      disconnect();
    };
  }, [disconnect]);

  return { connect, send, disconnect, isConnected, error, socketRef };
}
