import { repairSessionResources, SessionRepairError } from "./session-repair.mjs";

export function onRequest(body, ctx) {
  if (ctx?.options?.enabled !== true || ctx.protocol !== "responses" ||
      typeof ctx.path !== "string" || !ctx.path.endsWith("/responses")) return;

  try {
    const repaired = repairSessionResources(body);
    if (repaired.changed) return { ...repaired.body, store: false };
  } catch (error) {
    if (!(error instanceof SessionRepairError)) throw error;
    // A thrown hook fails open in Magpie; expected cleanup failures must reject.
    ctx.reject(400, `${error.code}: ${error.message}`);
  }
}
