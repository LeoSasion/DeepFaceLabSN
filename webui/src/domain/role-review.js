// Drafts stay in this browser session and are bounded across workspace/side pairs.
export function createRoleReviewStore(limit = 6) {
  const drafts = new Map();
  return {
    get(key) {
      const draft = drafts.get(key);
      return draft ? { ...draft, selected: [...draft.selected] } : null;
    },
    set(key, draft) {
      if (!key) return;
      drafts.delete(key);
      drafts.set(key, { ...draft, selected: [...draft.selected] });
      while (drafts.size > limit) drafts.delete(drafts.keys().next().value);
    },
    delete(key) { drafts.delete(key); },
  };
}

export function roleReviewRecovery(error, phase) {
  if (error?.code === "ROLE_RECOVERY_REQUIRED") return "recovery";
  if (phase === "refresh") return "refresh";
  if (error?.code === "ROLE_DATASET_CHANGED") return "analyze";
  if (phase === "analyze" && /准备视觉依赖/.test(error?.message ?? "")) return "dependencies";
  if (["WORKSPACE_JOB_BUSY", "WORKSPACE_MUTATION_BUSY", "ROLE_ASSIGNMENT_BUSY", "PROJECT_RESTART_PENDING"].includes(error?.code)) return null;
  // A lost mutation response does not establish that it failed. Refresh recovery
  // history before offering another write; never automatically repeat assignment.
  return phase === "analyze" ? "analyze" : "refresh";
}
