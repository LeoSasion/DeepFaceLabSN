import test from "node:test";
import assert from "node:assert/strict";
import { createRoleReviewStore, roleReviewRecovery } from "../src/domain/role-review.js";

test("person review drafts retain selection without crossing projects or sides", () => {
  const store = createRoleReviewStore(2);
  const draft = { data:{fingerprint:"reviewed"}, selected:["a.jpg"], roleName:"嘉宾", targetSide:"dst", threshold:.6 };
  store.set("project-a/src",draft);
  draft.selected.push("not-reviewed.jpg");
  assert.deepEqual(store.get("project-a/src").selected,["a.jpg"]);
  const returned = store.get("project-a/src"); returned.selected.length = 0;
  assert.equal(store.get("project-a/src").roleName,"嘉宾");
  assert.deepEqual(store.get("project-a/src").selected,["a.jpg"]);
  assert.equal(store.get("project-a/dst"),null);
  assert.equal(store.get("project-b/src"),null);
  store.set("project-a/dst",draft); store.set("project-b/src",draft);
  assert.equal(store.get("project-a/src"),null);
});

test("role failures offer a relevant recovery without blindly repeating mutations", () => {
  assert.equal(roleReviewRecovery({code:"ROLE_DATASET_CHANGED"},"assign"),"analyze");
  assert.equal(roleReviewRecovery({message:"角色分组模型缺失，请点击准备视觉依赖"},"analyze"),"dependencies");
  assert.equal(roleReviewRecovery({code:"RUNTIME_UNREACHABLE"},"assign"),"refresh");
  assert.equal(roleReviewRecovery({code:"RUNTIME_UNREACHABLE"},"analyze"),"analyze");
  assert.equal(roleReviewRecovery({code:"WORKSPACE_JOB_BUSY"},"restore"),null);
  assert.equal(roleReviewRecovery({code:"ROLE_NAME_INVALID"},"refresh"),"refresh");
});
