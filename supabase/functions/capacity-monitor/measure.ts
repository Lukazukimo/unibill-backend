/**
 * measure.ts — thin wrapper over app.measure_capacity() (T-602).
 *
 * The actual measurement is a SECURITY DEFINER SQL function (it needs
 * pg_database_size / storage.objects / pgmq access service_role lacks). This
 * just calls the rpc and types the result, so the monitor handler can inject a
 * fake `measure` in unit tests.
 */

import { type SupabaseClient } from 'jsr:@supabase/supabase-js@^2.45.0';

export interface CapacityMetrics {
  db_bytes: number;
  db_per_table: Record<string, number>;
  storage_bytes: number;
  storage_per_bucket: Record<string, number>;
  queue_depths: Record<string, number>;
}

export type MeasureFn = (client: SupabaseClient) => Promise<CapacityMetrics>;

export const measure: MeasureFn = async (client) => {
  const { data, error } = await client.rpc('measure_capacity');
  if (error) throw new Error(`measure_capacity failed: ${error.message}`);
  return data as CapacityMetrics;
};
