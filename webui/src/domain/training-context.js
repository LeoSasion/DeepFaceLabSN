import { activeJobStates } from "./job-presentation.js";

// A terminal selection must never redirect controls away from a live trainer.
export function selectTrainingJob(jobs = [], selectedJob = null) {
  const trainingJobs = jobs.filter(job => job.commandId === "train.saehd");
  return trainingJobs.find(job => activeJobStates.has(job.state) && job.state !== "queued")
    ?? trainingJobs.find(job => job.state === "queued")
    ?? trainingJobs.find(job => job.id === selectedJob?.id)
    ?? trainingJobs[0]
    ?? null;
}

// An explicitly named model that has disappeared is not interchangeable with
// another checkpoint. Leave the new-task model picker in control when ambiguous.
export function resolveSavedTrainingModel(models = [], job = null) {
  const candidates = models.filter(model => model.type === "SAEHD");
  const requestedName = job?.parameters?.forceModelName;
  if (requestedName) return candidates.find(model => model.name === requestedName) ?? null;
  return candidates.length === 1 ? candidates[0] : null;
}

export function getSavedTrainingModelState(models = [], job = null) {
  if (resolveSavedTrainingModel(models, job)) return "available";
  if (job?.parameters?.forceModelName) return "missing";
  return models.some(model => model.type === "SAEHD") ? "ambiguous" : "empty";
}
