import { useEffect, useState } from "react";
import { createRoleReviewStore } from "../domain/role-review.js";

const store = createRoleReviewStore();
const empty = (key, side) => ({ key, threshold:0.5, data:null, selected:[], roleName:"", targetSide:side });

export function useRoleReviewDraft(workspaceKey, side, refreshVersion = 0) {
  const key = workspaceKey ? JSON.stringify([workspaceKey, side, refreshVersion]) : null;
  const [draft, setDraft] = useState(() => store.get(key) ?? empty(key, side));
  const current = draft.key === key ? draft : empty(key, side);
  useEffect(() => { setDraft(store.get(key) ?? empty(key, side)); }, [key, side]);
  useEffect(() => { if (draft.key === key) store.set(key, draft); }, [draft, key]);
  const update = patch => setDraft(previous => {
    const base = previous.key === key ? previous : empty(key, side);
    return { ...base, ...(typeof patch === "function" ? patch(base) : patch) };
  });
  return [current, update];
}
