use crate::Reply;
use serde_json::{json, Value};
use std::{
    fs,
    io::{ErrorKind, Write},
    path::PathBuf,
    sync::Mutex,
};
pub struct Ctx {
    pub root: PathBuf,
    io: Mutex<()>,
}
impl Ctx {
    pub fn new(root: PathBuf) -> std::io::Result<Self> {
        fs::create_dir_all(root.join("models"))?;
        Ok(Self {
            root,
            io: Mutex::new(()),
        })
    }
    fn read_value(&self, name: &str, default: Value) -> Reply {
        match fs::read(self.root.join(format!("{name}.json"))) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| format!("{name}.json: {e}")),
            Err(e) if e.kind() == ErrorKind::NotFound => Ok(default),
            Err(e) => Err(e.to_string()),
        }
    }
    pub fn read(&self, name: &str, default: Value) -> Reply {
        let _guard = self.io.lock().unwrap();
        self.read_value(name, default)
    }
    fn save(&self, name: &str, v: &Value) -> Result<(), String> {
        let mut tmp = tempfile::NamedTempFile::new_in(&self.root).map_err(|e| e.to_string())?;
        serde_json::to_writer_pretty(tmp.as_file_mut(), v).map_err(|e| e.to_string())?;
        tmp.flush()
            .and_then(|_| tmp.as_file().sync_all())
            .map_err(|e| e.to_string())?;
        tmp.persist(self.root.join(format!("{name}.json")))
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    pub fn write(&self, name: &str, v: &Value) -> Result<(), String> {
        let _guard = self.io.lock().unwrap();
        self.save(name, v)
    }
    pub fn update(
        &self,
        name: &str,
        default: Value,
        f: impl FnOnce(&mut Value) -> Result<(), String>,
    ) -> Reply {
        let _guard = self.io.lock().unwrap();
        let mut v = self.read_value(name, default)?;
        f(&mut v)?;
        self.save(name, &v)?;
        Ok(v)
    }
    pub fn settings(&self) -> Reply {
        let mut v = json!({"models_dir":self.root.join("models"),"images_dir":self.root.join("images"),"port":8686,"perf_kv":"f16","custom_mirror":"","account_base":"","accel_lines":[],"hf_token":"","github_mirror":"","auto_restart":true});
        let saved = self.read("settings", json!({}))?;
        let saved = saved.as_object().ok_or("settings.json 格式错误")?;
        v.as_object_mut().unwrap().extend(saved.clone());
        Ok(v)
    }
}
