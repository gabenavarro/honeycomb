import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import {
  MutationCache,
  QueryCache,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import "./index.css";
import App from "./App";
import { ToastProvider } from "./hooks/useToasts";

// Deferred until after the provider tree mounts so caches can access the
// toast context. We stash a setter that the provider populates on mount.
type ToastFn = (kind: "error" | "info", title: string, body?: string) => void;
const toastRelay: { current: ToastFn | null } = { current: null };

function emitToast(title: string, body?: string, kind: "error" | "info" = "error") {
  toastRelay.current?.(kind, title, body);
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
  queryCache: new QueryCache({
    onError: (err, query) => {
      // Only toast on user-visible errors; skip background health polling.
      if (query.state.data === undefined) {
        emitToast(`Failed to load ${String(query.queryKey[0] ?? "data")}`, err.message);
      }
    },
  }),
  mutationCache: new MutationCache({
    onError: (err) => {
      emitToast("Request failed", err.message);
    },
  }),
});

function ToastRelayInstaller({ children }: { children: React.ReactNode }) {
  return (
    <ToastProvider>
      <ToastRelayBinder />
      {children}
    </ToastProvider>
  );
}

// Binds the `emitToast` global helper to the live ToastContext. Tiny inline
// component so we can call useToasts inside the provider subtree.
import { useEffect } from "react";
import { useToasts } from "./hooks/useToasts";

function ToastRelayBinder() {
  const { toast } = useToasts();
  useEffect(() => {
    toastRelay.current = (kind, title, body) => toast(kind, title, body);
    return () => {
      toastRelay.current = null;
    };
  }, [toast]);
  return null;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastRelayInstaller>
        <App />
      </ToastRelayInstaller>
    </QueryClientProvider>
  </StrictMode>,
);
