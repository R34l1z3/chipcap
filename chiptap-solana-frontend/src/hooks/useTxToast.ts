// ============================================================
// src/hooks/useTxToast.ts
//
// Wraps an async tx-builder so successes show a generic info toast
// and failures get a typed `error` toast via notifyTxError().
// Returns a tuple of [run, pending, error] like a mutation hook.
// ============================================================

import { useCallback, useState } from "react";
import { notify, notifyTxError } from "../lib/notifications";

export function useTxToast<T>(label: string, fn: () => Promise<T>) {
  const [pending, setPending] = useState(false);
  const [error, setError]     = useState<string | null>(null);

  const run = useCallback(async (): Promise<T | null> => {
    setError(null);
    setPending(true);
    try {
      const result = await fn();
      notify("info", `${label} ✓`);
      return result;
    } catch (e) {
      notifyTxError(label, e);
      setError((e as Error)?.message ?? String(e));
      return null;
    } finally {
      setPending(false);
    }
  }, [label, fn]);

  return [run, pending, error] as const;
}
