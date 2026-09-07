use chrono::{DateTime, Utc};
use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{fs::File, io::Read, path::Path};

#[derive(Serialize)]
struct IndexRecord {
    record_number: i64,
    channel: i64,
    start_time_utc: Option<String>,
    end_time_utc: Option<String>,
    length_bytes: i64,
    cluster_number: i64,
    index_in_cluster: i64,
    event_names: Vec<String>,
}

#[derive(Serialize)]
struct IndexReport {
    database_path: String,
    database_sha256: String,
    record_count: usize,
    valid_timestamped_record_count: usize,
    event_definitions: Vec<String>,
    records: Vec<IndexRecord>,
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|error| error.to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|error| error.to_string())?;
        if read == 0 { break; }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn unix_timestamp(timestamp: i64) -> Option<String> {
    if timestamp <= 0 { return None; }
    DateTime::<Utc>::from_timestamp(timestamp, 0).map(|value| value.to_rfc3339())
}

#[tauri::command]
fn inspect_sd_index(database_path: String) -> Result<IndexReport, String> {
    let path = Path::new(&database_path);
    if path.file_name().and_then(|name| name.to_str()) != Some("SDFileInfo.db") {
        return Err("Select the SDFileInfo.db index from a copied SD-card folder.".to_string());
    }
    let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)
        .map_err(|error| format!("Could not open the index read-only: {error}"))?;

    let event_definitions = connection.prepare("SELECT COALESCE(ED_Name, '') FROM EvtDef ORDER BY ED_Index")
        .map_err(|error| error.to_string())?
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?;

    let mut statement = connection.prepare(
        "SELECT f.FI_RecNo, f.FI_Channel, f.FI_StartTimeRealUTC, f.FI_EndTimeRealUTC,
                f.FI_Length, f.FI_ClusterNo, f.FI_IndexInCluster,
                COALESCE(group_concat(d.ED_Name, '|'), '')
           FROM File f
      LEFT JOIN Event e ON e.ET_FI_RecNo = f.FI_RecNo
      LEFT JOIN EvtDef d ON d.ED_Index = e.ET_ED_Index
       GROUP BY f.FI_RecNo
       ORDER BY f.FI_StartTimeRealUTC"
    ).map_err(|error| format!("The index schema is not recognised: {error}"))?;

    let records = statement.query_map([], |row| {
        let events: String = row.get(7)?;
        Ok(IndexRecord {
            record_number: row.get(0)?, channel: row.get(1)?,
            start_time_utc: unix_timestamp(row.get(2)?), end_time_utc: unix_timestamp(row.get(3)?),
            length_bytes: row.get(4)?, cluster_number: row.get(5)?, index_in_cluster: row.get(6)?,
            event_names: events.split('|').filter(|name| !name.is_empty()).map(str::to_owned).collect(),
        })
    }).map_err(|error| error.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?;
    let valid_timestamped_record_count = records.iter().filter(|record| record.start_time_utc.is_some() && record.end_time_utc.is_some()).count();
    let database_sha256 = sha256_file(path)?;

    Ok(IndexReport { database_path, database_sha256, record_count: records.len(), valid_timestamped_record_count, event_definitions, records })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_deep_link::init())
        .invoke_handler(tauri::generate_handler![inspect_sd_index])
        .run(tauri::generate_context!())
        .expect("error while running FCM SD Card Bridge");
}