export type AllocationRow = { goal_id: string; monthly_target_minor: number; locked: boolean; priority: number };

export function redistributeTargets(rows: AllocationRow[], changedGoalId: string, requestedBasisPoints: number): AllocationRow[] {
  const total = rows.reduce((sum, row) => sum + row.monthly_target_minor, 0);
  if (!total) return rows.map((row) => ({ ...row }));
  const result = rows.map((row) => ({ ...row }));
  const changed = result.find((row) => row.goal_id === changedGoalId);
  if (!changed || requestedBasisPoints < 0 || requestedBasisPoints > 10_000) throw new Error("Invalid allocation change");
  changed.locked = false;
  if (result.filter((row) => !row.locked).length < 2) {
    const partner = result.filter((row) => row.goal_id !== changedGoalId).sort((a, b) => b.priority - a.priority || b.goal_id.localeCompare(a.goal_id))[0];
    if (partner) partner.locked = false;
  }
  const target = Math.floor((total * requestedBasisPoints + 5_000) / 10_000);
  const fixed = result.filter((row) => row.locked).reduce((sum, row) => sum + row.monthly_target_minor, 0);
  if (target + fixed > total) throw new Error("Locked goals leave too little room");
  changed.monthly_target_minor = target;
  const flexible = result.filter((row) => !row.locked && row.goal_id !== changedGoalId);
  let remaining = total - fixed - target;
  const weights = flexible.map((row) => row.monthly_target_minor);
  const weightTotal = weights.reduce((sum, value) => sum + value, 0) || flexible.length;
  flexible.forEach((row, index) => { row.monthly_target_minor = Math.floor(remaining * (weightTotal === flexible.length && weights.every((value) => value === 0) ? 1 : weights[index]) / weightTotal); });
  let remainder = remaining - flexible.reduce((sum, row) => sum + row.monthly_target_minor, 0);
  for (const row of flexible.sort((a, b) => a.priority - b.priority || a.goal_id.localeCompare(b.goal_id))) { if (!remainder) break; row.monthly_target_minor += 1; remainder -= 1; }
  return result.sort((a, b) => a.priority - b.priority);
}
