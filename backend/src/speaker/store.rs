use anyhow::Result;
use rusqlite::{params, Connection};
use std::sync::Mutex;

pub struct SpeakerMatch {
    pub speaker_id: i64,
    pub name: Option<String>,
    pub confidence: f32,
}

/// SQLite-backed speaker enrollment and matching. A `Mutex<Connection>`
/// (not a pool) is deliberate — this is a single-robot, single-voice-turn-
/// at-a-time personal assistant, not a multi-tenant service, so lock
/// contention here is a non-issue at the scale this will ever run at.
pub struct SpeakerStore {
    conn: Mutex<Connection>,
    match_threshold: f32,
}

const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS speakers (
    id INTEGER PRIMARY KEY,
    name TEXT,
    fingerprint BLOB NOT NULL,
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL
);";

impl SpeakerStore {
    pub fn new(db_path: &str, match_threshold: f32) -> Result<Self> {
        if let Some(parent) = std::path::Path::new(db_path).parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent)?;
            }
        }
        let conn = Connection::open(db_path)?;
        conn.execute_batch(SCHEMA)?;
        Ok(Self {
            conn: Mutex::new(conn),
            match_threshold,
        })
    }

    pub fn in_memory(match_threshold: f32) -> Result<Self> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch(SCHEMA)?;
        Ok(Self {
            conn: Mutex::new(conn),
            match_threshold,
        })
    }

    fn encode_fingerprint(fp: &[f32]) -> Vec<u8> {
        fp.iter().flat_map(|f| f.to_le_bytes()).collect()
    }

    fn decode_fingerprint(blob: &[u8]) -> Vec<f32> {
        blob.chunks_exact(4)
            .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
            .collect()
    }

    fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
        let dot: f32 = a.iter().zip(b).map(|(x, y)| x * y).sum();
        let norm_a: f32 = a.iter().map(|x| x * x).sum::<f32>().sqrt();
        let norm_b: f32 = b.iter().map(|x| x * x).sum::<f32>().sqrt();
        if norm_a == 0.0 || norm_b == 0.0 {
            return 0.0;
        }
        dot / (norm_a * norm_b)
    }

    /// Linear scan over every enrolled speaker. Fine at personal/household
    /// scale (tens of speakers, not thousands) — no vector index needed,
    /// same reasoning as choosing SQLite over a dedicated vector DB.
    pub fn find_best_match(&self, fingerprint: &[f32]) -> Result<Option<SpeakerMatch>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT id, name, fingerprint FROM speakers")?;
        let rows = stmt.query_map([], |row| {
            let id: i64 = row.get(0)?;
            let name: Option<String> = row.get(1)?;
            let blob: Vec<u8> = row.get(2)?;
            Ok((id, name, blob))
        })?;

        let mut best: Option<(i64, Option<String>, f32)> = None;
        for row in rows {
            let (id, name, blob) = row?;
            let stored_fp = Self::decode_fingerprint(&blob);
            let sim = Self::cosine_similarity(fingerprint, &stored_fp);
            let is_better = best
                .as_ref()
                .map(|(_, _, best_sim)| sim > *best_sim)
                .unwrap_or(true);
            if is_better {
                best = Some((id, name, sim));
            }
        }

        Ok(best.and_then(|(id, name, sim)| {
            if sim >= self.match_threshold {
                Some(SpeakerMatch {
                    speaker_id: id,
                    name,
                    confidence: sim,
                })
            } else {
                None
            }
        }))
    }

    pub fn enroll(&self, fingerprint: &[f32], name: Option<&str>) -> Result<i64> {
        let conn = self.conn.lock().unwrap();
        let now = chrono::Utc::now().to_rfc3339();
        let blob = Self::encode_fingerprint(fingerprint);
        conn.execute(
            "INSERT INTO speakers (name, fingerprint, created_at, last_seen_at) VALUES (?1, ?2, ?3, ?3)",
            params![name, blob, now],
        )?;
        Ok(conn.last_insert_rowid())
    }

    pub fn set_name(&self, speaker_id: i64, name: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE speakers SET name = ?1 WHERE id = ?2",
            params![name, speaker_id],
        )?;
        Ok(())
    }

    pub fn touch_last_seen(&self, speaker_id: i64) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        let now = chrono::Utc::now().to_rfc3339();
        conn.execute(
            "UPDATE speakers SET last_seen_at = ?1 WHERE id = ?2",
            params![now, speaker_id],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A deterministic pseudo-fingerprint for tests: `seed` picks a
    /// direction in 256-d space so two different seeds are guaranteed to
    /// cosine-differ, and the same seed always reproduces the same vector.
    fn fake_fingerprint(seed: u32) -> Vec<f32> {
        (0..256)
            .map(|i| ((seed as f32 + 1.0) * (i as f32 + 1.0)).sin())
            .collect()
    }

    #[test]
    fn enroll_then_find_best_match_above_threshold() {
        let store = SpeakerStore::in_memory(0.75).unwrap();
        let fp = fake_fingerprint(1);
        let id = store.enroll(&fp, Some("Daan")).unwrap();

        let result = store
            .find_best_match(&fp)
            .unwrap()
            .expect("should match itself");
        assert_eq!(result.speaker_id, id);
        assert_eq!(result.name.as_deref(), Some("Daan"));
        assert!(
            result.confidence > 0.99,
            "identical fingerprint should be ~1.0 similarity"
        );
    }

    #[test]
    fn no_match_below_threshold() {
        let store = SpeakerStore::in_memory(0.75).unwrap();
        store.enroll(&fake_fingerprint(1), Some("Daan")).unwrap();

        let unrelated = fake_fingerprint(999);
        let result = store.find_best_match(&unrelated).unwrap();
        assert!(result.is_none(), "an unrelated fingerprint must not match");
    }

    #[test]
    fn enroll_without_name_then_set_name() {
        let store = SpeakerStore::in_memory(0.75).unwrap();
        let fp = fake_fingerprint(2);
        let id = store.enroll(&fp, None).unwrap();

        let before = store.find_best_match(&fp).unwrap().unwrap();
        assert_eq!(before.name, None);

        store.set_name(id, "Sarah").unwrap();

        let after = store.find_best_match(&fp).unwrap().unwrap();
        assert_eq!(after.name.as_deref(), Some("Sarah"));
    }

    #[test]
    fn finds_the_closest_of_multiple_enrolled_speakers() {
        let store = SpeakerStore::in_memory(0.75).unwrap();
        let id_a = store.enroll(&fake_fingerprint(1), Some("A")).unwrap();
        store.enroll(&fake_fingerprint(50), Some("B")).unwrap();
        store.enroll(&fake_fingerprint(100), Some("C")).unwrap();

        let result = store
            .find_best_match(&fake_fingerprint(1))
            .unwrap()
            .unwrap();
        assert_eq!(result.speaker_id, id_a);
    }

    #[test]
    fn touch_last_seen_does_not_error_on_existing_speaker() {
        let store = SpeakerStore::in_memory(0.75).unwrap();
        let id = store.enroll(&fake_fingerprint(3), Some("X")).unwrap();
        store.touch_last_seen(id).unwrap();
    }
}
