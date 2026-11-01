// Coach reports are not synthetic BLE sessions. Never pass them to trends.
export function historyItem(row) {
  const r = row.history_json || {};
  const raw = r.raw || {};
  const pulse = r.pulse_payload || row.polar_json || {};
  const duration = Number.isFinite(pulse.duration_s) ? `${Math.floor(pulse.duration_s / 60)} min ${pulse.duration_s % 60} s (recorded)`
    : raw.duration_min == null ? (typeof pulse.duration === 'string' ? `${pulse.duration} (reported)` : null)
      : `${raw.duration_min} min (reported)`;
  return {
    id: row.id, date: row.date, sourceKey: row.source_key,
    title: raw.session_name || ((raw.number || row.number) ? `Workout ${raw.number || row.number}` : 'Training report'),
    summary: raw.actual_summary || raw.summary || row.summary || '', notes: raw.notes || '',
    status: row.status === 'skip' ? 'Rest / skipped' : r.source_status?.completed === 0 ? 'Activity logged · plan partially completed' : 'Activity logged',
    duration,
    nativeLogId: row.source === 'pulse' ? row.log_id : null, record: row.history_json || row.polar_json || {},
  };
}

export async function loadHistory(client, userId, storage = localStorage) {
  if (!client || !userId) return { rows: [], cached: false };
  const key = `pulse.workoutHistory.v1.${userId}`;
  try {
    const all = [];
    for (let start = 0; ; start += 500) {
      const { data, error } = await client.from('workouts').select('*')
        .eq('user_id', userId).is('deleted_at', null).order('date', { ascending: false }).order('id').range(start, start + 499);
      if (error) throw error;
      if (!Array.isArray(data) || data.some((r) => r.user_id !== userId)) throw Error('Unexpected history owner');
      all.push(...data);
      if (data.length < 500) break;
    }
    try { storage.setItem(key, JSON.stringify(all)); } catch {}
    return { rows: all, cached: false };
  } catch (error) {
    let cached;
    try { cached = JSON.parse(storage.getItem(key) || 'null'); } catch {}
    if (Array.isArray(cached) && cached.every((r) => r.user_id === userId)) {
      return { rows: cached, cached: true, error: error.message || String(error) };
    }
    throw error;
  }
}
