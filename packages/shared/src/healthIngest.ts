/**
 * Record types the Android app may forward from Health Connect (the API rejects the rest). Shared so
 * the phone's mapping tests can check everything it produces is allowed.
 */
export const HEALTH_INGEST_TYPES: readonly string[] = [
  // Daily totals SparkyFitness has dedicated places for.
  'step',
  'steps',
  'Active Calories',
  'active_calories',
  'TotalCaloriesBurned',
  'BasalMetabolicRate',
  'weight',
  'body_fat',
  'height',
  'water',
  'Nutrition',
  'SleepSession',
  'ExerciseSession',
  // Everything else is kept by SparkyFitness as a daily custom measurement under this name.
  'distance',
  'resting_heart_rate',
  'heart_rate_min',
  'heart_rate_max',
  'heart_rate_avg',
  'HRV',
  'respiratory_rate',
  'oxygen_saturation',
  'vo2_max',
  'blood_pressure_systolic',
  'blood_pressure_diastolic',
  'blood_glucose',
  'body_temperature',
  'basal_body_temperature',
  'floors_climbed',
  'mindfulness_minutes',
];
