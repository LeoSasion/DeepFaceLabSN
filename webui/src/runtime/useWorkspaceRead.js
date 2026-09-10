import { useCallback, useEffect, useRef, useState } from "react";

// Keep the last good inventory visible, and ignore requests superseded by a
// refresh after a mutation or by leaving the workspace screen.
export function useWorkspaceRead(load, onLoaded) {
  const [state, setState] = useState({ data: null, loading: false, error: null });
  const generation = useRef(0);
  const handlers = useRef({ load, onLoaded });
  handlers.current = { load, onLoaded };
  useEffect(() => () => { generation.current += 1; }, []);
  const refresh = useCallback(async () => {
    const request = ++generation.current;
    setState(current => ({ ...current, loading: true, error: null }));
    try {
      const data = await handlers.current.load();
      if (request !== generation.current) return false;
      setState({ data, loading: false, error: null });
      handlers.current.onLoaded?.(data);
      return true;
    } catch (error) {
      if (request === generation.current) setState(current => ({ ...current, loading: false, error }));
      return false;
    }
  }, []);
  return { ...state, refresh };
}
