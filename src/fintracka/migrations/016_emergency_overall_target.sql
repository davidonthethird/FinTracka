UPDATE savings_goals
SET overall_target_minor = 2500000
WHERE pool = 'regular'
  AND lower(trim(name)) = 'emergency'
  AND overall_target_minor IS NULL;
